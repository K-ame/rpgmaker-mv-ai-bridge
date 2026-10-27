import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import {
  Envelope,
  GameInfo,
  GameState,
  PROTOCOL_VERSION,
  errorEnvelope,
} from './protocol.js';

const READ_ONLY = new Set(['observe', 'look', 'list_events', 'log']);

export const BRIDGE_DIR = process.env.MV_AI_BRIDGE_HOME
  ? path.resolve(process.env.MV_AI_BRIDGE_HOME)
  : path.join(os.homedir(), '.mv-ai-bridge');
const NOTES_FILE = path.join(BRIDGE_DIR, 'notes.json');

export function ensureBridgeDir(): void {
  fs.mkdirSync(BRIDGE_DIR, { recursive: true });
}

export function timeoutFor(action: string, args: Record<string, unknown>): number {
  const explicit = Number(args.timeout_ms);
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(explicit, 600_000);
  switch (action) {
    case 'observe':
    case 'look':
    case 'list_events':
    case 'log':
      return 10_000;
    case 'walk':
      return 45_000;
    case 'go_to':
      return 90_000;
    case 'talk_to':
      return 30_000;
    case 'advance': {
      const pages = Math.min(Math.max(Number(args.max_pages) || 50, 1), 500);
      const rawDelay = Number(args.page_delay_ms);
      const delay = Number.isFinite(rawDelay) && rawDelay >= 0 ? rawDelay : 2000;
      // Must stay slightly above the plugin's own deadline, which is the one
      // that returns a partial envelope with the pages collected so far.
      const perPage = Math.max(delay, 1800) + 400;
      return Math.min(15_000 + pages * perPage + 10_000, 600_000);
    }
    case 'select':
    case 'title':
      return 25_000;
    case 'battle':
      return args.action === 'auto' ? 260_000 : 40_000;
    case 'wait': {
      const ms = Number(args.ms) || 0;
      return Math.min(ms + 10_000, 130_000);
    }
    case 'checkpoint':
      return 35_000;
    case 'manage':
      return 25_000;
    default:
      return 20_000;
  }
}

interface PendingCall {
  resolve: (env: Envelope) => void;
  timer: NodeJS.Timeout;
}

export class GameSession {
  private ws: WebSocket | null = null;
  private pending = new Map<number, PendingCall>();
  private nextId = 1;

  connected = false;
  state: GameState | null = null;
  gameInfo: GameInfo = {};
  lastMessageAt = 0;
  connectedSince: number | null = null;

  attach(ws: WebSocket): void {
    if (this.ws && this.ws !== ws) {
      try {
        this.ws.close(1000, 'replaced by a newer game connection');
      } catch {
        /* ignore */
      }
    }
    this.rejectAll('game_reconnected');
    this.ws = ws;
    this.connected = ws.readyState === WebSocket.OPEN;
    this.connectedSince = Date.now();
    this.gameInfo = {};

    ws.on('message', (raw) => this.onMessage(raw));
    ws.on('close', () => {
      if (this.ws === ws) {
        this.ws = null;
        this.connected = false;
        this.connectedSince = null;
        this.rejectAll('game_disconnected');
      }
    });
    ws.on('error', () => {
      /* close follows */
    });
  }

  private onMessage(raw: WebSocket.RawData): void {
    this.lastMessageAt = Date.now();
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const t = msg.t;
    if (t === 'hello') {
      if (msg.proto !== PROTOCOL_VERSION) {
        void this.send({
          t: 'error',
          reason: 'protocol_mismatch',
          expected: PROTOCOL_VERSION,
          got: msg.proto,
        });
      }
      this.connected = true;
      this.gameInfo = (msg.game as GameInfo) || {};
      return;
    }
    if (t === 'state') {
      this.state = (msg.state as GameState) || null;
      return;
    }
    if (t === 'reply') {
      const id = Number(msg.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      const result = msg.result as Envelope;
      pending.resolve({
        ...result,
        state: result?.state ?? this.state,
      });
      if (result?.state) this.state = result.state;
      return;
    }
  }

  private rejectAll(reason: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve(errorEnvelope('*', reason, this.state));
    }
    this.pending.clear();
  }

  private send(obj: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  call(action: string, args: Record<string, unknown>): Promise<Envelope> {
    if (!this.connected || !this.ws) {
      return Promise.resolve(errorEnvelope(action, 'game_not_connected', this.state));
    }
    const id = this.nextId++;
    const timeoutMs = timeoutFor(action, args);
    return new Promise<Envelope>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(errorEnvelope(action, 'timeout', this.state));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, timer });
      const sent = this.send({ t: 'cmd', id, action, args });
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(errorEnvelope(action, 'send_failed', this.state));
      }
    });
  }

  ping(): boolean {
    return this.send({ t: 'ping', ts: Date.now() });
  }

  summary(): Record<string, unknown> {
    return {
      connected: this.connected,
      connected_since: this.connectedSince,
      game: this.gameInfo,
      state: this.state,
    };
  }
}

