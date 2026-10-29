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

const READ_ONLY = new Set(['observe', 'look', 'list_events', 'log', 'game_data']);

// A plugin that never sends hello is not usable, even though the socket is up.
const HANDSHAKE_TIMEOUT_MS = 5000;
const NOTES_SCHEMA = 1;
const LATE_RESULT_MAX = 8;

export const BRIDGE_DIR = process.env.MV_AI_BRIDGE_HOME
  ? path.resolve(process.env.MV_AI_BRIDGE_HOME)
  : path.join(os.homedir(), '.mv-ai-bridge');
const NOTES_FILE = path.join(BRIDGE_DIR, 'notes.json');
const NOTES_BACKUP = `${NOTES_FILE}.bak`;

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
  action: string;
}

export type ConnectionState = 'disconnected' | 'handshaking' | 'ready' | 'incompatible';

interface ConnectionRejection {
  reason: string;
  expected?: number;
  got?: unknown;
  at: string;
}

interface LateResult {
  action_id: number;
  action: string | null;
  status: string | null;
  reason: string | null;
  at: string;
  reported: boolean;
}

export class GameSession {
  private ws: WebSocket | null = null;
  private pending = new Map<number, PendingCall>();
  private nextId = 1;
  private handshakeTimer: NodeJS.Timeout | null = null;
  private lateResults: LateResult[] = [];

  connection: ConnectionState = 'disconnected';
  state: GameState | null = null;
  gameInfo: GameInfo = {};
  lastMessageAt = 0;
  connectedSince: number | null = null;
  protocolGot: number | null = null;
  pluginVersion: string | null = null;
  rejection: ConnectionRejection | null = null;
  // Several Game.exe windows attach to the same /game route and silently
  // replace each other, which looks like random state jumps. Count it so
  // /health can point at the cause.
  replacedConnections = 0;

  // Only a validated hello makes the connection usable. A bare TCP/WebSocket
  // open is transport state, not readiness.
  get connected(): boolean {
    return this.connection === 'ready';
  }

