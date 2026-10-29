import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const plugin = fs.readFileSync(path.join(ROOT, 'plugin', 'MV_AI_Bridge.js'), 'utf8');
const pluginVersion = plugin.match(/var VERSION = '([^']+)'/)?.[1];

const { VERSION, isLoopbackHost } = await import('../dist/cli/constants.js');
const { PROTOCOL_VERSION } = await import('../dist/protocol.js');

test('the package, CLI, plugin and lockfile agree on the version', () => {
  assert.equal(VERSION, pkg.version);
  assert.equal(pluginVersion, pkg.version);

  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
});

test('the protocol version is separate from the app version', () => {
  assert.equal(typeof PROTOCOL_VERSION, 'number');
  assert.notEqual(String(PROTOCOL_VERSION), pkg.version);
});

test('loopback hosts are recognised', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ['0.0.0.0', '192.168.1.20', '::', 'my-laptop.local']) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});
