import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BridgeCore } from './core.js';
import { Envelope } from './protocol.js';

const timeout = z
  .number()
  .int()
  .min(1000)
  .max(600000)
  .optional()
  .describe('Hard limit for this call in milliseconds. The action returns status "partial" instead of hanging.');

const radius = z.number().int().min(0).max(50).optional().describe('Only include events within this Manhattan distance.');

function result(env: Envelope) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(env, null, 2) }],
    structuredContent: env as unknown as Record<string, unknown>,
    isError: env.ok === false,
  };
}

const ENVELOPE_NOTE =
  'Every action returns the same envelope: {ok, status, action, effect, interrupted_by, reason, tick, state, new_log, warnings}. ' +
  'status is "done" (goal reached or the action naturally stopped), "partial" (budget ran out or movement was blocked), ' +
  '"interrupted" (a message, choice, battle, transfer or scene change took control), or "error". ' +
  'Interrupted and partial are normal gameplay outcomes, not tool failures. Read state and new_log before deciding what to do next.';

export function createMcpServer(core: BridgeCore): McpServer {
  const server = new McpServer({ name: 'mv-ai-bridge', version: '0.1.0' });

  const register = (
    name: string,
    title: string,
    description: string,
    inputSchema: Record<string, z.ZodTypeAny>,
    annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean },
  ) => {
    server.registerTool(name, { title, description, inputSchema }, async (args: Record<string, unknown>) =>
      result(await core.run(name, args || {})),
    );
    void annotations;
  };

  register(
    'observe',
    'Observe',
    'Read the current structured game state: scene, map, player tile and facing, open message text, choice window, ' +
      'party HP/gold, battle status, and nearby events. "objective" echoes the note you stored under key "objective" ' +
      '(set it with note {"action":"set","key":"objective","text":"..."}): keep a one-line current goal there and read ' +
      'it back on every observe so you do not drift into reacting only to what is on screen. "threats" lists nearby ' +
      'battle-capable events (roaming monsters) with distance, whether they move, and whether their move route chases ' +
      'the player, so you can engage or keep clear. "balloons" lists nearby quest markers ("!" / "?" overlays) with ' +
      'distance, balloon id and source image, so the first call already shows where the story continues. ' +
      'state.world_frozen is true while the optional FreezeWhileThinking mode is holding the map still between calls. ' +
      'In battle it exposes party_commands, actor_commands, the inputting actor, that actor\'s skill types with every ' +
      'skill (MP/TP cost and usable flag included), battle items, and enemy_targets/actor_targets with the indexes ' +
      'target_index expects — all available throughout the input phase, even when the plugin keeps only one window ' +
      'focused. In menus, shops and other non-map scenes it lists every visible window with its active cursor, items ' +
      'and shop prices, so base and custom screens can be navigated with input; save/load screens add a per-slot list ' +
      'with exists, timestamp and playtime so you never overwrite a save blindly. This is the primary perception tool; ' +
      'use it before and after every meaningful action. ' +
      ENVELOPE_NOTE,
    {
      radius,
      detail: z.enum(['brief', 'full']).optional().describe('"full" adds inventory, actor states and equipment-level detail.'),
    },
    { readOnlyHint: true, openWorldHint: false },
  );

  register(
    'look',
    'Look around',
    'Return a local map grid around the player as a compact character map: "@" you, "E" event, "." walkable, "#" blocked. ' +
      'The "origin" field is the map coordinate of the top-left character, and "events" lists event ids on occupied ' +
      'cells. detail "full" replaces this with per-cell objects carrying per-direction tile passability ("UDLR" with "-" ' +
      'for blocked). Cells outside the map are cropped and an oversized radius is clamped to the map, so the result is ' +
      'never silently empty; effect.radius is the radius actually used. overview:true returns the whole map in one call. ' +
      'Outside the map scene it fails with reason "bad_scene" and the current scene name. ' +
      'Use this to explore rooms, find doors and avoid dead ends. ' +
      ENVELOPE_NOTE,
    {
      radius: z.number().int().min(1).max(500).optional().describe('Grid radius in tiles. Default 5 (11x11 cells); clamped to the map size.'),
      overview: z.boolean().optional().describe('Return the entire map, ignoring radius.'),
      detail: z.enum(['brief', 'full']).optional().describe('"full" returns per-cell passability objects instead of the character map.'),
    },
    { readOnlyHint: true, openWorldHint: false },
  );

  register(
    'list_events',
    'List events',
    'List map events with id, name, position, facing, distance, trigger type and how the action button reaches them: ' +
      'interact_from "adjacent" (face it from a neighbouring tile) or "here" (stand on its tile; MV priority 0/2). ' +
      'action_trigger is false when the page does not respond to the action button at all; commands is how many ' +
      'commands the active page holds, and empty=true means the page is a placeholder that does nothing when pressed. ' +
      'balloon is the quest marker id shown above the event (1 "!", 2 "?", 0 none), detected from the overlay charset ' +
      'or a live balloon; page gives the active page index and total, note is the event note, and page_note is the ' +
      'comment commands of the active page (where note-driven plugins keep their tags) — all only present when used. ' +
      'hazard=true means the ' +
      'event\'s active page can start a battle, either directly or through a common event it calls, which is how ' +
      'roaming monsters are usually implemented; treat those events as dangerous. chases=true means the event moves ' +
      'toward the player. Erased (spent) events are omitted. ' +
      ENVELOPE_NOTE,
    { radius },
    { readOnlyHint: true, openWorldHint: false },
  );

  register(
    'walk',
    'Walk',
    'Hold a direction and walk up to N tiles. Stops early at the next decision point (message, choice, battle, transfer, ' +
      'scene change, or a wall). interrupted_by tells which one: "message" (advance it), "choice" (select an option), ' +
      '"event" (something is still running), "transfer" or the new scene name. If it stops before walking the requested ' +
      'number of tiles, status is "partial" (reason "blocked" or "stopped_short"); only fully completed walks return ' +
      '"done". Set avoid_hazard to stop before stepping within N tiles of a roaming monster that starts a battle; the ' +
      'result is "partial" with reason "threat_nearby" and effect.threat identifying the event. Check ' +
      'effect.steps_done to see how far it got. Outside the map scene it fails with reason "bad_scene" and the current ' +
      'scene name, so a menu is never mistaken for a map problem. ' +
      ENVELOPE_NOTE,
    {
      direction: z.enum(['up', 'down', 'left', 'right']).describe('Direction to walk.'),
      steps: z.number().int().min(1).max(500).optional().describe('Maximum tiles to walk. Default 1.'),
      avoid_hazard: z
        .number()
        .int()
        .min(0)
        .max(20)
        .optional()
        .describe('Safety margin in tiles: do not step closer than this to a battle event. Default 0 (no avoidance).'),
      timeout_ms: timeout,
    },
    { openWorldHint: false },
  );

  register(
    'go_to',
    'Go to tile',
    'Pathfind around walls and events and walk to an exact tile. Stops early at the next decision point and returns ' +
      '"partial" with the remaining position if it is blocked mid-route. When the target cannot be reached at all, the ' +
      'result is an error whose effect carries nearest_reachable {x,y,distance}, blocked_by ' +
      '("wall" | "event" | "one_way_tile" | "avoidance_zone" | ...), and the target tile passability, so you can pick ' +
      'a reachable goal instead of retrying blindly. Set avoid_hazard to route around cells within N tiles of roaming ' +
      'monsters and to stop before stepping toward one; the result then carries reason "threat_nearby" and ' +
      'effect.threat. The goal tile itself is exempt, so a deliberate approach still works. Outside the map scene it ' +
      'fails with reason "bad_scene" and the current scene name. ' +
      ENVELOPE_NOTE,
    {
      x: z.number().int().describe('Target map x.'),
      y: z.number().int().describe('Target map y.'),
      avoid_hazard: z
        .number()
        .int()
        .min(0)
        .max(20)
        .optional()
        .describe('Safety margin in tiles: path around and stop short of battle events. Default 0 (no avoidance).'),
      timeout_ms: timeout,
    },
    { openWorldHint: false },
  );

  register(
    'talk_to',
    'Talk to event',
    'Start a map event with the action button. For priority-1 events it walks to an adjacent tile and faces them; for ' +
      'priority-0/2 events (interact_from "here") it walks onto their tile first. Shop clerks behind a counter ' +
      '(interact_from "across_counter") are reached by standing in front of the counter and facing it, as MV allows. ' +
      'Use an event id from list_events, an exact tile, or omit both to pick the nearest interactable event. Errors ' +
      'distinguish unreachable tiles, events that do not respond to the action button at all, and pages that are empty ' +
      'placeholders. Outside the map scene it fails with reason "bad_scene" and the current scene name. ' +
      'If the event starts a message or choice, the call stops there and returns the text. ' +
      ENVELOPE_NOTE,
    {
      event_id: z.number().int().optional().describe('Event id on the current map.'),
      x: z.number().int().optional().describe('Event tile x (alternative to event_id).'),
      y: z.number().int().optional().describe('Event tile y (alternative to event_id).'),
      timeout_ms: timeout,
    },
    { openWorldHint: false },
  );

  register(
    'interact',
    'Interact',
    'Press the action button once, exactly as a player would. Use it to open doors, read signs, and confirm a focused ' +
      'option when you already know what is in front of the player. ' +
      ENVELOPE_NOTE,
    { timeout_ms: timeout },
    { openWorldHint: false },
  );

  register(
    'advance',
    'Advance dialogue',
    'Advance the current message: it fast-forwards typing, turns pages, and stops at a choice window ' +
      'or at the end of the event. Each page stays on screen for page_delay_ms (default 2000 ms, from the ' +
      'plugin ReadDelay parameter); that delay applies to message windows only, battle-log lines keep the game\'s own ' +
      'timing. effect.pages contains the text it passed. Use select afterward when a choice appears. ' +
      'In battle it only pushes log/result windows: while a command or target window is open it refuses with reason ' +
      '"needs_command" and does nothing, so it can never pick an action for you. In the battleEnd phase it presses ok ' +
      'through the victory/EXP windows until the map returns (stop "battle_end"). ' + ENVELOPE_NOTE,
    {
      max_pages: z.number().int().min(1).max(500).optional().describe('Safety limit on pages. Default 50.'),
      page_delay_ms: z
        .number()
        .int()
        .min(0)
        .max(10000)
        .optional()
        .describe('How long each message page stays on screen. Default: the plugin ReadDelay (2000 ms).'),
      timeout_ms: timeout,
    },
    { openWorldHint: false },
  );

  register(
    'select',
    'Select choice',
    'Pick an option by index or exact label. It works on the current message choice window, the Select Item window that ' +
      'map events open (item names as labels), and the active Window_Selectable of a menu, shop or battle screen — ' +
      'using the same index that observe.ui reports. The call navigates with the directional buttons and confirms with ' +
      'the action button. If a scene is still opening from a previous input (input menu right before select), it waits ' +
      'for the window instead of failing. On a save screen, choosing with select is the supported way to pick the slot; ' +
      'a bare input ok is refused until you do, so you cannot overwrite a save by accident. ' +
      ENVELOPE_NOTE,
    {
      index: z.number().int().min(0).optional().describe('Zero-based option index.'),
      label: z.string().optional().describe('Exact option text, or a unique substring.'),
      timeout_ms: timeout,
    },
    { openWorldHint: false },
  );

  register(
    'back',
    'Back / cancel',
    'Press the cancel button once. Use it to close menus, leave a submenu, or back out of an accidental dialog. ' +
      ENVELOPE_NOTE,
    { timeout_ms: timeout },
    { openWorldHint: false },
  );

  register(
    'battle',
    'Battle',
    '"auto" hands the whole battle to the engine\'s auto-battle loop until it ends, so it gives up tactical control ' +
      '(no chance to react to low HP, a downed member or a boss phase) — use it for trash fights only. The single-turn ' +
      'actions (attack/skill/guard/item/escape) issue exactly one command for the actor who is currently inputting and ' +
      'return as soon as the game commits it; call observe again to see the result and to command the next actor. ' +
      'The actor command window lists attack, one entry per skill type, guard and item. command_index selects an entry ' +
      'verbatim; otherwise action selects it by symbol, and skill_type_index picks which skill type when the actor has ' +
      'several. skill_index/item_index index the list inside the opened window (see observe.battle.skill_window and ' +
      'observe.battle.item_window, which are aligned with what the player sees). target_index picks an entry of ' +
      'observe.battle.targets/enemy_targets; it defaults to 0. All of these lists are available during the whole input ' +
      'phase. "advance" never issues a command: while a command or target window waits it returns needs_command, so this ' +
      'tool is the only way an action gets chosen. If the call is refused with reason "busy", effect names the action ' +
      'still running and the battle window state. ' +
      ENVELOPE_NOTE,
    {
      action: z
        .enum(['auto', 'attack', 'skill', 'guard', 'item', 'escape'])
        .optional()
        .describe(
          '"auto" fights until the battle ends (engine auto-battle, no tactical control). Default "auto" unless a command selector is supplied, which issues one command.',
        ),
      command_index: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Index into the active actor command window. Overrides action.'),
      skill_type_index: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Which skill-type command to open when the actor has several. Default 0.'),
      skill_index: z.number().int().min(0).optional().describe('Skill list index for action "skill".'),
      item_index: z.number().int().min(0).optional().describe('Item list index for action "item".'),
      target_index: z.number().int().min(0).optional().describe('Target list index. Default 0.'),
      timeout_ms: timeout,
    },
    { openWorldHint: false },
  );

  register(
    'manage',
    'Party management',
    'Read or change the party outside battle. action "roster" returns the party order, every actor\'s level, HP/MP/TP, ' +
      'states, equipment per slot, learned skills and the inventory; detail "full" also lists, for each slot, the ' +
      'inventory items that actor can equip. ' +
      'action "equip" changes one slot by actor_id + slot + item_id (item_id 0 unequips). action "formation" swaps two ' +
      'party positions with swap [i, j] by calling the runtime party-order API directly (bypasses: party-change plugins ' +
      'that charge a fee or enforce restrictions when the player reorders in the menu). action "use_item" applies the ' +
      'item through the engine action system instead of the item menu (bypasses: plugins that hook menu item selection, ' +
      'custom confirmations or extra targeting rules); target_actor_id defaults to the first member. ' +
      'Only roster is read-only; the rest require a settled map with no message, choice, event or transfer running. ' +
      ENVELOPE_NOTE,
    {
      action: z.enum(['roster', 'equip', 'formation', 'use_item']).describe('Management operation.'),
      detail: z.enum(['brief', 'full']).optional().describe('"full" adds per-slot equip options to the roster.'),
      actor_id: z.number().int().optional().describe('Party actor id for "equip".'),
      slot: z.number().int().min(0).optional().describe('Equip slot index for "equip" (see roster equips[].slot).'),
      item_id: z.number().int().min(0).optional().describe('Weapon/armor id for "equip" (0 unequips), item id for "use_item".'),
      swap: z
        .array(z.number().int().min(0))
        .length(2)
        .optional()
        .describe('Two party indices to exchange for "formation".'),
      target_actor_id: z.number().int().optional().describe('Item target for "use_item". Default first party member.'),
      timeout_ms: timeout,
    },
    { openWorldHint: false },
  );

  register(
    'title',
    'Title screen',
    'Operate the title screen: start a new game, continue from the newest save, open options, or press back. ' +
      ENVELOPE_NOTE,
    {
      action: z.enum(['new', 'continue', 'options', 'back']).describe('What to do on the title screen.'),
      timeout_ms: timeout,
    },
    { openWorldHint: false },
  );

  register(
    'wait',
    'Wait',
    'Wait until a condition is true: the map is settled, a message appears, a choice appears, a battle starts, the scene ' +
      'changes, or a millisecond delay elapses. Use it after animations, transfers and scripted sequences. ' +
      ENVELOPE_NOTE,
    {
      until: z.enum(['settled', 'message', 'choice', 'battle', 'scene_change', 'ms']).optional().describe('Condition. Default "settled".'),
      ms: z.number().int().min(0).max(120000).optional().describe('Delay for until="ms".'),
      timeout_ms: timeout,
    },
    { readOnlyHint: false, openWorldHint: false },
  );

  register(
    'checkpoint',
    'Checkpoint',
    'Save, load, list or delete an in-memory snapshot of the whole game state. Checkpoints live inside the running game ' +
      'process and never touch save slots on disk. "save" only works on a settled map (no message, choice, event or ' +
      'movement in progress); otherwise it returns not_settled with effect.blocked_by, or bad_scene outside the map. ' +
      '"load" works from any scene and replaces the runtime state wholesale (bypasses: plugin logic ' +
      'that normally runs when the player loads from the menu). Save before a risky room, load to retry it. ' +
      ENVELOPE_NOTE,
    {
      action: z.enum(['save', 'load', 'list', 'delete']).describe('Checkpoint operation.'),
      id: z.string().optional().describe('Checkpoint id. "load" defaults to the most recent one.'),
      timeout_ms: timeout,
    },
    { openWorldHint: false },
  );

  register(
    'input',
    'Raw input',
    'Press one engine button for an exact hold time. This is the escape hatch for menus and minigames that the ' +
      'higher-level tools do not understand yet. Prefer walk/advance/select/interact when they fit. ' +
      'effect.effective reports whether anything changed (scene, message, player tile/facing). If the button cannot ' +
      'act now — menu during a message, or a scene that disables the menu — the result is error/partial with reason ' +
      '"input_swallowed" and effect.blocked_by so a silent no-op never looks like success. On a save screen, ok is ' +
      'refused ("save_slot_not_chosen") until select has focused a slot, because ok overwrites the slot under the ' +
      'cursor. ' +
      ENVELOPE_NOTE,
    {
      button: z
        .enum(['ok', 'cancel', 'up', 'down', 'left', 'right', 'shift', 'menu', 'pageup', 'pagedown', 'debug', 'escape'])
        .describe('Engine button name.'),
      hold_ms: z.number().int().min(16).max(3000).optional().describe('How long to hold. Default 60 ms.'),
      timeout_ms: timeout,
    },
    { openWorldHint: false },
  );

  register(
    'log',
    'Event log',
    'Read the game event log: messages shown, choices offered, map transfers, scene changes, battle starts/ends, ' +
      'party state or equipment changes (armor break, poison, charm, unequips), and hint entries for dialogue that ' +
      'states a requirement or clue ("...が必要", "...しなければ", "...すると良い", and similar). ' +
      'Use since=<last_seq> to fetch only new entries. This is cheaper than repeatedly calling observe when you need history. ' +
      ENVELOPE_NOTE,
    {
      since: z.number().int().min(0).optional().describe('Return only entries with seq greater than this.'),
      limit: z.number().int().min(1).max(500).optional().describe('Maximum entries, newest last. Default 50.'),
    },
    { readOnlyHint: true, openWorldHint: false },
  );

  register(
    'note',
    'Notes',
    'Persistent notes for the agent, stored on the bridge machine and keyed by game title. They survive context resets ' +
      'and game restarts. Use them for plans, discovered routes, NPC locations and puzzles. ' +
      'The key "objective" is special: its value is echoed as observe.effect.objective on every observation. ' +
      'In long games keep a one-line goal there and restate it as you make progress. ' +
      'Actions: set (key + value or text), get (key), list, delete (key). ' +
      'Example: {"action":"set","key":"objective","text":"Earn 2000G to register at the guild; need a weapon before leaving town."}',
    {
      action: z.enum(['set', 'get', 'list', 'delete']).describe('Note operation.'),
      key: z.string().optional().describe('Note key (use "objective" for the echoed goal).'),
      value: z.unknown().optional().describe('Any JSON value to store.'),
      text: z.string().optional().describe('Alias for value; handy for plain string notes such as the objective.'),
    },
    { readOnlyHint: false, openWorldHint: false },
  );

  return server;
}
