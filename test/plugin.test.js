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

  // A calm 20x20 map by default; tests flip individual stubs.
  const W = 20;
  ctx.SceneManager._scene = new Scene_Map();
  ctx.$dataMap = {};
  ctx.$dataMapInfos = {};
  ctx.$gameMap = {
    isEventRunning: () => false,
    mapId: () => 1,
    width: () => W,
    height: () => W,
    events: () => [],
    event: () => null,
    eventsXy: () => [],
    _interpreter: null,
    isValid: (x, y) => x >= 0 && y >= 0 && x < W && y < W,
    roundXWithDirection: (x, d) => x + (d === 6 ? 1 : d === 4 ? -1 : 0),
    roundYWithDirection: (y, d) => y + (d === 2 ? 1 : d === 8 ? -1 : 0),
  };
  ctx.$gamePlayer = {
    x: 0,
    y: 0,
    isTransferring: () => false,
    isMoving: () => false,
    direction: () => 2,
    canPass: () => true,
  };
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

test('state.nearby lists the closest events with a kind', () => {
  const { ctx, connect, command, consoleLines } = loadPlugin({ params: { Debug: 'true' } });
  const ws = connect();
  const page = (trigger, codes) => ({ trigger, list: codes.map((code) => ({ code })) });
  const ev = (id, name, x, y, pages) => ({
    _erased: false,
    _pageIndex: 0,
    x,
    y,
    eventId: () => id,
    event: () => ({ name, pages }),
    list: () => pages[0].list,
  });
  ctx.$gamePlayer.x = 5;
  ctx.$gamePlayer.y = 5;
  ctx.$gameMap.events = () => [
    ev(1, 'Bed', 5, 6, [page(0, [0])]),
    ev(2, 'Robert', 7, 5, [page(0, [101, 0])]),
    ev(3, 'Stairs', 5, 2, [page(0, [201, 0])]),
    ev(4, 'Clerk', 9, 5, [page(0, [302, 0])]),
    ev(5, 'Floor trigger', 4, 5, [page(1, [101, 0])]),
    ev(6, 'Far away', 19, 19, [page(0, [0])]),
  ];

  const reply = command(ws, 'state');
  assert.ok(reply.effect, consoleLines.join('\n'));
  const nearby = reply.effect.nearby;
  assert.equal(nearby.length, 5);
  assert.deepEqual(nearby.map((n) => n.event_id), [1, 5, 2, 3, 4]);
  const kinds = Object.fromEntries(nearby.map((n) => [n.event_id, n.kind]));
  assert.deepEqual(kinds, { 1: 'action', 5: 'touch', 2: 'action', 3: 'transfer', 4: 'shop' });
});

test('go_to dry_run returns the route without moving the player', () => {
  const { ctx, connect, command } = loadPlugin();
  const ws = connect();
  ctx.$gamePlayer.x = 1;
  ctx.$gamePlayer.y = 1;

  const reply = command(ws, 'go_to', { x: 4, y: 1, dry_run: true });
  assert.equal(reply.ok, true);
  assert.equal(reply.status, 'done');
  assert.equal(reply.effect.dry_run, true);
  assert.deepEqual(reply.effect.path, [6, 6, 6]);
  assert.equal(reply.effect.path_length, 3);
  assert.equal(ctx.$gamePlayer.x, 1);
  assert.equal(ctx.$gamePlayer.y, 1);
});

test('go_to blames an open choice window instead of an unreachable wall', () => {
  const { ctx, connect, command } = loadPlugin();
  const ws = connect();
  ctx.$gameMessage = { isBusy: () => true };
  ctx.SceneManager._scene._messageWindow = {
    _choiceWindow: {
      active: true,
      _list: [{ name: 'はい' }],
      isOpen: () => true,
      index: () => 0,
    },
  };

  const reply = command(ws, 'go_to', { x: 2, y: 1 });
  assert.equal(reply.ok, false);
  assert.equal(reply.reason, 'busy');
  assert.equal(reply.effect.blocked_by, 'choice');
});

