import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';

// Loads the real plugin file into a sandbox with just enough of the MV runtime
// stubbed to exercise the connection and checkpoint code. This is not a game:
// it checks the logic the plugin owns, not RPG Maker itself.

const PLUGIN = fs.readFileSync(new URL('../plugin/MV_AI_Bridge.js', import.meta.url), 'utf8');
const HOME = path.join('/home', 'tester', '.mv-ai-bridge');

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
  }
}
FakeWebSocket.instances = [];

class Scene_Map {}
class Scene_Battle {}
class Scene_Gameover {}

function loadPlugin({ params = {}, files = {}, env = {} } = {}) {
  FakeWebSocket.instances = [];
  const timers = [];
  const calls = [];
  const consoleLines = [];

  const fakeFs = {
    readFileSync(p) {
      if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
      const err = new Error(`ENOENT: ${p}`);
      err.code = 'ENOENT';
      throw err;
    },
  };

  const ctx = {
    console: {
      log: (...args) => consoleLines.push(args.join(' ')),
      error: (...args) => consoleLines.push(args.join(' ')),
    },
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
    performance: { now: () => Date.now() },
    process: { env, cwd: () => '/game' },
    require: (name) => {
      if (name === 'fs') return fakeFs;
      if (name === 'path') return path;
      if (name === 'os') return { homedir: () => path.join('/home', 'tester') };
      throw new Error(`unexpected require(${name})`);
    },
    PluginManager: { parameters: () => params },
    SceneManager: {
      _scene: null,
      updateMain() {},
      updateScene() {},
      isSceneChanging: () => false,
      goto(cls) {
        calls.push(`goto:${cls.name}`);
      },
    },
    Input: { _currentState: {} },
    WebSocket: FakeWebSocket,
    JsonEx: { stringify: JSON.stringify, parse: JSON.parse },
    DataManager: {
      makeSaveContents() {
        calls.push('makeSaveContents');
        return { map: 1 };
      },
      createGameObjects() {
        calls.push('createGameObjects');
      },
      extractSaveContents() {
        calls.push('extractSaveContents');
      },
    },
    Scene_Map,
    Scene_Battle,
    Scene_Gameover,
  };
  ctx.window = ctx;
  ctx.global = ctx;

  // A calm map by default; tests flip individual stubs.
  ctx.SceneManager._scene = new Scene_Map();
  ctx.$dataMap = {};
  ctx.$gameMap = { isEventRunning: () => false, mapId: () => 1 };
  ctx.$gamePlayer = { isTransferring: () => false, isMoving: () => false };
  ctx.$gameMessage = { isBusy: () => false };
  ctx.$gameSystem = {
    onBeforeSave() {
      calls.push('onBeforeSave');
    },
    onAfterLoad() {
      calls.push('onAfterLoad');
    },
  };

  vm.createContext(ctx);
  vm.runInContext(PLUGIN, ctx);

  const connect = () => {
    timers.shift()(); // the plugin schedules connect() on boot
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    ws.readyState = 1;
    ws.onopen();
    return ws;
  };

  let nextId = 1;
  const command = (ws, action, args = {}) => {
    const id = nextId++;
    ws.onmessage({ data: JSON.stringify({ t: 'cmd', id, action, args }) });
    const reply = ws.sent.find((m) => m.t === 'reply' && m.id === id);
    assert.ok(reply, `no reply to ${action}`);
    return reply.result;
  };

  return { ctx, calls, connect, command, consoleLines };
}

const sessionFile = path.join(HOME, 'session.json');
const tokenFile = path.join(HOME, 'token');

test('sends the token from the Token parameter', () => {
  const { connect } = loadPlugin({ params: { Token: 'from-param' }, files: { [tokenFile]: 'from-file\n' } });
  assert.equal(connect().url, 'ws://127.0.0.1:7321/game?token=from-param');
});

test('prefers the live token in session.json when the port matches', () => {
  const { connect } = loadPlugin({
    files: {
      [sessionFile]: JSON.stringify({ port: 7321, token: 'live-token' }),
      [tokenFile]: 'file-token\n',
    },
  });
  assert.equal(connect().url, 'ws://127.0.0.1:7321/game?token=live-token');
});

test('ignores session.json from a bridge on another port', () => {
  const { connect } = loadPlugin({
    files: {
      [sessionFile]: JSON.stringify({ port: 9999, token: 'other-bridge' }),
      [tokenFile]: 'file-token\n',
    },
  });
  assert.equal(connect().url, 'ws://127.0.0.1:7321/game?token=file-token');
});

