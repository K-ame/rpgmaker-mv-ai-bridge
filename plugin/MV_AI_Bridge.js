//=============================================================================
// MV_AI_Bridge.js
//=============================================================================
/*:
 * @plugindesc Exposes structured game state and player-level input to an AI
 * agent over a local WebSocket. Gameplay only: no screenshots, no mutations
 * of the game database.
 * @author mv-ai-bridge
 *
 * @param Host
 * @desc Bridge host. Keep 127.0.0.1 for local play.
 * @default 127.0.0.1
 *
 * @param Port
 * @desc Bridge port.
 * @default 7321
 *
 * @param Token
 * @desc Bridge token. Leave empty to read it from ~/.mv-ai-bridge (the
 * running bridge writes it there). Only needed when that folder is not
 * reachable from the game, e.g. a different user or MV_AI_BRIDGE_HOME.
 * @default
 *
 * @param Debug
 * @desc Log bridge activity to the console.
 * @default false
 *
 * @param FreezeWhileThinking
 * @desc Pause map updates while no bridge action runs and the scene is settled.
 * @default false
 *
 * @param LogFile
 * @desc Append the same diagnostics to this file (relative to the game's
 * working directory). `true` means www/mv-ai-bridge.log.
 * @default
 *
 * @param ReadDelay
 * @desc Milliseconds each dialogue page stays on screen before advance() taps
 * through it. Per call, page_delay_ms wins.
 * @default 2000
 *
 * @help
 * This plugin connects the game to a local MCP bridge. Install it through
 * `mv-ai-bridge install <gameDir>`; it is meant to be the last plugin in the
 * list so that its wrappers see every other plugin's behaviour.
 *
 * Protocol version: 1. See README.md for the message schema.
 */
//=============================================================================

