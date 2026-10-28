import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findProject, getOrCreateToken, PluginEntry, ProjectLayout, readPlugins, writePlugins } from './files.js';
import { PLUGIN_NAME } from './constants.js';

function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
}

export function pluginSource(): string {
  const local = path.join(packageRoot(), 'plugin', 'MV_AI_Bridge.js');
  if (fs.existsSync(local)) return local;
  throw new Error(`plugin source not found at ${local}`);
}

export interface InstallResult {
  layout: ProjectLayout;
  pluginPath: string;
  backupPath: string | null;
  entry: PluginEntry;
}

export function installPlugin(gameDir: string, port: number, debug = false): InstallResult {
  const layout = findProject(gameDir);
  if (!layout) {
    throw new Error(
      `Could not find www/js/plugins.js under ${gameDir}. Pass the game folder that contains Game.exe and www/.`,
    );
  }
  fs.mkdirSync(layout.pluginsDir, { recursive: true });
  const dest = path.join(layout.pluginsDir, `${PLUGIN_NAME}.js`);
  fs.copyFileSync(pluginSource(), dest);

  const entries = readPlugins(layout.pluginsJs);
  const filtered = entries.filter((e) => e && e.name !== PLUGIN_NAME);
  const entry: PluginEntry = {
    name: PLUGIN_NAME,
    status: true,
    description: 'AI bridge (mv-ai-bridge): structured state and player input over a local WebSocket.',
    parameters: {
      Host: '127.0.0.1',
      Port: String(port),
      // Written because the game and the bridge can run on different sides of
      // WSL, where the plugin's HOME is not the bridge's HOME. A token stored
      // here still works when the files cannot see each other.
      Token: getOrCreateToken(),
      Debug: debug ? 'true' : 'false',
      FreezeWhileThinking: 'false',
    },
  };
  filtered.push(entry);

  const backup = `${layout.pluginsJs}.mv-ai-bridge.bak`;
  let backupPath: string | null = null;
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(layout.pluginsJs, backup);
    backupPath = backup;
  }

  writePlugins(layout.pluginsJs, filtered);
  return { layout, pluginPath: dest, backupPath, entry };
}

export function manualSnippet(port: number): string {
  return JSON.stringify(
    {
      name: PLUGIN_NAME,
      status: true,
      description: 'AI bridge (mv-ai-bridge).',
      parameters: {
        Host: '127.0.0.1',
        Port: String(port),
        Token: getOrCreateToken(),
        Debug: 'false',
        FreezeWhileThinking: 'false',
      },
    },
    null,
    2,
  );
}