test('walk refuses to start while a message owns the screen', () => {
  const { ctx, connect, command } = loadPlugin();
  const ws = connect();
  ctx.$gameMessage = { isBusy: () => true };

  const reply = command(ws, 'walk', { direction: 'down', steps: 1 });
  assert.equal(reply.ok, false);
  assert.equal(reply.reason, 'busy');
  assert.equal(reply.effect.blocked_by, 'message');
  assert.equal(ctx.$gamePlayer.y, 0);
});

test('state.ui exposes a custom map overlay window with its cursor', () => {
  const { ctx, connect, command } = loadPlugin();
  const ws = connect();
  const win = {
    constructor: { name: 'Window_DestinationList' },
    visible: true,
    active: true,
    isOpen: () => true,
    index: () => 1,
    maxCols: () => 1,
    maxItems: () => 3,
    _list: [{ name: '帝国マルドニア' }, { name: 'マルドニア北街道' }],
  };
  ctx.SceneManager._scene._windowLayer = { children: [win] };

  const reply = command(ws, 'state');
  assert.equal(reply.effect.ui.scene, 'map');
  const listed = reply.effect.ui.windows.find((w) => w.name === 'Window_DestinationList');
  assert.ok(listed);
  assert.equal(listed.index, 1);
  assert.equal(listed.selected, 'マルドニア北街道');
  assert.deepEqual(listed.items.map((i) => i.name), ['帝国マルドニア', 'マルドニア北街道']);
});

test('log records a same-map jump as transfer_by_event', () => {
  const { ctx, connect, command } = loadPlugin();
  const ws = connect();
  ctx.$gamePlayer.x = 1;
  ctx.$gamePlayer.y = 1;
  for (let i = 0; i < 5; i++) ctx.SceneManager.updateMain();

  ctx.$gamePlayer.x = 6;
  ctx.$gamePlayer.y = 2;
  for (let i = 0; i < 5; i++) ctx.SceneManager.updateMain();

  const reply = command(ws, 'log', { since: 0 });
  const jump = reply.effect.items.find((it) => it.type === 'transfer_by_event');
  assert.ok(jump, JSON.stringify(reply.effect.items));
  assert.deepEqual(jump.data.from, { x: 1, y: 1 });
  assert.deepEqual(jump.data.to, { x: 6, y: 2 });
});

function showMessage(ctx, text, extra = {}) {
  ctx.$gameMessage = { isBusy: () => true, _texts: [text], _choices: [], ...extra };
  ctx.$gameMap._interpreter = {
    isRunning: () => true,
    _eventId: () => 7,
    _index: 42,
  };
}

test('state.message carries the running event context', () => {
  const { ctx, connect, command } = loadPlugin();
  const ws = connect();
  showMessage(ctx, 'hello');
  const reply = command(ws, 'observe');
  assert.deepEqual(reply.state.message.context, { map_id: 1, event_id: 7, command_index: 42 });
});

test('message history keeps the context of each line', () => {
  const { ctx, connect, command } = loadPlugin();
  const ws = connect();
  showMessage(ctx, 'first line');
  ctx.SceneManager.updateMain();
  const reply = command(ws, 'observe');
  assert.deepEqual(reply.state.message_history, [
    { text: 'first line', speaker: null, context: { map_id: 1, event_id: 7, command_index: 42 } },
  ]);
});

test('event context is omitted when the runtime cannot answer', () => {
  const { ctx, connect, command } = loadPlugin();
  const ws = connect();
  ctx.$gameMessage = { isBusy: () => true, _texts: ['battle line'], _choices: [] };
  ctx.$gameMap._interpreter = null;
  const reply = command(ws, 'observe');
  assert.equal(reply.state.message.context, undefined);
  assert.equal(reply.state.message.text, 'battle line');
});

test('talk_to names the stage when the target does not exist', () => {
  const { connect, command } = loadPlugin();
  const ws = connect();
  const reply = command(ws, 'talk_to', { event_id: 99 });
  assert.equal(reply.ok, false);
  assert.equal(reply.reason, 'no_event');
  assert.equal(reply.effect.stage, 'locate');
  assert.equal(reply.effect.map_id, 1);
});

