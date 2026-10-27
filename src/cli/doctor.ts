import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DEFAULT_HOST, DEFAULT_PORT, PLUGIN_NAME } from './constants.js';
import { findProject, isProcessRunning, readPlugins, readSession, TOKEN_FILE } from './files.js';

export interface CheckLine {
  level: 'ok' | 'warn' | 'fail';
  text: string;
}

function portFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

export async function doctor(gameDir?: string): Promise<CheckLine[]> {
  const lines: CheckLine[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  lines.push({
    level: major >= 20 ? 'ok' : 'fail',
    text: `Node ${process.versions.node}${major >= 20 ? '' : ' (need >= 20)'}`,
  });

  const dir = gameDir ? path.resolve(gameDir) : process.cwd();
  const layout = findProject(dir);
  if (!layout) {
    lines.push({
      level: 'warn',
      text: `No www/js/plugins.js under ${dir}. Run from the game folder or pass one to \`mv-ai-bridge doctor <gameDir>\`.`,
    });
  } else {
    lines.push({ level: 'ok', text: `Game project: ${layout.wwwDir}` });
    const dest = path.join(layout.pluginsDir, `${PLUGIN_NAME}.js`);
    lines.push({
      level: fs.existsSync(dest) ? 'ok' : 'fail',
      text: fs.existsSync(dest)
        ? `Plugin file installed: ${dest}`
        : `Plugin file missing: ${dest} (run \`mv-ai-bridge install "${dir}"\`)`,
    });
    try {
      const entries = readPlugins(layout.pluginsJs);
      const index = entries.findIndex((e) => e && e.name === PLUGIN_NAME);
      if (index < 0) {
        lines.push({ level: 'fail', text: `${PLUGIN_NAME} is not listed in plugins.js` });
      } else {
        const entry = entries[index];
        lines.push({
          level: entry.status === false ? 'warn' : 'ok',
          text: `plugins.js entry at position ${index + 1}/${entries.length}, status=${entry.status === false ? 'off' : 'on'}`,
        });
        if (index !== entries.length - 1) {
          lines.push({
            level: 'warn',
            text: `${PLUGIN_NAME} is not the last plugin. It still works, but loading last is the tested arrangement.`,
          });
        }
      }
    } catch (err) {
      lines.push({ level: 'fail', text: `Cannot parse plugins.js: ${(err as Error).message}` });
    }
    const backup = layout.pluginsJs + '.mv-ai-bridge.bak';
    lines.push({
      level: fs.existsSync(backup) ? 'ok' : 'warn',
      text: `plugins.js backup: ${fs.existsSync(backup) ? backup : 'missing'}`,
    });
  }

  lines.push({
    level: fs.existsSync(TOKEN_FILE) ? 'ok' : 'warn',
    text: fs.existsSync(TOKEN_FILE) ? `Token file: ${TOKEN_FILE}` : 'Token file not created yet (it appears on first `serve`)',
  });

  const session = readSession();
  if (!session) {
    const busy = !(await portFree(DEFAULT_HOST, DEFAULT_PORT));
    lines.push({
      level: busy ? 'warn' : 'ok',
      text: busy
        ? `Default port ${DEFAULT_PORT} is already in use`
        : `Default port ${DEFAULT_PORT} is free (no bridge running)`,
    });
  } else if (!isProcessRunning(session.pid)) {
    lines.push({ level: 'warn', text: `Stale session file: pid ${session.pid} is not running` });
  } else {
    lines.push({ level: 'ok', text: `Bridge running: pid ${session.pid}, ${session.url}` });
    const free = await portFree(session.host, session.port);
    if (free) {
      lines.push({
        level: 'warn',
        text: `Session file says ${session.host}:${session.port}, but nothing is listening there`,
      });
    }
  }

  return lines;
}
