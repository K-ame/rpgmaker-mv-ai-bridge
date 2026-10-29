import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { BridgeCore } from './core.js';
import { VERSION } from './cli/constants.js';
import { createMcpServer } from './mcp.js';
import { PROTOCOL_VERSION } from './protocol.js';

export interface ServeOptions {
  host: string;
  port: number;
  token: string;
  core: BridgeCore;
}

export interface BridgeServer {
  httpServer: http.Server;
  close: () => Promise<void>;
  url: string;
}

const MAX_BODY = 4 * 1024 * 1024;

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function authorized(req: http.IncomingMessage, url: URL, token: string): boolean {
  if (!token) return true;
  const header = req.headers['authorization'];
  if (typeof header === 'string' && header === `Bearer ${token}`) return true;
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey === token) return true;
  if (url.searchParams.get('token') === token) return true;
  return false;
}

function cors(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-API-Key, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID',
  );
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  cors(res);
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export function startServer(options: ServeOptions): Promise<BridgeServer> {
  const { host, port, token, core } = options;

  const httpServer = http.createServer((req, res) => {
    void handleRequest(req, res);
  });

  const wss = new WebSocketServer({ noServer: true });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    cors(res);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (url.pathname === '/health') {
      if (!authorized(req, url, token)) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      json(res, 200, {
        ok: true,
        version: VERSION,
        protocol_version: PROTOCOL_VERSION,
        ...core.session.summary(),
        notes: core.notes.status(),
        rejected_last_minute: rejectedLastMinute(),
      });
      return;
    }

    if (url.pathname === '/') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(
        'mv-ai-bridge ' + VERSION + '\n' +
          `game: ${core.session.connection}\n` +
          `MCP endpoint: http://${host}:${port}/mcp\n` +
          'Add it as a Streamable HTTP MCP server with the token from ~/.mv-ai-bridge/session.json.\n',
      );
      return;
    }

    if (url.pathname !== '/mcp') {
      json(res, 404, { error: 'not_found' });
      return;
    }

    if (!authorized(req, url, token)) {
      json(res, 401, { error: 'unauthorized', hint: 'Use Authorization: Bearer <token> from ~/.mv-ai-bridge/session.json' });
      return;
    }

    if (req.method !== 'POST') {
      // Stateless server: no standalone SSE stream and no session to delete.
      json(res, 405, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed. This bridge uses stateless Streamable HTTP: send POST requests.' },
        id: null,
      });
      return;
    }

    let body: unknown;
    try {
      body = await readBody(req);
    } catch (err) {
      json(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32700, message: String((err as Error).message || err) },
        id: null,
      });
      return;
    }

    const server = createMcpServer(core);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on('close', () => {
      try {
        void transport.close();
      } catch {
        /* ignore */
      }
      try {
        void server.close();
      } catch {
        /* ignore */
      }
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        json(res, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: String((err as Error).message || err) },
          id: null,
        });
      }
    }
  }

  // One chatty source (typically a browser extension probing localhost) used
  // to consume the single 30-second log slot, hiding the game's own 401s.
  // Group by origin kind and report a count per window instead.
  const REJECT_WINDOW_MS = 60_000;
  const REJECT_LOG_MS = 30_000;
  const rejectLog = new Map<string, { lastLogAt: number; count: number }>();
  const rejectTimes: Array<{ at: number; kind: string }> = [];

  function rejectKind(origin: unknown): string {
    const value = typeof origin === 'string' ? origin : '';
    if (!value) return 'game'; // the game plugin does not send an Origin header
    if (/^(chrome|moz|safari-web)-extension:\/\//i.test(value)) return 'extension';
    if (value === 'null') return 'none';
    return 'web';
  }

  function noteRejectedGame(origin: unknown): void {
    const nowMs = Date.now();
    const kind = rejectKind(origin);
    while (rejectTimes.length && nowMs - rejectTimes[0].at > REJECT_WINDOW_MS) rejectTimes.shift();
    rejectTimes.push({ at: nowMs, kind });
    if (rejectTimes.length > 5000) rejectTimes.splice(0, rejectTimes.length - 5000);

    const stat = rejectLog.get(kind) ?? { lastLogAt: 0, count: 0 };
    stat.count += 1;
    if (nowMs - stat.lastLogAt > REJECT_LOG_MS) {
      const shown = String(origin ?? 'none').replace(/[^\x20-\x7e]/g, '?').slice(0, 100);
      console.error(
        `[mv-ai-bridge] rejected ${stat.count}x /game connections ` +
          `(kind=${kind}, missing or wrong token, origin: ${shown}). ` +
          'If this is your game, copy the latest plugin (re-run install) or set its Token parameter.',
      );
      stat.count = 0;
      stat.lastLogAt = nowMs;
    }
    rejectLog.set(kind, stat);
  }

  function rejectedLastMinute(): Record<string, number> {
    const nowMs = Date.now();
    while (rejectTimes.length && nowMs - rejectTimes[0].at > REJECT_WINDOW_MS) rejectTimes.shift();
    const out: Record<string, number> = {};
    for (const entry of rejectTimes) out[entry.kind] = (out[entry.kind] ?? 0) + 1;
    return out;
  }

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/game') {
      socket.destroy();
      return;
    }
    // Browsers let any web page open a WebSocket to 127.0.0.1, and a newer
    // /game connection replaces the current one. Without this check a page
    // the user happens to visit could kick the real game out and feed the
    // agent fabricated state and dialogue.
    if (!authorized(req, url, token)) {
      noteRejectedGame(req.headers.origin);
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      core.session.attach(ws);
    });
  });

  httpServer.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  const pingTimer = setInterval(() => {
    core.session.ping();
  }, 15000);
  pingTimer.unref?.();

  return new Promise<BridgeServer>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      clearInterval(pingTimer);
      reject(err);
    };
    httpServer.once('error', onError);
    httpServer.listen(port, host, () => {
      httpServer.off('error', onError);
      resolve({
        httpServer,
        url: `http://${host}:${port}/mcp`,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(pingTimer);
            for (const client of wss.clients) {
              try {
                client.close(1001, 'bridge shutting down');
              } catch {
                /* ignore */
              }
            }
            wss.close();
            httpServer.close(() => done());
            setTimeout(done, 1500).unref?.();
          }),
      });
    });
  });
}