test('talk_to names the trigger stage for an event page that ignores the action button', () => {
  const { ctx, connect, command } = loadPlugin();
  const ws = connect();
  const ev = {
    eventId: () => 5,
    x: 2,
    y: 3,
    _pageIndex: 0,
    isNormalPriority: () => true,
    list: () => [{ code: 101 }],
    event: () => ({ pages: [{ trigger: 1, list: [{ code: 101 }] }] }),
  };
  ctx.$gameMap.event = () => ev;
  const reply = command(ws, 'talk_to', { event_id: 5 });
  assert.equal(reply.ok, false);
  assert.equal(reply.reason, 'event_not_action_trigger');
  assert.equal(reply.effect.stage, 'trigger');
  assert.equal(reply.effect.event_id, 5);
});

function makeEvent(id, opts) {
  opts = opts || {};
  const pages = opts.pages || [{ trigger: 0, list: [{ code: 101 }] }];
  const index = opts.pageIndex === undefined ? pages.length - 1 : opts.pageIndex;
  return {
    eventId: () => id,
    x: opts.x === undefined ? 3 : opts.x,
    y: opts.y === undefined ? 3 : opts.y,
    _pageIndex: index,
    _erased: false,
    direction: () => 2,
    isNormalPriority: () => true,
    isThrough: () => false,
    isMoving: () => false,
    list: () => pages[index].list || [],
    event: () => ({
      id,
      name: opts.name || `Event ${id}`,
      note: opts.note || '',
      pages,
    }),
  };
}

const NO_CONDITIONS = {
  switch1Valid: false,
  switch2Valid: false,
  variableValid: false,
  selfSwitchValid: false,
  itemValid: false,
  actorValid: false,
};

test('list_events reports the conditions that gate each event page', () => {
  const { ctx, connect, command } = loadPlugin();
  ctx.$dataSystem = { switches: { 10: 'Quest Accepted' }, variables: {} };
  ctx.$gameSwitches = { value: (id) => id === 10 };
  ctx.$gameMap.events = () => [
    makeEvent(4, {
      pageIndex: 1,
      pages: [
        { trigger: 0, conditions: { ...NO_CONDITIONS, switch1Valid: true, switch1Id: 10 }, list: [{ code: 101 }] },
        { trigger: 0, conditions: { ...NO_CONDITIONS }, list: [{ code: 101 }] },
      ],
    }),
  ];
  const ws = connect();
  const reply = command(ws, 'list_events');
  const ev = reply.effect.events.find((e) => e.id === 4);
  assert.deepEqual(ev.pages, [
    {
      index: 0,
      active: false,
      trigger: 0,
      conditions: { switches: [{ id: 10, name: 'Quest Accepted', on: true }] },
    },
    { index: 1, active: true, trigger: 0 },
  ]);
});

test('page conditions resolve variable, self switch, item and actor requirements', () => {
  const { ctx, connect, command } = loadPlugin();
  ctx.$dataSystem = { switches: {}, variables: { 3: 'Guild Rank' } };
  ctx.$dataActors = { 1: { name: 'Alex' } };
  ctx.$dataItems = { 7: { id: 7, name: 'Old Key', itypeId: 2 } };
  ctx.$gameVariables = { value: () => 2 };
  ctx.$gameSelfSwitches = { value: () => false };
  ctx.$gameParty = {
    gold: () => 0,
    members: () => [],
    allMembers: () => [{ actorId: () => 1 }],
    hasItem: () => false,
  };
  ctx.$gameMap.events = () => [
    makeEvent(6, {
      pageIndex: 1,
      pages: [
        {
          trigger: 0,
          conditions: {
            switch1Valid: false,
            switch2Valid: false,
            variableValid: true,
            variableId: 3,
            variableValue: 5,
            selfSwitchValid: true,
            selfSwitchCh: 'A',
            itemValid: true,
            itemId: 7,
            actorValid: true,
            actorId: 1,
          },
          list: [{ code: 101 }],
        },
        { trigger: 0, conditions: { ...NO_CONDITIONS }, list: [{ code: 101 }] },
      ],
    }),
  ];
  const ws = connect();
  const ev = command(ws, 'list_events').effect.events.find((e) => e.id === 6);
  assert.deepEqual(ev.pages[0].conditions, {
    variable: { id: 3, name: 'Guild Rank', needs: 5, value: 2 },
    self_switch: { key: 'A', on: false },
    item: { id: 7, name: 'Old Key', held: false },
    actor: { id: 1, name: 'Alex', in_party: true },
  });
});

