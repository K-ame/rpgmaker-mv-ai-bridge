# Changelog

[English](CHANGELOG.md) | [简体中文](CHANGELOG.zh-CN.md) | [日本語](CHANGELOG.ja.md)

## v0.2.0

A reliability and perception release: the bridge now says whether it is really
ready, what happened when a call timed out, and shows the game data an agent
needs to stop wandering and find the next step.

### Connection and errors

- Explicit connection states: `disconnected`, `handshaking`, `ready`,
  `incompatible`. State is ignored until the plugin's `hello` arrives; a 5 s
  handshake timeout closes the socket with `4001`, and a protocol mismatch keeps
  the socket open with a clear rejection instead of reconnect spam. `/health`
  reports the state, both protocol versions and the plugin version.
- `game_not_ready` (socket up, no compatible handshake) is now distinct from
  `game_not_connected` (no socket), with `effect.connection` explaining why.
- Timeouts carry `action_id` and `effect: {outcome: "unknown", retry_safe, hint}`;
  a late game reply is surfaced once in `warnings` so it is never replayed blindly.
- `/health` counts `connection.replaced_connections`, so several `Game.exe`
  windows fighting over `/game` are visible instead of looking like random
  state jumps.
- Non-loopback `--host` prints a warning.

### Perception

- `list_events` exposes conditional event pages: per-page `index`, `active`,
  `trigger` and the switches, variable minimum, self switch, item or actor the
  page waits for, resolved to names and current values.
- New read-only `game_data` tool: named switches/variables with current values,
  item/weapon/armor/skill lookup with help text, and a shop event's goods with
  effective prices.
- `observe` adds `party.inventory` (key items first, then items, with totals).
- Transfer events in `list_events` and `nearby` carry `destination`
  (`map_id`, `x`, `y`, map name; inactive pages add `page_index` and their
  conditions), and an empty `list_events` result explains itself with events
  loaded, radius and transfer/message state.
- `game_data` shop now reads the real MV shape (one good per 302 plus 605
  additions) and returns every page that has goods, with its conditions.
- A successful `go_to` reports `events_at_target` / `arrived_event`, so
  "arrived but nothing happened" is explainable (OK or a step may still be
  needed).
- A message drawn as an image exposes `message.image_text` (DTextPicture),
  visible picture names and `text_source` (`image_text` / `picture`).
- Messages, log entries and `advance` carry `context` (`map_id`, `event_id`,
  `common_event_id`, `command_index`) while a map event runs; fields are omitted
  rather than guessed. `talk_to` errors name the failing `stage`
  (`locate` / `trigger` / `move`).

### Persistence and tooling

- `notes.json` uses a versioned schema, atomic writes, a `.bak` copy and corrupt
  copy recovery; warnings are returned by `note` and `/health`.
- The bundled CLI finds the plugin in the release layout again (the bundle has no
  `import.meta.url`); `install` validates `plugins.js` before copying anything.
- `doctor` fails on a token mismatch between `plugins.js` and the bridge token
  file, and warns on a plugin/bridge version mismatch.
- Every MCP tool declares full read-only / destructive / idempotent annotations.
- Version checks now compare `package.json`, the CLI, the plugin and the lockfile.

## v0.1.2

The first release shaped by live play: a bridge in WSL, a game on Windows, and a
real battle to fight.

### Connection

- `install` writes the bridge token into `plugins.js`, so the bridge and the game
  no longer need the same home directory (WSL + Windows works out of the box).
- `serve` prints absolute paths for home, token and session.
- `/health` now reports `rejected_last_minute` per origin kind (`game`,
  `extension`, `none`, `web`) instead of a single rate-limited log line.

### Reading the game

- `state.message_history` keeps the last three dialogue lines, and `effect.pages`
  carries every page seen during an `advance` call.
- `state.nearby` lists the closest events with a `kind` (`action`, `touch`,
  `transfer`, `shop`, `other`), so doors, beds and shop counters are visible.
- `go_to` accepts `dry_run` and always returns `path` / `path_length`.
- `transfer_by_event` is logged when a cutscene moves the player across the map
  without a map change.

### Movement and UI

- `walk` / `go_to` return `busy` with `blocked_by` (`message`, `choice`,
  `transfer`) instead of a misleading `unreachable`.
- `state.ui` is computed on map scenes too, so cursor-driven overlay menus are
  exposed, and `input` reports the cursor window it moved.

### Battle

- A failed `skill` / `item` selection cancels its window before returning, so a
  bad cast no longer deadlocks later commands.
- The actor command is matched by `command_index`, then symbol, then visible
  label; `attack` falls back to the first usable entry.
- `auto` takes `policy: "skill_first"`; the default `attack` policy is unchanged
  and `auto` is documented as a command repeater, not the engine's auto-battle.
- `effect.turn` / `effect.turns` report rounds, and `state.battle.log` exposes
  the battle log lines.
- `escape` returns `nearest_threat` (coords + direction) so the agent can step
  away before being re-engaged.

## v0.1.1

- `/game` requires the token; connections without it get a 401.
- Optional `Token` plugin parameter for games that cannot read `~/.mv-ai-bridge`.
- `checkpoint` refuses to save outside a settled map scene.

## v0.1.0

- First public build: in-game plugin, MCP server, button-level input, structured
  state, and a single-file bundle for the release archive.