interface NoteEntry {
  value: unknown;
  updatedAt: string;
}

interface NotesFile {
  games: Record<string, Record<string, NoteEntry>>;
}

export class NotesStore {
  private cache: NotesFile | null = null;

  private load(): NotesFile {
    if (this.cache) return this.cache;
    try {
      const raw = fs.readFileSync(NOTES_FILE, 'utf8');
      const parsed = JSON.parse(raw) as NotesFile;
      this.cache = parsed && typeof parsed === 'object' && parsed.games ? parsed : { games: {} };
    } catch {
      this.cache = { games: {} };
    }
    return this.cache;
  }

  private save(): void {
    ensureBridgeDir();
    fs.writeFileSync(NOTES_FILE, JSON.stringify(this.load(), null, 2), 'utf8');
  }

  private bucket(game: string): Record<string, NoteEntry> {
    const data = this.load();
    if (!data.games[game]) data.games[game] = {};
    return data.games[game];
  }

  set(game: string, key: string, value: unknown): NoteEntry {
    const bucket = this.bucket(game);
    const entry = { value, updatedAt: new Date().toISOString() };
    bucket[key] = entry;
    this.save();
    return entry;
  }

  get(game: string, key: string): NoteEntry | null {
    return this.bucket(game)[key] ?? null;
  }

  list(game: string): Record<string, NoteEntry> {
    return this.bucket(game);
  }

  delete(game: string, key: string): boolean {
    const bucket = this.bucket(game);
    const existed = Object.prototype.hasOwnProperty.call(bucket, key);
    delete bucket[key];
    this.save();
    return existed;
  }
}

export class BridgeCore {
  readonly session = new GameSession();
  readonly notes = new NotesStore();
  private busy = false;
  private currentAction: string | null = null;

  private gameKey(): string {
    const title = this.session.gameInfo?.title;
    return title && title.trim() ? title.trim() : 'unnamed-game';
  }

  // The objective note is echoed on every observe so the agent keeps a task
  // in view instead of reacting only to whatever is on screen.
  private attachObjective(env: Envelope): void {
    if (!env.effect || typeof env.effect !== 'object') return;
    const entry = this.notes.get(this.gameKey(), 'objective');
    (env.effect as Record<string, unknown>).objective = entry ? entry.value : null;
  }

  async run(action: string, args: Record<string, unknown>): Promise<Envelope> {
    if (action === 'note') return this.note(args);

    if (READ_ONLY.has(action)) {
      const env = await this.session.call(action, args);
      if (action === 'observe') this.attachObjective(env);
      return env;
    }

    if (this.busy) {
      const env = errorEnvelope(action, 'busy', this.session.state);
      env.effect = {
        active_action: this.currentAction,
        hint: 'Another action is still running; wait for its reply before retrying.',
      };
      return env;
    }
    this.busy = true;
    this.currentAction = action;
    try {
      return await this.session.call(action, args);
    } finally {
      this.busy = false;
      this.currentAction = null;
    }
  }

  private note(args: Record<string, unknown>): Envelope {
    const game = this.gameKey();
    const op = String(args.action || 'get');
    const key = args.key === undefined || args.key === null ? '' : String(args.key);
    const base = {
      ok: true,
      status: 'done' as const,
      action: 'note',
      interrupted_by: null,
      reason: null,
      tick: this.session.state?.tick ?? 0,
      state: this.session.state,
      new_log: [],
      warnings: [],
    };

    if (op === 'set') {
      if (!key) return errorEnvelope('note', 'missing_key', this.session.state);
      // `text` is accepted as an alias so the natural call works too.
      const value = args.value !== undefined ? args.value : args.text;
      const entry = this.notes.set(game, key, value);
      return { ...base, effect: { game, key, entry } };
    }
    if (op === 'get') {
      if (!key) return errorEnvelope('note', 'missing_key', this.session.state);
      return { ...base, effect: { game, key, entry: this.notes.get(game, key) } };
    }
    if (op === 'list') {
      return { ...base, effect: { game, notes: this.notes.list(game) } };
    }
    if (op === 'delete') {
      if (!key) return errorEnvelope('note', 'missing_key', this.session.state);
      return { ...base, effect: { game, key, deleted: this.notes.delete(game, key) } };
    }
    return errorEnvelope('note', 'invalid_action', this.session.state);
  }
}