test('events without conditional pages stay compact', () => {
  const { ctx, connect, command } = loadPlugin();
  ctx.$gameMap.events = () => [makeEvent(3)];
  const ws = connect();
  const ev = command(ws, 'list_events').effect.events.find((e) => e.id === 3);
  assert.equal(ev.pages, undefined);
});

test('game_data lists named switches and variables by default', () => {
  const { ctx, connect, command } = loadPlugin();
  ctx.$dataSystem = { switches: [null, '', 'Quest Accepted', 'Met Alice'], variables: [null, '', 'Gold Found'] };
  ctx.$gameSwitches = { value: (id) => id === 3 };
  ctx.$gameVariables = { value: (id) => (id === 2 ? 40 : 0) };
  const ws = connect();

  const named = command(ws, 'game_data', { kind: 'switches' }).effect;
  assert.equal(named.named_only, true);
  assert.deepEqual(named.entries, [
    { id: 2, name: 'Quest Accepted', value: false },
    { id: 3, name: 'Met Alice', value: true },
  ]);

  const all = command(ws, 'game_data', { kind: 'switches', all: true }).effect;
  assert.deepEqual(all.entries.map((e) => e.id), [1, 2, 3]);

  const vars = command(ws, 'game_data', { kind: 'variables' }).effect;
  assert.deepEqual(vars.entries, [{ id: 2, name: 'Gold Found', value: 40 }]);

  const selected = command(ws, 'game_data', { kind: 'switches', ids: [3] }).effect;
  assert.deepEqual(selected.entries, [{ id: 3, name: 'Met Alice', value: true }]);
});

test('game_data searches the database and returns help text', () => {
  const { ctx, connect, command } = loadPlugin();
  ctx.$dataItems = [
    null,
    { id: 1, name: 'Potion', description: 'Restores 100 HP.', price: 50, itypeId: 1 },
    { id: 2, name: 'Old Key', description: 'Opens the north gate.', price: 0, itypeId: 2 },
  ];
  ctx.$dataWeapons = [null, { id: 1, name: 'Iron Sword', description: 'A sturdy blade.', price: 300 }];
  ctx.$dataArmors = [null];
  ctx.$dataSkills = [null];
  const ws = connect();

  const found = command(ws, 'game_data', { kind: 'items', query: 'gate' }).effect;
  assert.deepEqual(found.entries, [
    { id: 2, name: 'Old Key', description: 'Opens the north gate.', key_item: true, price: 0 },
  ]);

  const exact = command(ws, 'game_data', { kind: 'weapons', ids: [1] }).effect;
  assert.deepEqual(exact.entries, [{ id: 1, name: 'Iron Sword', description: 'A sturdy blade.', price: 300 }]);

  const index = command(ws, 'game_data', { kind: 'items' }).effect;
  assert.deepEqual(index.entries.map((e) => e.name), ['Potion', 'Old Key']);
});

