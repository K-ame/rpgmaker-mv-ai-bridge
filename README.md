<h1 align="center">RPG Maker MV AI Bridge</h1>

<p align="center"><b>Let an AI agent play RPG Maker MV games.</b><br>
It reads tiles, events, dialogue and battle state, and plays by pressing buttons — no screenshots, no vision model.</p>

<p align="center">
  <a href="https://github.com/K-ame/rpgmaker-mv-ai-bridge/releases"><img src="https://img.shields.io/github/v/release/K-ame/rpgmaker-mv-ai-bridge?color=2ea44f" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/K-ame/rpgmaker-mv-ai-bridge" alt="License"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-339933" alt="Node 20+">
  <img src="https://img.shields.io/badge/protocol-MCP-6E56CF" alt="Model Context Protocol">
</p>

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

Two pieces: an in-game plugin that exposes state and accepts player-level input over a local WebSocket, and an MCP
server that turns it into tools. Grab the [prebuilt zip](https://github.com/K-ame/rpgmaker-mv-ai-bridge/releases) or
[build from source](#install).

- **Gameplay only.** The bridge reads state and presses buttons. It does not edit the database or teleport the player.
  A few conveniences (`manage.formation`, `manage.use_item`, `checkpoint.load`) call runtime APIs directly and
  therefore bypass plugin-level side effects; each one is marked `bypasses:` in its tool description.
- **Native MCP.** Stdio and Streamable HTTP, no agent-specific glue.
- **Built for long sessions.** Composite actions stop at the next decision point, checkpoints retry a bad room,
  notes survive context resets.

## How it works

```
MCP client (agent)
      │  stdio or Streamable HTTP (bearer token)
      ▼
mv-ai-bridge  ── WebSocket ws://127.0.0.1:7321/game ──  MV_AI_Bridge.js (in game)
                                                              │
                                                        RPG Maker MV runtime
```

One process serves both halves:

- `ws://<host>:<port>/game` for the game plugin (the game dials out to the bridge).
- `http://<host>:<port>/mcp` for MCP clients (Streamable HTTP, JSON responses).
- `http://<host>:<port>/health` for a quick status check. It requires the token because it returns the game title and
  a copy of the last observed game state, not just a boolean. `rejected_last_minute` counts rejected game connections
  over the last 60 seconds by origin kind (`game`, `extension`, `web`, `none`), which separates a wrong token from
  unrelated localhost probes.

The bridge binds to loopback by default and requires a bearer token.

## Requirements

- Node.js 20 or newer.
- An RPG Maker MV game on PC (NW.js), MV 1.5+ / 1.6.x. RPG Maker MZ uses a different runtime and is not supported.
- Windows, macOS or Linux. The game and the bridge run on the same machine.

## Install

**Prebuilt (no build step):** grab the latest `.zip` from
[Releases](https://github.com/K-ame/rpgmaker-mv-ai-bridge/releases) — it holds the plugin, the bridge bundled into a
single file, `install.bat` / `install.sh` and `serve.bat`. Node.js 20+ is the only requirement.

Or build from source:

```bash
git clone https://github.com/K-ame/rpgmaker-mv-ai-bridge.git
cd rpgmaker-mv-ai-bridge
npm install
npm run build

# copy the plugin into the game and register it in plugins.js
node dist/cli/index.js install "/path/to/MyGame"
```

`install` writes `www/js/plugins/MV_AI_Bridge.js`, appends the entry at the end of `www/js/plugins.js` (so the plugin
wraps every other plugin's behaviour), writes the current token into the entry's `Token` parameter, and keeps a
one-time backup at `plugins.js.mv-ai-bridge.bak`. A short manual snippet is printed if `plugins.js` is not plain JSON.
See [Uninstall](#uninstall) to undo it.

Run `node dist/cli/index.js doctor "/path/to/MyGame"` to check Node version, project layout, plugin placement,
token and session state.

## Run

```bash
node dist/cli/index.js serve            # HTTP MCP + game WebSocket
node dist/cli/index.js serve --stdio    # also speak MCP over stdin/stdout
node dist/cli/index.js serve --no-stdio # HTTP only
```

Default address is `127.0.0.1:7321`. The bridge writes the live token and URL to `~/.mv-ai-bridge/session.json`;
`node dist/cli/index.js session` prints it. Then launch the game — the plugin retries the socket every few seconds.

Stdio MCP is only enabled with `--stdio`; it is never inferred from stdin, so background or piped runs keep stdout
clean. To let an MCP client launch the bridge as a child process:

```json
{
  "mcpServers": {
    "mv-ai-bridge": {
      "command": "node",
      "args": ["C:/path/to/rpgmaker-mv-ai-bridge/dist/cli/index.js", "serve", "--stdio"]
    }
  }
}
```

Or connect over HTTP. The token is in `~/.mv-ai-bridge/token`:

```json
{
  "mcpServers": {
    "mv-ai-bridge": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:7321/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

## Files

| Path | Purpose |
| --- | --- |
| `~/.mv-ai-bridge/token` | Bearer token for `/mcp`, `/health` and the game connection `/game`. Created on first run. |
| `~/.mv-ai-bridge/session.json` | Running bridge address, live token, pid and version. The game plugin reads the token from here. |
| `~/.mv-ai-bridge/notes.json` | Persistent agent notes, keyed by game title. |

Set `MV_AI_BRIDGE_HOME` to relocate that directory.

### WSL + Windows

When the bridge runs under WSL and the game runs on Windows, the two sides have different home directories: the
bridge reads `/home/<you>/.mv-ai-bridge/token` while the plugin looks under `C:\Users\<you>\.mv-ai-bridge\token`, and
the tokens then differ. Connections are rejected with 401 and `/health` stays `connected: false` even though the game
window looks fine. Any one of these fixes it:

- Run `install` from the side that also runs `serve` (both WSL or both Windows), so the token written into
  `plugins.js` matches; the plugin's `Token` parameter takes priority over the file.
- Or set `MV_AI_BRIDGE_HOME` on the bridge to the Windows-side directory the game can read.
- Or copy the token file to the other side.

`serve` prints the absolute bridge home, token file and session file paths so it is clear which side holds them.
`/health` reports rejected game connections by origin kind (`game`, `extension`, `web`, `none`) over the last minute,
which distinguishes a wrong token from unrelated localhost probes.

## Tools

Every call returns the same envelope:

```json
{
  "ok": true,
  "status": "done",
  "action": "walk",
  "effect": { "steps_done": 3 },
  "interrupted_by": null,
  "reason": null,
  "tick": 12345,
  "state": { "scene": "map", "map": { "id": 100, "name": "Cave 3", "area": ["Cave 1", "Cave 2"] } },
  "new_log": [],
  "warnings": []
}
```

`status` is one of:

- `done` — the goal was reached or the action naturally stopped.
- `partial` — a budget ran out or movement was blocked; `effect` shows how far it got.
- `interrupted` — a message, choice, battle, transfer or scene change took control. `interrupted_by` says which.
- `error` — the action could not start (`ok: false`).

`partial` and `interrupted` are normal gameplay outcomes, not tool failures.

| Tool | What it does |
| --- | --- |
| `observe` | Scene, map, player tile/facing, open message, choices, party, battle, nearby events. `state.nearby` lists the five closest events as `{event_id, name, x, y, distance, kind}`, where `kind` is `action` (action button), `touch` (player/event touch), `transfer` (door or stairs), `shop` or `other`; zero-command decoration such as beds and locked doors is included, because those are often the trigger the agent needs. `state.message_history` keeps the last three dialogue lines the frame loop saw, including cutscene lines that were auto-advanced between calls. `objective` echoes the note stored under key `objective`, so a long session can keep its goal in view. On the map it also lists `threats` (battle events within 8 tiles with distance, moving and chases), `balloons` (quest markers — `!` / `?` overlays — within 8 tiles with distance, balloon id and source image) and `world_frozen` (true while `FreezeWhileThinking` is holding the map still). In battle the whole input phase exposes `party_commands`, `actor_commands`, the inputting actor, skill types with every skill (MP/TP cost and usable flag), battle items, and `enemy_targets` / `actor_targets` whose indexes are what `target_index` drives — not just the one focused window; `skill_window` / `item_window` themselves exist only after that command is chosen. `battle.log` carries the last `Window_BattleLog` lines. In menus, shops and other non-map scenes it lists every visible window with cursor, items and shop prices; save screens add per-slot `exists` / `timestamp` / `playtime`. On the map, `state.ui` lists custom overlay windows (a world-map destination list, a HUD menu) when one is open; the stock dialogue and map-name windows are excluded because `state.message` / `state.map` already cover them. |
| `look` | Local map as a character grid (`@` you, `E` event, `.` walkable, `#` blocked) with map-coordinate `origin` and an `events` list. `detail: "full"` returns per-cell passability instead. Out-of-map cells are cropped and an oversized radius is clamped to the map (reported in `radius`), so the result is never silently empty; `overview: true` returns the whole map. Outside the map scene it fails with `bad_scene` and the current scene name. |
| `list_events` | Nearby events with names, distance, trigger type, `interact_from` (`adjacent` or `here`), `action_trigger`, `commands` / `empty` (the active page holds no commands, so pressing the button does nothing), `hazard` (active page starts a battle, directly or via a common event) and `chases` (move route follows the player). Also `balloon` (quest marker above the event: 1 `!`, 2 `?`, 0 none, detected from the overlay charset or a live balloon), `page` (active page index and total), `note` (event note) and `page_note` (comment commands of the active page, where note-driven plugins keep their tags); the last two appear only when used. |
| `walk` | Hold a direction for up to N tiles. Returns `partial` if it stops short (wall or blocked step). `interrupted_by` distinguishes `message` (advance it), `choice` (select it), `event`, `transfer` and the new scene. If a message, choice, event or transfer already owns the screen, the call fails up front with `busy` and `blocked_by` instead of letting the walk stall. `avoid_hazard: N` stops before stepping within N tiles of a battle event. Outside the map scene (menus, saves, ...) it fails with `bad_scene` and the current scene name. |
| `go_to` | A* pathfind to an exact tile. `effect.path` is the route as MV direction codes (2 down, 4 left, 6 right, 8 up) and `path_length` its size, so a route can be cached or drawn; `dry_run: true` returns the same path without moving. The target tile must be standable — beds, counters and walls are not — and failure returns an error with `nearest_reachable {x, y, distance, steps}`, `blocked_by` (`wall`, `event`, `one_way_tile`, `avoidance_zone`, ...), `target_passable` and `events_at_target`; read those instead of retrying blindly. A window that owns the screen returns `busy` with `blocked_by` (`choice`, `message`, `event`, `transfer`) rather than blaming the map. `avoid_hazard: N` routes around battle events and stops if the next step closes in. Outside the map scene it fails with `bad_scene`. |
| `talk_to` | Start a map event with the action button: face it from an adjacent tile, walk onto its tile for `interact_from: "here"` events, or stand in front of a counter and face it for clerks behind one (`interact_from: "across_counter"`). Errors distinguish unreachable tiles, non-action pages and empty placeholder pages; outside the map scene it fails with `bad_scene`. |
| `interact` | One action-button press. |
| `advance` | Fast-forward typing, turn pages, stop at a choice or the end of the event. Read `effect.pages`: every page that appeared while the call ran, which for an event that completes in one call can be the whole conversation (and can be empty when the call only pushed an already-seen line). `effect.advanced_text` is a fallback for lines the frame loop saw but `pages` missed; it is normally absent. `page_delay_ms` applies to message windows only; battle-log lines keep the game's own pace. In battle it never issues a command: it returns `needs_command` while a command or target window waits, and pushes victory/EXP windows in the `battleEnd` phase (`stop: "battle_end"`) until the map returns. |
| `select` | Pick an option by index or label in the message choice, an event's Select Item window, or the active menu/shop/battle window (same index as `observe.ui`). Waits for a menu scene that is still opening. On a save screen you must focus a slot with select; a bare `input ok` is refused. |
| `back` | Cancel button (close menus, back out). |
| `battle` | Drive the battle UI: `auto` repeats a command until the fight ends — `policy: "attack"` (default) attacks, `policy: "skill_first"` casts the first usable skill while MP allows and falls back to attack; it is not the engine's auto-battle and never heals. A command selector issues exactly one command for the inputting actor. The action is matched by `command_index`, then by symbol, then by visible label. A failed `skill`/`item` selection cancels its window before returning the error. `effect.turn` is the current round, `effect.turns` rounds that completed during the call, `effect.log` the last battle-log lines, and `escape` adds `nearest_threat` (coords + direction). A `busy` refusal carries the battle window state. |
| `manage` | Out-of-battle party control: roster with equipment/skills/inventory, equip a slot, swap formation, use an item. |
| `title` | New game, continue from the newest save, options, back. The argument is `action`. |
| `wait` | Wait for settled / message / choice / battle / scene change / milliseconds. |
| `checkpoint` | Save, load, list or delete an in-memory snapshot. Never touches save slots on disk. |
| `input` | Raw engine button press (`button`, `hold_ms`) with an exact hold time. `effect.effective` says whether anything changed (including a cursor move in a custom window); `effect.window` names the window that owns the cursor afterwards with `index` and `selected`. A button that cannot act (menu during a message, a scene that disables it) returns `reason: "input_swallowed"` with `blocked_by`. On a save screen ok returns `save_slot_not_chosen` until select has focused a slot. |
| `log` | Polled event log: messages, choices, transfers, scene changes, battle starts/ends, party or enemy state and equipment changes, plus `hint` entries for dialogue that states a requirement or clue. A cutscene that moves the player on the same map without a scene change is logged as `transfer_by_event` with `from`, `to` and the running `event_id`, so old coordinate targets are visibly stale. |
| `note` | Persistent notes on the bridge machine, keyed by game title. The value under key `objective` is echoed by every observe. Example: `{"action":"set","key":"objective","text":"Earn 2000G to register at the guild; buy a weapon before leaving town"}`. |

### Error reasons

When an action cannot start, `ok` is `false` and `reason` is usually one of:

| `reason` | Meaning |
| --- | --- |
| `bad_scene` | The action only works on the map (or another specific scene) and the current scene is different. `effect.scene` names it. |
| `not_on_map` | The scene looks like a map but no usable map data was found, usually a missing or partial `Map###.json`. |
| `needs_command` | `advance` was called in battle while a command or target window is waiting; issue a `battle` command first. |
| `save_slot_not_chosen` | `ok` was pressed on a save screen before `select` focused a slot. |
| `input_swallowed` | The button cannot act right now; `blocked_by` names what holds the screen (a message, an event, a disabled window). |

Other reasons (`blocked`, `threat_nearby`, `busy`, `unreachable`, ...) describe action-specific outcomes and are
documented with the action that returns them.

### Inferred fields

Two fields are heuristics, not data the engine exposes:

- `balloon` (on `list_events`) and `balloons` (on `observe`) — RPG Maker has no quest-marker flag. The bridge
  reports one when the event page's overlay image name matches `bikkuri` (`!`) or `hatena` / `question` (`?`), or
  when a balloon is playing on the event right now. A marker drawn with a differently named image, as a picture, or
  by a balloon that has already finished is missed.
- `hint` (in `log`) — added when a dialogue line matches a small set of requirement or clue patterns. A hint phrased
  unusually can be missed, and ordinary text that happens to match can be flagged.

Everything else in the envelope is read from runtime objects.

### Reading pace

`advance` keeps each dialogue page on screen for `page_delay_ms` before tapping through it, so the text stays
readable. The default comes from the plugin parameter `ReadDelay` (2000 ms). Pass `page_delay_ms: 0` to skip at
full speed. The delay applies to message windows only; battle-log lines keep the game's own pace.

### Debug log file

NW.js hides its console, so the plugin parameter `Debug` is usually invisible in a real play session. Set `LogFile`
to a path (for example `www/mv-ai-bridge.log`, resolved against the game's working directory) to write the same
diagnostics to a file: connection, every command with its arguments, the final job status and errors. `true` is
shorthand for `www/mv-ai-bridge.log`. The file is appended, never rotated.

### Freeze while thinking

Set the plugin parameter `FreezeWhileThinking` to `true` (default `false`; edit the entry in `plugins.js`, or
re-run `install` and change it) to pause map updates whenever the game is settled and no bridge action is running. The scene keeps
rendering; bridge actions (walking, menus) unfreeze the world while they run. Only the world simulation (event
movement, parallel events) stops. `observe` then reports `state.world_frozen: true`.

The freeze does not apply while a message, choice, battle or transfer is active, so dialogue and combat animate
normally. It reduces, but does not replace, `avoid_hazard`: a monster that already reached an adjacent tile will
still engage when the agent acts.

### Roaming monsters

Many MV games implement world-map enemies as ordinary events that start a battle, either directly (Battle
Processing) or through a common event the page calls. `list_events` reports `hazard: true` for those, scanning only
the page that is active right now, and `chases: true` when the move route follows the player. `observe` adds a
`threats` list of battle events within 8 tiles, so the first perception call is enough to decide whether to engage.

`walk` and `go_to` accept `avoid_hazard: N`, which keeps the route N tiles away from battle events and stops with
`status: "partial"`, `reason: "threat_nearby"` before stepping closer. This is best-effort: a chasing monster whose
chase range meets or exceeds the margin will still reach a player who stands still. Treat it as a way to reduce
accidental encounters, not a guarantee of evasion.

### Battle tactics

The bridge does not decide tactics; it exposes every option and executes the one the agent picks. `battle auto` is
the exception, and it is deliberately small: `policy: "attack"` (the default) repeats attack for every actor;
`policy: "skill_first"` casts the first usable skill while that actor's MP allows and falls back to attack. It is
not the engine's auto-battle — nobody heals, swaps targets by weakness, or reacts to a downed member — so it is
meant for trash encounters.

`effect.turn` is the round the call ran in; `effect.turns` counts rounds that completed while it ran (a
single-command call returns 0 because it ends as soon as the game commits the command). `effect.log` mirrors the
last `Window_BattleLog` lines. After `escape`, `effect.nearest_threat` gives the closest battle event with coords and
direction: a chase event retriggers immediately if the player stands still, so step away before doing anything else.

- `observe` during battle returns `state.battle.commands` (the actor command window: attack, one entry per skill
  type, guard, item), `state.battle.actor` (who is choosing), `skill_types` with every skill and its
  `mp_cost` / `tp_cost` / `usable`, the battle `items`, and `targets`.
- `battle` with `command_index` (or `action` plus `skill_type_index`), `skill_index`, `item_index` and `target_index`
  issues one command for the inputting actor and returns as soon as the game commits it. Call `observe` again to
  command the next actor.
- Costs come from the game's skill plugins, so they are read with `skillMpCost` / `skillTpCost` rather than the
  `mp` field of `Skills.json`, which is often absent or overridden.
- Perception covers more than HP: `observe` lists `states` for every party member, every enemy and both target
  windows, and the event log records `actor_state` / `actor_equip` entries whenever a state is added or removed or
  an equipment slot changes. Enemy state changes are logged the same way as `enemy_state`. Costume damage and similar
  conditions implemented as states or unequips are visible even if they only exist for a single round.

### Party management

`manage` covers equipment, formation and item use outside battle:

- `roster` (read-only) — party order, level, HP/MP/TP, states, equipment per slot, learned skills and inventory;
  `detail: "full"` adds the items each slot can accept.
- `equip` — change one slot by `actor_id` + `slot` + `item_id` (`item_id: 0` unequips).
- `formation` — swap two party positions with `swap: [i, j]`. This calls the runtime party-order API directly
  (`bypasses:` party-change plugins that charge a fee or enforce restrictions when the player reorders in the menu).
- `use_item` — apply an inventory item through the engine action system rather than selecting it in the item menu
  (`bypasses:` plugins that hook menu item selection, add their own confirmation or enforce extra targeting rules;
  the user is the movable member with the highest `pha`).

Everything except `roster` requires a settled map with no message, choice, event or transfer running.

### Menus and shops

Menus and shops are driven with `input`, `back` and `observe`. Outside the map and outside battle, `observe` adds a
`ui` block listing every visible window with its class name, `active` flag, cursor index and the entries the window
itself holds — menu commands, item lists with counts, shop goods with prices. The bridge does not model individual
menu plugins; it reads the window objects the game built, so the stock MV menus and heavily redesigned ones look the
same to the agent. Open the menu with `input` `menu`, move with the arrow buttons and confirm with `ok`; `back`
closes a screen.

### Checkpoints

`checkpoint save` serialises the whole runtime state with `JsonEx` and keeps it in memory. `checkpoint load` restores
it and returns to the map scene; it replaces the runtime state wholesale, so plugin logic that normally runs when the
player loads from the menu is bypassed. This is ideal for retrying a room or a choice, but it is not a save slot: it
dies with the game process and never appears in the game's load menu.

- `save` is only accepted on a settled map: no message, choice, event, movement or transfer in progress. Otherwise it
  returns `not_settled` with `effect.blocked_by` (`message`, `choice`, `event`, `transfer`, `moving` or `busy`), or
  `bad_scene` when the scene is not the map. The save contents keep the map interpreter's progress but not the message
  window or a battle, so a snapshot taken mid-event would restore without the text that was on screen. Use `wait` with
  `until: "settled"` and retry.
- `load` works from any scene (including game over). Like the game's own load, it rebuilds the game objects first,
  because the save contents do not include `$gameTemp`, `$gameMessage` or `$gameTroop`; a pending message, choice or
  reserved common event from before the load does not survive it.

## Uninstall

To remove the bridge from a game:

1. Delete `www/js/plugins/MV_AI_Bridge.js`.
2. Remove the `MV_AI_Bridge` entry from `www/js/plugins.js`, or restore `www/js/plugins.js.mv-ai-bridge.bak` over it.
3. Optionally delete `~/.mv-ai-bridge/` to remove the token, session file and notes.

Steam's "Verify integrity of game files" may restore `plugins.js`, which also removes the entry. Check the game's
licence first: some commercial titles do not permit modifying their files.

## Security

- The bridge listens on `127.0.0.1` unless you pass `--host`. Do not expose it to a network you do not control.
- `/mcp`, `/health` and the game connection `/game` require the bearer token from `~/.mv-ai-bridge/token`. Delete the
  file to rotate it, then re-run `install` (or clear the plugin's `Token` parameter) so the game sends the new one.
- The plugin sends its `Token` parameter when set, otherwise the live token from `~/.mv-ai-bridge/session.json`
  (matching port required), otherwise the token file (`MV_AI_BRIDGE_HOME` respected), as `?token=`. `install` writes
  the current token into that parameter, in plain text, so keep the game folder private. A connection without the
  token gets a 401. This
  matters because any web page can open a WebSocket to `127.0.0.1`, and a newer `/game` connection replaces the
  current one: without the check, a page the user visits could kick the real game out and feed the agent fabricated
  state and dialogue.
- A game that still runs an older plugin file does not send the token and is rejected. Re-run `install` to update it.
- The game plugin connects outwards to the bridge; no inbound port on the game side.
- Only one write action runs at a time, so an agent cannot interleave two movement routines.

## Development

```bash
npm run build
npm test                 # mock game on a random port, no real game needed
node test/live.js observe '{}'   # one-shot call against a running bridge
```

`test/live.js` reads `~/.mv-ai-bridge/session.json` and calls a single tool; it is a manual tool, not part of `npm test`.

Tested against RPG Maker MV 1.6.1 on two projects: a commercial Japanese title with 127 plugin files of its own, with the bridge
registered last in `plugins.js` (custom message, battle and menu systems), and a Chinese fan game. Sessions covered map movement and
pathfinding, dialogue and choices, menus, battles, shops and the event log.
`npm test` covers the bridge protocol against a mock game.

## Known limitations

- **Plugins that replace, not wrap.** The plugin must load last. It virtualises input by writing
  `Input._currentState` and hooks `SceneManager.updateMain` / `SceneManager.updateScene`; a plugin that replaces
  those symbols wholesale instead of calling the previous implementation can break movement or freezing.
- **Project layout.** `install` expects `www/js/plugins.js` plus `www/js/plugins/`. Games whose runtime sits at the
  root (`js/`, `data/` beside `Game.exe`), or that are packed with Enigma or similar protection, need a manual
  plugin copy and a manual `plugins.js` entry.
- **One game per bridge.** A bridge process serves one game connection at a time. To drive a second game at the same
  time, install that game with a different `--port` and run a second bridge on that port.
- **PC only.** NW.js desktop builds are supported. Mobile, Cordova and browser deployments are not.
- **Battle plugins that bypass the window layer.** The battle tools drive the stock command windows. A battle plugin
  with its own input flow can degrade them; use `input` for screens it does not model.
- **Checkpoints are memory-only.** They live in the running process, never appear in the load menu and disappear
  when the game closes.
- **`go_to` destinations must be standable.** Beds, counters, walls and other blocked tiles cannot be walked to, and
  the call returns `unreachable` with diagnostics instead. Read `effect.nearest_reachable` (plus `blocked_by`,
  `target_passable`, `events_at_target`) and target that tile, or use `dry_run: true` to inspect a route first.

## License

MIT. See [LICENSE](LICENSE).
