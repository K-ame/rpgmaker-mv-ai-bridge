<h1 align="center">RPG Maker MV AI Bridge</h1>

<p align="center"><b>让 AI 代理来玩 RPG Maker MV。</b><br>
读取地块、事件、对话和战斗状态，用「按键」的方式操作——没有截图，也不需要视觉模型。</p>

<p align="center">
  <a href="https://github.com/K-ame/rpgmaker-mv-ai-bridge/releases"><img src="https://img.shields.io/github/v/release/K-ame/rpgmaker-mv-ai-bridge?color=2ea44f" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/K-ame/rpgmaker-mv-ai-bridge" alt="License"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-339933" alt="Node 20+">
  <img src="https://img.shields.io/badge/protocol-MCP-6E56CF" alt="Model Context Protocol">
</p>

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

两部分组成：一个游戏内插件，通过本地 WebSocket 暴露状态并接收玩家级输入；一个 MCP 服务器，把它变成工具。
可以下[打包好的 zip](https://github.com/K-ame/rpgmaker-mv-ai-bridge/releases)，或者[从源码构建](#安装)。

- **只做游玩。** 桥接层读取状态、按按钮，不修改数据库、不传送玩家。少数便利功能（`manage.formation`、
  `manage.use_item`、`checkpoint.load`）直接调用运行时 API，因而会绕过插件层的副作用；每个这样的工具描述里都标了
  `bypasses:`。
- **原生 MCP。** 支持 stdio 和 Streamable HTTP，不绑定任何特定代理框架。
- **为长会话设计。** 复合动作在下一个决策点停下，检查点可重试某个房间，笔记能跨越上下文重置。

## 工作原理

```
MCP 客户端（代理）
      │  stdio 或 Streamable HTTP（Bearer Token）
      ▼
mv-ai-bridge  ── WebSocket ws://127.0.0.1:7321/game ──  MV_AI_Bridge.js（游戏内）
                                                              │
                                                        RPG Maker MV 运行时
```

一个进程同时提供两端：

- `ws://<host>:<port>/game` 供游戏插件连接（由游戏主动拨出）。
- `http://<host>:<port>/mcp` 供 MCP 客户端连接（Streamable HTTP，JSON 响应）。
- `http://<host>:<port>/health` 用于快速检查状态。由于它会返回游戏标题和最近一次观测到的游戏状态（而不只是布尔值），
  同样需要 Token。`rejected_last_minute` 按来源类别（`game`、`extension`、`web`、`none`）统计最近 60 秒被拒的
  游戏连接，用来区分 Token 错误和无关的 localhost 探测。

桥接默认只监听回环地址，并要求 Bearer Token。

## 环境要求

- Node.js 20 或更高版本。
- PC 版（NW.js）RPG Maker MV 游戏，MV 1.5+ / 1.6.x。RPG Maker MZ 运行时不同，不支持。
- Windows、macOS 或 Linux，游戏与桥接器运行在同一台机器上。

## 安装

**直接用打包好的（不用构建）：** 到 [Releases](https://github.com/K-ame/rpgmaker-mv-ai-bridge/releases) 下载最新的 zip，里面有插件、打成一个文件的桥接程序、`install.bat` / `install.sh` 和 `serve.bat`。
只需要装 Node.js 20 以上。

或者从源码构建：

```bash
git clone https://github.com/K-ame/rpgmaker-mv-ai-bridge.git
cd rpgmaker-mv-ai-bridge
npm install
npm run build

# 把插件复制进游戏并注册到 plugins.js
node dist/cli/index.js install "/path/to/MyGame"
```

`install` 会写入 `www/js/plugins/MV_AI_Bridge.js`，把条目追加到 `www/js/plugins.js` 末尾（保证插件包裹其他
所有插件的行为），把当前 Token 写进该条目的 `Token` 参数，并留下一次性备份 `plugins.js.mv-ai-bridge.bak`。
如果 `plugins.js` 不是纯 JSON，会打印手动添加的片段。卸载方法见 [卸载](#卸载)。

运行 `node dist/cli/index.js doctor "/path/to/MyGame"` 可检查 Node 版本、工程结构、插件位置、Token 和会话状态。

## 运行

```bash
node dist/cli/index.js serve            # HTTP MCP + 游戏 WebSocket
node dist/cli/index.js serve --stdio    # 同时通过 stdin/stdout 提供 MCP
node dist/cli/index.js serve --no-stdio # 仅 HTTP
```

默认地址为 `127.0.0.1:7321`。桥接会把当前 Token 和 URL 写入 `~/.mv-ai-bridge/session.json`；
`node dist/cli/index.js session` 可打印该文件。然后启动游戏，插件每隔几秒重连一次。

stdio MCP 仅在显式传入 `--stdio` 时启用，绝不会根据 stdin 推断，因此后台或管道运行不会污染 stdout。
要让 MCP 客户端把桥接作为子进程拉起：

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

也可以通过 HTTP 连接。Token 位于 `~/.mv-ai-bridge/token`：

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

## 文件

| 路径 | 用途 |
| --- | --- |
| `~/.mv-ai-bridge/token` | `/mcp`、`/health` 与游戏连接 `/game` 的 Bearer Token，首次运行时创建。 |
| `~/.mv-ai-bridge/session.json` | 运行中的桥接地址、当前 Token、pid 和版本；游戏插件会优先从这里读取 Token。 |
| `~/.mv-ai-bridge/notes.json` | 代理持久笔记，按游戏标题分组。 |

设置 `MV_AI_BRIDGE_HOME` 可改变该目录。

### WSL + Windows

桥接跑在 WSL、游戏跑在 Windows 时，两侧的 HOME 不同：桥接读 `/home/<你>/.mv-ai-bridge/token`，插件找
`C:\Users\<你>\.mv-ai-bridge\token`，两个 Token 对不上。表现是所有 `/game` 连接 401、`/health` 一直是
`connected: false`，而游戏画面一切正常。任选一种解决：

- 在**跑 `serve` 的那一侧**执行 `install`（都在 WSL 或都在 Windows），写进 `plugins.js` 的 Token 就会一致；
  插件的 `Token` 参数优先于文件。
- 或者给桥接设置 `MV_AI_BRIDGE_HOME`，指向游戏侧能读到的 Windows 目录。
- 或者把 Token 文件复制到另一侧。

`serve` 启动横幅会打印桥接目录、Token 文件和会话文件的绝对路径，便于确认哪一侧持有它们。`/health` 的
`rejected_last_minute` 按来源类别（`game`、`extension`、`web`、`none`）统计最近一分钟被拒的连接，用来区分
「Token 不对」和「浏览器插件的探测」。

## 工具

每次调用返回同一个信封：

```json
{
  "ok": true,
  "status": "done",
  "action": "walk",
  "effect": { "steps_done": 3 },
  "interrupted_by": null,
  "reason": null,
  "tick": 12345,
  "state": { "scene": "map", "map": { "id": 100, "name": "洞窟３", "area": ["洞窟１", "洞窟２"] } },
  "new_log": [],
  "warnings": []
}
```

`status` 取值：

- `done` — 达成目标或动作自然结束。
- `partial` — 预算耗尽或移动受阻，`effect` 表示实际完成到哪里。
- `interrupted` — 被消息、选项、战斗、传送或场景切换打断，`interrupted_by` 标明原因。
- `error` — 动作无法开始（`ok: false`）。

`partial` 和 `interrupted` 是正常的游玩结果，不是工具故障。

| 工具 | 作用 |
| --- | --- |
| `observe` | 场景、地图、玩家位置/朝向、当前消息、选项、队伍、战斗、附近事件。`state.nearby` 按距离给出最近的 5 个事件，元素为 `{event_id, name, x, y, distance, kind}`，`kind` 取 `action`（确定键触发）、`touch`（踩上去触发）、`transfer`（门/楼梯）、`shop` 或 `other`；0 指令的床、上锁的门这类装饰事件也会列出，因为它们常常正是要找的触发点。`state.message_history` 保留帧循环看到的最近 3 句台词，包括两次调用之间被过场自动推进的句子。`objective` 原样带回 `note` 里 key 为 `objective` 的值，长流程用它记住当前目标。在地图上还会列出 `threats`（8 格内的战斗事件，含距离、是否移动、是否追击）、`balloons`（8 格内的任务标记：`!` / `?` 气泡，含距离、`balloon` 编号与来源贴图）和 `world_frozen`（`FreezeWhileThinking` 正在冻结地图时为 true）。战斗中的整个输入阶段都会给出 `party_commands`、`actor_commands`、正在选择的角色、技能类型与全部技能（含 MP/TP 消耗和可用性）、战斗道具，以及 `enemy_targets` / `actor_targets`（索引即 `target_index`），不再只报当前聚焦的那个窗口；`skill_window` / `item_window` 本身只在选中该指令后才出现。`battle.log` 是最新的 `Window_BattleLog` 文本。在菜单、商店等非地图场景中，列出每个可见窗口的光标、条目与商店价格；存档界面额外给每个槽位的 `exists` / `timestamp` / `playtime`。在地图上，若打开了自绘覆盖窗口（世界地图目的地列表、HUD 菜单等），会放进 `state.ui`；原生对话框与地图名窗口不重复列出（`state.message` / `state.map` 已经覆盖）。 |
| `look` | 本地地图字符图（`@` 你、`E` 事件、`.` 可走、`#` 挡路），带地图坐标 `origin` 和事件列表。`detail: "full"` 改为返回每格通行性。越界格已裁掉，超过地图的半径会裁到边界并回报实际 `radius`；`overview: true` 一次返回整张地图。非地图场景返回 `bad_scene` 并带当前场景名。 |
| `list_events` | 附近事件的名字、距离、触发方式、`interact_from`（`adjacent` / `here`）、`action_trigger`、`commands` / `empty`（当前激活页没有指令，按确定键不会有反应）、`hazard`（当前激活页会开战，直接或经公共事件调用）和 `chases`（移动路线会追玩家）。另有 `balloon`（头顶任务标记：1 `!`、2 `?`、0 无，按叠加贴图或当前 balloon 识别）、`page`（激活页序号与总页数）、`note`（事件备注）及 `page_note`（激活页的注释指令，note 型插件的标签常放这里），后两者只在有内容时出现。 |
| `walk` | 沿一个方向最多走 N 格。没走满（撞墙或中途被挡）返回 `partial`。`interrupted_by` 区分 `message`（先 advance）、`choice`（先 select）、`event`、`transfer` 和场景名。若消息、选项、事件或传送已经占着画面，调用会直接返回 `busy` 与 `blocked_by`，而不是让行走悄悄卡住。`avoid_hazard: N` 会在踏进战斗事件 N 格范围前停下。非地图场景（菜单、存档等）返回 `bad_scene` 并带当前场景名。 |
| `go_to` | A* 寻路到指定地块。`effect.path` 是方向码数组（2 下、4 左、6 右、8 上），`path_length` 为步数，客户端可缓存或画出来；`dry_run: true` 只返回路径、不移动。目标格必须可站立——床、柜台、墙不算——失败时返回 `nearest_reachable {x, y, distance, steps}`、`blocked_by`（`wall`、`event`、`one_way_tile`、`avoidance_zone` 等）、`target_passable` 和 `events_at_target`，按这些字段换目标，不要盲目重试。若画面被窗口占着，返回 `busy` 与 `blocked_by`（`choice` / `message` / `event` / `transfer`），不会误报成墙。`avoid_hazard: N` 会绕开战斗事件，下一步靠近时停下。非地图场景返回 `bad_scene`。 |
| `talk_to` | 用确定键触发地图事件：从相邻格面向它，对 `interact_from: "here"` 的事件先走到它格子上再按；柜台后的 NPC（`interact_from: "across_counter"`）会站到柜台前、面向柜台再按。错误会区分不可达、非确定键页面和空占位页；非地图场景返回 `bad_scene`。 |
| `interact` | 按一次确定键。 |
| `advance` | 快进打字、翻页，遇到选项或事件结束时停下。**先读 `effect.pages`**：它是本次调用期间出现过的全部页，事件一次跑完时可能就是整段对话（若这次只推进了已看过的行，也可能为空）。`effect.advanced_text` 只是兜底：帧循环看到、但 `pages` 漏掉的句子，通常不出现。`page_delay_ms` 只作用于消息窗口，战斗日志按游戏自身节奏播放。战斗里**绝不出招**：指令/目标窗口打开时返回 `needs_command`；`battleEnd` 阶段按确定键推进胜利/经验窗口直到回到地图（`stop: "battle_end"`）。 |
| `select` | 按序号或文本选择选项：消息选项、事件弹出的 Select Item 窗口，或当前激活的菜单/商店/战斗窗口（索引与 `observe.ui` 一致）。菜单场景仍在打开时会自动等待；存档界面必须先用 `select` 聚焦槽位，直接 `input ok` 会被拒绝。 |
| `back` | 取消键（关闭菜单、返回上一层）。 |
| `battle` | 驱动战斗界面：`auto` 会一直重复指令到战斗结束——`policy: "attack"`（默认）全体普攻，`policy: "skill_first"` 在 MP 够时放第一个可用技能、否则普攻；它不是引擎自动战斗，也不会回复。给出指令选择参数时，只为当前输入角色发一条指令。指令先按 `command_index`、再按 symbol、最后按可见文本（攻撃/attack 等）匹配。`skill` / `item` 失败时会先关掉对应窗口再返回错误。`effect.turn` 是当前回合，`effect.turns` 是本次调用期间完成的回合数，`effect.log` 是最近的战斗日志，`escape` 额外给 `nearest_threat`（坐标 + 方向）。`busy` 时会带战斗窗口状态。 |
| `manage` | 战斗外的队伍控制：roster 查看装备/技能/道具，equip 换装，formation 调整站位，use_item 使用道具。 |
| `title` | 标题界面：新游戏、读取最近存档、设置、返回。参数名为 `action`。 |
| `wait` | 等待 settled / message / choice / battle / 场景切换 / 指定毫秒。 |
| `checkpoint` | 保存、读取、列出、删除内存快照。绝不触碰磁盘存档。 |
| `input` | 原始引擎按键（`button`、`hold_ms`），可精确控制按住时长。`effect.effective` 说明这次按键是否真的产生了变化（包括自绘窗口里的光标移动）；`effect.window` 给出按键后光标所在的窗口、`index` 与 `selected`。菜单被消息/事件挡住或场景禁用时返回 `reason: "input_swallowed"` 与 `blocked_by`。存档界面未选槽时按 `ok` 返回 `save_slot_not_chosen`。 |
| `log` | 轮询事件日志：消息、选项、传送、场景切换、战斗开始/结束，以及队员与敌人的状态和装备变化。台词中出现「〜が必要」「〜しなければ」「〜すると良い」这类要求时会额外记一条 `hint`。过场在同一张地图内直接改动玩家位置时，会记一条 `transfer_by_event`（含 `from`、`to` 与正在执行的事件 `event_id`），旧坐标目标因此可见地失效。 |
| `note` | 桥接机器上的持久笔记，按游戏标题分组。`key: "objective"` 的值会出现在每次 `observe` 的 `objective` 字段里。例：`{"action":"set","key":"objective","text":"凑够 2000G 登记公会；出城前先买武器"}`。 |

### 错误原因

动作无法开始时，`ok` 为 `false`，`reason` 通常是下列之一：

| `reason` | 含义 |
| --- | --- |
| `bad_scene` | 该动作只在地图（或其他特定场景）可用，当前场景不同。`effect.scene` 给出场景名。 |
| `not_on_map` | 场景看起来是地图，但读不到可用的地图数据，通常是 `Map###.json` 缺失或不完整。 |
| `needs_command` | 战斗中指令或目标窗口正在等待时调用了 `advance`；先发一条 `battle` 指令。 |
| `save_slot_not_chosen` | 存档界面还没用 `select` 聚焦槽位就按了 `ok`。 |
| `input_swallowed` | 此刻按键无法生效，`blocked_by` 说明是什么占着画面（消息、事件、被禁用的窗口）。 |

其他 reason（`blocked`、`threat_nearby`、`busy`、`unreachable` 等）是动作特有的结果，会在对应动作的说明里列出。

### 推断字段

有两个字段是启发式推断，不是引擎直接给出的数据：

- `balloon`（`list_events`）与 `balloons`（`observe`）——RPG Maker 没有「任务标记」字段。桥接在事件页叠加贴图名匹配
  `bikkuri`（`!`）或 `hatena` / `question`（`?`），或事件上正有 balloon 播放时上报标记。用其他名字的贴图、图片，
  或已经播完的气泡绘制的标记会漏检。
- `hint`（`log`）——台词命中少量「要求 / 线索」句式时追加。换种说法的线索可能漏报，普通台词也可能误报。

信封里其余字段都直接读自运行时对象。

### 阅读节奏

`advance` 会让每页对话在屏幕上停留 `page_delay_ms` 再翻页，方便观看。
默认值来自插件参数 `ReadDelay`（2000 ms）。传 `page_delay_ms: 0` 可全速跳过。
这个延迟只作用于消息窗口；战斗日志一行一行的节奏由游戏自己控制，不受该参数影响。

### 思考时冻结世界

把插件参数 `FreezeWhileThinking` 设为 `true`（默认 `false`；编辑 `plugins.js` 里的条目，或重新安装后修改），
地图在游戏稳定、没有桥接动作运行时会暂停更新。画面继续渲染；桥接动作（移动、菜单）执行时会解除冻结。
只有世界模拟（事件移动、并行事件）停下，此时 `observe` 会返回 `state.world_frozen: true`。

消息、选项、战斗或传送进行中不会冻结，对话和战斗动画照常播放。它能减少但不能替代 `avoid_hazard`：
已经贴到相邻格的怪，在代理行动时仍会开战。

### 日志文件

NW.js 没有面向玩家的控制台，插件参数 `Debug` 在实际游玩里往往看不到输出。把 `LogFile` 设为路径
（例如 `www/mv-ai-bridge.log`，相对路径按游戏工作目录解析）即可把同样的诊断写入文件：连接、每条命令与参数、
任务结束状态和错误。设为 `true` 等价于 `www/mv-ai-bridge.log`。文件只追加，不会自动轮换。

### 地图上的怪物

许多 MV 游戏把大地图怪物实现为普通事件：事件页里直接放“战斗处理”，或通过公共事件间接开战。
`list_events` 会为这类事件返回 `hazard: true`，并且只检查当前激活的事件页；移动路线会追玩家时返回 `chases: true`。
`observe` 还会在地图上给出 `threats`（8 格内的战斗事件），第一次感知就能决定是打还是绕。

`walk` 和 `go_to` 支持 `avoid_hazard: N`：路径会与战斗事件保持 N 格距离，移动中若下一步会靠近，则以
`status: "partial"`、`reason: "threat_nearby"` 停下。这只是尽力而为：追击范围不小于安全距离的怪，
仍会追上站着不动的玩家。它用于减少误踩战斗，不保证一定躲开。

### 战斗战术

桥接层不做战术判断，只把全部选项暴露出来，并执行代理选中的那一个。`battle auto` 是例外，而且刻意做得很少：
`policy: "attack"`（默认）让每个角色反复普攻；`policy: "skill_first"` 在 MP 够时放第一个可用技能，否则普攻。
它不是引擎自动战斗——不会回复、不会按弱点换目标、不会处理倒下的队友——所以只适合杂兵战。

`effect.turn` 是本次调用所在回合；`effect.turns` 是调用期间完成的回合数（单条指令调用会在提交后立刻返回，
所以是 0）。`effect.log` 是最近的 `Window_BattleLog` 文本。`escape` 之后 `effect.nearest_threat` 给出最近的
战斗事件坐标与方向：追击事件在玩家原地不动时会立刻再次触发，逃完先离开那一格。

- 战斗中 `observe` 会返回 `state.battle.commands`（角色指令窗口：攻击、每个技能类型一项、防御、道具）、
  `state.battle.actor`（当前选择者）、`skill_types`（每个技能及其 `mp_cost` / `tp_cost` / `usable`）、
  战斗 `items` 和 `targets`。
- `battle` 传入 `command_index`（或 `action` + `skill_type_index`）、`skill_index`、`item_index`、`target_index`
  时，只为当前输入角色发一条指令，游戏提交后立即返回。之后再次 `observe` 指示下一位角色。
- 消耗由游戏自身的技能插件定义，因此读取的是 `skillMpCost` / `skillTpCost`，而不是 `Skills.json` 里常被覆盖或缺失的 `mp`。
- 感知不止 HP：`observe` 会为每名队员、每个敌人以及两个目标窗口列出 `states`；事件日志在状态增减或装备槽变化时写入
  `actor_state` / `actor_equip`，敌人的状态增删同样以 `enemy_state` 写入。以状态或卸装实现的爆衣等效果，
  即使只持续一回合也能被看到。

### 队伍管理

`manage` 负责战斗外的装备、站位和道具：

- `roster`（只读）— 队伍顺序、等级、HP/MP/TP、状态、各槽位装备、已学技能和道具；`detail: "full"` 还会列出
  每个槽位可装备的道具。
- `equip` — 用 `actor_id` + `slot` + `item_id` 更换一个槽位（`item_id: 0` 卸下）。
- `formation` — 用 `swap: [i, j]` 交换两名队员的位置。这里直接调用运行时队伍顺序 API
  （`bypasses:` 换人插件在菜单中收取的费用或限制）。
- `use_item` — 通过引擎的动作系统使用道具，而不是在道具菜单里选择
  （`bypasses:` 挂钩菜单选择、添加确认框或额外目标规则的插件；使用者是可行动成员中 pha 最高者）。

除 `roster` 外，其余操作都要求地图处于稳定状态：没有消息、选项、事件或传送在运行。

### 菜单与商店

菜单和商店用 `input`、`back` 与 `observe` 驱动。在地图和战斗之外，`observe` 会多出一个 `ui` 块，列出每个可见窗口的
类名、`active` 标记、光标位置以及窗口自身持有的条目——菜单指令、带数量的道具列表、带价格的商店商品。
桥接不为各个菜单插件建模，而是读取游戏自己构造的窗口对象，因此原版菜单和大幅重做的菜单对代理呈现一致。
用 `input` `menu` 打开菜单，方向键移动，`ok` 确认，`back` 返回。

### 检查点

`checkpoint save` 用 `JsonEx` 序列化整个运行时状态并保存在内存中，`checkpoint load` 恢复并回到地图场景。
读取时整体替换运行时状态，因此玩家从菜单读档时才会运行的插件逻辑会被绕过。
它适合重试某个房间或选择，但不是存档槽：随游戏进程消失，也不会出现在游戏的读档菜单里。

- `save` 只在「稳定的地图」上接受：没有对话、选项、事件、移动或传送在进行。否则返回 `not_settled`，并在
  `effect.blocked_by` 给出原因（`message`、`choice`、`event`、`transfer`、`moving`、`busy`）；不在地图场景时返回
  `bad_scene`。存档内容会保留地图解释器的执行进度，但不含消息窗口和战斗，所以在事件进行中保存的快照，恢复后会缺少
  当时屏幕上的那段文字。请先用 `wait`（`until: "settled"`）再重试。
- `load` 可在任何场景使用（包括游戏结束画面）。与游戏自带的读档一样，它会先重建游戏对象：存档内容不含
  `$gameTemp`、`$gameMessage`、`$gameTroop`，所以读档前遗留的对话、选项或预约的公共事件不会带到读档之后。

## 卸载

1. 删除 `www/js/plugins/MV_AI_Bridge.js`。
2. 从 `www/js/plugins.js` 中删除 `MV_AI_Bridge` 条目，或用 `www/js/plugins.js.mv-ai-bridge.bak` 覆盖还原。
3. 如需清除 Token、会话文件和笔记，再删除 `~/.mv-ai-bridge/`。

Steam 的“验证游戏文件完整性”可能还原 `plugins.js`，效果上也会移除该条目。安装前请确认游戏许可条款：
部分商业游戏不允许修改其文件。

## 安全

- 除非传入 `--host`，桥接只监听 `127.0.0.1`。不要把它暴露到不受控制的网络。
- `/mcp`、`/health` 以及游戏连接 `/game` 都需要 `~/.mv-ai-bridge/token` 中的 Bearer Token。删除该文件即可轮换，
  轮换后要重新运行 `install`（或清空插件的 `Token` 参数），游戏才会发送新令牌。
- 插件优先发送 `Token` 参数；未设置时读 `~/.mv-ai-bridge/session.json`（端口需一致）中的当前令牌，再回退到
  token 文件（支持 `MV_AI_BRIDGE_HOME`），连接时以 `?token=` 发送。`install` 会把当前令牌以明文写进该参数，
  请注意保护游戏目录。没有令牌的连接会收到 401。这一点很重要：任何网页都能向
  `127.0.0.1` 发起 WebSocket，而新的 `/game` 连接会替换当前连接；没有校验的话，用户访问的某个网页就能把真正的游戏
  挤掉，再向代理发送伪造的状态和对话。
- 仍在运行旧版插件文件的游戏不会发送令牌，会被拒绝。重新运行 `install` 即可更新。
- 游戏插件向外连接桥接，游戏侧不开放入站端口。
- 同一时刻只允许一个写操作，代理无法交错执行两套移动流程。

## 开发

```bash
npm run build
npm test                 # 随机端口上的模拟游戏，无需真实游戏
node test/live.js observe '{}'   # 对运行中的桥接发起一次调用
```

`test/live.js` 读取 `~/.mv-ai-bridge/session.json` 并调用单个工具；它是手动工具，不包含在 `npm test` 中。

已在 RPG Maker MV 1.6.1 上实测两个工程：一个自带 127 个插件文件、桥接注册在 `plugins.js` 末尾（含自定义消息、战斗与
菜单系统）的日文商业游戏，和一个中文同人游戏。实机覆盖地图移动与寻路、对话与选项、菜单、战斗、商店、事件日志。
`npm test` 用模拟游戏覆盖桥接协议。

## 已知限制

- **整体替换而非包裹的插件。** 插件必须最后加载。它通过写入 `Input._currentState` 虚拟化输入，并挂钩
  `SceneManager.updateMain` / `SceneManager.updateScene`；如果其他插件整体替换这些符号而不调用原实现，
  移动或冻结可能失效。
- **工程结构。** `install` 要求 `www/js/plugins.js` 加 `www/js/plugins/`。运行时位于根目录（`Game.exe` 旁直接
  是 `js/`、`data/`）或经过 Enigma 等加密打包的游戏，需要手动复制插件并手动添加 `plugins.js` 条目。
- **一个桥接只服务一个游戏。** 同一进程同时只连接一个游戏。要并行驱动第二个游戏，需用另一个 `--port` 安装它，
  并在该端口启动第二个桥接。
- **仅限 PC。** 支持 NW.js 桌面版。移动端、Cordova 和浏览器部署不支持。
- **绕过窗口层的战斗插件。** 战斗工具驱动原版指令窗口。自带输入流程的战斗插件会让这些工具降级，
  对未建模的画面请改用 `input`。
- **检查点只在内存中。** 它活在运行中的进程里，不会出现在读档菜单，游戏关闭即消失。
- **`go_to` 的目标格必须可站立。** 床、柜台、墙等不可站立格走不到，调用会返回 `unreachable` 和诊断信息。
  读 `effect.nearest_reachable`（以及 `blocked_by`、`target_passable`、`events_at_target`）改走最近可达格，
  或先用 `dry_run: true` 看一眼路线。

## 许可证

MIT。见 [LICENSE](LICENSE)。