test('game_data reads a shop event\'s goods with effective prices', () => {
  const { ctx, connect, command } = loadPlugin();
  ctx.$dataItems = [null, { id: 1, name: 'Potion', price: 50 }];
  ctx.$dataWeapons = [null, null, { id: 2, name: 'Iron Sword', price: 300 }];
  ctx.$dataArmors = [null];
  ctx.$dataSystem = { switches: { 5: 'Shop Open' } };
  ctx.$gameSwitches = { value: (id) => id === 5 };
  // MV stores one good per 302 and appends further goods as 605 commands.
  const shop = makeEvent(8, {
    name: 'Tool Shop',
    pageIndex: 1,
    pages: [
      {
        trigger: 0,
        conditions: { ...NO_CONDITIONS, switch1Valid: true, switch1Id: 5 },
        list: [
          { code: 302, parameters: [0, 1, 0, 0] },
          { code: 605, parameters: [1, 2, 1, 200] },
        ],
      },
      {
        trigger: 0,
        conditions: { ...NO_CONDITIONS },
        list: [{ code: 302, parameters: [0, 1, 1, 40] }],
      },
    ],
  });
  ctx.$gameMap.event = (id) => (id === 8 ? shop : null);
  const ws = connect();

  const reply = command(ws, 'game_data', { kind: 'shop', event_id: 8 });
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.effect.goods, [
    { kind: 'items', id: 1, name: 'Potion', price: 40 },
  ]);
  assert.equal(reply.effect.page, 1);
  assert.equal(reply.effect.source, 'active_page');
  assert.deepEqual(reply.effect.pages, [
    {
      page_index: 0,
      active: false,
      trigger: 0,
      goods: [
        { kind: 'items', id: 1, name: 'Potion', price: 50 },
        { kind: 'weapons', id: 2, name: 'Iron Sword', price: 200 },
      ],
      conditions: { switches: [{ id: 5, name: 'Shop Open', on: true }] },
    },
    {
      page_index: 1,
      active: true,
      trigger: 0,
      goods: [{ kind: 'items', id: 1, name: 'Potion', price: 40 }],
    },
  ]);
});

test('transfer events expose their destination map, tile and name', () => {
  const { ctx, connect, command } = loadPlugin();
  ctx.$dataMapInfos = { 43: { name: 'Company Office' } };
  ctx.$dataSystem = { switches: { 5: 'Shop Open' }, variables: {} };
  ctx.$gameMap.events = () => [
    makeEvent(8, {
      x: 5,
      y: 15,
      pages: [
        { trigger: 1, list: [{ code: 201, parameters: [0, 43, 2, 7, 2, 0] }] },
      ],
    }),
  ];
  ctx.$gamePlayer.x = 5;
  ctx.$gamePlayer.y = 14;
  const ws = connect();

  const ev = command(ws, 'list_events').effect.events.find((e) => e.id === 8);
  assert.deepEqual(ev.destination, {
    map_id: 43,
    x: 2,
    y: 7,
    name: 'Company Office',
    from_variables: false,
    page_index: 0,
    active: true,
    trigger: 1,
  });

  const nearby = command(ws, 'state').effect.nearby.find((e) => e.event_id === 8);
  assert.equal(nearby.destination.name, 'Company Office');
});

test('a transfer on an inactive page reports the page and its conditions', () => {
  const { ctx, connect, command } = loadPlugin();
  ctx.$dataMapInfos = { 12: { name: 'Guild Hall' } };
  ctx.$dataSystem = { switches: { 5: 'Guild Open' }, variables: {} };
  ctx.$gameSwitches = { value: () => false };
  ctx.$gameVariables = { value: () => 0 };
  ctx.$gameParty = { gold: () => 0, members: () => [], allMembers: () => [], hasItem: () => false };
  ctx.$gameMap.events = () => [
    makeEvent(9, {
      pageIndex: 0,
      pages: [
        { trigger: 0, conditions: { ...NO_CONDITIONS }, list: [{ code: 101 }] },
        { trigger: 0, conditions: { ...NO_CONDITIONS, switch1Valid: true, switch1Id: 5 }, list: [{ code: 201, parameters: [0, 12, 3, 4, 2, 0] }] },
      ],
    }),
  ];
  const ws = connect();

  const ev = command(ws, 'list_events').effect.events.find((e) => e.id === 9);
  assert.equal(ev.destination.page_index, 1);
  assert.equal(ev.destination.active, false);
  assert.deepEqual(ev.destination.conditions, {
    switches: [{ id: 5, name: 'Guild Open', on: false }],
  });
});

