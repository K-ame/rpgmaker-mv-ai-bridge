import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { WebSocket } from 'ws';

process.env.MV_AI_BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-ai-bridge-test-'));

const { BridgeCore } = await import('../dist/core.js');
const { startServer } = await import('../dist/http.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

const TOKEN = 'test-token';

const STATE = {
  tick: 10,
  scene: 'map',
  settled: true,
  map: { id: 1, name: 'Test Map', width: 20, height: 20 },
  player: { x: 5, y: 5, direction: 2, moving: false, transferring: false },
  message: null,
  choices: null,
  battle: null,
  party: { gold: 100, members: [] },
};

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function envelope(action, status, extra = {}) {
  return {
    ok: status !== 'error',
    status,
    action,
    effect: null,
    interrupted_by: null,
    reason: null,
    tick: STATE.tick,
    state: STATE,
    new_log: [],
    warnings: [],
    ...extra,
  };
}

function openGame(port, { title = 'Mock Game', slowWalk = 300 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/game?token=${TOKEN}`);
    ws.once('error', reject);
    ws.once('open', () => {
      ws.send(JSON.stringify({ t: 'hello', proto: 1, game: { title, rpgmaker: '1.6.1' } }));
      ws.send(JSON.stringify({ t: 'state', state: STATE }));
      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.t !== 'cmd') return;
        const reply = (result) =>
          ws.send(JSON.stringify({ t: 'reply', id: msg.id, result: { ...envelope(msg.action, result.status || 'done'), ...result } }));
        if (msg.action === 'observe') {
          reply({ status: 'done', effect: { scene: 'map', events: [] } });
        } else if (msg.action === 'walk') {
          setTimeout(() => reply({ status: 'interrupted', interrupted_by: 'message', effect: { steps_done: 2 } }), slowWalk);
        } else if (msg.action === 'go_to') {
          reply({ status: 'done', effect: { to: { x: msg.args.x, y: msg.args.y } } });
        } else {
          reply({ status: 'done', effect: { echoed: msg.args } });
        }
      });
      resolve(ws);
    });
  });
}

async function connectMcp(url, token = TOKEN) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'mv-ai-bridge-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

const port = await freePort();
const core = new BridgeCore();
const server = await startServer({ host: '127.0.0.1', port, token: TOKEN, core });

after(async () => {
  await server.close();
});

test('exposes the 18 gameplay tools', async () => {
  const client = await connectMcp(server.url);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'advance', 'back', 'battle', 'checkpoint', 'go_to', 'input', 'interact', 'list_events',
    'log', 'look', 'manage', 'note', 'observe', 'select', 'talk_to', 'title', 'wait', 'walk',
  ]);
  await client.close();
});

test('reports a clear error when no game is connected', async () => {
  const client = await connectMcp(server.url);
  const res = await client.callTool({ name: 'observe', arguments: {} });
  assert.equal(res.isError, true);
  assert.equal(res.structuredContent.reason, 'game_not_connected');
  await client.close();
});

test('forwards commands to the game and surfaces interruptions', async () => {
  const game = await openGame(port);
  const client = await connectMcp(server.url);

  const observed = await client.callTool({ name: 'observe', arguments: {} });
  assert.equal(observed.isError, false);
  assert.equal(observed.structuredContent.status, 'done');
  assert.equal(observed.structuredContent.effect.scene, 'map');

  const walked = await client.callTool({ name: 'walk', arguments: { direction: 'down', steps: 3 } });
  assert.equal(walked.isError, false);
  assert.equal(walked.structuredContent.status, 'interrupted');
  assert.equal(walked.structuredContent.interrupted_by, 'message');
  assert.equal(walked.structuredContent.state.player.x, 5);

  await client.close();
  game.close();
});

test('a second write waits for the first and returns busy', async () => {
  const game = await openGame(port);
  const client = await connectMcp(server.url);

  const walking = client.callTool({ name: 'walk', arguments: { direction: 'up', steps: 1 } });
  await new Promise((r) => setTimeout(r, 50));
  const second = await client.callTool({ name: 'go_to', arguments: { x: 1, y: 1 } });
  assert.equal(second.isError, true);
  assert.equal(second.structuredContent.reason, 'busy');

  const first = await walking;
  assert.equal(first.structuredContent.status, 'interrupted');

  await client.close();
  game.close();
});

test('notes persist without a game', async () => {
  const client = await connectMcp(server.url);
  const set = await client.callTool({ name: 'note', arguments: { action: 'set', key: 'route', value: { next: 'north' } } });
  assert.equal(set.isError, false);
  const get = await client.callTool({ name: 'note', arguments: { action: 'get', key: 'route' } });
  assert.deepEqual(get.structuredContent.effect.entry.value, { next: 'north' });
  const list = await client.callTool({ name: 'note', arguments: { action: 'list' } });
  assert.ok(list.structuredContent.effect.notes.route);
  await client.close();
});

test('rejects requests without the bearer token', async () => {
  const response = await fetch(server.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(response.status, 401);
});

test('health endpoint reports the connected game', async () => {
  const game = await openGame(port, { title: 'Health Game' });
  await new Promise((r) => setTimeout(r, 100));
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const body = await response.json();
  assert.equal(body.connected, true);
  assert.equal(body.game.title, 'Health Game');
  game.close();
  await new Promise((r) => setTimeout(r, 100));
});

function tryGame(port, query = '') {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/game${query}`);
    ws.once('open', () => resolve({ opened: true, ws }));
    ws.once('unexpected-response', (_req, res) => {
      res.resume();
      resolve({ opened: false, status: res.statusCode });
    });
    ws.once('error', () => resolve({ opened: false, status: null }));
  });
}

test('rejects a game connection without the token', async () => {
  const result = await tryGame(port);
  assert.equal(result.opened, false);
  assert.equal(result.status, 401);
});

test('rejects a game connection with the wrong token', async () => {
  const result = await tryGame(port, '?token=not-the-token');
  assert.equal(result.opened, false);
  assert.equal(result.status, 401);
});

test('accepts the token as a query parameter or a bearer header', async () => {
  const viaQuery = await tryGame(port, `?token=${TOKEN}`);
  assert.equal(viaQuery.opened, true);
  viaQuery.ws.close();
  await new Promise((r) => setTimeout(r, 50));

  const viaHeader = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/game`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    ws.once('open', () => resolve({ opened: true, ws }));
    ws.once('error', () => resolve({ opened: false }));
  });
  assert.equal(viaHeader.opened, true);
  viaHeader.ws.close();
  await new Promise((r) => setTimeout(r, 50));
});

test('an unauthenticated attempt cannot replace the connected game', async () => {
  const game = await openGame(port, { title: 'Real Game' });
  await new Promise((r) => setTimeout(r, 100));

  const intruder = await tryGame(port);
  assert.equal(intruder.opened, false);
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(game.readyState, WebSocket.OPEN);
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const body = await response.json();
  assert.equal(body.connected, true);
  assert.equal(body.game.title, 'Real Game');
  game.close();
  await new Promise((r) => setTimeout(r, 100));
});