  attach(ws: WebSocket): void {
    if (this.ws && this.ws !== ws) {
      this.replacedConnections += 1;
      try {
        this.ws.close(1000, 'replaced by a newer game connection');
      } catch {
        /* ignore */
      }
    }
    this.rejectAll('game_reconnected');
    this.resetHandshake();
    this.ws = ws;
    this.connection = 'handshaking';
    this.connectedSince = Date.now();
    this.lastMessageAt = Date.now();
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (this.connection !== 'handshaking') return;
      this.connection = 'incompatible';
      this.rejection = { reason: 'hello_timeout', expected: PROTOCOL_VERSION, at: new Date().toISOString() };
      try {
        ws.close(4001, 'hello timeout');
      } catch {
        /* ignore */
      }
    }, HANDSHAKE_TIMEOUT_MS);
    this.handshakeTimer.unref?.();

    ws.on('message', (raw) => this.onMessage(raw));
    ws.on('close', () => {
      if (this.ws === ws) {
        this.ws = null;
        this.resetHandshake();
        this.rejectAll('game_disconnected');
      }
    });
    ws.on('error', () => {
      /* close follows */
    });
  }

  // Drops everything that belongs to the previous connection. `rejection` is
  // kept so /health can explain why the last handshake failed.
  private resetHandshake(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    this.connection = 'disconnected';
    this.state = null;
    this.gameInfo = {};
    this.connectedSince = null;
    this.protocolGot = null;
    this.pluginVersion = null;
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
      this.onHello(msg);
      return;
    }
    if (t === 'state') {
      // State from a socket that has not completed a valid hello is not this
      // bridge's game; accepting it would mix two connections.
      if (this.connection === 'ready') this.state = (msg.state as GameState) || null;
      return;
    }
    if (t === 'reply') {
      const id = Number(msg.id);
      const result = msg.result as Envelope;
      const pending = this.pending.get(id);
      if (!pending) {
        this.noteLate(id, result);
        return;
      }
      this.pending.delete(id);
      clearTimeout(pending.timer);
      const env: Envelope = {
        ...result,
        action_id: id,
        state: result?.state ?? this.state,
      };
      pending.resolve(env);
      if (result?.state) this.state = result.state;
      return;
    }
  }

  private onHello(msg: Record<string, unknown>): void {
    if (msg.proto !== PROTOCOL_VERSION) {
      if (this.handshakeTimer) {
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
      }
      this.connection = 'incompatible';
      this.protocolGot = typeof msg.proto === 'number' ? msg.proto : null;
      this.rejection = {
        reason: 'protocol_mismatch',
        expected: PROTOCOL_VERSION,
        got: msg.proto ?? null,
        at: new Date().toISOString(),
      };
      void this.send({
        t: 'error',
        reason: 'protocol_mismatch',
        expected: PROTOCOL_VERSION,
        got: msg.proto,
      });
      // Keep the socket open but unusable. Closing it would make the plugin
      // reconnect every few seconds and flood both logs.
      return;
    }
    const game = msg.game;
    if (game !== undefined && game !== null && (typeof game !== 'object' || Array.isArray(game))) {
      if (this.handshakeTimer) {
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
      }
      this.connection = 'incompatible';
      this.rejection = { reason: 'bad_hello', expected: PROTOCOL_VERSION, got: typeof game, at: new Date().toISOString() };
      return;
    }
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    this.connection = 'ready';
    this.protocolGot = PROTOCOL_VERSION;
    this.pluginVersion = typeof msg.plugin === 'string' ? msg.plugin : null;
    this.gameInfo = (game as GameInfo) || {};
    if (this.connectedSince === null) this.connectedSince = Date.now();
    this.rejection = null;
  }

  private noteLate(id: number, result: Envelope | undefined): void {
    if (!Number.isFinite(id)) return;
    this.lateResults.push({
      action_id: id,
      action: typeof result?.action === 'string' ? result.action : null,
      status: typeof result?.status === 'string' ? result.status : null,
      reason: typeof result?.reason === 'string' ? result.reason : null,
      at: new Date().toISOString(),
      reported: false,
    });
    if (this.lateResults.length > LATE_RESULT_MAX) this.lateResults.shift();
  }

  // Late replies are surfaced once, on the next envelope, so the agent learns
  // that an action it had given up on actually finished.
  takeLateWarnings(): string[] {
    const out: string[] = [];
    for (const entry of this.lateResults) {
      if (entry.reported) continue;
      entry.reported = true;
      const action = entry.action ? ` (${entry.action})` : '';
      const reason = entry.reason ? `, reason ${entry.reason}` : '';
      out.push(
        `action ${entry.action_id}${action} finished after the bridge stopped waiting: status ${entry.status ?? 'unknown'}${reason}. Re-observe before retrying.`,
      );
    }
    return out;
  }

  private rejectAll(reason: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      const env = errorEnvelope(pending.action, reason, this.state);
      env.effect = { connection: this.connectionSummary() };
      pending.resolve(env);
    }
    this.pending.clear();
  }

  connectionSummary(): Record<string, unknown> {
    return {
      state: this.connection,
      protocol: {
        bridge: PROTOCOL_VERSION,
        game: this.protocolGot,
        plugin_version: this.pluginVersion,
      },
      connected_since: this.connectedSince,
      rejection: this.rejection,
      replaced_connections: this.replacedConnections,
    };
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
    if (this.connection !== 'ready' || !this.ws) {
      const env = errorEnvelope(
        action,
        this.connection === 'disconnected' ? 'game_not_connected' : 'game_not_ready',
        this.state,
      );
      env.effect = {
        connection: this.connectionSummary(),
        hint:
          this.connection === 'disconnected'
            ? 'Start the game (or let its plugin reconnect) and observe again.'
            : 'The socket is open but the handshake has not completed. Check the plugin version and the bridge log.',
      };
      return Promise.resolve(env);
    }
    const id = this.nextId++;
    const timeoutMs = timeoutFor(action, args);
    return new Promise<Envelope>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const env = errorEnvelope(action, 'timeout', this.state);
        // A bridge timeout says nothing about the game: the plugin keeps its
        // own job running and may still finish the action.
        env.action_id = id;
        env.effect = {
          action_id: id,
          outcome: 'unknown',
          retry_safe: READ_ONLY.has(action),
          hint: READ_ONLY.has(action)
            ? 'The bridge stopped waiting; observe again before repeating the call.'
            : 'The game may still carry out this action. Observe the state before retrying; do not repeat it blindly.',
        };
        resolve(env);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, timer, action });
      const sent = this.send({ t: 'cmd', id, action, args });
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(id);
        const env = errorEnvelope(action, 'send_failed', this.state);
        env.action_id = id;
        resolve(env);
      }
    });
  }

  ping(): boolean {
    return this.send({ t: 'ping', ts: Date.now() });
  }

  summary(): Record<string, unknown> {
    return {
      connected: this.connected,
      connection: this.connectionSummary(),
      game: this.gameInfo,
      state: this.state,
      late_results: this.lateResults.map(({ reported: _reported, ...rest }) => rest),
    };
  }
}

interface NoteEntry {
  value: unknown;
  updatedAt: string;
}

interface NotesFile {
  schema: number;
  games: Record<string, Record<string, NoteEntry>>;
}

export interface NotesStatus {
  file: string;
  schema: number;
  status: 'empty' | 'ok' | 'migrated' | 'recovered_backup' | 'recovered_empty';
  corrupt_copy: string | null;
  warnings: string[];
}

function isNotesFile(value: unknown): value is { schema?: unknown; games: Record<string, unknown> } {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !!((value as { games?: unknown }).games) &&
    typeof (value as { games: unknown }).games === 'object'
  );
}

