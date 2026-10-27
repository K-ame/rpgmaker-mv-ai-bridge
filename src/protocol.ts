export const PROTOCOL_VERSION = 1;

export type Status = 'done' | 'partial' | 'interrupted' | 'error';

export interface GameState {
  tick: number;
  scene: string;
  settled: boolean;
  map: { id: number; name: string; width: number; height: number } | null;
  player: { x: number; y: number; direction: number; moving: boolean; transferring: boolean } | null;
  message: {
    active: boolean;
    text: string;
    waiting_for: 'ok' | 'choice' | 'number' | 'item';
    choices: string[] | null;
    index: number | null;
    speaker: string | null;
  } | null;
  choices: { visible: boolean; index: number | null; items: unknown[] } | null;
  battle: unknown;
  party: { gold: number; members: unknown[] } | null;
}

export interface LogItem {
  seq: number;
  tick: number;
  type: string;
  data: unknown;
}

export interface Envelope {
  ok: boolean;
  status: Status;
  action: string;
  effect: unknown;
  interrupted_by: string | null;
  reason: string | null;
  tick: number;
  state: GameState | null;
  new_log: LogItem[];
  warnings: string[];
}

export interface GameInfo {
  title?: string;
  rpgmaker?: string;
  version?: string;
}

export function errorEnvelope(action: string, reason: string, state: GameState | null = null): Envelope {
  return {
    ok: false,
    status: 'error',
    action,
    effect: null,
    interrupted_by: null,
    reason,
    tick: state?.tick ?? 0,
    state,
    new_log: [],
    warnings: [],
  };
}
