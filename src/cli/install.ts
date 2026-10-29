import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findProject, getOrCreateToken, PluginEntry, ProjectLayout, readPlugins, writePlugins } from './files.js';
import { PLUGIN_NAME } from './constants.js';

function scriptDir(): string | null {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    // The single-file CJS bundle has no import.meta.url.
    return null;
  }
}

// The plugin ships next to dist/ in the package, and next to the bundle in the
// release zip, so look in every layout instead of assuming one.
export function pluginSource(): string {
  const here = scriptDir();
  const dirs = [
    here ? path.resolve(here, '..', '..') : null,
    path.dirname(process.argv[1] || ''),
    process.cwd(),
    path.dirname(process.execPath),
  ].filter((dir): dir is string => !!dir);
  const tried: string[] = [];
  for (const dir of dirs) {
    const candidate = path.join(dir, 'plugin', 'MV_AI_Bridge.js');
    if (tried.includes(candidate)) continue;
    tried.push(candidate);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`plugin source not found; looked in:\n  ${tried.join('\n  ')}`);
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
  // Validate plugins.js before touching the game directory, so a malformed
  // list does not leave a copied plugin behind without a registration.
  const entries = readPlugins(layout.pluginsJs);
  fs.mkdirSync(layout.pluginsDir, { recursive: true });
  const dest = path.join(layout.pluginsDir, `${PLUGIN_NAME}.js`);
  fs.copyFileSync(pluginSource(), dest);

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