test('go_to reports the events standing on the goal tile', () => {
  const { ctx, connect, command } = loadPlugin();
  const ev = makeEvent(8, {
    x: 3,
    y: 3,
    pages: [{ trigger: 0, list: [{ code: 101 }] }],
  });
  ctx.$gameMap.events = () => [ev];
  ctx.$gamePlayer.x = 3;
  ctx.$gamePlayer.y = 3;
  const ws = connect();

  const reply = command(ws, 'go_to', { x: 3, y: 3 });
  assert.equal(reply.ok, true);
  assert.equal(reply.status, 'done');
  assert.equal(reply.effect.arrived_event.event_id, 8);
  assert.equal(reply.effect.arrived_event.trigger, 0);
  assert.ok(reply.effect.arrived_event.hint.includes('OK'));
  assert.deepEqual(reply.effect.events_at_target.map((e) => e.event_id), [8]);
});

test('list_events explains an empty result instead of returning a bare list', () => {
  const { ctx, connect, command } = loadPlugin();
  const ws = connect();

  const empty = command(ws, 'list_events').effect;
  assert.deepEqual(empty.events, []);
  assert.deepEqual(empty.diagnostic, {
    map_id: 1,
    events_loaded: 0,
    radius: null,
    transferring: false,
    message: false,
    event_running: false,
  });

  ctx.$gameMap.events = () => [makeEvent(4, { x: 15, y: 15 })];
  ctx.$gamePlayer.x = 0;
  ctx.$gamePlayer.y = 0;
  const filtered = command(ws, 'list_events', { radius: 1 }).effect;
  assert.deepEqual(filtered.events, []);
  assert.equal(filtered.diagnostic.events_loaded, 1);
  assert.equal(filtered.diagnostic.radius, 1);
});

test('a message drawn as an image exposes DTextPicture text and pictures', () => {
  const { ctx, connect, command } = loadPlugin();
  ctx.$gameMessage = { isBusy: () => true, _texts: [], _choices: [] };
  ctx.$gameScreen = {
    isSettingDText: () => true,
    getDTextPictureInfo: () => ({ originalValue: '\\C[1]你好\\C[0]', value: '你好' }),
    picture: (id) => (id === 1 ? { name: () => 'Subchoice01', opacity: () => 255 } : null),
  };
  const ws = connect();

  const message = command(ws, 'observe').state.message;
  assert.equal(message.text, '');
  assert.equal(message.image_text, '你好');
  assert.equal(message.text_source, 'image_text');
  assert.deepEqual(message.pictures, [{ id: 1, name: 'Subchoice01' }]);
});

test('a picture-only message is marked as picture text', () => {
  const { ctx, connect, command } = loadPlugin();
  ctx.$gameMessage = { isBusy: () => true, _texts: [], _choices: [] };
  ctx.$gameScreen = {
    isSettingDText: () => false,
    picture: (id) => (id === 2 ? { name: () => 'Subchoice01', opacity: () => 255 } : null),
  };
  const ws = connect();

  const message = command(ws, 'observe').state.message;
  assert.equal(message.text, '');
  assert.equal(message.image_text, undefined);
  assert.equal(message.text_source, 'picture');
  assert.deepEqual(message.pictures, [{ id: 2, name: 'Subchoice01' }]);
});

test('observe summarises the inventory with key items first', () => {
  const { ctx, connect, command } = loadPlugin();
  ctx.$gameParty = {
    gold: () => 120,
    members: () => [],
    allMembers: () => [],
    items: () => [
      { id: 1, name: 'Potion', itypeId: 1 },
      { id: 7, name: 'Old Key', itypeId: 2 },
    ],
    numItems: (it) => (it.id === 1 ? 3 : 1),
  };
  const ws = connect();
  const inventory = command(ws, 'observe').effect.party.inventory;
  assert.deepEqual(inventory.key_items, [{ id: 7, name: 'Old Key', count: 1 }]);
  assert.deepEqual(inventory.items, [{ id: 1, name: 'Potion', count: 3 }]);
  assert.equal(inventory.key_items_total, 1);
  assert.equal(inventory.items_total, 1);
});
