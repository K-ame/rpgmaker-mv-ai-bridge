import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BRIDGE_DIR, ensureBridgeDir } from '../core.js';

export const TOKEN_FILE = path.join(BRIDGE_DIR, 'token');
export const SESSION_FILE = path.join(BRIDGE_DIR, 'session.json');

export interface SessionInfo {
  pid: number;
  host: string;
  port: number;
  token: string;
  url: string;
  startedAt: string;
  version: string;
}

export function getOrCreateToken(): string {
  ensureBridgeDir();
  try {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* create below */
  }
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_FILE, token + '\n', { encoding: 'utf8', mode: 0o600 });
  return token;
}

export function writeSession(info: SessionInfo): void {
  ensureBridgeDir();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(info, null, 2) + '\n', 'utf8');
}

export function readSession(): SessionInfo | null {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) as SessionInfo;
  } catch {
    return null;
  }
}

export function removeSession(pid: number): void {
  const current = readSession();
  if (current && current.pid === pid) {
    try {
      fs.unlinkSync(SESSION_FILE);
    } catch {
      /* ignore */
    }
  }
}

export function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface ProjectLayout {
  gameDir: string;
  wwwDir: string;
  pluginsJs: string;
  pluginsDir: string;
}

export function findProject(gameDir: string): ProjectLayout | null {
  const candidates = [path.join(gameDir, 'www'), gameDir];
  for (const wwwDir of candidates) {
    const pluginsJs = path.join(wwwDir, 'js', 'plugins.js');
    if (fs.existsSync(pluginsJs)) {
      return {
        gameDir,
        wwwDir,
        pluginsJs,
        pluginsDir: path.join(wwwDir, 'js', 'plugins'),
      };
    }
  }
  return null;
}

export interface PluginEntry {
  name: string;
  status: boolean;
  description?: string;
  parameters?: Record<string, string>;
}

export function readPlugins(pluginsJs: string): PluginEntry[] {
  let text = fs.readFileSync(pluginsJs, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('plugins.js does not contain a plugin array');
  const json = text.slice(start, end + 1);
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('plugins.js plugin list is not an array');
  return parsed as PluginEntry[];
}

export function writePlugins(pluginsJs: string, entries: PluginEntry[]): void {
  const body = entries.map((entry) => JSON.stringify(entry)).join(',\n');
  fs.writeFileSync(pluginsJs, `var $plugins =\n[\n${body}\n];\n`, 'utf8');
}