(function () {
    'use strict';

    var PLUGIN_NAME = 'MV_AI_Bridge';
    var VERSION = '0.1.0';
    var PROTO = 1;

    var params = PluginManager.parameters(PLUGIN_NAME) || {};
    var HOST = String(params['Host'] || '127.0.0.1');
    var PORT = parseInt(params['Port'], 10) || 7321;
    var TOKEN_PARAM = String(params['Token'] || '').trim();
    var DEBUG = String(params['Debug'] || 'false') === 'true';
    // NW.js has no visible console for players, so Debug can look like a
    // no-op. LogFile appends the same lines to a file instead (relative paths
    // are resolved from the game's working directory).
    var LOG_FILE = String(params['LogFile'] || '').trim();
    if (LOG_FILE === 'true') LOG_FILE = 'www/mv-ai-bridge.log';
    var fsMod = null;
    var pathMod = null;
    var READ_DELAY = clamp(
        params['ReadDelay'] === undefined ? 2000 : (parseInt(params['ReadDelay'], 10) || 0),
        0, 10000);
    // Off by default: when on, the map stops updating while no job is running
    // and the scene is settled, so the world does not move while the agent is
    // thinking. Rendering and input polling continue, so the window still draws.
    var FREEZE_WHILE_THINKING = String(params['FreezeWhileThinking'] || 'false') === 'true';

    var DIRS = { down: 2, left: 4, right: 6, up: 8 };
    var DIR_BTN = { 2: 'down', 4: 'left', 6: 'right', 8: 'up' };
    var BUTTONS = ['ok', 'cancel', 'up', 'down', 'left', 'right', 'shift', 'menu', 'pageup', 'pagedown', 'debug', 'escape'];

    //-------------------------------------------------------------------------
    // Small utilities

    function now() {
        return (typeof performance !== 'undefined' && performance.now)
            ? performance.now() : Date.now();
    }

    function logArg(a) {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch (e) { return String(a); }
    }

    function fileLog(args) {
        if (!LOG_FILE || typeof require !== 'function') return;
        try {
            if (!fsMod) fsMod = require('fs');
            if (!pathMod) pathMod = require('path');
            var dest = pathMod.isAbsolute(LOG_FILE)
                ? LOG_FILE
                : pathMod.join(process.cwd(), LOG_FILE);
            var line = '[' + new Date().toISOString() + '] ' +
                args.map(logArg).join(' ').slice(0, 4000) + '\r\n';
            fsMod.appendFileSync(dest, line);
        } catch (e) { /* logging must never break the game */ }
    }

    function log() {
        if (!DEBUG && !LOG_FILE) return;
        var args = Array.prototype.slice.call(arguments);
        if (DEBUG) console.log.apply(console, ['[MV_AI_Bridge]'].concat(args));
        if (LOG_FILE) fileLog(args);
    }

    function clamp(n, lo, hi) {
        return Math.max(lo, Math.min(hi, n));
    }

    function safe(fn, fallback) {
        try { return fn(); } catch (e) { log('error', e && e.stack || e); return fallback; }
    }

    function sceneOf() {
        return SceneManager._scene || null;
    }

    function sceneTag() {
        var s = sceneOf();
        if (!s) return 'none';
        if (typeof Scene_Battle !== 'undefined' && s instanceof Scene_Battle) return 'battle';
        if (typeof Scene_Map !== 'undefined' && s instanceof Scene_Map) return 'map';
        if (typeof Scene_Title !== 'undefined' && s instanceof Scene_Title) return 'title';
        var name = s.constructor && s.constructor.name ? s.constructor.name : 'unknown';
        return name.replace(/^Scene_/, '').toLowerCase();
    }

    function inMap() {
        return typeof $gameMap !== 'undefined' && $gameMap &&
            typeof $gamePlayer !== 'undefined' && $gamePlayer &&
            typeof $dataMap !== 'undefined' && $dataMap;
    }

    function inBattle() {
        return typeof Scene_Battle !== 'undefined' && sceneOf() instanceof Scene_Battle;
    }

    function mapInfoName(id) {
        var infos = $dataMapInfos && $dataMapInfos[id];
        return infos && infos.name ? String(infos.name) : '';
    }

    function mapDisplayName() {
        if (!$dataMap) return '';
        if ($dataMap.displayName) return String($dataMap.displayName);
        return $gameMap ? mapInfoName($gameMap.mapId()) : '';
    }

    // Parent maps give the agent regional context ("Cave 1 > Cave 2 > Cave 3").
    function mapArea() {
        var chain = [];
        try {
            var infos = $dataMapInfos && $dataMapInfos[$gameMap.mapId()];
            while (infos && infos.parentId) {
                infos = $dataMapInfos[infos.parentId];
                if (!infos) break;
                chain.unshift(String(infos.name || ''));
            }
        } catch (e) { /* ignore */ }
        return chain;
    }

    function messageWindow() {
        var s = sceneOf();
        if (!s) return null;
        if (s._messageWindow) return s._messageWindow;
        if (s._windowLayer) {
            var kids = s._windowLayer.children || [];
            for (var i = 0; i < kids.length; i++) {
                if (kids[i] && kids[i].constructor && kids[i].constructor.name === 'Window_Message') {
                    return kids[i];
                }
            }
        }
        return null;
    }

    function choiceWindow() {
        var mw = messageWindow();
        if (mw && mw._choiceWindow) return mw._choiceWindow;
        var s = sceneOf();
        if (s && s._choiceWindow) return s._choiceWindow;
        if (s && s._messageWindow && s._messageWindow._choiceWindow) return s._messageWindow._choiceWindow;
        return null;
    }

    // An event's "Select Item" command opens Window_EventItem over the map.
    // It is a normal Window_ItemList, so the same virtual keys drive it.
    function itemChoiceWindow() {
        var ok = safe(function () {
            return !!($gameMessage && $gameMessage.isItemChoice && $gameMessage.isItemChoice());
        }, false);
        if (!ok) return null;
        var mw = messageWindow();
        if (mw && mw._itemWindow) return mw._itemWindow;
        var s = sceneOf();
        if (s && s._messageWindow && s._messageWindow._itemWindow) return s._messageWindow._itemWindow;
        return null;
    }

    // A pending SetChoices command is not the same as a choice the player can
    // pick: the text may still be typing. Only the open, active window counts.
    function choiceVisible() {
        var w = choiceWindow();
        if (!w) return false;
        // Some message plugins leave an open but empty choice window behind on
        // the map; that is not a decision point the player has to answer.
        if (!(w._list && w._list.length)) return false;
        if (w.active) return true;
        return !!(w.isOpen && w.isOpen() && w.visible !== false && w.index && w.index() >= 0);
    }

    function currentChoiceIndex() {
        var w = choiceWindow();
        if (w && typeof w.index === 'function') return w.index();
        return null;
    }

    // A window is "in play" while it is visible and opening/open. Custom
    // battle systems often keep .active false even while they accept input,
    // so .active alone is not a reliable test.
    function windowLive(w) {
        if (!w) return false;
        if (w.visible === false) return false;
        return !!safe(function () {
            if (typeof w.openness === 'number') return w.openness > 0;
            return typeof w.isOpen === 'function' ? w.isOpen() : true;
        }, false);
    }

    function isEventRunning() {
        return !!(typeof $gameMap !== 'undefined' && $gameMap && $gameMap.isEventRunning && $gameMap.isEventRunning());
    }

    function isMessageBusy() {
        return !!(typeof $gameMessage !== 'undefined' && $gameMessage && $gameMessage.isBusy && $gameMessage.isBusy());
    }

    function isTransferring() {
        return !!(typeof $gamePlayer !== 'undefined' && $gamePlayer && $gamePlayer.isTransferring && $gamePlayer.isTransferring());
    }

    function isPlayerMoving() {
        return !!(typeof $gamePlayer !== 'undefined' && $gamePlayer && $gamePlayer.isMoving && $gamePlayer.isMoving());
    }

    function isSettled() {
        if (sceneTag() !== 'map' || !inMap()) return false;
        if (typeof SceneManager !== 'undefined' && SceneManager.isSceneChanging && SceneManager.isSceneChanging()) return false;
        if (isEventRunning() || isMessageBusy() || choiceVisible()) return false;
        if (isTransferring() || isPlayerMoving()) return false;
        var s = sceneOf();
        if (s && s._encounterEffectDuration > 0) return false;
        if (s && s._waitCount > 0) return false;
        if (s && s._fadeDuration > 0) return false;
        if (s && typeof s.isBusy === 'function' && s.isBusy()) return false;
        return true;
    }

    // The optional thinking freeze. Only ever holds a settled map with no job
    // in flight; input polling and rendering keep running so the window stays
    // responsive and is still capturable by OBS.
    function worldFrozen() {
        if (!FREEZE_WHILE_THINKING) return false;
        if (activeJob) return false;
        if (typeof SceneManager === 'undefined' || !SceneManager._scene) return false;
        if (typeof SceneManager.isCurrentSceneStarted === 'function' &&
            !SceneManager.isCurrentSceneStarted()) return false;
        return isSettled();
    }

    //-------------------------------------------------------------------------
    // Text

    function cleanText(text) {
        if (text === null || text === undefined) return '';
        var s = String(text);
        if (s.indexOf('\x1b') < 0 && s.indexOf('\\') < 0) return s.replace(/\f/g, '\n');
        try {
            var ctx = {
                actorName: function (n) {
                    var a = n >= 1 ? $gameActors.actor(n) : null;
                    return a ? a.name() : '';
                },
                partyMemberName: function (n) {
                    var m = $gameParty.members();
                    var a = n >= 1 ? m[n - 1] : null;
                    return a ? a.name() : '';
                }
            };
            s = Window_Base.prototype.convertEscapeCharacters.call(ctx, s);
        } catch (e) { /* keep raw text */ }
        s = s.replace(/\x1b[A-Za-z]+\[\d+\]/g, '');
        s = s.replace(/\x1b[A-Za-z]+/g, '');
        s = s.replace(/\x1b/g, '');
        // Literal codes survive when the author double-escaped them
        // ("\\C[17]") or a plugin bypassed convertEscapeCharacters. Strip the
        // whole family so they never reach the agent's context.
        s = s.replace(/\\+[A-Za-z]+\[\d+\]/g, '');
        s = s.replace(/\\+[{}.,|!><^$]/g, '');
        s = s.replace(/\f/g, '\n');
        // Translation artifacts sometimes carry a literal \n instead of a line break.
        s = s.replace(/\\r\\n/g, '\n');
        s = s.replace(/\\n/g, '\n');
        return s;
    }

    function messageInfo() {
        if (!isMessageBusy()) return null;
        var texts = ($gameMessage._texts || []).slice();
        var raw = texts.join('\n');
        var waiting = 'ok';
        if (choiceVisible()) waiting = 'choice';
        else if ($gameMessage.isNumberInput && $gameMessage.isNumberInput()) waiting = 'number';
        else if ($gameMessage.isItemChoice && $gameMessage.isItemChoice()) waiting = 'item';
        var choices = null;
        if (waiting === 'choice') {
            choices = ($gameMessage._choices || []).map(function (c) { return cleanText(c); });
        }
        var speaker = $gameMessage._speakerName || $gameMessage._speaker || null;
        var mw = messageWindow();
        return {
            active: true,
            text: cleanText(raw),
            waiting_for: waiting,
            choices: choices,
            index: waiting === 'choice' ? currentChoiceIndex() : null,
            speaker: speaker ? String(speaker) : null,
            window_hidden: !!(mw && typeof mw.isHidden === 'function' && mw.isHidden())
        };
    }

    function stateNames(battler) {
        return safe(function () {
            return battler.states().filter(function (st) { return st && st.id !== 0; })
                .map(function (st) { return st.name; });
        }, []);
    }

    function partyInfo() {
        var out = [];
        try {
            var members = $gameParty.members();
            for (var i = 0; i < members.length; i++) {
                var a = members[i];
                if (!a) continue;
                out.push({
                    id: a.actorId(),
                    name: a.name(),
                    level: a.level,
                    hp: a.hp,
                    mhp: a.mhp,
                    mp: a.mp,
                    mmp: a.mmp,
                    state: a.isDead() ? 'dead' : 'alive',
                    states: stateNames(a)
                });
            }
        } catch (e) { /* ignore */ }
        return out;
    }

    function commandList(win) {
        var out = [];
        var list = win && win._list ? win._list : [];
        for (var i = 0; i < list.length; i++) {
            var c = list[i];
            out.push({
                index: i,
                name: cleanText(c && c.name !== undefined ? c.name : ''),
                symbol: c ? c.symbol : null,
                ext: c && c.ext !== undefined ? c.ext : null,
                enabled: !(c && c.enabled === false)
            });
        }
        return out;
    }

    // Mirrors Window_BattleSkill: one list per skill type, unfiltered by
    // canUse so index order matches the real window (disabled entries included).
    function skillOptionList(actor) {
        var groups = [];
        var types = [];
        try { types = actor.addedSkillTypes().slice().sort(function (a, b) { return a - b; }); } catch (e) { types = []; }
        for (var ti = 0; ti < types.length; ti++) {
            var tid = types[ti];
            var skills = [];
            try {
                skills = actor.skills().filter(function (sk) { return sk.stypeId === tid; });
            } catch (e) { skills = []; }
            groups.push({
                stype_id: tid,
                name: ($dataSystem.skillTypes && $dataSystem.skillTypes[tid]) || ('type ' + tid),
                skills: skills.map(function (sk, i) {
                    return {
                        index: i,
                        id: sk.id,
                        name: sk.name,
                        mp_cost: safe(function () { return actor.skillMpCost(sk); }, sk.mp || 0),
                        tp_cost: safe(function () { return actor.skillTpCost(sk); }, 0),
                        usable: safe(function () { return actor.canUse(sk); }, false),
                        description: cleanText(sk.description || '')
                    };
                })
            });
        }
        return groups;
    }

    // Mirrors Window_BattleItem: $gameParty.items() filtered by canUse.
    function battleItemList() {
        var out = [];
        try {
            var items = $gameParty.items().filter(function (it) { return $gameParty.canUse(it); });
            out = items.map(function (it, i) {
                return {
                    index: i,
                    id: it.id,
                    name: it.name,
                    count: $gameParty.numItems(it),
                    description: cleanText(it.description || '')
                };
            });
        } catch (e) { /* ignore */ }
        return out;
    }

    function actorBrief(actor) {
        return {
            id: actor.actorId(),
            name: actor.name(),
            index: $gameParty.members().indexOf(actor),
            hp: actor.hp, mhp: actor.mhp, mp: actor.mp, mmp: actor.mmp,
            states: safe(function () { return actor.states().map(function (st) { return st.name; }); }, [])
        };
    }

    // Party commands (fight / escape in stock MV). Window_PartyCommand builds
    // its list in initialize, so it is readable even before it opens.
    function partyCommandOptions(win) {
        if (win && win._list && win._list.length) return commandList(win);
        return [
            {
                index: 0,
                name: cleanText(safe(function () { return TextManager.fight; }, 'fight') || 'fight'),
                symbol: 'fight', ext: null, enabled: true
            },
            {
                index: 1,
                name: cleanText(safe(function () { return TextManager.escape; }, 'escape') || 'escape'),
                symbol: 'escape', ext: null,
                enabled: safe(function () { return BattleManager.canEscape(); }, true)
            }
        ];
    }

    // Actor commands (attack, one per skill type carrying skills, guard, item
    // in stock MV). Fall back to the same construction when the scene does
    // not keep a Window_ActorCommand.
    function actorCommandOptions(win, actor) {
        if (win && win._list && win._list.length) return commandList(win);
        var out = [];
        function add(symbol, name, enabled, ext) {
            out.push({
                index: out.length,
                name: cleanText(name || symbol),
                symbol: symbol,
                ext: ext === undefined ? null : ext,
                enabled: enabled !== false
            });
        }
        add('attack', safe(function () { return TextManager.attack; }, 'attack') || 'attack', true);
        var types = safe(function () { return actor.addedSkillTypes(); }, []) || [];
        for (var i = 0; i < types.length; i++) {
            var tid = types[i];
            var has = safe(function () {
                return actor.skills().some(function (sk) { return sk.stypeId === tid; });
            }, false);
            if (!has) continue;
            var tname = ($dataSystem.skillTypes && $dataSystem.skillTypes[tid]) || ('type ' + tid);
            add('skill', tname, true, tid);
        }
        add('guard', safe(function () { return TextManager.guard; }, 'guard') || 'guard', true);
        add('item', safe(function () { return TextManager.item; }, 'item') || 'item', true);
        return out;
    }

    function enemyTargetList(win) {
        var list = win && win._enemies ? win._enemies : safe(function () { return $gameTroop.aliveMembers(); }, []);
        return (list || []).map(function (en, i) {
            return {
                index: i,
                troop_index: safe(function () { return en.index(); }, i),
                id: en.enemyId(),
                name: en.name(),
                hp: en.hp,
                mhp: en.mhp,
                dead: en.isDead(),
                states: stateNames(en)
            };
        });
    }

    function actorTargetList() {
        return $gameParty.members().map(function (a, i) {
            return {
                index: i,
                id: a.actorId(),
                name: a.name(),
                hp: a.hp,
                mhp: a.mhp,
                dead: a.isDead(),
                states: stateNames(a)
            };
        });
    }

    function battleInfo() {
        var s = sceneOf();
        if (!(s instanceof Scene_Battle)) return null;
        var info = { phase: null, turn: null, inputting: false, active_window: null, enemies: [], party: partyInfo() };
        try { info.phase = BattleManager._phase || null; } catch (e) {}
        try { info.turn = BattleManager._turn || null; } catch (e) {}
        try { info.inputting = !!(BattleManager.isInputting && BattleManager.isInputting()); } catch (e) {}
        try {
            if (info.inputting && BattleManager.actor()) info.actor = actorBrief(BattleManager.actor());
        } catch (e) {}
        try {
            var troops = $gameTroop.members();
            for (var i = 0; i < troops.length; i++) {
                var e = troops[i];
                info.enemies.push({
                    index: i,
                    id: e.enemyId(),
                    name: e.name(),
                    hp: e.hp,
                    mhp: e.mhp,
                    dead: e.isDead(),
                    states: stateNames(e)
                });
            }
        } catch (e) {}
        var waiting = inputWindow(s);
        info.waiting = waiting ? waiting.name : null;
        info.windows = {
            party_command: windowLive(s._partyCommandWindow),
            actor_command: windowLive(s._actorCommandWindow),
            skill: windowLive(s._skillWindow),
            item: windowLive(s._itemWindow),
            actor_target: windowLive(s._actorWindow),
            enemy_target: windowLive(s._enemyWindow)
        };
        if (waiting) info.waiting_index = safe(function () { return waiting.win.index(); }, null);
        if (s._skillWindow && windowLive(s._skillWindow)) {
            info.windows.skill_index = safe(function () { return s._skillWindow.index(); }, null);
            info.windows.skill_rows = safe(function () { return (s._skillWindow._data || []).length; }, null);
        }
        var mw = messageWindow();
        if (mw) {
            info.windows.message = { active: !!mw.active, open: safe(function () { return mw.isOpen(); }, null), pause: !!mw.pause };
        }

        // During input the agent needs every option up front, not just the
        // window that happens to be focused: choosing a command is what opens
        // the skill/target windows.
        var inputting = !!info.inputting;
        var actor = safe(function () { return inputting ? BattleManager.actor() : null; }, null);
        if (!actor && s._actorCommandWindow && s._actorCommandWindow._actor) {
            actor = safe(function () { return s._actorCommandWindow._actor; }, null);
        }
        var partyCmds = partyCommandOptions(s._partyCommandWindow);
        if (inputting) info.party_commands = partyCmds;
        if (actor) {
            info.actor = actorBrief(actor);
            info.actor_commands = actorCommandOptions(s._actorCommandWindow, actor);
            if (inputting) {
                info.skill_types = skillOptionList(actor);
                info.items = battleItemList();
            }
        } else if (s._actorCommandWindow && windowLive(s._actorCommandWindow)) {
            info.actor_commands = commandList(s._actorCommandWindow);
        }
        if (inputting) {
            info.commands = (waiting && waiting.name === 'party_command')
                ? partyCmds
                : (info.actor_commands || partyCmds);
            info.enemy_targets = enemyTargetList(s._enemyWindow);
            info.actor_targets = actorTargetList();
        }

        if (s._skillWindow && windowLive(s._skillWindow)) {
            var sw = s._skillWindow;
            info.skill_window = {
                stype_id: sw._stypeId,
                cursor: safe(function () { return sw.index(); }, null),
                skills: (sw._data || []).map(function (sk, i) {
                    return {
                        index: i,
                        id: sk.id,
                        name: sk.name,
                        mp_cost: safe(function () { return sw._actor ? sw._actor.skillMpCost(sk) : sk.mp || 0; }, sk.mp || 0),
                        tp_cost: safe(function () { return sw._actor ? sw._actor.skillTpCost(sk) : 0; }, 0),
                        usable: safe(function () { return sw._actor && sw._actor.canUse(sk); }, false)
                    };
                })
            };
        }
        if (s._itemWindow && windowLive(s._itemWindow)) {
            info.item_window = (s._itemWindow._data || []).map(function (it, i) {
                return { index: i, id: it.id, name: it.name, count: $gameParty.numItems(it) };
            });
        }
        if (s._actorWindow && windowLive(s._actorWindow)) {
            info.active_window = 'actor_target';
            info.targets = actorTargetList();
        } else if (s._enemyWindow && windowLive(s._enemyWindow)) {
            info.active_window = 'enemy_target';
            info.targets = enemyTargetList(s._enemyWindow);
        } else if (waiting) {
            info.active_window = waiting.name;
        } else if (mw && mw.active) {
            info.active_window = 'message';
        }
        return info;
    }

    // Generic window snapshot for non-map scenes. MV menus, shops and custom
    // screens all build on Window_Selectable, so reading each visible window's
    // own list/data keeps the bridge usable without knowing the plugin.
    function windowItems(w) {
        var list = (w._list && w._list.length) ? w._list : ((w._data && w._data.length) ? w._data : null);
        if (!list) return null;
        var out = [];
        for (var i = 0; i < list.length && i < 100; i++) {
            var it = list[i];
            if (it === null || it === undefined) { out.push(null); continue; }
            var entry = { index: i, name: cleanText(it.name !== undefined ? it.name : it) };
            if (it.name !== undefined) {
                if (it.id !== undefined) entry.id = it.id;
                if (it.symbol !== undefined) entry.symbol = it.symbol;
                if (it.enabled !== undefined) entry.enabled = !!it.enabled;
                if (it.ext !== undefined) entry.ext = it.ext;
            }
            if (typeof w.price === 'function') {
                // Stock MV passes the item to price(); some plugins pass an
                // index instead. Ask both ways and keep the meaningful answer.
                var byItem = safe(function () { return w.price(it); }, null);
                var byIndex = safe(function () { return w.price(i); }, null);
                var price = (byItem === null || byItem === undefined || (byItem === 0 && byIndex))
                    ? byIndex : byItem;
                if (price !== null && price !== undefined) entry.price = price;
            }
            if (typeof w.isEnabled === 'function') {
                entry.enabled = safe(function () { return !!w.isEnabled(it); }, entry.enabled !== false);
            }
            var count = safe(function () {
                if (!(DataManager.isItem(it) || DataManager.isWeapon(it) || DataManager.isArmor(it))) return null;
                return $gameParty.numItems(it);
            }, null);
            if (count !== null) entry.count = count;
            out.push(entry);
        }
        return out;
    }

    // The stock savefile window keeps no item list: it draws straight from
    // DataManager global info. Read the slots explicitly so the agent knows
    // which ones exist before pressing ok and overwriting a save.
    // Stock MV 1.6.1 has no DataManager.savefileInfo; the save-list windows
    // use isThisGameFile (globalId/title check) plus loadSavefileInfo, which
    // reads the same global.rpgsave metadata they render.
    function savefileSlots() {
        var max = clamp(safe(function () { return DataManager.maxSavefiles(); }, 20), 1, 100);
        var out = [];
        for (var i = 1; i <= max; i++) {
            var exists = !!safe(function () { return DataManager.isThisGameFile(i); }, false);
            var info = exists ? safe(function () { return DataManager.loadSavefileInfo(i); }, null) : null;
            var slot = { index: i - 1, file_id: i, exists: exists };
            if (info) {
                if (info.timestamp) {
                    var ts = Number(info.timestamp);
                    slot.timestamp = isNaN(ts) ? String(info.timestamp) : new Date(ts).toISOString();
                }
                if (info.playtime !== undefined) slot.playtime = info.playtime;
                if (info.title !== undefined) slot.title = String(info.title);
                // charactersForSavefile stores [filename, index] pairs.
                var chars = info.characters;
                if (chars && chars.length) {
                    slot.characters = chars.filter(Boolean).map(function (c) {
                        return String(Array.isArray(c) ? c[0] : c);
                    }).slice(0, 4);
                    if (slot.characters.length) slot.lead = slot.characters[0];
                }
                // Plugins may add fields to global info; pass through the ones
                // that answer "who/where" without guessing.
                if (info.level !== undefined) slot.level = info.level;
                if (info.map !== undefined) slot.map = info.map;
                if (info.mapId !== undefined) slot.map_id = info.mapId;
                if (info.mapName !== undefined) slot.map_name = info.mapName;
            }
            out.push(slot);
        }
        return out;
    }

    function uiInfo() {
        var s = sceneOf();
        if (!s || !s._windowLayer) return null;
        var kids = s._windowLayer.children || [];
        var windows = [];
        for (var i = 0; i < kids.length; i++) {
            var w = kids[i];
            if (!w) continue;
            // Custom menus (MOG and friends) keep the real windows offscreen
            // and draw sprites instead; the window still owns the cursor, so
            // active or open windows count even when they are not visible.
            var open = safe(function () { return !!(w.isOpen && w.isOpen()); }, false);
            if (!w.visible && !w.active && !open) continue;
            var cname = (w.constructor && w.constructor.name) || 'Window';
            var win = {
                name: cname,
                active: !!w.active,
                open: open,
                visible: w.visible !== false
            };
            var cols = safe(function () { return w.maxCols ? w.maxCols() : null; }, null);
            if (cols) win.max_cols = cols;
            if (typeof w.index === 'function') win.index = safe(function () { return w.index(); }, null);
            if (typeof w.maxItems === 'function') win.max_items = safe(function () { return w.maxItems(); }, null);
            var items = windowItems(w);
            if (items) win.items = items;
            if (cname === 'Window_SavefileList') win.slots = savefileSlots();
            var text = safe(function () { return w._text ? cleanText(w._text) : null; }, null);
            if (text) win.text = text;
            windows.push(win);
        }
        return { scene: sceneTag(), windows: windows };
    }

    function briefState() {
        var st = {
            tick: tick,
            scene: sceneTag(),
            settled: false,
            map: null,
            player: null,
            message: null,
            choices: null,
            battle: null,
            party: null
        };
        if (inMap()) {
            st.map = {
                id: $gameMap.mapId(),
                name: mapDisplayName(),
                area: mapArea(),
                width: $gameMap.width(),
                height: $gameMap.height()
            };
            st.player = {
                x: $gamePlayer.x,
                y: $gamePlayer.y,
                direction: $gamePlayer.direction(),
                moving: isPlayerMoving(),
                transferring: isTransferring()
            };
            st.settled = isSettled();
            // True only while the optional FreezeWhileThinking mode is holding
            // the map still. The agent needs this to know that distances will
            // not change between two observes.
            st.world_frozen = safe(worldFrozen, false);
            // Keep monsters visible in the primary perception tool, so the
            // agent can decide to engage or keep clear without extra queries.
            st.threats = safe(function () {
                return sceneTag() === 'map' ? hazardsNear(8) : [];
            }, []);
            // Quest markers ("!" / "?") sit on separate overlay events; list
            // them so the first observe shows where the story continues.
            st.balloons = safe(function () {
                return sceneTag() === 'map' ? balloonsNear(8) : [];
            }, []);
        }
        st.message = safe(messageInfo, null);
        var w = choiceWindow();
        if (w && (w.active || w.isOpen()) && w._list && w._list.length) {
            st.choices = {
                visible: true,
                index: typeof w.index === 'function' ? w.index() : null,
                items: w._list.map(function (it) { return cleanText(it && it.name !== undefined ? it.name : it); })
            };
        }
        st.battle = safe(battleInfo, null);
        var wantUi = st.scene !== 'map' && st.scene !== 'battle' && st.scene !== 'none';
        // A map event can open an item or number window on top of the map;
        // expose it like any other menu so the agent can drive it by buttons.
        if (!wantUi && st.scene === 'map' && st.message &&
            (st.message.waiting_for === 'item' || st.message.waiting_for === 'number')) {
            wantUi = true;
        }
        if (wantUi) {
            st.ui = safe(uiInfo, null);
        }
        if (typeof $gameParty !== 'undefined' && $gameParty && $gameParty.gold) {
            st.party = { gold: $gameParty.gold(), members: safe(partyInfo, []) };
        }
        return st;
    }

    //-------------------------------------------------------------------------
    // World queries

    // Roaming encounters are ordinary map events, and their battle can sit in
    // the page itself (code 301) or in a common event the page calls (code 117).
    // Scan only the page that is active right now and follow those calls.
    var hazardCache = {};

    function eventData(ev) {
        try { return ev.event ? ev.event() : null; } catch (e) { return null; }
    }

    function listHasBattle(list, seen) {
        for (var i = 0; i < list.length; i++) {
            var c = list[i];
            if (!c) continue;
            if (c.code === 301) return true;
            if (c.code === 117 && commonEventHasBattle(c.parameters[0], seen)) return true;
        }
        return false;
    }

    function commonEventHasBattle(id, seen) {
        if (!id || seen[id]) return false;
        seen[id] = true;
        var ce = (typeof $dataCommonEvents !== 'undefined' && $dataCommonEvents) ? $dataCommonEvents[id] : null;
        return !!(ce && ce.list && listHasBattle(ce.list, seen));
    }

    function eventHazard(ev) {
        var data = eventData(ev);
        var page = (data && data.pages && ev._pageIndex >= 0) ? data.pages[ev._pageIndex] : null;
        if (!page) return false;
        var key = $gameMap.mapId() + ':' + ev.eventId() + ':' + ev._pageIndex;
        if (hazardCache[key] !== undefined) return hazardCache[key];
        var hazard = listHasBattle(page.list || [], {});
        hazardCache[key] = hazard;
        return hazard;
    }

    function eventTrigger(ev) {
        var data = eventData(ev);
        var page = data && data.pages && data.pages[ev._pageIndex];
        return page ? page.trigger : null;
    }

    // Number of executable commands in the active page; 0 means the page is an
    // empty placeholder and the action button will not visibly respond.
    function eventCommandCount(ev) {
        var list = safe(function () { return ev.list(); }, null);
        if (!list) return 0;
        var n = 0;
        for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].code !== 0) n++;
        }
        return n;
    }

    // Quest markers in this engine are separate overlay events drawn with a
    // balloon charset (for example !$bikuri above an NPC). MV event pages have
    // no balloon field, so the charset name is the durable signal; _balloonId
    // covers the transient Show Balloon Icon case.
    var BALLOON_IMAGES = [
        { re: /bikk?uri/i, id: 1 },          // exclamation
        { re: /hatena|question/i, id: 2 }    // question mark
    ];

    function pageImageName(ev) {
        var data = eventData(ev);
        var page = (data && data.pages && ev._pageIndex >= 0) ? data.pages[ev._pageIndex] : null;
        return page && page.image && page.image.characterName
            ? String(page.image.characterName) : '';
    }

    function eventBalloon(ev) {
        var live = safe(function () { return Number(ev._balloonId) || 0; }, 0);
        if (live > 0) return live;
        var name = pageImageName(ev);
        for (var i = 0; i < BALLOON_IMAGES.length; i++) {
            if (BALLOON_IMAGES[i].re.test(name)) return BALLOON_IMAGES[i].id;
        }
        return 0;
    }

    function eventPageInfo(ev) {
        var data = eventData(ev);
        return {
            index: ev._pageIndex,
            count: data && data.pages ? data.pages.length : 0
        };
    }

    // Plugin tags live in comment commands (108, continued by 408). Exposing
    // them keeps note-driven plugins (quest markers, shops) readable.
    function pageComments(ev) {
        var list = safe(function () { return ev.list(); }, null) || [];
        var out = [];
        var inComment = false;
        for (var i = 0; i < list.length; i++) {
            var c = list[i];
            if (!c) { inComment = false; continue; }
            if (c.code === 108) {
                inComment = true;
                out.push(String(c.parameters[0] || ''));
            } else if (c.code === 408 && inComment) {
                out.push(String(c.parameters[0] || ''));
            } else {
                inComment = false;
            }
        }
        return out.join('\n').trim().slice(0, 800);
    }

    function eventNote(ev) {
        var data = eventData(ev);
        return data && data.note ? String(data.note).trim().slice(0, 800) : '';
    }

    // An event "chases" when its active page walks toward the player, either
    // through the built-in approach move type or a custom route command 9.
    function eventChases(ev) {
        var data = eventData(ev);
        var page = (data && data.pages && ev._pageIndex >= 0) ? data.pages[ev._pageIndex] : null;
        if (!page) return false;
        if (page.moveType === 2) return true;
        if (page.moveType !== 3 || !page.moveRoute) return false;
        var list = page.moveRoute.list || [];
        for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].code === 9) return true;
        }
        return false;
    }

    function threatInfo(ev, dist) {
        var data = eventData(ev);
        return {
            id: ev.eventId(),
            name: data && data.name ? String(data.name) : null,
            x: ev.x,
            y: ev.y,
            distance: dist,
            moving: ev.isMoving(),
            chases: eventChases(ev)
        };
    }

    // Quest-marker overlays near the player, closest first. Same radius and
    // shape as threats so the first observe already shows where the story is.
    function balloonsNear(radius) {
        var out = [];
        if (!inMap()) return out;
        var px = $gamePlayer.x;
        var py = $gamePlayer.y;
        var events = $gameMap.events();
        for (var i = 0; i < events.length; i++) {
            var ev = events[i];
            if (!ev || ev._erased) continue;
            var balloon = eventBalloon(ev);
            if (!balloon) continue;
            var d = Math.abs(ev.x - px) + Math.abs(ev.y - py);
            if (d > radius) continue;
            var data = eventData(ev);
            out.push({
                id: ev.eventId(),
                name: data && data.name ? String(data.name) : null,
                x: ev.x,
                y: ev.y,
                distance: d,
                balloon: balloon,
                image: pageImageName(ev)
            });
        }
        out.sort(function (a, b) { return a.distance - b.distance || a.id - b.id; });
        return out;
    }

    // Battle-capable events near the player, closest first.
    function hazardsNear(radius) {
        var out = [];
        if (!inMap()) return out;
        var px = $gamePlayer.x;
        var py = $gamePlayer.y;
        var events = $gameMap.events();
        for (var i = 0; i < events.length; i++) {
            var ev = events[i];
            if (!ev || ev._erased || !eventHazard(ev)) continue;
            var d = Math.abs(ev.x - px) + Math.abs(ev.y - py);
            if (d > radius) continue;
            out.push(threatInfo(ev, d));
        }
        out.sort(function (a, b) { return a.distance - b.distance || a.id - b.id; });
        return out;
    }

    // The hazard event the next step would move toward, if any.
    function hazardAhead(radius, dir) {
        if (!inMap()) return null;
        var px = $gamePlayer.x;
        var py = $gamePlayer.y;
        var nx = $gameMap.roundXWithDirection(px, dir);
        var ny = $gameMap.roundYWithDirection(py, dir);
        var events = $gameMap.events();
        var best = null;
        for (var i = 0; i < events.length; i++) {
            var ev = events[i];
            if (!ev || ev._erased || !eventHazard(ev)) continue;
            var d = Math.abs(ev.x - px) + Math.abs(ev.y - py);
            if (d > radius) continue;
            var nd = Math.abs(ev.x - nx) + Math.abs(ev.y - ny);
            if (nd >= d) continue;       // this step does not get closer
            if (!best || d < best.distance) best = threatInfo(ev, d);
        }
        return best;
    }

    // Predicate for findPath: tiles within `radius` of a battle event.
    function hazardBlocker(radius) {
        var cells = {};
        var events = $gameMap.events();
        for (var i = 0; i < events.length; i++) {
            var ev = events[i];
            if (!ev || ev._erased || !eventHazard(ev)) continue;
            for (var dy = -radius; dy <= radius; dy++) {
                for (var dx = -radius; dx <= radius; dx++) {
                    if (Math.abs(dx) + Math.abs(dy) > radius) continue;
                    cells[(ev.x + dx) + ',' + (ev.y + dy)] = true;
                }
            }
        }
        return function (x, y) { return !!cells[x + ',' + y]; };
    }

    function eventList(radius) {
        var out = [];
        if (!inMap()) return out;
        var px = $gamePlayer.x;
        var py = $gamePlayer.y;
        var events = $gameMap.events();
        for (var i = 0; i < events.length; i++) {
            var ev = events[i];
            // Erased events are invisible in-game (spent one-shot events), so
            // they should not show up as things the agent can walk up to.
            if (!ev || ev._erased) continue;
            var dist = Math.abs(ev.x - px) + Math.abs(ev.y - py);
            if (radius !== null && radius !== undefined && dist > radius) continue;
            var adjacent = dist === 1;
            var data = eventData(ev);
            var trigger = eventTrigger(ev);
            var normalPriority = ev.isNormalPriority();
            // Action-button events with priority 1 are triggered by facing them
            // from an adjacent tile. Priority 0/2 events are triggered only when
            // the player stands on the same tile. MV collision only treats
            // priority-1 events as obstacles, so priority 0/2 tiles are always
            // steppable regardless of the "through" checkbox.
            var interactFrom = normalPriority ? 'adjacent' : 'here';
            var actionTrigger = trigger === 0;
            var commands = eventCommandCount(ev);
            var info = {
                id: ev.eventId(),
                name: data && data.name ? String(data.name) : null,
                x: ev.x,
                y: ev.y,
                direction: ev.direction(),
                distance: dist,
                adjacent: adjacent,
                normal_priority: normalPriority,
                through: ev.isThrough(),
                moving: ev.isMoving(),
                hazard: eventHazard(ev),
                chases: eventChases(ev),
                balloon: eventBalloon(ev),
                page: eventPageInfo(ev),
                trigger: trigger,
                action_trigger: actionTrigger,
                commands: commands,
                empty: actionTrigger && commands === 0,
                interact_from: interactFrom,
                interactable: actionTrigger && commands > 0 && (normalPriority
                    ? (adjacent && !ev.isMoving())
                    : dist === 0)
            };
            // Keep the common case small; notes and page tags only cost tokens
            // when the author actually used them.
            var note = eventNote(ev);
            if (note) info.note = note;
            var comments = pageComments(ev);
            if (comments) info.page_note = comments;
            out.push(info);
        }
        out.sort(function (a, b) { return a.distance - b.distance || a.id - b.id; });
        return out;
    }

    // Default output is a compact character grid. Per-cell passability strings
    // are only meaningful to code, so they move behind detail:"full".
    function lookGrid(radius, detail) {
        if (!inMap()) return null;
        var full = detail === 'full';
        var px = $gamePlayer.x;
        var py = $gamePlayer.y;
        var w = $gameMap.width();
        var h = $gameMap.height();
        // A radius larger than the map used to produce an empty grid; clamp it
        // so "look radius:25" and overview mode always show what exists.
        radius = Math.max(1, Math.min(radius, Math.max(w, h)));
        var minX = Math.max(0, px - radius);
        var maxX = Math.min(w - 1, px + radius);
        var minY = Math.max(0, py - radius);
        var maxY = Math.min(h - 1, py + radius);
        var eventAt = {};
        var list = $gameMap.events();
        for (var i = 0; i < list.length; i++) {
            var ev = list[i];
            // Through events are usually invisible triggers; keep them out of
            // the grid unless they respond to the action button.
            if (!ev || ev._erased || (ev.isThrough() && eventTrigger(ev) !== 0)) continue;
            var k = ev.x + ',' + ev.y;
            (eventAt[k] = eventAt[k] || []).push(ev.eventId());
        }
        var rows = [];
        var ascii = [];
        var events = [];
        for (var y = minY; y <= maxY; y++) {
            var cells = [];
            var line = '';
            for (var x = minX; x <= maxX; x++) {
                var valid = $gameMap.isValid(x, y);
                var p = valid ? passabilityString(x, y) : '----';
                var ids = eventAt[x + ',' + y] || [];
                var ch = (x === px && y === py) ? '@' : (ids.length ? 'E' : (p === '----' ? '#' : '.'));
                line += ch;
                if (ids.length) events.push({ x: x, y: y, ids: ids });
                if (full) {
                    cells.push({
                        x: x,
                        y: y,
                        v: valid ? 1 : 0,
                        p: p,
                        e: ids,
                        me: (x === px && y === py) ? 1 : 0
                    });
                }
            }
            ascii.push(line);
            if (full) rows.push(cells);
        }
        var out = {
            map_id: $gameMap.mapId(),
            map_name: mapDisplayName(),
            width: w,
            height: h,
            center: { x: px, y: py },
            radius: radius,
            origin: { x: minX, y: minY },
            legend: '@ you, E event, . walkable, # blocked',
            ascii: ascii,
            events: events
        };
        if (full) {
            out.detail = 'full';
            out.passability_legend = 'p: UDLR = the tile can be left upward/downward/left/right, - = blocked';
            out.rows = rows;
        }
        return out;
    }

    //-------------------------------------------------------------------------
    // Pathfinding

    function heapPush(heap, node) {
        heap.push(node);
        var i = heap.length - 1;
        while (i > 0) {
            var p = (i - 1) >> 1;
            if (heap[p].f <= heap[i].f) break;
            var t = heap[p]; heap[p] = heap[i]; heap[i] = t;
            i = p;
        }
    }

    function heapPop(heap) {
        var top = heap[0];
        var last = heap.pop();
        if (heap.length > 0) {
            heap[0] = last;
            var i = 0;
            for (;;) {
                var l = i * 2 + 1;
                var r = l + 1;
                var m = i;
                if (l < heap.length && heap[l].f < heap[m].f) m = l;
                if (r < heap.length && heap[r].f < heap[m].f) m = r;
                if (m === i) break;
                var t = heap[m]; heap[m] = heap[i]; heap[i] = t;
                i = m;
            }
        }
        return top;
    }

    function findPath(sx, sy, tx, ty, opts) {
        opts = opts || {};
        if (!inMap()) return null;
        if (!$gameMap.isValid(tx, ty)) return null;
        if (sx === tx && sy === ty) return [];
        var maxNodes = opts.maxNodes || 30000;
        var heap = [];
        var nodes = {};
        var closed = {};
        function key(x, y) { return x + ',' + y; }
        var start = { x: sx, y: sy, g: 0, f: 0, parent: null };
        nodes[key(sx, sy)] = start;
        heapPush(heap, start);
        var visited = 0;
        var dirs = [2, 4, 6, 8];
        while (heap.length > 0) {
            var cur = heapPop(heap);
            var ck = key(cur.x, cur.y);
            if (closed[ck]) continue;
            closed[ck] = true;
            if (cur.x === tx && cur.y === ty) {
                var path = [];
                var n = cur;
                while (n.parent) {
                    path.push(directionBetween(n.parent.x, n.parent.y, n.x, n.y));
                    n = n.parent;
                }
                path.reverse();
                return path;
            }
            if (++visited > maxNodes) return null;
            for (var d = 0; d < dirs.length; d++) {
                var dir = dirs[d];
                var nx = $gameMap.roundXWithDirection(cur.x, dir);
                var ny = $gameMap.roundYWithDirection(cur.y, dir);
                if (!$gameMap.isValid(nx, ny)) continue;
                if (!$gamePlayer.canPass(cur.x, cur.y, dir)) continue;
                // Optional caller-supplied keep-out cells (dangerous tiles).
                // The goal itself is exempt so a deliberate approach still works.
                if (opts.blocked && !(nx === tx && ny === ty) && opts.blocked(nx, ny)) continue;
                var nk = key(nx, ny);
                if (closed[nk]) continue;
                var g = cur.g + 1;
                var existing = nodes[nk];
                if (!existing) {
                    var node = {
                        x: nx, y: ny, g: g, f: g + Math.abs(nx - tx) + Math.abs(ny - ty), parent: cur
                    };
                    nodes[nk] = node;
                    heapPush(heap, node);
                } else if (g < existing.g) {
                    existing.g = g;
                    existing.f = g + Math.abs(nx - tx) + Math.abs(ny - ty);
                    existing.parent = cur;
                    heapPush(heap, existing);
                }
            }
        }
        return null;
    }

    function directionBetween(x1, y1, x2, y2) {
        if (x2 > x1) return 6;
        if (x2 < x1) return 4;
        if (y2 > y1) return 2;
        if (y2 < y1) return 8;
        return 0;
    }

    // Tile-only passability summary, same "UDLR" notation as look.
    function passabilityString(x, y) {
        var up = $gameMap.isPassable(x, y, 8);
        var down = $gameMap.isPassable(x, y, 2);
        var left = $gameMap.isPassable(x, y, 4);
        var right = $gameMap.isPassable(x, y, 6);
        return (up ? 'U' : '-') + (down ? 'D' : '-') + (left ? 'L' : '-') + (right ? 'R' : '-');
    }

    // Flood fill with the same movement rules as findPath. Used only to
    // explain a failed path: which tile the player can actually get closest to.
    function reachableFrom(sx, sy, opts) {
        opts = opts || {};
        var dist = {};
        var queue = [{ x: sx, y: sy, d: 0 }];
        dist[sx + ',' + sy] = 0;
        var head = 0;
        var maxNodes = opts.maxNodes || 30000;
        var dirs = [2, 4, 6, 8];
        while (head < queue.length && head < maxNodes) {
            var cur = queue[head++];
            for (var i = 0; i < dirs.length; i++) {
                var dir = dirs[i];
                var nx = $gameMap.roundXWithDirection(cur.x, dir);
                var ny = $gameMap.roundYWithDirection(cur.y, dir);
                if (!$gameMap.isValid(nx, ny)) continue;
                if (!$gamePlayer.canPass(cur.x, cur.y, dir)) continue;
                if (opts.blocked && !(nx === opts.goalX && ny === opts.goalY) && opts.blocked(nx, ny)) continue;
                var nk = nx + ',' + ny;
                if (dist[nk] !== undefined) continue;
                dist[nk] = cur.d + 1;
                queue.push({ x: nx, y: ny, d: cur.d + 1 });
            }
        }
        return dist;
    }

    function nearestInSet(dist, tx, ty) {
        var best = null;
        for (var k in dist) {
            var parts = k.split(',');
            var x = parseInt(parts[0], 10);
            var y = parseInt(parts[1], 10);
            var md = Math.abs(x - tx) + Math.abs(y - ty);
            if (!best || md < best.distance || (md === best.distance && dist[k] < best.steps)) {
                best = { x: x, y: y, distance: md, steps: dist[k] };
            }
        }
        return best;
    }

    // Explain why the target could not be reached. Distinguishes a real wall,
    // an event occupying the tile, and one-way/ledge tiles that cannot be
    // entered from the reachable side.
    function targetEntryInfo(tx, ty, dist, avoid) {
        var info = {
            target_valid: $gameMap.isValid(tx, ty),
            target_passable: null,
            events_at_target: [],
            blocked_by: null
        };
        if (!info.target_valid) {
            info.blocked_by = 'out_of_bounds';
            return info;
        }
        info.target_passable = passabilityString(tx, ty);
        var evs = safe(function () { return $gameMap.eventsXyNt(tx, ty) || []; }, []);
        info.events_at_target = evs.map(function (e) {
            var d = eventData(e);
            return { id: e.eventId(), name: d && d.name ? String(d.name) : null };
        });
        var dirs = [2, 4, 6, 8];
        var enterable = false;
        var fromReachable = false;
        for (var i = 0; i < dirs.length; i++) {
            var dir = dirs[i];
            var nx = $gameMap.roundXWithDirection(tx, dir);
            var ny = $gameMap.roundYWithDirection(ty, dir);
            if (!$gameMap.isValid(nx, ny)) continue;
            if (!$gamePlayer.canPass(nx, ny, reverse(dir))) continue;
            enterable = true;
            if (dist[nx + ',' + ny] !== undefined) fromReachable = true;
        }
        // Only priority-1 events are movement obstacles; priority 0/2 events
        // can share the tile with the player.
        var blocking = evs.some(function (e) { return e.isNormalPriority(); });
        if (blocking) {
            info.blocked_by = 'event';
        } else if (!enterable) {
            info.blocked_by = info.target_passable === '----' ? 'wall' : 'one_way_tile';
        } else if (!fromReachable) {
            info.blocked_by = 'one_way_tile';
        } else {
            info.blocked_by = 'unreachable_area';
        }
        if (avoid && info.blocked_by !== 'event') {
            var plain = reachableFrom($gamePlayer.x, $gamePlayer.y, {});
            if (plain[tx + ',' + ty] !== undefined) info.blocked_by = 'avoidance_zone';
        }
        return info;
    }

    function pathFailure(start, tx, ty, blocked, avoid) {
        var dist = reachableFrom(start.x, start.y, { blocked: blocked, goalX: tx, goalY: ty });
        var info = targetEntryInfo(tx, ty, dist, avoid);
        return {
            nearest_reachable: nearestInSet(dist, tx, ty),
            blocked_by: info.blocked_by,
            target_passable: info.target_passable,
            events_at_target: info.events_at_target
        };
    }

    function directionToEvent(ev) {
        return directionBetween($gamePlayer.x, $gamePlayer.y, ev.x, ev.y);
    }

    //-------------------------------------------------------------------------
    // Virtual input

    var VInput = {
        _held: {},       // button -> release timestamp
        _move: 0,        // held direction (2/4/6/8) for continuous movement
        _moveBtn: null,

        tap: function (button, holdMs) {
            if (BUTTONS.indexOf(button) < 0) return false;
            var t = now() + (holdMs || 60);
            this._held[button] = Math.max(this._held[button] || 0, t);
            return true;
        },

        hold: function (button, holdMs) {
            return this.tap(button, holdMs);
        },

        setMove: function (dir) {
            if (this._move === dir) return;
            this._releaseMove();
            this._move = dir || 0;
            this._moveBtn = DIR_BTN[this._move] || null;
        },

        releaseMove: function () { this._releaseMove(); },

        _releaseMove: function () {
            if (this._moveBtn && Input._currentState[this._moveBtn]) {
                Input._currentState[this._moveBtn] = false;
            }
            this._move = 0;
            this._moveBtn = null;
        },

        releaseAll: function () {
            for (var k in this._held) {
                if (Input._currentState[k]) Input._currentState[k] = false;
            }
            this._held = {};
            this._releaseMove();
        },

        isHeld: function (button) {
            return (this._held[button] || 0) > now();
        },

        apply: function () {
            var t = now();
            for (var k in this._held) {
                if (this._held[k] > t) {
                    Input._currentState[k] = true;
                } else {
                    if (Input._currentState[k]) Input._currentState[k] = false;
                    delete this._held[k];
                }
            }
            if (this._moveBtn) {
                Input._currentState[this._moveBtn] = true;
            }
        }
    };

    //-------------------------------------------------------------------------
    // Event log (polled)

    var logItems = [];
    var logSeq = 0;
    var logWatch = { message: null, choices: null, mapId: null, scene: null, battle: null };

    function pushLog(type, data) {
        logSeq++;
        var item = { seq: logSeq, tick: tick, type: type, data: data || null };
        logItems.push(item);
        if (logItems.length > 500) logItems.splice(0, logItems.length - 500);
        return item;
    }

    // Dialogue that states a requirement is a quest clue. Mark it in the log
    // so the agent can pull only hints instead of re-reading every message.
    var HINT_PATTERNS = [
        /必要/, /なければ/, /ないと/, /すると良/, /した方/, /探して/,
        /欲し/, /べき/, /助けて/, /登録/, /料金/, /依頼/
    ];

    function addHintLog(text) {
        if (!text) return;
        for (var i = 0; i < HINT_PATTERNS.length; i++) {
            if (HINT_PATTERNS[i].test(text)) {
                pushLog('hint', {
                    text: String(text).slice(0, 240),
                    matched: String(HINT_PATTERNS[i])
                });
                return;
            }
        }
    }

    // Battle-only conditions (armor break, poison, charm...) live on the
    // battler's state list and can appear and vanish between two observations,
    // so record every transition as a log entry. Equipment is diffed too:
    // some games express costume damage as an unequip rather than a state.
    var actorWatch = {};

    function equipLabel(e) {
        if (!e) return null;
        // MV normally returns data entries here, but some plugins hand back
        // Game_Item wrappers instead, so unwrap before looking the name up.
        if (typeof e === 'object') {
            if (typeof e.name === 'string') return e.name;
            if (typeof e.itemId === 'function') {
                var id = safe(function () { return e.itemId(); }, 0);
                if (id) return equipLabel(id);
            }
            if (typeof e.object === 'function') {
                var obj = safe(function () { return e.object(); }, null);
                if (obj) return obj.name || null;
            }
            return null;
        }
        if (typeof $dataWeapons !== 'undefined' && $dataWeapons[e]) return $dataWeapons[e].name;
        if (typeof $dataArmors !== 'undefined' && $dataArmors[e]) return $dataArmors[e].name;
        return 'item ' + e;
    }

    // Enemies change states too (poison, paralysis, enrage). Diff them the same
    // way as actors so a log-driven subtitle or replay can show those moments.
    var enemyWatch = {};

    function watchEnemyChanges() {
        if (typeof $gameTroop === 'undefined' || !$gameTroop || !inBattle()) {
            enemyWatch = {};
            return;
        }
        var members = safe(function () { return $gameTroop.members(); }, []);
        var seen = {};
        for (var i = 0; i < members.length; i++) {
            var e = members[i];
            if (!e) continue;
            var key = String(i);
            seen[key] = true;
            var states = safe(function () {
                return e.states().filter(function (st) { return st && st.id !== 0; })
                    .map(function (st) { return { id: st.id, name: st.name }; });
            }, []);
            var prev = enemyWatch[key];
            if (!prev) { enemyWatch[key] = states; continue; }
            var added = states.filter(function (s) {
                return !prev.some(function (p) { return p.id === s.id; });
            });
            var removed = prev.filter(function (p) {
                return !states.some(function (s) { return s.id === p.id; });
            });
            if (added.length || removed.length) {
                pushLog('enemy_state', {
                    index: i,
                    enemy_id: safe(function () { return e.enemyId ? e.enemyId() : 0; }, 0),
                    name: safe(function () { return e.name(); }, null),
                    added: added.map(function (s) { return s.name; }),
                    removed: removed.map(function (s) { return s.name; })
                });
            }
            enemyWatch[key] = states;
        }
        for (var k in enemyWatch) {
            if (!seen[k]) delete enemyWatch[k];
        }
    }

    function watchPartyChanges() {
        if (typeof $gameParty === 'undefined' || !$gameParty || !$gameParty.members) return;
        var members = $gameParty.members();
        var seen = {};
        for (var i = 0; i < members.length; i++) {
            var a = members[i];
            if (!a) continue;
            var actorId = a.actorId();
            seen[actorId] = true;
            var states = safe(function () {
                return a.states().filter(function (st) { return st && st.id !== 0; })
                    .map(function (st) { return { id: st.id, name: st.name }; });
            }, []);
            var equips = safe(function () { return a.equips().map(equipLabel); }, []);
            var prev = actorWatch[actorId];
            if (!prev) { actorWatch[actorId] = { states: states, equips: equips }; continue; }
            var added = states.filter(function (s) {
                return !prev.states.some(function (p) { return p.id === s.id; });
            });
            var removed = prev.states.filter(function (p) {
                return !states.some(function (s) { return s.id === p.id; });
            });
            if (added.length || removed.length) {
                pushLog('actor_state', {
                    actor_id: actorId,
                    name: a.name(),
                    added: added.map(function (s) { return s.name; }),
                    removed: removed.map(function (s) { return s.name; })
                });
            }
            var changes = [];
            var slots = Math.max(prev.equips.length, equips.length);
            for (var e = 0; e < slots; e++) {
                if (prev.equips[e] !== equips[e]) {
                    changes.push({ slot: e, from: prev.equips[e] || null, to: equips[e] || null });
                }
            }
            if (changes.length) {
                pushLog('actor_equip', { actor_id: actorId, name: a.name(), changes: changes });
            }
            actorWatch[actorId] = { states: states, equips: equips };
        }
        for (var key in actorWatch) {
            if (!seen[key]) delete actorWatch[key];
        }
    }

    function pollLog() {
        if (tick % 5 !== 0) return;
        var scene = sceneTag();
        if (scene !== logWatch.scene) {
            pushLog('scene', { from: logWatch.scene, to: scene });
            logWatch.scene = scene;
        }
        if (!inMap()) return;
        var mapId = $gameMap.mapId();
        if (mapId !== logWatch.mapId) {
            if (logWatch.mapId !== null) {
                pushLog('transfer', { from: logWatch.mapId, to: mapId, name: mapDisplayName() });
            }
            logWatch.mapId = mapId;
        }
        watchPartyChanges();
        var msg = safe(messageInfo, null);
        var signature = msg ? JSON.stringify([msg.text, msg.choices, msg.waiting_for]) : null;
        if (signature !== logWatch.message) {
            if (msg) {
                pushLog('message', {
                    text: msg.text,
                    waiting_for: msg.waiting_for,
                    choices: msg.choices,
                    speaker: msg.speaker
                });
                addHintLog(msg.text);
            }
            logWatch.message = signature;
        }
        if (msg && msg.waiting_for === 'choice') {
            var cSig = JSON.stringify(msg.choices || []);
            if (cSig !== logWatch.choices) {
                pushLog('choice', { choices: msg.choices });
                logWatch.choices = cSig;
            }
        } else if (!msg) {
            logWatch.choices = null;
        }
        if (inBattle()) {
            if (!logWatch.battle) {
                var enemies = safe(function () {
                    return $gameTroop.members().map(function (e) { return e.name(); });
                }, []);
                pushLog('battle_start', { enemies: enemies });
                logWatch.battle = true;
                enemyWatch = {};
            }
            watchEnemyChanges();
        } else {
            if (logWatch.battle) {
                pushLog('battle_end', null);
                logWatch.battle = false;
            }
            watchEnemyChanges();
        }
    }

    //-------------------------------------------------------------------------
    // Jobs

    var tick = 0;
    var activeJob = null;

    function Job(id, action, args) {
        this.id = id;
        this.action = action;
        this.args = args || {};
        this.t0 = now();
        this.tick0 = tick;
        this.logStart = logSeq;
        this.nextAt = 0;
        this.steps = 0;
        this.warnings = [];
        this.effect = null;
        this.data = {};
        this.done = false;
        this.timeoutMs = this.args.timeout_ms || defaultTimeout(action, this.args);
        this.deadline = this.t0 + this.timeoutMs;
    }

    function defaultTimeout(action, args) {
        switch (action) {
        case 'walk': return clamp(3000 + (args.steps || 1) * 400, 5000, 45000);
        case 'go_to': return 60000;
        case 'talk_to': return 20000;
        case 'advance': {
            var advPages = clamp(parseInt(args.max_pages, 10) || 50, 1, 500);
            var advDelay = parseInt(args.page_delay_ms, 10);
            if (isNaN(advDelay)) advDelay = READ_DELAY;
            // A page costs at least the game's own typing/auto-message time,
            // which is ~1.8 s in practice even when we tap at full speed.
            var advPerPage = Math.max(advDelay, 1800) + 400;
            return clamp(15000 + advPages * advPerPage, 20000, 580000);
        }
        case 'select': return 15000;
        case 'battle': return args.action === 'auto' ? 240000 : 30000;
        case 'title': return 20000;
        case 'wait': return clamp((args.ms || 0) + 5000, 5000, 120000);
        case 'checkpoint': return 30000;
        default: return 15000;
        }
    }

    function makeEnvelope(action, status, effect, extra) {
        extra = extra || {};
        var newLog = logItems.filter(function (it) { return it.seq > (extra.logStart || logSeq); });
        return {
            ok: status !== 'error',
            status: status,
            action: action,
            effect: effect === undefined ? null : effect,
            interrupted_by: extra.interrupted_by || null,
            reason: extra.reason || null,
            tick: tick,
            state: safe(briefState, null),
            new_log: newLog,
            warnings: extra.warnings || []
        };
    }

    function finishJob(job, status, effect, extra) {
        if (job.done) return;
        job.done = true;
        extra = extra || {};
        extra.logStart = job.logStart;
        extra.warnings = (extra.warnings || []).concat(job.warnings);
        var env = makeEnvelope(job.action, status, effect, extra);
        VInput.releaseAll();
        send({ t: 'reply', id: job.id, result: env });
        if (activeJob === job) activeJob = null;
        log('job finished', job.action, status, extra.reason || '');
    }

    function updateJobs(t) {
        var job = activeJob;
        if (!job || job.done) return;
        if (t > job.deadline) {
            finishJob(job, 'partial', job.effect, { reason: 'timeout' });
            return;
        }
        try {
            job.handler(job, t);
        } catch (e) {
            finishJob(job, 'error', job.effect, { reason: String(e && e.message || e) });
        }
        if (!job.done && t > job.deadline) {
            finishJob(job, 'partial', job.effect, { reason: 'timeout' });
        }
    }

    function act(job, intervalMs) {
        if (now() < job.nextAt) return false;
        job.nextAt = now() + (intervalMs || 80);
        return true;
    }

    //-------------------------------------------------------------------------
    // Interruption

    function movementInterrupt() {
        if (sceneTag() !== 'map') return sceneTag();
        if (isTransferring()) return 'transfer';
        // A message shown by an event keeps that event's interpreter running,
        // so "event" would hide the useful answer: the player just has to
        // advance the message before walking.
        if (choiceVisible()) return 'choice';
        if (isMessageBusy()) return 'message';
        if (isEventRunning()) return 'event';
        var s = sceneOf();
        if (s && s._encounterEffectDuration > 0) return 'battle';
        return null;
    }

    //-------------------------------------------------------------------------
    // Movement helpers

    function playerTile() {
        return { x: $gamePlayer.x, y: $gamePlayer.y };
    }

    function faceDirection(dir) {
        if (!dir) return;
        $gamePlayer.setDirection(dir);
    }

    function reverse(d) {
        switch (d) {
        case 2: return 8;
        case 8: return 2;
        case 4: return 6;
        case 6: return 4;
        default: return 0;
        }
    }

    // Tiles the player can stand on to face `ev`, nearest first.
    function bestAdjacent(ev) {
        var dirs = [2, 4, 6, 8];
        var best = null;
        var bestPath = null;
        var px = $gamePlayer.x;
        var py = $gamePlayer.y;
        for (var i = 0; i < dirs.length; i++) {
            var d = dirs[i];
            var x = $gameMap.roundXWithDirection(ev.x, d);
            var y = $gameMap.roundYWithDirection(ev.y, d);
            if (!$gameMap.isValid(x, y)) continue;
            if (x === px && y === py) {
                return { tile: { x: x, y: y, face: reverse(d) }, path: [] };
            }
            var p = findPath(px, py, x, y, { maxNodes: 20000 });
            if (p && (!bestPath || p.length < bestPath.length)) {
                best = { x: x, y: y, face: reverse(d) };
                bestPath = p;
            }
        }
        return best ? { tile: best, path: bestPath } : null;
    }

    // MV counters are impassable but interactable: the action button checks
    // the faced counter tile, then the tile behind it when that tile is a
    // counter. Stand one step further out and face the counter.
    function bestCounterAdjacent(ev) {
        var dirs = [2, 4, 6, 8];
        var best = null;
        var bestPath = null;
        var px = $gamePlayer.x;
        var py = $gamePlayer.y;
        for (var i = 0; i < dirs.length; i++) {
            var d = dirs[i];
            var cx = $gameMap.roundXWithDirection(ev.x, d);
            var cy = $gameMap.roundYWithDirection(ev.y, d);
            if (!$gameMap.isValid(cx, cy)) continue;
            if (!safe(function () { return $gameMap.isCounter(cx, cy); }, false)) continue;
            var sx = $gameMap.roundXWithDirection(cx, d);
            var sy = $gameMap.roundYWithDirection(cy, d);
            if (!$gameMap.isValid(sx, sy)) continue;
            if (sx === px && sy === py) {
                return {
                    tile: { x: sx, y: sy, face: reverse(d) },
                    path: [],
                    counter: { x: cx, y: cy }
                };
            }
            var p = findPath(px, py, sx, sy, { maxNodes: 20000 });
            if (p && (!bestPath || p.length < bestPath.length)) {
                best = { x: sx, y: sy, face: reverse(d), counter: { x: cx, y: cy } };
                bestPath = p;
            }
        }
        return best ? { tile: best, path: bestPath, counter: best.counter } : null;
    }

    // A movement sub-state machine shared by walk/go_to/talk_to.
    function initMover(job, path, opts) {
        job.data.mover = {
            path: path || [],
            index: 0,
            lastX: $gamePlayer.x,
            lastY: $gamePlayer.y,
            stepsDone: 0,
            stuck: 0,
            repaths: 0,
            opts: opts || {}
        };
        VInput.releaseAll();
    }

    // Returns 'done' | 'blocked' | null
    function updateMover(job, t) {
        var m = job.data.mover;
        if (!m) return 'blocked';
        if (movementInterrupt()) return 'interrupted';
        var px = $gamePlayer.x;
        var py = $gamePlayer.y;
        if (px !== m.lastX || py !== m.lastY) {
            m.lastX = px;
            m.lastY = py;
            m.stepsDone++;
            m.stuck = 0;
            if (m.opts.onStep) m.opts.onStep(m.stepsDone, px, py);
            if (m.opts.maxSteps && m.stepsDone >= m.opts.maxSteps) {
                VInput.releaseMove();
                return 'done';
            }
            if (m.index < m.path.length) {
                // consume one planned step
                m.index++;
            }
            if (m.index >= m.path.length) {
                VInput.releaseMove();
                return 'done';
            }
        }
        if (m.index >= m.path.length) {
            VInput.releaseMove();
            return 'done';
        }
        // Stop before stepping toward a battle event when the caller asked
        // for a safety margin. Steps that move away are always allowed.
        if (m.opts.avoidHazard > 0) {
            var threat = hazardAhead(m.opts.avoidHazard, m.path[m.index]);
            if (threat) {
                m.threat = threat;
                VInput.releaseMove();
                return 'threat';
            }
        }
        var dir = m.path[m.index];
        if (VInput._move !== dir) {
            VInput.setMove(0);
            // wait one frame after releasing to avoid double movement
            if (!m.releaseAt) m.releaseAt = t + 40;
            if (t < m.releaseAt) return null;
            m.releaseAt = 0;
            VInput.setMove(dir);
        }
        if (!isPlayerMoving()) {
            m.stuck++;
        } else {
            m.stuck = 0;
        }
        if (m.stuck > 90) {
            // tile never changed: repath or give up
            if (m.repaths < 2 && m.opts.repath) {
                m.repaths++;
                var np = m.opts.repath(px, py);
                if (np && np.length) {
                    VInput.releaseAll();
                    m.path = np;
                    m.index = 0;
                    m.stuck = 0;
                    return null;
                }
            }
            VInput.releaseMove();
            return 'blocked';
        }
        return null;
    }

    //-------------------------------------------------------------------------
    // Action handlers

    var HANDLERS = {};

    // Scene first, coordinates second. Inside a menu the player still has map
    // coordinates, so reporting not_on_map sends the agent hunting for a map
    // bug instead of noticing that the menu owns the screen.
    function rejectNonMapScene(job) {
        var tag = sceneTag();
        if (tag === 'map') return false;
        finishJob(job, 'error', { scene: tag }, { reason: 'bad_scene' });
        return true;
    }

    HANDLERS.walk = function (job) {
        var args = job.args;
        if (rejectNonMapScene(job)) return;
        var dir = typeof args.direction === 'string' ? DIRS[args.direction] : Number(args.direction);
        if (!dir || !DIR_BTN[dir]) {
            finishJob(job, 'error', null, { reason: 'invalid_direction' });
            return;
        }
        var steps = clamp(parseInt(args.steps, 10) || 1, 1, 500);
        var avoid = clamp(parseInt(args.avoid_hazard, 10) || 0, 0, 20);
        var path = [];
        for (var i = 0; i < steps; i++) path.push(dir);
        job.effect = { direction: dir, steps_requested: steps, steps_done: 0, from: playerTile() };
        if (avoid) job.effect.avoid_hazard = avoid;
        initMover(job, path, { maxSteps: steps, avoidHazard: avoid });
        job.handler = function (j, t) {
            var r = updateMover(j, t);
            if (r === 'interrupted') {
                var why = movementInterrupt() || 'unknown';
                j.effect.steps_done = j.data.mover.stepsDone;
                j.effect.to = playerTile();
                finishJob(j, 'interrupted', j.effect, { interrupted_by: why });
            } else if (r === 'threat') {
                j.effect.steps_done = j.data.mover.stepsDone;
                j.effect.to = playerTile();
                j.effect.threat = j.data.mover.threat || null;
                finishJob(j, 'partial', j.effect, { reason: 'threat_nearby' });
            } else if (r === 'blocked') {
                j.effect.steps_done = j.data.mover.stepsDone;
                j.effect.to = playerTile();
                finishJob(j, j.effect.steps_done < steps ? 'partial' : 'done', j.effect, { reason: 'blocked' });
            } else if (r === 'done') {
                j.effect.steps_done = j.data.mover.stepsDone;
                j.effect.to = playerTile();
                if (j.effect.steps_done < steps) {
                    finishJob(j, 'partial', j.effect, { reason: 'stopped_short' });
                } else {
                    finishJob(j, 'done', j.effect);
                }
            }
        };
        job.handler(job, now());
    };

    HANDLERS.go_to = function (job) {
        var args = job.args;
        if (rejectNonMapScene(job)) return;
        var tx = parseInt(args.x, 10);
        var ty = parseInt(args.y, 10);
        if (isNaN(tx) || isNaN(ty)) {
            finishJob(job, 'error', null, { reason: 'invalid_target' });
            return;
        }
        var player = $gamePlayer;
        var avoid = clamp(parseInt(args.avoid_hazard, 10) || 0, 0, 20);
        var blocked = avoid ? hazardBlocker(avoid) : null;
        var start = playerTile();
        if (start.x === tx && start.y === ty) {
            finishJob(job, 'done', { from: start, to: start, steps: 0, path: [] });
            return;
        }
        // When avoidance is on, route around cells within `avoid` tiles of a
        // battle event. The goal tile itself stays reachable, so deliberately
        // walking up to a monster still works.
        var path = findPath(start.x, start.y, tx, ty, { blocked: blocked });
        if (!path) {
            var reason = avoid ? 'unreachable_with_avoidance' : 'unreachable';
            var failEffect = { from: start, target: { x: tx, y: ty } };
            var diag = safe(function () { return pathFailure(start, tx, ty, blocked, avoid); }, null);
            if (diag) {
                failEffect.nearest_reachable = diag.nearest_reachable;
                failEffect.blocked_by = diag.blocked_by;
                failEffect.target_passable = diag.target_passable;
                failEffect.events_at_target = diag.events_at_target;
            }
            finishJob(job, 'error', failEffect, { reason: reason });
            return;
        }
        job.effect = {
            from: start,
            target: { x: tx, y: ty },
            path_length: path.length,
            steps_done: 0
        };
        if (avoid) job.effect.avoid_hazard = avoid;
        initMover(job, path, {
            avoidHazard: avoid,
            repath: function () {
                return findPath($gamePlayer.x, $gamePlayer.y, tx, ty, { blocked: blocked });
            }
        });
        job.handler = function (j, t) {
            var r = updateMover(j, t);
            if (r === 'interrupted') {
                var why = movementInterrupt() || 'unknown';
                j.effect.steps_done = j.data.mover.stepsDone;
                j.effect.to = playerTile();
                finishJob(j, 'interrupted', j.effect, { interrupted_by: why });
            } else if (r === 'threat') {
                j.effect.steps_done = j.data.mover.stepsDone;
                j.effect.to = playerTile();
                j.effect.threat = j.data.mover.threat || null;
                finishJob(j, 'partial', j.effect, { reason: 'threat_nearby' });
            } else if (r === 'blocked') {
                j.effect.steps_done = j.data.mover.stepsDone;
                j.effect.to = playerTile();
                finishJob(j, 'partial', j.effect, { reason: 'blocked' });
            } else if (r === 'done') {
                j.effect.steps_done = j.data.mover.stepsDone;
                j.effect.to = playerTile();
                if (j.effect.to.x === tx && j.effect.to.y === ty) {
                    finishJob(j, 'done', j.effect);
                } else {
                    finishJob(j, 'partial', j.effect, { reason: 'stopped_short' });
                }
            }
        };
        job.handler(job, now());
    };

    HANDLERS.talk_to = function (job) {
        var args = job.args;
        if (rejectNonMapScene(job)) return;
        var ev = null;
        if (args.event_id !== undefined && args.event_id !== null) {
            ev = $gameMap.event(parseInt(args.event_id, 10));
        } else if (args.x !== undefined && args.y !== undefined) {
            var list = $gameMap.eventsXy(parseInt(args.x, 10), parseInt(args.y, 10));
            ev = list && list.length ? list[0] : null;
        } else {
            var here = eventList(6).filter(function (e) { return e.interactable; });
            if (here.length) {
                ev = $gameMap.event(here[0].id);
            }
        }
        if (!ev) {
            finishJob(job, 'error', null, { reason: 'no_event' });
            return;
        }
        var trigger = eventTrigger(ev);
        if (trigger !== null && trigger !== 0) {
            finishJob(job, 'error', { event_id: ev.eventId(), trigger: trigger }, {
                reason: 'event_not_action_trigger'
            });
            return;
        }
        // A page with only the terminator is a placeholder: the action button
        // will start an empty interpreter and nothing visible happens.
        var commands = eventCommandCount(ev);
        if (commands === 0) {
            finishJob(job, 'error', { event_id: ev.eventId(), commands: 0 }, {
                reason: 'event_has_no_commands'
            });
            return;
        }
        // Priority 1 events are faced from an adjacent tile; priority 0/2
        // events only respond when the player stands on their tile. MV only
        // blocks movement on priority-1 events, so 0/2 tiles are always
        // steppable even when the "through" checkbox is off.
        var hereMode = !ev.isNormalPriority();
        var start = playerTile();
        var path = null;
        var face = 0;
        if (hereMode) {
            if (start.x === ev.x && start.y === ev.y) {
                path = [];
            } else {
                path = findPath(start.x, start.y, ev.x, ev.y, { maxNodes: 20000 });
            }
            if (!path) {
                var failEffect = {
                    event_id: ev.eventId(),
                    event_pos: { x: ev.x, y: ev.y },
                    interact_from: 'here'
                };
                var diag = safe(function () { return pathFailure(start, ev.x, ev.y, null, 0); }, null);
                if (diag) {
                    failEffect.nearest_reachable = diag.nearest_reachable;
                    failEffect.blocked_by = diag.blocked_by;
                }
                finishJob(job, 'error', failEffect, { reason: 'unreachable' });
                return;
            }
        } else {
            var adj = bestAdjacent(ev);
            if (!adj) {
                // Events behind a shop counter cannot be faced from a
                // neighbouring tile: the counter itself blocks that tile.
                adj = safe(function () { return bestCounterAdjacent(ev); }, null);
            }
            if (!adj) {
                var failAdj = {
                    event_id: ev.eventId(),
                    event_pos: { x: ev.x, y: ev.y },
                    interact_from: 'adjacent'
                };
                var diag2 = safe(function () { return pathFailure(start, ev.x, ev.y, null, 0); }, null);
                if (diag2) {
                    failAdj.nearest_reachable = diag2.nearest_reachable;
                    failAdj.blocked_by = diag2.blocked_by;
                }
                finishJob(job, 'error', failAdj, { reason: 'unreachable' });
                return;
            }
            path = adj.path;
            face = adj.tile.face;
            job.data.counterTile = adj.counter || null;
        }
        job.effect = {
            event_id: ev.eventId(),
            event_pos: { x: ev.x, y: ev.y },
            interact_from: hereMode ? 'here' : (job.data.counterTile ? 'across_counter' : 'adjacent'),
            commands: commands,
            phase: 'move',
            started: false
        };
        if (job.data.counterTile) job.effect.counter = job.data.counterTile;
        initMover(job, path, {});
        job.data.targetEvent = ev;
        job.data.hereMode = hereMode;
        job.data.phase = 'move';
        job.data.waitStart = 0;

        job.handler = function (j, t) {
            var phase = j.data.phase;
            var target = j.data.targetEvent;
            if (phase === 'move') {
                var r = updateMover(j, t);
                if (r === 'interrupted') {
                    var why = movementInterrupt() || 'unknown';
                    finishJob(j, 'interrupted', j.effect, { interrupted_by: why });
                    return;
                }
                if (r === 'blocked') {
                    finishJob(j, 'partial', j.effect, { reason: 'blocked' });
                    return;
                }
                if (r === 'done') {
                    VInput.releaseAll();
                    j.data.phase = 'face';
                    j.nextAt = 0;
                }
                return;
            }
            if (phase === 'face') {
                if (!act(j, 0)) return;
                if (j.data.hereMode) {
                    if ($gamePlayer.x !== target.x || $gamePlayer.y !== target.y) {
                        finishJob(j, 'partial', j.effect, { reason: 'event_moved' });
                        return;
                    }
                } else {
                    var dist = Math.abs($gamePlayer.x - target.x) + Math.abs($gamePlayer.y - target.y);
                    // Two tiles away is valid only across the counter tile we
                    // planned to stand behind.
                    if (dist !== 1 && !(j.data.counterTile && dist === 2)) {
                        finishJob(j, 'partial', j.effect, { reason: 'event_moved' });
                        return;
                    }
                    face = directionToEvent(target);
                    faceDirection(face);
                    j.effect.facing = face;
                }
                // The page can change (or be erased) while we walk over.
                if (target._pageIndex < 0) {
                    finishJob(j, 'error', j.effect, { reason: 'event_erased' });
                    return;
                }
                j.data.phase = 'press';
                j.nextAt = now() + 60;
                return;
            }
            if (phase === 'press') {
                if (now() < j.nextAt) return;
                VInput.tap('ok', 60);
                j.data.phase = 'wait';
                j.data.waitStart = now();
                j.nextAt = now() + 120;
                return;
            }
            if (phase === 'wait') {
                // Only the target's own interpreter counts: an unrelated
                // autorun or parallel event must not look like a response.
                var running = !!(target._interpreter && target._interpreter.isRunning());
                if (running || isMessageBusy() || choiceVisible()) {
                    if (!j.data.sawRun) j.data.sawRun = now();
                    if (isMessageBusy() || choiceVisible() || now() - j.data.sawRun >= 250) {
                        j.effect.started = true;
                        j.effect.message = safe(messageInfo, null);
                        finishJob(j, 'done', j.effect);
                    }
                    return;
                }
                if (now() - j.data.waitStart > 900 && !j.data.fallbackTried) {
                    j.data.fallbackTried = true;
                    // Fallback: start the map event directly, as the action
                    // button would: own tile for priority 0/2, facing tile for
                    // priority 1.
                    safe(function () {
                        if (j.data.hereMode) {
                            $gamePlayer.startMapEvent($gamePlayer.x, $gamePlayer.y, [0, 1, 2], false);
                        } else {
                            var x = $gameMap.roundXWithDirection($gamePlayer.x, $gamePlayer.direction());
                            var y = $gameMap.roundYWithDirection($gamePlayer.y, $gamePlayer.direction());
                            $gamePlayer.startMapEvent(x, y, [0, 1, 2], true);
                            // Same extra step as Game_Player.checkEventTriggerThere:
                            // the faced tile is a counter, so check behind it.
                            if (j.data.counterTile && !$gameMap.isAnyEventStarting()) {
                                var bx = $gameMap.roundXWithDirection(x, $gamePlayer.direction());
                                var by = $gameMap.roundYWithDirection(y, $gamePlayer.direction());
                                $gamePlayer.startMapEvent(bx, by, [0, 1, 2], true);
                            }
                        }
                    });
                }
                if (now() - j.data.waitStart > 2000) {
                    j.effect.trigger = trigger;
                    finishJob(j, 'done', j.effect, { reason: 'no_response' });
                }
            }
        };
        job.handler(job, now());
    };

    HANDLERS.interact = function (job) {
        if (sceneTag() !== 'map' && sceneTag() !== 'battle' && sceneTag() !== 'title') {
            finishJob(job, 'error', null, { reason: 'bad_scene' });
            return;
        }
        var before = sceneTag();
        var started = now();
        var tapped = false;
        job.effect = { scene_before: before };
        job.handler = function (j, t) {
            if (!tapped) {
                VInput.tap('ok', 60);
                tapped = true;
                j.nextAt = t + 150;
                return;
            }
            if (t < j.nextAt) return;
            if (sceneTag() !== before) {
                j.effect.scene_after = sceneTag();
                finishJob(j, 'done', j.effect);
                return;
            }
            if (isEventRunning() || isMessageBusy() || choiceVisible()) {
                j.effect.started = true;
                j.effect.message = safe(messageInfo, null);
                finishJob(j, 'done', j.effect);
                return;
            }
            if (t - started > 1200) {
                j.effect.started = false;
                finishJob(j, 'done', j.effect, { reason: 'no_response' });
            }
        };
        job.handler(job, now());
    };

    // Which subsystem currently owns the action button, if any. Used to say
    // why a tapped button did nothing instead of reporting a silent success.
    function inputBlocker() {
        if (choiceVisible()) return 'choice';
        if (isMessageBusy()) return 'message';
        if (isEventRunning()) return 'event';
        if (isTransferring()) return 'transfer';
        if (typeof SceneManager !== 'undefined' && SceneManager.isSceneChanging &&
                SceneManager.isSceneChanging()) return 'scene_change';
        return null;
    }

    // Menu cursors are the only visible change for an arrow press outside the
    // map, so the active window and its index have to be part of the signature.
    function uiSignature() {
        var s = sceneOf();
        if (!s || !s._windowLayer) return '';
        var kids = s._windowLayer.children || [];
        var out = [];
        for (var i = 0; i < kids.length; i++) {
            var w = kids[i];
            if (!w || (!w.visible && !w.active)) continue;
            var cn = (w.constructor && w.constructor.name) || 'Window';
            var idx = safe(function () {
                return typeof w.index === 'function' ? w.index() : -1;
            }, -1);
            out.push(cn + (w.active ? '*' : '') + ':' + idx);
        }
        return out.join(',');
    }

    function inputSignature() {
        var mi = safe(messageInfo, null);
        return [
            sceneTag(),
            (mi && mi.text) || '',
            (mi && mi.waiting_for) || '',
            safe(function () {
                return $gamePlayer
                    ? ($gamePlayer.x + ',' + $gamePlayer.y + ',' + $gamePlayer.direction())
                    : '';
            }, ''),
            isEventRunning() ? 1 : 0,
            choiceVisible() ? 1 : 0,
            uiSignature()
        ].join('|');
    }

    // A Window_SavefileList in save mode. Pressing ok there writes the slot
    // under the cursor, so a blind ok can overwrite an old save.
    function activeSavefileWindow() {
        var s = sceneOf();
        if (!s) return null;
        var w = s._listWindow || null;
        if (!w) {
            var kids = s._windowLayer ? (s._windowLayer.children || []) : [];
            for (var i = 0; i < kids.length; i++) {
                var cn = kids[i] && kids[i].constructor && kids[i].constructor.name;
                if (cn === 'Window_SavefileList') { w = kids[i]; break; }
            }
        }
        if (!w || !windowLive(w)) return null;
        var mode = safe(function () { return typeof s.mode === 'function' ? s.mode() : null; }, null);
        if (!mode) mode = safe(function () { return w._mode; }, null);
        return String(mode || '') === 'save' ? w : null;
    }

    var savePickScene = null;
    var savePickWin = null;

    HANDLERS.input = function (job) {
        var btn = String(job.args.button || '').toLowerCase();
        if (BUTTONS.indexOf(btn) < 0) {
            finishJob(job, 'error', null, { reason: 'invalid_button' });
            return;
        }
        var holdMs = clamp(parseInt(job.args.hold_ms, 10) || 60, 16, 3000);
        var t0 = now();
        var sent = false;
        var tappedAt = 0;
        var sigBefore = inputSignature();
        job.effect = { button: btn, hold_ms: holdMs, effective: null };

        if (btn === 'menu') {
            var blocker = inputBlocker();
            if (blocker) {
                job.effect.blocked_by = blocker;
                job.effect.hint = 'A message, choice, event or transition owns the screen; ' +
                    'advance it with advance/select before opening the menu.';
                finishJob(job, 'error', job.effect, { reason: 'input_swallowed' });
                return;
            }
        }

        if (btn === 'ok') {
            var saveWin = activeSavefileWindow();
            if (saveWin && !(savePickScene === sceneOf() && savePickWin === saveWin)) {
                job.effect.slot = safe(function () { return saveWin.index(); }, null);
                job.effect.exists = safe(function () {
                    return DataManager.isThisGameFile(saveWin.index() + 1);
                }, null);
                job.effect.hint = 'Read ui.windows[].index and slots, then choose the slot with select ' +
                    'before pressing ok; a blind ok overwrites the slot under the cursor.';
                finishJob(job, 'error', job.effect, { reason: 'save_slot_not_chosen' });
                return;
            }
        }

        job.handler = function (j, t) {
            if (!sent) {
                VInput.tap(btn, holdMs);
                sent = true;
                tappedAt = t;
                return;
            }
            var elapsed = t - tappedAt;
            if (elapsed < holdMs + 60) return;
            if (btn === 'menu') {
                // Give the menu scene a few frames to start so the next tool
                // call (usually select) does not race the scene transition.
                if (sceneTag() !== 'map') {
                    j.effect.effective = true;
                    j.effect.scene_after = sceneTag();
                    finishJob(j, 'done', j.effect);
                    return;
                }
                if (elapsed < 900) return;
                j.effect.effective = false;
                j.effect.blocked_by = inputBlocker();
                finishJob(j, 'partial', j.effect, { reason: 'input_swallowed' });
                return;
            }
            j.effect.effective = inputSignature() !== sigBefore;
            finishJob(j, 'done', j.effect);
        };
        job.handler(job, now());
    };

    // Battle "advance" has two jobs that must stay separate from commands:
    // pushing battle-log / result windows, and refusing to touch the command
    // or target window, where ok would silently pick the first option.
    function advanceBattle(j, t) {
        var s = sceneOf();
        var phase = safe(function () { return BattleManager._phase; }, null);
        var inputting = safe(function () {
            return !!(BattleManager.isInputting && BattleManager.isInputting());
        }, false);
        var iw = inputWindow(s);
        var mw = s && s._messageWindow;
        var pausing = !!(mw && (mw.active || (mw.isOpen && mw.isOpen())) && mw.pause);

        if (iw || (inputting && phase !== 'battleEnd' && !pausing)) {
            j.effect.stop = 'needs_command';
            j.effect.battle = {
                phase: phase,
                waiting_for: iw ? iw.name : null,
                actor: safe(function () {
                    var a = BattleManager.actor();
                    return a ? { id: a.actorId(), name: a.name() } : null;
                }, null),
                hint: 'A battle command or target window is waiting. ' +
                    'Call battle with action/command_index; advance never taps ok here.'
            };
            finishJob(j, 'error', j.effect, { reason: 'needs_command' });
            return;
        }

        if (phase === 'battleEnd') {
            j.effect.battle_end = true;
            j.effect.battle_end_presses = (j.effect.battle_end_presses || 0) + 1;
            if (j.effect.battle_end_presses > 40) {
                j.effect.stop = 'battle_end_stuck';
                finishJob(j, 'partial', j.effect, { reason: 'battle_end_stuck' });
                return;
            }
            if (act(j, 450)) VInput.tap('ok', 50);
            return;
        }

        // Action execution and turn end: ok only fast-forwards animations.
        if (act(j, 400)) VInput.tap('ok', 60);
    }

    HANDLERS.advance = function (job) {
        var maxPages = clamp(parseInt(job.args.max_pages, 10) || 50, 1, 500);
        var argDelay = parseInt(job.args.page_delay_ms, 10);
        var readDelay = clamp(isNaN(argDelay) ? READ_DELAY : argDelay, 0, 10000);
        if (sceneTag() !== 'map' && sceneTag() !== 'battle') {
            finishJob(job, 'error', null, { reason: 'not_in_dialogue_scene' });
            return;
        }
        job.effect = { pages: [], choices: null, stop: null, page_delay_ms: readDelay };
        job.data.startedInBattle = sceneTag() === 'battle';
        var lastText = null;
        var pages = 0;
        job.handler = function (j, t) {
            // A message can hand control to a shop or another scene while this
            // job is still running; tapping ok there would confirm purchases.
            var sc = sceneTag();
            if (sc !== 'map' && sc !== 'battle') {
                j.effect.stop = 'scene_changed';
                finishJob(j, 'partial', j.effect, { reason: 'left_dialogue_scene' });
                return;
            }
            if (j.data.startedInBattle && sc === 'map') {
                j.effect.stop = 'battle_end';
                finishJob(j, 'done', j.effect);
                return;
            }
            var freshPage = false;
            if (choiceVisible()) {
                var mi = safe(messageInfo, null);
                j.effect.stop = 'choice';
                j.effect.choices = mi ? mi.choices : null;
                j.effect.message = mi;
                if (mi && mi.text && mi.text !== lastText) j.effect.pages.push(mi.text);
                finishJob(j, 'done', j.effect);
                return;
            }
            var mi2 = safe(messageInfo, null);
            if (mi2 && mi2.text && mi2.text !== lastText) {
                lastText = mi2.text;
                j.effect.pages.push(mi2.text);
                pages++;
                freshPage = true;
            }
            if (sc === 'battle') {
                if (pages >= maxPages) {
                    j.effect.stop = 'max_pages';
                    finishJob(j, 'partial', j.effect, { reason: 'max_pages' });
                    return;
                }
                advanceBattle(j, t);
                return;
            }
            if (mi2 && mi2.window_hidden) {
                j.effect.stop = 'message_hidden';
                finishJob(j, 'partial', j.effect, { reason: 'message_hidden' });
                return;
            }
            if (!isMessageBusy() && !isEventRunning()) {
                j.effect.stop = 'end';
                finishJob(j, 'done', j.effect);
                return;
            }
            if (pages >= maxPages) {
                j.effect.stop = 'max_pages';
                finishJob(j, 'partial', j.effect, { reason: 'max_pages' });
                return;
            }
            if (!act(j, freshPage && readDelay > 0 ? readDelay : 140)) return;
            VInput.tap('ok', 50);
            if (isEventRunning() && !isMessageBusy()) {
                // an event is running without a message (move route, wait, etc.)
                j.nextAt = now() + 250;
            }
        };
        job.handler(job, now());
    };

    // The active Window_Selectable of the current scene, if any. Menus,
    // shops, battle commands and custom screens all build on it.
    function activeSelectableWindow() {
        var s = sceneOf();
        if (!s || !s._windowLayer) return null;
        var kids = s._windowLayer.children || [];
        for (var i = 0; i < kids.length; i++) {
            var w = kids[i];
            if (!w || !w.active) continue;
            if (typeof w.index !== 'function' || typeof w.maxItems !== 'function') continue;
            var n = safe(function () { return w.maxItems(); }, 0);
            if (!n || n <= 0) continue;
            return w;
        }
        return null;
    }

    HANDLERS.select = function (job) {
        var args = job.args;
        var mode = null;
        var w = null;
        var choices = [];
        if (choiceVisible()) {
            mode = 'choice';
            w = choiceWindow();
            choices = ($gameMessage._choices || []).map(function (c) { return cleanText(c); });
        } else {
            var iw = itemChoiceWindow();
            if (iw && iw._data && iw._data.length) {
                mode = 'item';
                w = iw;
                choices = iw._data.map(function (it) { return it ? cleanText(it.name) : ''; });
            } else {
                w = activeSelectableWindow();
                if (!w) {
                    var mi = safe(messageInfo, null);
                    if (mi && mi.waiting_for === 'number') {
                        finishJob(job, 'error', { message: mi }, { reason: 'number_input_not_supported' });
                        return;
                    }
                    // The previous input menu may still be opening its scene.
                    // Wait for the window instead of failing on the race.
                    if (job.data.waitAttempts === undefined &&
                            typeof SceneManager !== 'undefined' && SceneManager.isSceneChanging &&
                            SceneManager.isSceneChanging()) {
                        job.data.waitAttempts = 0;
                        job.data.waitUntil = now() + 3000;
                        job.handler = function (j) {
                            var ww = activeSelectableWindow();
                            if (!ww && !choiceVisible() && now() <= j.data.waitUntil) return;
                            j.handler = null;
                            if (!ww && !choiceVisible()) {
                                finishJob(j, 'error', {
                                    scene: sceneTag(),
                                    hint: 'The scene change ended but no selectable window became active.'
                                }, { reason: 'no_choice' });
                                return;
                            }
                            HANDLERS.select(j);
                        };
                        job.handler(job, now());
                        return;
                    }
                    finishJob(job, 'error', {
                        hint: 'No message choice and no active menu window. Open a menu first, then use observe.ui for indexes.'
                    }, { reason: 'no_choice' });
                    return;
                }
                mode = 'window';
                var n = clamp(safe(function () { return w.maxItems(); }, 0), 0, 1000);
                var items = windowItems(w);
                for (var i = 0; i < n; i++) {
                    choices.push(items && items[i] ? cleanText(items[i].name) : '#' + i);
                }
                if (!n && items) {
                    choices = items.map(function (it) { return cleanText(it.name); });
                }
            }
        }
        var target = null;
        if (args.index !== undefined && args.index !== null) {
            target = parseInt(args.index, 10);
        } else if (args.label !== undefined && args.label !== null) {
            var want = cleanText(String(args.label)).trim();
            for (var li = 0; li < choices.length; li++) {
                if (choices[li].trim() === want) { target = li; break; }
            }
            if (target === null) {
                for (var lj = 0; lj < choices.length; lj++) {
                    if (choices[lj].indexOf(want) >= 0) { target = lj; break; }
                }
            }
        }
        if (target === null || isNaN(target) || target < 0 || target >= choices.length) {
            finishJob(job, 'error', {
                choices: choices,
                window: mode === 'window' ? (w.constructor && w.constructor.name) : null
            }, { reason: 'invalid_choice' });
            return;
        }
        job.effect = {
            target: target,
            label: choices[target],
            choices: choices,
            selected: null,
            window: mode === 'window' ? ((w.constructor && w.constructor.name) || 'Window') : null
        };
        job.data.phase = 'navigate';
        job.data.target = target;
        job.data.mode = mode;
        job.data.window = w;
        job.data.scene_before = sceneTag();
        job.handler = function (j, t) {
            if (!act(j, 90)) return;
            if (j.data.phase === 'finish') {
                j.effect.selected = j.data.target;
                finishJob(j, 'done', j.effect);
                return;
            }
            var sceneChanged = sceneTag() !== j.data.scene_before;
            var curW = null;
            if (j.data.mode === 'choice') {
                curW = choiceWindow();
            } else if (j.data.mode === 'item') {
                curW = itemChoiceWindow();
            } else {
                curW = sceneChanged ? null : j.data.window;
                if (curW && !curW.active) {
                    var alt = activeSelectableWindow();
                    if (alt) curW = alt;
                }
            }
            if (!curW) {
                // Confirming a menu item can switch scenes or close the window.
                if (j.data.mode === 'window' || sceneChanged || j.data.phase === 'confirm') {
                    j.effect.selected = j.data.target;
                    finishJob(j, 'done', j.effect);
                    return;
                }
                finishJob(j, 'error', null, { reason: 'choice_window_lost' });
                return;
            }
            if (!curW.active && !(curW.isOpen && curW.isOpen())) {
                return; // still opening; try again on the next tick
            }
            if (j.data.phase === 'navigate') {
                var cur = typeof curW.index === 'function' ? curW.index() : -1;
                if (cur === j.data.target) {
                    if (j.data.mode === 'window' &&
                            safe(function () { return curW._mode === 'save'; }, false)) {
                        savePickScene = sceneOf();
                        savePickWin = curW;
                    }
                    j.data.phase = 'confirm';
                    j.data.stuck = 0;
                    return;
                }
                // Stock Window_Selectable does not wrap: from index 0 an "up"
                // tap stays at 0. Always move in numeric order toward the
                // target, and treat an unchanged cursor as a stuck step.
                if (cur === j.data.lastCursor) {
                    j.data.stuck = (j.data.stuck || 0) + 1;
                    if (j.data.stuck >= 3) {
                        finishJob(j, 'error', {
                            target: j.data.target,
                            label: choices[j.data.target],
                            cursor: cur,
                            window: j.effect.window
                        }, { reason: 'cursor_stuck' });
                        return;
                    }
                } else {
                    j.data.stuck = 0;
                }
                j.data.lastCursor = cur;
                var cols = (typeof curW.maxCols === 'function' ? curW.maxCols() : 1) || 1;
                if (cols > 1) {
                    // Multi-column lists move by col/row; "down" would skip a tile.
                    var curRow = Math.floor(cur / cols), curCol = cur % cols;
                    var tgtRow = Math.floor(j.data.target / cols), tgtCol = j.data.target % cols;
                    if (curCol < tgtCol) { VInput.tap('right', 50); return; }
                    if (curCol > tgtCol) { VInput.tap('left', 50); return; }
                    if (curRow < tgtRow) { VInput.tap('down', 50); return; }
                    if (curRow > tgtRow) { VInput.tap('up', 50); return; }
                }
                if (cur < 0) {
                    VInput.tap('down', 50);
                    return;
                }
                VInput.tap(j.data.target > cur ? 'down' : 'up', 50);
                return;
            }
            if (j.data.phase === 'confirm') {
                VInput.tap('ok', 60);
                j.data.phase = 'finish';
                j.nextAt = now() + 300;
                return;
            }
            if (j.data.phase === 'finish') {
                j.effect.selected = j.data.target;
                finishJob(j, 'done', j.effect);
            }
        };
        job.handler(job, now());
    };

    HANDLERS.back = function (job) {
        var before = choiceVisible();
        var t0 = now();
        var tapped = false;
        job.effect = { choice_before: before };
        job.handler = function (j, t) {
            if (!tapped) {
                VInput.tap('cancel', 60);
                tapped = true;
                return;
            }
            if (t - t0 > 400) {
                j.effect.choice_after = choiceVisible();
                finishJob(j, 'done', j.effect);
            }
        };
        job.handler(job, now());
    };

    //--- battle -----------------------------------------------------------

    function windowSymbolIndex(win, symbol) {
        if (!win || !win._list) return -1;
        for (var i = 0; i < win._list.length; i++) {
            var it = win._list[i];
            if (it && it.symbol === symbol) return i;
        }
        return -1;
    }

    // Lists do not wrap by default, pressing down at index -1 jumps to the
    // last item, and a window may lay items out in several columns (the skill
    // list uses two), where up/down move by a whole row. Read the geometry
    // from the window and align to the first column before moving vertically,
    // so a short last row cannot block the cursor.
    function navigateWindow(win, index) {
        var cur = typeof win.index === 'function' ? win.index() : -1;
        if (cur === index) return true;
        if (cur < 0) { VInput.tap('down', 50); return false; }
        var cols = Math.max(1, safe(function () { return win.maxCols(); }, 1) || 1);
        var curRow = Math.floor(cur / cols), curCol = cur % cols;
        var tgtRow = Math.floor(index / cols), tgtCol = index % cols;
        if (curRow !== tgtRow) {
            // Align to the first column before changing rows, so a short last
            // row cannot block the cursor. Only do this while rows differ.
            if (curCol !== 0) { VInput.tap('left', 50); return false; }
            VInput.tap(tgtRow > curRow ? 'down' : 'up', 50);
            return false;
        }
        if (curCol !== tgtCol) { VInput.tap(tgtCol > curCol ? 'right' : 'left', 50); return false; }
        return false;
    }

    // The window currently waiting for a decision, most specific first.
    // .active wins when present; otherwise fall back to any window that is
    // visibly open, which is what custom battle UIs expose.
    function inputWindow(s) {
        if (!s) return null;
        var cands = [
            ['enemy_target', s._enemyWindow],
            ['actor_target', s._actorWindow],
            ['skill', s._skillWindow],
            ['item', s._itemWindow],
            ['actor_command', s._actorCommandWindow],
            ['party_command', s._partyCommandWindow]
        ];
        var i, w;
        for (i = 0; i < cands.length; i++) {
            w = cands[i][1];
            if (w && w.active) return { name: cands[i][0], win: w };
        }
        for (i = 0; i < cands.length; i++) {
            w = cands[i][1];
            if (windowLive(w)) return { name: cands[i][0], win: w };
        }
        return null;
    }

    // The command the caller asked for, as an index into the visible actor
    // command window. command_index wins; otherwise action + skill_type_index
    // pick it by symbol. Skill types appear as one command each, in
    // addedSkillTypes() order, exactly like Window_ActorCommand builds them.
    function actorCommandIndex(win, job) {
        var list = win._list || [];
        var ci = parseInt(job.args.command_index, 10);
        if (!isNaN(ci) && ci >= 0 && ci < list.length) return ci;
        var sym = 'attack';
        var act = job.data.battleAction;
        if (act === 'guard') sym = 'guard';
        else if (act === 'skill') sym = 'skill';
        else if (act === 'item') sym = 'item';
        else if (act === 'escape') sym = 'escape';
        var matches = [];
        for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].symbol === sym) matches.push(i);
        }
        if (sym === 'skill' && matches.length) {
            var sti = parseInt(job.args.skill_type_index, 10);
            if (isNaN(sti) || sti < 0 || sti >= matches.length) sti = 0;
            return matches[sti];
        }
        if (matches.length) return matches[0];
        return windowSymbolIndex(win, 'attack');
    }

    function notePress(job, windowName, patch) {
        var d = job.data;
        d.pending = d.pending || {};
        for (var k in patch) d.pending[k] = patch[k];
        d.pressed = true;
        d.pressAt = now();
        d.lastPressedWindow = windowName;
        VInput.tap('ok', 60);
    }

    // Fold the command we just issued into the envelope and reset per-actor
    // state so the next actor (in auto mode) starts a fresh command.
    function flushIssued(job) {
        var d = job.data;
        if (d.pressed && d.pending && d.pending.command) {
            job.effect.issued.push({
                turn: safe(function () { return BattleManager._turn; }, null),
                actor: d.pending.actor || null,
                command: d.pending.command,
                skill: d.pending.skill || null,
                item: d.pending.item || null,
                target: d.pending.target || null
            });
        }
        d.pressed = false;
        d.awaiting = false;
        d.pending = null;
        d.lastPressedWindow = null;
        d.startActorId = undefined;
    }

    function commandAction(job, s) {
        var aw = inputWindow(s);
        if (!aw) {
            // Some battle systems show a message window in front of the
            // command windows; only tap it when no input window is waiting.
            var msg = s._messageWindow;
            if (msg && (msg.active || msg.isOpen()) && msg.pause) {
                VInput.tap('ok', 50);
            }
            return;
        }
        var win = aw.win;
        var d = job.data;

        if (aw.name === 'party_command') {
            var want = d.battleAction === 'escape' ? 'escape' : 'fight';
            var pi = windowSymbolIndex(win, want);
            if (pi < 0) pi = 0;
            var pcmd = (win._list || [])[pi] || {};
            if (pcmd.enabled === false && d.battleAction === 'escape') {
                finishJob(job, 'error', job.effect, { reason: 'command_disabled' });
                return;
            }
            if (navigateWindow(win, pi)) {
                notePress(job, 'party_command', {
                    actor: null,
                    command: { index: pi, name: cleanText(pcmd.name || ''), symbol: pcmd.symbol || null },
                    skill: null, item: null, target: null
                });
                d.awaiting = d.battleAction === 'escape';
            }
            return;
        }

        if (aw.name === 'actor_command') {
            var actor = win._actor || safe(function () { return BattleManager.actor(); }, null);
            var ci = actorCommandIndex(win, job);
            if (ci < 0) {
                finishJob(job, 'error', job.effect, { reason: 'no_command' });
                return;
            }
            var cmd = (win._list || [])[ci] || {};
            if (cmd.enabled === false) {
                if (job.args.command_index !== undefined && job.args.command_index !== null) {
                    finishJob(job, 'error', job.effect, { reason: 'command_disabled' });
                    return;
                }
                ci = windowSymbolIndex(win, 'attack');
                cmd = ci >= 0 ? ((win._list || [])[ci] || {}) : {};
                if (ci < 0) {
                    finishJob(job, 'error', job.effect, { reason: 'no_command' });
                    return;
                }
            }
            if (navigateWindow(win, ci)) {
                notePress(job, 'actor_command', {
                    actor: actor ? { id: actor.actorId(), name: actor.name() } : null,
                    command: { index: ci, name: cleanText(cmd.name || ''), symbol: cmd.symbol || null },
                    skill_type_id: cmd.symbol === 'skill' && cmd.ext !== undefined ? cmd.ext : null,
                    skill: null, item: null, target: null
                });
                if (actor) d.startActorId = actor.actorId();
                d.awaiting = true;
            }
            return;
        }

        if (aw.name === 'skill') {
            var skills = win._data || [];
            var si = parseInt(job.args.skill_index, 10);
            if (isNaN(si) || si < 0) si = 0;
            var sk = skills[si];
            if (!sk) {
                finishJob(job, 'error', job.effect, { reason: 'skill_not_found' });
                return;
            }
            if (win._actor && !safe(function () { return win._actor.canUse(sk); }, false)) {
                finishJob(job, 'error', job.effect, { reason: 'skill_unusable' });
                return;
            }
            if (navigateWindow(win, si)) {
                notePress(job, 'skill', {
                    skill: { id: sk.id, name: sk.name, stype_id: sk.stypeId }
                });
                d.awaiting = true;
            }
            return;
        }

        if (aw.name === 'item') {
            var items = win._data || [];
            var ii = parseInt(job.args.item_index, 10);
            if (isNaN(ii) || ii < 0) ii = 0;
            var it = items[ii];
            if (!it) {
                finishJob(job, 'error', job.effect, { reason: 'item_not_found' });
                return;
            }
            if (navigateWindow(win, ii)) {
                notePress(job, 'item', { item: { id: it.id, name: it.name } });
                d.awaiting = true;
            }
            return;
        }

        if (aw.name === 'actor_target' || aw.name === 'enemy_target') {
            var ti = parseInt(job.args.target_index, 10);
            if (isNaN(ti) || ti < 0) ti = 0;
            // index is the window position, which is what target_index drives.
            var targets = aw.name === 'enemy_target' ? enemyTargetList(win) : actorTargetList();
            if (!targets.length) return;
            if (ti >= targets.length) ti = 0;
            if (navigateWindow(win, ti)) {
                notePress(job, aw.name, { target: targets[ti] });
                d.awaiting = true;
            }
            return;
        }
    }

    HANDLERS.battle = function (job) {
        if (!inBattle()) {
            finishJob(job, 'error', null, { reason: 'not_in_battle' });
            return;
        }
        if (safe(function () { return BattleManager._phase === 'battleEnd'; }, false)) {
            finishJob(job, 'error', { phase: 'battleEnd' }, {
                reason: 'battle_ended',
                hint: 'The battle is over; use advance to push the result windows.'
            });
            return;
        }
        var hasSelector = job.args.command_index !== undefined ||
            job.args.skill_index !== undefined ||
            job.args.item_index !== undefined ||
            job.args.target_index !== undefined ||
            job.args.skill_type_index !== undefined;
        var auto = job.args.action === 'auto' ||
            ((job.args.action === undefined || job.args.action === null) && !hasSelector);
        var action = auto ? 'attack' : String(job.args.action || 'attack');
        if (['attack', 'skill', 'guard', 'item', 'escape'].indexOf(action) < 0) {
            finishJob(job, 'error', null, { reason: 'invalid_action' });
            return;
        }
        job.data.battleAction = action;
        job.effect = { mode: auto ? 'auto' : action, turns: 0, issued: [], ended: false };
        var t0 = now();
        var lastTurn = null;
        job.data.lastProgress = t0;
        job.handler = function (j, t) {
            var s = sceneOf();
            if (!(s instanceof Scene_Battle)) {
                j.effect.ended = true;
                j.effect.scene_after = sceneTag();
                flushIssued(j);
                finishJob(j, 'done', j.effect);
                return;
            }
            var turn = safe(function () { return BattleManager._turn; }, null);
            if (turn !== lastTurn) {
                if (lastTurn !== null) j.effect.turns++;
                lastTurn = turn;
            }

            var inputting = false;
            var actor = null;
            try {
                inputting = !!(BattleManager.isInputting && BattleManager.isInputting());
                actor = inputting ? BattleManager.actor() : null;
            } catch (e) {}
            if (inputting) {
                j.data.lastProgress = t;
                if (actor && j.data.startActorId === undefined) {
                    j.data.startActorId = actor.actorId();
                }
            }

            if (j.data.pressed && j.data.awaiting) {
                // A command is committed once input moves to another actor,
                // leaves the input phase, or reopens the command window for
                // the same actor (a second action in the same turn).
                var movedOn = !inputting ||
                    (actor && j.data.startActorId !== undefined && actor.actorId() !== j.data.startActorId);
                var activeNow = inputWindow(s);
                // Once a terminal choice (skill, item, target) has been accepted,
                // the game returns to a command window - either for the next
                // actor or, with multi-action actors, for the same one.
                var terminal = j.data.lastPressedWindow === 'skill' ||
                    j.data.lastPressedWindow === 'item' ||
                    j.data.lastPressedWindow === 'actor_target' ||
                    j.data.lastPressedWindow === 'enemy_target';
                if (!movedOn && inputting && activeNow && terminal &&
                        (activeNow.name === 'actor_command' || activeNow.name === 'party_command')) {
                    movedOn = true;
                }
                if (movedOn) {
                    flushIssued(j);
                    if (!auto) {
                        j.effect.committed = true;
                        finishJob(j, 'done', j.effect);
                        return;
                    }
                }
            }

            if (!auto && !j.data.pressed && t - j.data.lastProgress > 12000) {
                j.effect.battle = {
                    phase: safe(function () { return BattleManager._phase; }, null),
                    inputting: inputting,
                    waiting_for: (inputWindow(s) || {}).name || null,
                    actor: actor ? { id: actor.actorId(), name: actor.name() } : null
                };
                finishJob(j, 'partial', j.effect, { reason: 'command_not_reached' });
                return;
            }
            if (!auto && j.data.pressed && j.data.pressAt && t - j.data.pressAt > 8000) {
                j.effect.pending = j.data.pending;
                j.effect.battle = {
                    phase: safe(function () { return BattleManager._phase; }, null),
                    inputting: inputting,
                    waiting_for: (inputWindow(s) || {}).name || null
                };
                finishJob(j, 'partial', j.effect, { reason: 'command_not_committed' });
                return;
            }

            if (!act(j, 120)) return;
            commandAction(j, s);
        };
        job.handler(job, now());
    };

    //--- party management -------------------------------------------------

    function findPartyActor(actorId) {
        var members = $gameParty.members();
        for (var i = 0; i < members.length; i++) {
            if (members[i].actorId() === actorId) return members[i];
        }
        return null;
    }

    function findEquipItem(itemId) {
        itemId = parseInt(itemId, 10);
        if (!itemId) return null;
        return ($dataWeapons && $dataWeapons[itemId]) || ($dataArmors && $dataArmors[itemId]) || null;
    }

    function equipRoster(actor, withOptions) {
        var slots = safe(function () { return actor.equipSlots(); }, []);
        var equips = safe(function () { return actor.equips(); }, []);
        var inventory = safe(function () { return $gameParty.equipItems(); }, []);
        var out = [];
        for (var i = 0; i < slots.length; i++) {
            var etype = slots[i];
            var item = equips[i] || null;
            var row = {
                slot: i,
                etype_id: etype,
                type: ($dataSystem.equipTypes && $dataSystem.equipTypes[etype]) || ('type ' + etype),
                item_id: item ? item.id : 0,
                name: item ? item.name : null,
                change_ok: safe(function () { return actor.isEquipChangeOk(i); }, true)
            };
            if (withOptions) {
                row.options = [];
                for (var j = 0; j < inventory.length; j++) {
                    var candidate = inventory[j];
                    if (!candidate || candidate.etypeId !== etype) continue;
                    if (!safe(function () { return actor.canEquip(candidate); }, false)) continue;
                    row.options.push({ id: candidate.id, name: candidate.name });
                }
            }
            out.push(row);
        }
        return out;
    }

    // canUse also checks the occasion (map vs battle), which would mark every
    // battle-only skill unusable while standing on the map. This mirrors
    // meetsSkillConditions without that gate.
    function skillUsableInBattle(actor, sk) {
        return safe(function () {
            return actor.isSkillWtypeOk(sk) && actor.canPaySkillCost(sk) &&
                !actor.isSkillSealed(sk.id) && !actor.isSkillTypeSealed(sk.stypeId);
        }, false);
    }

    function skillRoster(actor) {
        var skills = safe(function () { return actor.skills(); }, []);
        return skills.map(function (sk) {
            return {
                id: sk.id,
                name: sk.name,
                stype_id: sk.stypeId,
                stype: ($dataSystem.skillTypes && $dataSystem.skillTypes[sk.stypeId]) || ('type ' + sk.stypeId),
                mp_cost: safe(function () { return actor.skillMpCost(sk); }, sk.mp || 0),
                tp_cost: safe(function () { return actor.skillTpCost(sk); }, 0),
                usable_in_battle: skillUsableInBattle(actor, sk),
                description: cleanText(sk.description || '')
            };
        }).sort(function (a, b) { return a.stype_id - b.stype_id || a.id - b.id; });
    }

    function inventoryRoster() {
        var items = [], weapons = [], armors = [];
        safe(function () {
            items = $gameParty.items().map(function (it) {
                return {
                    id: it.id,
                    name: it.name,
                    count: $gameParty.numItems(it),
                    usable_now: $gameParty.canUse(it),
                    description: cleanText(it.description || '')
                };
            });
            weapons = $gameParty.weapons().map(function (it) {
                return { id: it.id, name: it.name, count: $gameParty.numItems(it) };
            });
            armors = $gameParty.armors().map(function (it) {
                return { id: it.id, name: it.name, count: $gameParty.numItems(it) };
            });
        }, null);
        return { items: items, weapons: weapons, armors: armors };
    }

    function partyRoster(withOptions) {
        var members = $gameParty.allMembers();
        var maxBattle = safe(function () { return $gameParty.maxBattleMembers(); }, members.length);
        return {
            max_battle_members: maxBattle,
            order: members.map(function (a) { return a.actorId(); }),
            actors: members.map(function (a, i) {
                return {
                    id: a.actorId(),
                    name: a.name(),
                    index: i,
                    battle_member: i < maxBattle,
                    class: safe(function () { return a.currentClass().name; }, ''),
                    level: a.level,
                    exp: safe(function () { return a.currentExp(); }, null),
                    hp: a.hp, mhp: a.mhp,
                    mp: a.mp, mmp: a.mmp,
                    tp: a.tp,
                    state: a.isDead() ? 'dead' : 'alive',
                    states: safe(function () { return a.states().map(function (st) { return st.name; }); }, []),
                    equips: equipRoster(a, withOptions),
                    skills: skillRoster(a)
                };
            }),
            inventory: inventoryRoster()
        };
    }

    function useItemOutsideBattle(job) {
        var itemId = parseInt(job.args.item_id, 10);
        var item = itemId && $dataItems ? $dataItems[itemId] : null;
        if (!item) {
            finishJob(job, 'error', null, { reason: 'item_not_found' });
            return;
        }
        if (!$gameParty.hasItem(item)) {
            finishJob(job, 'error', null, { reason: 'item_not_in_inventory' });
            return;
        }
        var members = $gameParty.members();
        // Same user selection as Scene_Item: the movable member with the
        // highest pha (a-param), which decides menu item scaling.
        var movable = safe(function () { return $gameParty.movableMembers(); }, []);
        var user = movable[0] || null;
        var bestPha = 0;
        for (var i = 0; i < movable.length; i++) {
            if (movable[i].pha > bestPha) {
                bestPha = movable[i].pha;
                user = movable[i];
            }
        }
        if (!user) {
            finishJob(job, 'error', null, { reason: 'no_usable_user' });
            return;
        }
        if (!safe(function () { return user.canUse(item); }, false)) {
            finishJob(job, 'error', null, { reason: 'item_unusable' });
            return;
        }
        var targetId = parseInt(job.args.target_actor_id, 10);
        var target = targetId ? findPartyActor(targetId) : members[0];
        if (!target) {
            finishJob(job, 'error', null, { reason: 'target_not_in_party' });
            return;
        }
        var action = new Game_Action(user);
        action.setItemObject(item);
        if (!action.isForFriend()) {
            finishJob(job, 'error', null, { reason: 'not_usable_outside_battle' });
            return;
        }
        var targets = action.isForAll() ? members : [target];
        var applies = false;
        for (var ti = 0; ti < targets.length; ti++) {
            if (safe(function () { return action.testApply(targets[ti]); }, false)) applies = true;
        }
        if (!applies) {
            finishJob(job, 'error', null, { reason: 'no_effect' });
            return;
        }
        var before = targets.map(function (a) {
            return { id: a.actorId(), name: a.name(), hp: a.hp, mp: a.mp, states: a.states().map(function (st) { return st.name; }) };
        });
        user.useItem(item);
        for (var ti2 = 0; ti2 < targets.length; ti2++) {
            for (var r = 0; r < action.numRepeats(); r++) {
                action.apply(targets[ti2]);
            }
        }
        action.applyGlobal();
        job.effect = {
            user: { id: user.actorId(), name: user.name() },
            item: { id: item.id, name: item.name },
            targets: targets.map(function (a) { return { id: a.actorId(), name: a.name() }; }),
            before: before,
            after: targets.map(function (a) {
                return { id: a.actorId(), name: a.name(), hp: a.hp, mp: a.mp, states: a.states().map(function (st) { return st.name; }) };
            }),
            count_left: $gameParty.numItems(item),
            common_event_reserved: safe(function () { return $gameTemp.isCommonEventReserved(); }, false)
        };
        finishJob(job, 'done', job.effect);
    }

    HANDLERS.manage = function (job) {
        var args = job.args;
        var what = String(args.action || 'roster');

        if (what === 'roster') {
            job.effect = partyRoster(args.detail === 'full');
            finishJob(job, 'done', job.effect);
            return;
        }

        // Everything below changes party state, so it waits for a calm map.
        if (sceneTag() !== 'map' || isMessageBusy() || isEventRunning() ||
                isTransferring() || choiceVisible()) {
            finishJob(job, 'error', null, { reason: 'not_settled' });
            return;
        }

        if (what === 'equip') {
            var who = findPartyActor(parseInt(args.actor_id, 10));
            if (!who) {
                finishJob(job, 'error', null, { reason: 'actor_not_in_party' });
                return;
            }
            var slot = parseInt(args.slot, 10);
            var slots = safe(function () { return who.equipSlots(); }, []);
            if (isNaN(slot) || slot < 0 || slot >= slots.length) {
                finishJob(job, 'error', null, { reason: 'invalid_slot' });
                return;
            }
            if (!safe(function () { return who.isEquipChangeOk(slot); }, false)) {
                finishJob(job, 'error', null, { reason: 'slot_locked' });
                return;
            }
            var itemId = parseInt(args.item_id, 10) || 0;
            var item = itemId ? findEquipItem(itemId) : null;
            if (itemId && !item) {
                finishJob(job, 'error', null, { reason: 'item_not_found' });
                return;
            }
            if (item) {
                if (item.etypeId !== slots[slot]) {
                    finishJob(job, 'error', null, { reason: 'wrong_equip_type' });
                    return;
                }
                if (!safe(function () { return who.canEquip(item); }, false)) {
                    finishJob(job, 'error', null, { reason: 'cannot_equip' });
                    return;
                }
                if (!$gameParty.hasItem(item)) {
                    finishJob(job, 'error', null, { reason: 'item_not_in_inventory' });
                    return;
                }
            }
            var beforeItem = who.equips()[slot] || null;
            who.changeEquip(slot, item);
            var afterItem = who.equips()[slot] || null;
            if ((item && (!afterItem || afterItem.id !== item.id)) || (!item && afterItem)) {
                finishJob(job, 'error', null, { reason: 'equip_failed' });
                return;
            }
            job.effect = {
                actor: { id: who.actorId(), name: who.name() },
                slot: slot,
                before: beforeItem ? { id: beforeItem.id, name: beforeItem.name } : null,
                after: afterItem ? { id: afterItem.id, name: afterItem.name } : null,
                equips: equipRoster(who, false)
            };
            finishJob(job, 'done', job.effect);
            return;
        }

        if (what === 'formation') {
            var swap = args.swap;
            if (!Array.isArray(swap) || swap.length !== 2) {
                finishJob(job, 'error', null, { reason: 'invalid_swap' });
                return;
            }
            var a = parseInt(swap[0], 10);
            var b = parseInt(swap[1], 10);
            var all = $gameParty.allMembers();
            if (isNaN(a) || isNaN(b) || a < 0 || b < 0 || a >= all.length || b >= all.length) {
                finishJob(job, 'error', null, { reason: 'invalid_swap' });
                return;
            }
            var beforeOrder = all.map(function (m) { return { id: m.actorId(), name: m.name() }; });
            $gameParty.swapOrder(a, b);
            job.effect = {
                before: beforeOrder,
                after: $gameParty.allMembers().map(function (m) { return { id: m.actorId(), name: m.name() }; })
            };
            finishJob(job, 'done', job.effect);
            return;
        }

        if (what === 'use_item') {
            useItemOutsideBattle(job);
            return;
        }

        finishJob(job, 'error', null, { reason: 'invalid_action' });
    };

    //--- title ------------------------------------------------------------

    HANDLERS.title = function (job) {
        if (sceneTag() !== 'title' && sceneTag() !== 'file' && sceneTag() !== 'load') {
            finishJob(job, 'error', null, { reason: 'not_at_title' });
            return;
        }
        var want = String(job.args.action || 'new');
        var symbols = { new: 'newGame', continue: 'continue', options: 'options', back: null };
        if (want !== 'back' && !symbols[want]) {
            finishJob(job, 'error', null, { reason: 'invalid_action' });
            return;
        }
        job.effect = { action: want };
        job.data.phase = 'command';
        var t0 = now();
        job.handler = function (j, t) {
            var scene = sceneTag();
            if (want === 'continue' && (scene === 'load')) {
                if (!act(j, 200)) return;
                VInput.tap('ok', 60);
                j.data.phase = 'loading';
                return;
            }
            if (j.data.phase === 'loading') {
                if (scene === 'map') {
                    j.effect.loaded = true;
                    finishJob(j, 'done', j.effect);
                    return;
                }
                if (t - t0 > 8000) {
                    finishJob(j, 'partial', j.effect, { reason: 'load_timeout' });
                }
                return;
            }
            if (scene !== 'title') {
                if (scene === 'load') { j.data.phase = 'loading'; return; }
                if (scene === 'options') {
                    finishJob(j, 'done', j.effect);
                    return;
                }
                if (scene === 'map') {
                    j.effect.started = true;
                    finishJob(j, 'done', j.effect);
                    return;
                }
                finishJob(j, 'partial', j.effect, { reason: 'unexpected_scene' });
                return;
            }
            if (want === 'back') {
                VInput.tap('cancel', 60);
                finishJob(j, 'done', j.effect);
                return;
            }
            if (!act(j, 150)) return;
            var s = sceneOf();
            var win = s && s._commandWindow;
            if (!win) {
                finishJob(j, 'error', null, { reason: 'no_command_window' });
                return;
            }
            var idx = windowSymbolIndex(win, symbols[want]);
            if (idx < 0) {
                // Some games rename the symbols; fall back to list order.
                idx = want === 'new' ? 0 : want === 'continue' ? 1 : 2;
            }
            if (navigateWindow(win, idx)) {
                VInput.tap('ok', 60);
                j.data.phase = 'confirm';
                j.nextAt = now() + 400;
            }
        };
        job.handler(job, now());
    };

    //--- wait -------------------------------------------------------------

    HANDLERS.wait = function (job) {
        var until = String(job.args.until || 'settled');
        var ms = parseInt(job.args.ms, 10);
        var t0 = now();
        job.effect = { until: until, ms: isNaN(ms) ? null : ms, satisfied: false };
        var sceneAtStart = sceneTag();
        job.handler = function (j, t) {
            var ok = false;
            switch (until) {
            case 'settled': ok = isSettled(); break;
            case 'message': ok = isMessageBusy(); break;
            case 'choice': ok = choiceVisible(); break;
            case 'battle': ok = inBattle(); break;
            case 'scene_change': ok = sceneTag() !== sceneAtStart; break;
            case 'ms': ok = true; break;
            default: ok = isSettled(); break;
            }
            if (ok) {
                j.effect.satisfied = true;
                if (until === 'ms' && !isNaN(ms)) {
                    if (t - t0 >= ms) finishJob(j, 'done', j.effect);
                    return;
                }
                finishJob(j, 'done', j.effect);
                return;
            }
            if (until === 'ms' && !isNaN(ms) && t - t0 >= ms) {
                j.effect.satisfied = true;
                finishJob(j, 'done', j.effect);
                return;
            }
            if (until === 'settled' && t - t0 > 3000 && isMessageBusy()) {
                finishJob(j, 'done', j.effect, { reason: 'not_settled' });
            }
        };
        job.handler(job, now());
    };

    //--- checkpoint -------------------------------------------------------

    var checkpoints = {};
    var checkpointSeq = 0;

    function saveContents() {
        var contents = DataManager.makeSaveContents();
        return JsonEx.stringify(contents);
    }

    // Names the first thing that keeps isSettled() false, for error replies.
    function unsettledBy() {
        if (isMessageBusy()) return 'message';
        if (choiceVisible()) return 'choice';
        if (isEventRunning()) return 'event';
        if (isTransferring()) return 'transfer';
        if (isPlayerMoving()) return 'moving';
        return 'busy';
    }

    HANDLERS.checkpoint = function (job) {
        var action = String(job.args.action || 'save');
        var id = job.args.id ? String(job.args.id) : null;
        if (action === 'save') {
            // The save contents keep the map interpreter's progress but not
            // $gameMessage or the battle, so a snapshot taken during a message,
            // event or battle would resume without the text that was on screen.
            // Only a calm map gives a snapshot that restores cleanly.
            if (sceneTag() !== 'map') {
                finishJob(job, 'error', { action: 'save', scene: sceneTag() }, { reason: 'bad_scene' });
                return;
            }
            if (!isSettled()) {
                finishJob(job, 'error', {
                    action: 'save',
                    blocked_by: unsettledBy(),
                    hint: 'Checkpoints can only be saved on a settled map. ' +
                        'Call wait with until "settled", then retry.'
                }, { reason: 'not_settled' });
                return;
            }
            // Mirrors DataManager.saveGameWithoutRescue so onAfterLoad has
            // valid BGM/BGS state to restore.
            if ($gameSystem.onBeforeSave) $gameSystem.onBeforeSave();
            var data = saveContents();
            if (!id) {
                checkpointSeq++;
                id = 'cp' + checkpointSeq;
            }
            checkpoints[id] = { data: data, tick: tick, mapId: inMap() ? $gameMap.mapId() : null, at: Date.now() };
            pushLog('checkpoint', { action: 'save', id: id });
            finishJob(job, 'done', { action: 'save', id: id, bytes: data.length });
            return;
        }
        if (action === 'list') {
            var list = Object.keys(checkpoints).map(function (k) {
                var cp = checkpoints[k];
                return { id: k, tick: cp.tick, map_id: cp.mapId, created_at: cp.at, bytes: cp.data.length };
            });
            finishJob(job, 'done', { action: 'list', checkpoints: list });
            return;
        }
        if (action === 'delete') {
            if (id && checkpoints[id]) { delete checkpoints[id]; }
            finishJob(job, 'done', { action: 'delete', id: id, existed: !!id });
            return;
        }
        if (action === 'load') {
            var targetId = id || Object.keys(checkpoints).pop();
            var cp = targetId ? checkpoints[targetId] : null;
            if (!cp) {
                finishJob(job, 'error', { id: id }, { reason: 'checkpoint_not_found' });
                return;
            }
            try {
                var contents = JsonEx.parse(cp.data);
                // Same order as DataManager.loadGameWithoutRescue. The save
                // contents do not include $gameTemp, $gameMessage or $gameTroop,
                // so rebuild the game objects first; otherwise a pending message,
                // choice or reserved common event from before the load survives it.
                DataManager.createGameObjects();
                DataManager.extractSaveContents(contents);
                if ($gameSystem.onAfterLoad) $gameSystem.onAfterLoad();
                SceneManager.goto(Scene_Map);
                pushLog('checkpoint', { action: 'load', id: targetId });
                finishJob(job, 'done', { action: 'load', id: targetId, map_id: cp.mapId });
            } catch (e) {
                finishJob(job, 'error', null, { reason: String(e && e.message || e) });
            }
            return;
        }
        finishJob(job, 'error', null, { reason: 'invalid_action' });
    };

    //-------------------------------------------------------------------------
    // Immediate actions

    function immediate(action, id, args) {
        args = args || {};
        var env;
        try {
            if (action === 'observe') {
                var radius = args.radius === undefined ? 8 : parseInt(args.radius, 10);
                var effect = safe(briefState, null);
                if (effect) {
                    effect.events = eventList(isNaN(radius) ? 8 : radius);
                    if (args.detail === 'full' && inMap()) {
                        effect.items = safe(function () {
                            return $gameParty.allItems().map(function (it) {
                                return { name: it.name, count: $gameParty.numItems(it) };
                            });
                        }, []);
                        effect.actors = safe(function () {
                            return $gameParty.members().map(function (a) {
                                return {
                                    id: a.actorId(),
                                    name: a.name(),
                                    level: a.level,
                                    hp: a.hp, mhp: a.mhp, mp: a.mp, mmp: a.mmp,
                                    states: a.states().map(function (s) { return s.name; })
                                };
                            });
                        }, []);
                    }
                }
                env = makeEnvelope(action, 'done', effect, { logStart: logSeq });
            } else if (action === 'look') {
                if (sceneTag() !== 'map') {
                    env = makeEnvelope(action, 'error', { scene: sceneTag() },
                        { reason: 'bad_scene', logStart: logSeq });
                } else {
                    var asked = parseInt(args.radius, 10);
                    var r;
                    if (args.overview) {
                        r = Math.max(
                            safe(function () { return $gameMap.width(); }, 20),
                            safe(function () { return $gameMap.height(); }, 20)
                        );
                    } else {
                        r = isNaN(asked) ? 5 : clamp(asked, 1, 500);
                    }
                    var grid = lookGrid(r, args.detail === 'full' ? 'full' : 'brief');
                    if (!grid) throw new Error('not_on_map');
                    if (!isNaN(asked)) grid.radius_requested = asked;
                    if (args.overview) grid.overview = true;
                    env = makeEnvelope(action, 'done', grid, { logStart: logSeq });
                }
            } else if (action === 'list_events') {
                var rad = args.radius === undefined ? null : parseInt(args.radius, 10);
                env = makeEnvelope(action, 'done', { events: eventList(isNaN(rad) ? null : rad) }, { logStart: logSeq });
            } else if (action === 'log') {
                var since = parseInt(args.since, 10);
                var limit = clamp(parseInt(args.limit, 10) || 50, 1, 500);
                var items = logItems.filter(function (it) { return isNaN(since) || it.seq > since; }).slice(-limit);
                env = makeEnvelope(action, 'done', { items: items, last_seq: logSeq }, { logStart: logSeq });
            } else if (action === 'state') {
                env = makeEnvelope(action, 'done', safe(briefState, null), { logStart: logSeq });
            } else {
                env = makeEnvelope(action, 'error', null, { reason: 'unknown_action' });
            }
        } catch (e) {
            env = makeEnvelope(action, 'error', null, { reason: String(e && e.message || e) });
        }
        send({ t: 'reply', id: id, result: env });
    }

    //-------------------------------------------------------------------------
    // Network

    var ws = null;
    var connected = false;
    var reconnectTimer = null;
    var reconnectDelay = 1000;
    var lastStateSent = 0;

    // The bridge only accepts a game connection that presents its token.
    // The running bridge writes the live token (which may come from --token)
    // to session.json; the token file is the fallback. It is read on every
    // connection attempt so a bridge started after the game is picked up.
    function bridgeHome() {
        var os = require('os');
        var path = require('path');
        var env = (typeof process !== 'undefined' && process.env) ? process.env.MV_AI_BRIDGE_HOME : '';
        return env ? path.resolve(env) : path.join(os.homedir(), '.mv-ai-bridge');
    }

    function readBridgeToken() {
        if (TOKEN_PARAM) return TOKEN_PARAM;
        if (typeof require !== 'function') return '';
        try {
            var fs = require('fs');
            var path = require('path');
            var home = bridgeHome();
            try {
                var session = JSON.parse(fs.readFileSync(path.join(home, 'session.json'), 'utf8'));
                // With several bridges running, session.json only describes
                // the latest one, so use it only when the port matches.
                if (session && session.token && Number(session.port) === PORT) {
                    return String(session.token);
                }
            } catch (e) { /* no usable session file; try the token file */ }
            return String(fs.readFileSync(path.join(home, 'token'), 'utf8')).trim();
        } catch (e) {
            return '';
        }
    }

    var warnedNoToken = false;

    function wsUrl() {
        var url = 'ws://' + HOST + ':' + PORT + '/game';
        var token = readBridgeToken();
        if (!token) {
            if (!warnedNoToken) {
                warnedNoToken = true;
                log('no bridge token found; the bridge will reject this connection. ' +
                    'Start the bridge once or set the Token plugin parameter.');
            }
            return url;
        }
        return url + '?token=' + encodeURIComponent(token);
    }

    // For logs: the token must never reach the debug console or the log file.
    function wsLogUrl() {
        return 'ws://' + HOST + ':' + PORT + '/game';
    }

    function send(obj) {
        if (!ws || ws.readyState !== 1) return false;
        try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
    }

    function connect() {
        if (typeof WebSocket === 'undefined') return;
        if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
        try {
            ws = new WebSocket(wsUrl());
        } catch (e) {
            scheduleReconnect();
            return;
        }
        ws.onopen = function () {
            connected = true;
            reconnectDelay = 1000;
            log('connected', wsLogUrl());
            send({
                t: 'hello',
                proto: PROTO,
                plugin: VERSION,
                game: {
                    title: (typeof $dataSystem !== 'undefined' && $dataSystem) ? $dataSystem.gameTitle : '',
                    rpgmaker: (typeof Utils !== 'undefined' && Utils.RPGMAKER_VERSION) || '',
                    version: (typeof $dataSystem !== 'undefined' && $dataSystem) ? $dataSystem.versionId : ''
                }
            });
            lastStateSent = 0;
        };
        ws.onmessage = function (ev) {
            var msg;
            try { msg = JSON.parse(ev.data); } catch (e) { return; }
            handleMessage(msg);
        };
        ws.onclose = function () {
            connected = false;
            ws = null;
            scheduleReconnect();
        };
        ws.onerror = function () {
            try { if (ws) ws.close(); } catch (e) {}
        };
    }

    function scheduleReconnect() {
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(function () {
            reconnectTimer = null;
            connect();
        }, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 1.5, 5000);
    }

    function handleMessage(msg) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.t === 'ping') {
            send({ t: 'pong', ts: msg.ts });
            return;
        }
        if (msg.t !== 'cmd') return;
        var action = String(msg.action || '');
        var args = msg.args || {};
        log('cmd', action, args);
        if (action === 'observe' || action === 'look' || action === 'list_events' ||
            action === 'log' || action === 'state') {
            immediate(action, msg.id, args);
            return;
        }
        if (activeJob) {
            var busyEffect = {
                active_action: activeJob.action,
                active_for_ms: Math.round(now() - activeJob.t0),
                hint: 'Another action is still running; wait for its reply before retrying.'
            };
            var busyBattle = safe(battleInfo, null);
            if (busyBattle) {
                busyEffect.battle = {
                    phase: busyBattle.phase,
                    inputting: !!busyBattle.inputting,
                    active_window: busyBattle.active_window,
                    waiting_for: busyBattle.waiting
                };
            }
            send({
                t: 'reply',
                id: msg.id,
                result: makeEnvelope(action, 'error', busyEffect, { reason: 'busy', logStart: logSeq })
            });
            return;
        }
        var job = new Job(msg.id, action, args);
        var handler = HANDLERS[action];
        if (!handler) {
            send({
                t: 'reply',
                id: msg.id,
                result: makeEnvelope(action, 'error', null, { reason: 'unknown_action', logStart: logSeq })
            });
            return;
        }
        try {
            handler(job);
            if (!job.done) {
                activeJob = job;
            }
        } catch (e) {
            finishJob(job, 'error', null, { reason: String(e && e.message || e) });
        }
    }

    //-------------------------------------------------------------------------
    // Frame integration

    function applyInput() {
        if (!Input || !Input._currentState) return;
        VInput.apply();
    }

    function afterUpdate() {
        tick++;
        var t = now();
        updateJobs(t);
        safe(pollLog, null);
        if (!connected) return;
        if (t - lastStateSent > 250) {
            lastStateSent = t;
            send({ t: 'state', seq: tick, state: safe(briefState, null) });
        }
    }

    var _SceneManager_updateMain = SceneManager.updateMain;
    SceneManager.updateMain = function () {
        safe(applyInput, null);
        _SceneManager_updateMain.call(this);
        safe(afterUpdate, null);
    };

    // Freezing happens at updateScene, not updateMain: changeScene, input
    // polling, renderScene and requestUpdate keep running, so the window still
    // draws and stays responsive; only the scene's own update (map, events,
    // timers, animations) pauses.
    if (FREEZE_WHILE_THINKING) {
        var _SceneManager_updateScene = SceneManager.updateScene;
        SceneManager.updateScene = function () {
            if (worldFrozen()) return;
            _SceneManager_updateScene.call(this);
        };
    }

    //-------------------------------------------------------------------------
    // Boot

    window.__MV_AI_BRIDGE__ = {
        version: VERSION,
        proto: PROTO,
        state: function () { return safe(briefState, null); },
        log: function () { return logItems.slice(); },
        job: function () { return activeJob ? activeJob.action : null; }
    };

    setTimeout(connect, 300);
})();
