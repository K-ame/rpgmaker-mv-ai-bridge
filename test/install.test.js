import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-ai-bridge-install-'));
process.env.MV_AI_BRIDGE_HOME = HOME;
const { installPlugin } = await import('../dist/cli/install.js');
const { readPlugins, writePlugins, TOKEN_FILE } = await import('../dist/cli/files.js');
const { doctor } = await import('../dist/cli/doctor.js');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GAMES = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-ai-bridge-games-'));

function makeGame(name) {
  const dir = path.join(GAMES, name);
  const js = path.join(dir, 'www', 'js');
  fs.mkdirSync(path.join(js, 'plugins'), { recursive: true });
  fs.writeFileSync(
    path.join(js, 'plugins.js'),
    'var $plugins =\n[\n{"name":"Other_Plugin","status":true,"parameters":{"X":"1"}}\n];\n',
  );
  return dir;
}

const pluginsJs = (game) => path.join(game, 'www', 'js', 'plugins.js');

after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(GAMES, { recursive: true, force: true });
});

test('install writes a plugin entry the game plugin can read', () => {
  const game = makeGame('basic');
  const before = fs.readFileSync(pluginsJs(game), 'utf8');
  const result = installPlugin(game, 7333);
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

  assert.ok(fs.existsSync(result.pluginPath));
  assert.equal(result.entry.parameters.Token, token);
  assert.ok(result.backupPath);
  assert.equal(fs.readFileSync(result.backupPath, 'utf8'), before);

  const entries = readPlugins(pluginsJs(game));
  assert.deepEqual(entries.map((e) => e.name), ['Other_Plugin', 'MV_AI_Bridge']);
  const bridge = entries[1];
  assert.equal(bridge.status, true);
  assert.equal(bridge.parameters.Port, '7333');
  assert.equal(bridge.parameters.Host, '127.0.0.1');
  assert.equal(bridge.parameters.Token, token);
});

test('installing twice keeps one entry, the original backup and the same token', () => {
  const game = makeGame('twice');
  const before = fs.readFileSync(pluginsJs(game), 'utf8');
  installPlugin(game, 7333);
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  const second = installPlugin(game, 7333);

  assert.equal(second.backupPath, null);
  assert.equal(fs.readFileSync(pluginsJs(game) + '.mv-ai-bridge.bak', 'utf8'), before);

  const entries = readPlugins(pluginsJs(game));
  assert.deepEqual(entries.map((e) => e.name), ['Other_Plugin', 'MV_AI_Bridge']);
  assert.equal(entries[1].parameters.Token, token);
});

test('a malformed plugins.js fails before anything is copied', () => {
  const game = makeGame('broken');
  fs.writeFileSync(pluginsJs(game), 'var $plugins = {};', 'utf8');
  assert.throws(() => installPlugin(game, 7333), /plugin array/);
  assert.ok(!fs.existsSync(path.join(game, 'www', 'js', 'plugins', 'MV_AI_Bridge.js')));
});

test('doctor reports a Token that does not match the bridge', async () => {
  const game = makeGame('doctor-mismatch');
  installPlugin(game, 7333);
  const entries = readPlugins(pluginsJs(game));
  entries[1].parameters.Token = 'a-different-token';
  writePlugins(pluginsJs(game), entries);

  const lines = await doctor(game);
  assert.ok(
    lines.some((l) => l.level === 'fail' && l.text.includes('Token does not match')),
    JSON.stringify(lines, null, 2),
  );
});

test('doctor confirms a matching Token and plugin version', async () => {
  const game = makeGame('doctor-ok');
  installPlugin(game, 7333);
  const lines = await doctor(game);
  assert.ok(lines.some((l) => l.level === 'ok' && l.text.includes('Token matches')));
  assert.ok(lines.some((l) => l.level === 'ok' && l.text.includes('Plugin version')));
});

const BUNDLE = path.join(ROOT, 'dist', 'bundle', 'mv-ai-bridge.cjs');

test('the bundled CLI installs from a release-style layout', { skip: !fs.existsSync(BUNDLE) }, () => {
  const release = fs.mkdtempSync(path.join(GAMES, 'release-'));
  fs.copyFileSync(BUNDLE, path.join(release, 'mv-ai-bridge.cjs'));
  fs.cpSync(path.join(ROOT, 'plugin'), path.join(release, 'plugin'), { recursive: true });
  const game = makeGame('bundle');
  const home = fs.mkdtempSync(path.join(GAMES, 'bundle-home-'));

  const result = spawnSync(process.execPath, [path.join(release, 'mv-ai-bridge.cjs'), 'install', game], {
    cwd: os.tmpdir(),
    env: { ...process.env, MV_AI_BRIDGE_HOME: home },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const entries = readPlugins(pluginsJs(game));
  assert.deepEqual(entries.map((e) => e.name), ['Other_Plugin', 'MV_AI_Bridge']);
  assert.equal(entries[1].parameters.Token, fs.readFileSync(path.join(home, 'token'), 'utf8').trim());
});