test('honours MV_AI_BRIDGE_HOME', () => {
  const custom = path.resolve('/srv/bridge-home');
  const { connect } = loadPlugin({
    env: { MV_AI_BRIDGE_HOME: custom },
    files: { [path.join(custom, 'token')]: 'custom-token\n' },
  });
  assert.equal(connect().url, 'ws://127.0.0.1:7321/game?token=custom-token');
});

test('connects without a token when none can be found, and says so once', () => {
  const { connect, consoleLines } = loadPlugin({ params: { Debug: 'true' } });
  const ws = connect();
  assert.equal(ws.url, 'ws://127.0.0.1:7321/game');
  assert.ok(consoleLines.some((l) => l.includes('no bridge token found')));
});

test('never writes the token to the debug log', () => {
  const { connect, consoleLines } = loadPlugin({ params: { Debug: 'true', Token: 'super-secret' } });
  connect();
  assert.ok(consoleLines.some((l) => l.includes('connected')));
  assert.ok(consoleLines.every((l) => !l.includes('super-secret')));
});

test('checkpoint save snapshots a settled map', () => {
  const { connect, command, calls } = loadPlugin();
  const ws = connect();
  const reply = command(ws, 'checkpoint', { action: 'save', id: 'a' });
  assert.equal(reply.ok, true);
  assert.equal(reply.status, 'done');
  assert.deepEqual(calls, ['onBeforeSave', 'makeSaveContents']);
});

test('checkpoint save is refused while a message is showing', () => {
  const { ctx, connect, command, calls } = loadPlugin();
  const ws = connect();
  ctx.$gameMessage.isBusy = () => true;
  const reply = command(ws, 'checkpoint', { action: 'save' });
  assert.equal(reply.ok, false);
  assert.equal(reply.reason, 'not_settled');
  assert.equal(reply.effect.blocked_by, 'message');
  assert.ok(!calls.includes('makeSaveContents'));
});

test('checkpoint save is refused while an event is running or the player is moving', () => {
  const { ctx, connect, command } = loadPlugin();
  const ws = connect();

  ctx.$gameMap.isEventRunning = () => true;
  let reply = command(ws, 'checkpoint', { action: 'save' });
  assert.equal(reply.reason, 'not_settled');
  assert.equal(reply.effect.blocked_by, 'event');

  ctx.$gameMap.isEventRunning = () => false;
  ctx.$gamePlayer.isMoving = () => true;
  reply = command(ws, 'checkpoint', { action: 'save' });
  assert.equal(reply.reason, 'not_settled');
  assert.equal(reply.effect.blocked_by, 'moving');
});

test('checkpoint save is refused outside the map scene', () => {
  const { ctx, connect, command, calls } = loadPlugin();
  const ws = connect();
  ctx.SceneManager._scene = new Scene_Battle();
  const reply = command(ws, 'checkpoint', { action: 'save' });
  assert.equal(reply.ok, false);
  assert.equal(reply.reason, 'bad_scene');
  assert.equal(reply.effect.scene, 'battle');
  assert.ok(!calls.includes('makeSaveContents'));
});

test('checkpoint load rebuilds the game objects before restoring', () => {
  const { connect, command, calls } = loadPlugin();
  const ws = connect();
  command(ws, 'checkpoint', { action: 'save', id: 'a' });
  calls.length = 0;

  const reply = command(ws, 'checkpoint', { action: 'load', id: 'a' });
  assert.equal(reply.ok, true);
  assert.deepEqual(calls, ['createGameObjects', 'extractSaveContents', 'onAfterLoad', 'goto:Scene_Map']);
});

test('checkpoint load works from a non-map scene such as game over', () => {
  const { ctx, connect, command, calls } = loadPlugin();
  const ws = connect();
  command(ws, 'checkpoint', { action: 'save', id: 'a' });
  calls.length = 0;

  ctx.SceneManager._scene = new Scene_Gameover();
  const reply = command(ws, 'checkpoint', { action: 'load', id: 'a' });
  assert.equal(reply.ok, true);
  assert.ok(calls.includes('createGameObjects'));
  assert.ok(calls.includes('goto:Scene_Map'));
});

test('checkpoint load reports an unknown checkpoint without touching the game', () => {
  const { connect, command, calls } = loadPlugin();
  const ws = connect();
  const reply = command(ws, 'checkpoint', { action: 'load', id: 'nope' });
  assert.equal(reply.ok, false);
  assert.equal(reply.reason, 'checkpoint_not_found');
  assert.deepEqual(calls, []);
});
