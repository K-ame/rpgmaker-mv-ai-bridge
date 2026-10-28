#!/usr/bin/env node
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BRIDGE_DIR, BridgeCore } from '../core.js';
import { startServer } from '../http.js';
import { createMcpServer } from '../mcp.js';
import { DEFAULT_HOST, DEFAULT_PORT, VERSION } from './constants.js';
import { doctor } from './doctor.js';
import { getOrCreateToken, isProcessRunning, readSession, removeSession, TOKEN_FILE, writeSession } from './files.js';
import { installPlugin, manualSnippet } from './install.js';

interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags[body] = next;
          i++;
        } else {
          flags[body] = true;
        }
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      flags[arg.slice(1)] = true;
      continue;
    }
    positional.push(arg);
  }
  return { flags, positional };
}

function log(message: string): void {
  process.stderr.write(message + '\n');
}

function fail(message: string): never {
  log(message);
  process.exit(1);
}

function parsePort(value: string | boolean | undefined): number {
  const port = Number(value ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`Invalid port: ${String(value)}`);
  }
  return port;
}

const HELP = `mv-ai-bridge ${VERSION}

Let an AI agent play an RPG Maker MV game through native MCP.

Usage:
  mv-ai-bridge serve [--port 7321] [--host 127.0.0.1] [--stdio|--no-stdio]
  mv-ai-bridge install <gameDir> [--port 7321]
  mv-ai-bridge doctor [gameDir]
  mv-ai-bridge session
  mv-ai-bridge --help

serve:
  Runs the local bridge. It listens for the game plugin on ws://<host>:<port>/game
  and exposes MCP at http://<host>:<port>/mcp (Streamable HTTP, bearer token).
  Stdio MCP is off by default; pass --stdio to speak MCP over stdin/stdout as
  well. It is never enabled implicitly, so piped or background runs keep a
  clean stdout.

install:
  Copies the plugin into <gameDir>/www/js/plugins/ and appends it to plugins.js.
  A one-time backup is written to plugins.js.mv-ai-bridge.bak.

Files:
  ~/.mv-ai-bridge/token         MCP bearer token
  ~/.mv-ai-bridge/session.json  Running bridge address and pid
  ~/.mv-ai-bridge/notes.json    Agent notes
`;

async function serve(args: ParsedArgs): Promise<void> {
  const host = typeof args.flags.host === 'string' ? args.flags.host : DEFAULT_HOST;
  const port = parsePort(args.flags.port);
  const token = typeof args.flags.token === 'string' ? args.flags.token : getOrCreateToken();

  // Stdio MCP must be explicit. Inferring it from a non-TTY stdin made
  // background and containerised runs leak JSON-RPC frames into stdout.
  const wantStdio = args.flags.stdio === true;
  if (!wantStdio && args.flags['no-stdio'] !== true && !process.stdin.isTTY) {
    console.error(
      '[mv-ai-bridge] stdin is not a TTY; stdio MCP is disabled. Pass --stdio to enable it.',
    );
  }

  const core = new BridgeCore();
  let server;
  try {
    server = await startServer({ host, port, token, core });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      fail(`Port ${port} is already in use. Stop the other bridge or pick another port with --port.`);
    }
    fail(`Failed to start the bridge: ${(err as Error).message}`);
  }

  writeSession({
    pid: process.pid,
    host,
    port,
    token,
    url: server.url,
    startedAt: new Date().toISOString(),
    version: VERSION,
  });

  log(`mv-ai-bridge ${VERSION}`);
  log(`  game WebSocket : ws://${host}:${port}/game`);
  log(`  MCP (HTTP)    : ${server.url}`);
  log(`  token         : ${token}`);
  // Absolute paths: with WSL the bridge and the game can have different HOMEs,
  // and a relative "~/.mv-ai-bridge" hides which side actually holds the token.
  log(`  bridge home   : ${BRIDGE_DIR}`);
  log(`  token file    : ${TOKEN_FILE}`);
  log(`  session file  : ${path.join(BRIDGE_DIR, 'session.json')}`);
  log('  waiting for the game to connect...');

  let lastConnected = false;
  const statusTimer = setInterval(() => {
    const connected = core.session.connected;
    if (connected !== lastConnected) {
      lastConnected = connected;
      if (connected) {
        const title = core.session.gameInfo?.title || 'unnamed game';
        const rm = core.session.gameInfo?.rpgmaker || '?';
        log(`  game connected: ${title} (RPG Maker ${rm})`);
      } else {
        log('  game disconnected; waiting for the plugin to reconnect...');
      }
    }
  }, 1000);
  statusTimer.unref?.();

  if (wantStdio) {
    const mcp = createMcpServer(core);
    const transport = new StdioServerTransport();
    await mcp.connect(transport);
    log('  MCP (stdio)   : connected to this process');
  }

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    clearInterval(statusTimer);
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    removeSession(process.pid);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

function install(args: ParsedArgs): void {
  const gameDir = typeof args.flags.dir === 'string' ? args.flags.dir : args.positional[0];
  if (!gameDir) fail('Usage: mv-ai-bridge install <gameDir> [--port 7321]');
  const port = parsePort(args.flags.port);
  try {
    const result = installPlugin(gameDir, port, args.flags.debug === true);
    log(`Installed ${result.entry.name} into ${result.pluginPath}`);
    log(`Updated ${result.layout.pluginsJs}`);
    if (result.backupPath) log(`Backup written to ${result.backupPath}`);
    else log('Backup already exists, leaving it untouched.');
    log('');
    log('Next steps:');
    log('  1. Run `mv-ai-bridge serve` (or configure it as an MCP server).');
    log('  2. Launch the game. The plugin retries the local socket every few seconds.');
    log('  3. Point your MCP client at ~/.mv-ai-bridge/session.json for the token and URL.');
  } catch (err) {
    log(`Install failed: ${(err as Error).message}`);
    log('');
    log('If plugins.js is not plain JSON, add this entry manually at the end of $plugins:');
    log(manualSnippet(port));
    process.exit(1);
  }
}

async function runDoctor(args: ParsedArgs): Promise<void> {
  const gameDir = typeof args.flags.dir === 'string' ? args.flags.dir : args.positional[0];
  const lines = await doctor(gameDir);
  let failed = false;
  for (const line of lines) {
    const mark = line.level === 'ok' ? '[ok]  ' : line.level === 'warn' ? '[warn]' : '[fail]';
    if (line.level === 'fail') failed = true;
    log(`${mark} ${line.text}`);
  }
  process.exit(failed ? 1 : 0);
}

function session(): void {
  const info = readSession();
  if (!info) {
    log('No session file. Start the bridge with `mv-ai-bridge serve`.');
    process.exit(1);
  }
  const running = isProcessRunning(info.pid);
  log(JSON.stringify({ ...info, running }, null, 2));
  if (!running) {
    log('This session looks stale. Start the bridge again.');
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (command === '--version' || command === '-v' || args.flags.version === true) {
    log(VERSION);
    return;
  }
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    log(HELP);
    return;
  }
  if (command === 'serve') return serve(args);
  if (command === 'install') return install(args);
  if (command === 'doctor') return runDoctor(args);
  if (command === 'session') return session();

  fail(`Unknown command: ${command}\n\n${HELP}`);
}

void main();