export class NotesStore {
  private cache: NotesFile | null = null;
  private diagnostics: NotesStatus = {
    file: NOTES_FILE,
    schema: NOTES_SCHEMA,
    status: 'empty',
    corrupt_copy: null,
    warnings: [],
  };

  private fresh(status: NotesStatus['status'] = 'empty'): NotesFile {
    this.diagnostics = { ...this.diagnostics, status };
    return { schema: NOTES_SCHEMA, games: {} };
  }

  private readBackup(): NotesFile | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(NOTES_BACKUP, 'utf8'));
      if (!isNotesFile(parsed)) return null;
      return { schema: NOTES_SCHEMA, games: parsed.games as NotesFile['games'] };
    } catch {
      return null;
    }
  }

  // A broken notes file is kept, not overwritten: it may be the only copy of
  // a long session's findings. The last known-good backup is tried next.
  private recoverFromCorrupt(reason: string): NotesFile {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const copy = `${NOTES_FILE}.corrupt-${stamp}`;
    let kept = false;
    try {
      fs.renameSync(NOTES_FILE, copy);
      kept = true;
    } catch {
      try {
        fs.copyFileSync(NOTES_FILE, copy);
        kept = true;
      } catch {
        /* leave the original in place */
      }
    }
    this.diagnostics.corrupt_copy = kept ? copy : null;
    this.diagnostics.warnings.push(
      `${NOTES_FILE} could not be read (${reason})${kept ? `; kept a copy at ${copy}` : ''}.`,
    );
    const backup = this.readBackup();
    if (backup) {
      this.diagnostics.status = 'recovered_backup';
      this.diagnostics.warnings.push(`Notes restored from ${NOTES_BACKUP}.`);
      return backup;
    }
    this.diagnostics.warnings.push('No usable notes backup; starting from an empty store. The next write replaces the file.');
    return this.fresh('recovered_empty');
  }

  private load(): NotesFile {
    if (this.cache) return this.cache;
    let raw: string;
    try {
      raw = fs.readFileSync(NOTES_FILE, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = this.fresh('empty');
      } else {
        this.cache = this.recoverFromCorrupt((err as Error).message);
      }
      return this.cache;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.cache = this.recoverFromCorrupt((err as Error).message);
      return this.cache;
    }
    if (!isNotesFile(parsed)) {
      this.cache = this.recoverFromCorrupt('unexpected structure');
      return this.cache;
    }
    if (parsed.schema !== NOTES_SCHEMA) {
      this.diagnostics.status = 'migrated';
      this.diagnostics.warnings.push(`Notes migrated from schema ${String(parsed.schema ?? 'legacy')} to ${NOTES_SCHEMA}.`);
    } else {
      this.diagnostics.status = 'ok';
    }
    this.cache = { schema: NOTES_SCHEMA, games: parsed.games as NotesFile['games'] };
    return this.cache;
  }

  // Atomic replace: the old file stays readable until the new one is fully on
  // disk. The pre-write copy becomes the recovery point for the next load.
  private save(): void {
    ensureBridgeDir();
    const json = JSON.stringify(this.load(), null, 2) + '\n';
    const tmp = `${NOTES_FILE}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, json, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.copyFileSync(NOTES_FILE, NOTES_BACKUP);
    } catch {
      /* first write, or no readable previous file */
    }
    try {
      fs.renameSync(tmp, NOTES_FILE);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  status(): NotesStatus {
    this.load();
    return {
      ...this.diagnostics,
      warnings: this.diagnostics.warnings.slice(),
    };
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

  private withLateWarnings(env: Envelope): Envelope {
    const late = this.session.takeLateWarnings();
    if (late.length) env.warnings = (env.warnings || []).concat(late);
    return env;
  }

  async run(action: string, args: Record<string, unknown>): Promise<Envelope> {
    if (action === 'note') return this.note(args);

    if (READ_ONLY.has(action)) {
      const env = await this.session.call(action, args);
      if (action === 'observe') this.attachObjective(env);
      return this.withLateWarnings(env);
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
      return this.withLateWarnings(await this.session.call(action, args));
    } finally {
      this.busy = false;
      this.currentAction = null;
    }
  }

  private note(args: Record<string, unknown>): Envelope {
    const game = this.gameKey();
    const op = String(args.action || 'get');
    const key = args.key === undefined || args.key === null ? '' : String(args.key);
    const status = this.notes.status();
    const base = {
      ok: true,
      status: 'done' as const,
      action: 'note',
      action_id: null,
      interrupted_by: null,
      reason: null,
      tick: this.session.state?.tick ?? 0,
      state: this.session.state,
      new_log: [],
      // Storage problems are reported once here instead of hidden behind an
      // empty list, so a recovered or unreadable file never looks like "no notes".
      warnings: status.warnings.slice(),
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
