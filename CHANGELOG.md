# Changelog

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
