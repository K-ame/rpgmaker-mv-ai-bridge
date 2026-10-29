# 更新日志

[English](CHANGELOG.md) | [简体中文](CHANGELOG.zh-CN.md) | [日本語](CHANGELOG.ja.md)

## v0.2.0

可靠性与感知版本：桥接现在能说清自己是否真正就绪、调用超时时到底发生了什么，并直接把 AI 找下一步所需的游戏数据摆出来。

### 连接与错误

- 显式连接状态：`disconnected`、`handshaking`、`ready`、`incompatible`。收到插件的 `hello` 前忽略状态；握手 5 秒超时以 `4001` 关闭，协议不匹配则保持连接并给出明确拒绝，避免反复重连。`/health` 报告状态、双方协议版本和插件版本。
- `game_not_ready`（socket 已连但握手不兼容）与 `game_not_connected`（没有连接）分开，`effect.connection` 说明原因。
- 超时信封带 `action_id` 和 `effect: {outcome: "unknown", retry_safe, hint}`；迟到的游戏回执会在 `warnings` 里出现一次，避免盲目重放。
- `/health` 统计 `connection.replaced_connections`，同时开多个 `Game.exe` 抢夺 `/game` 时不再表现成状态乱跳。
- `--host` 不是回环地址时打印警告。

### 感知

- `list_events` 暴露条件事件页：每页的 `index`、`active`、`trigger`，以及等待的开关、变量下限、独立开关、道具或角色，全部解析成名称和当前值。
- 新增只读工具 `game_data`：有名字的开关/变量及当前值、道具/武器/防具/技能的帮助文本查询、商店事件的商品与实际价格。
- `observe` 增加 `party.inventory`（关键物品在前，普通物品在后，并给总数）。
- `list_events` 与 `nearby` 的传送事件带 `destination`（`map_id`、`x`、`y`、地图名；非激活页附 `page_index` 与条件）；空结果用 `diagnostic` 说明读取到的事件数、半径和传送/消息状态，不再像一张没有事件的地图。
- `game_data` 的商店按 MV 真实指令格式解析（每个 `302` 一件商品，后续 `605` 追加），并返回所有带商品的页及其条件。
- `go_to` 成功抵达时返回 `events_at_target` / `arrived_event`，说明「到了却没反应」是还需要按 OK 还是再走一步。
- 消息正文用图片绘制时，暴露 `message.image_text`（DTextPicture）、可见图片名和 `text_source`（`image_text` / `picture`）。
- 地图事件运行期间，消息、日志与 `advance` 带 `context`（`map_id`、`event_id`、`common_event_id`、`command_index`），无法观测的字段直接省略而不是猜测；`talk_to` 错误会标明失败阶段 `stage`（`locate` / `trigger` / `move`）。

### 持久化与工具链

- `notes.json` 使用带版本的 schema、原子写入、`.bak` 备份和损坏副本恢复；`note` 与 `/health` 会返回警告。
- 修复打包版 CLI 找不到插件的问题（单文件包没有 `import.meta.url`）；`install` 先校验 `plugins.js` 再复制，不会留下半个安装。
- `doctor` 在 `plugins.js` 与桥接 token 文件不一致时直接失败，在插件/桥接版本不一致时警告。
- 所有 MCP 工具补全只读/破坏性/幂等注解。
- 版本检查覆盖 `package.json`、CLI、插件与 lockfile。

## v0.1.2

第一个经过实机游玩的版本：桥跑在 WSL、游戏跑在 Windows，真的打了一场。

### 连接

- `install` 会把当前的 token 写进 `plugins.js`，桥和游戏不再需要同一个家目录（WSL + Windows 开箱即用）。
- `serve` 启动时打印 home、token、session 的绝对路径。
- `/health` 增加 `rejected_last_minute`，按来源分类（`game`、`extension`、`none`、`web`），不再只有一条被限流的日志。

### 读取游戏

- `state.message_history` 保留最近三句台词，`effect.pages` 带上一次 `advance` 期间出现过的所有页。
- `state.nearby` 按距离列出事件并标注 `kind`（`action`、`touch`、`transfer`、`shop`、`other`），门、床、柜台不再隐身。
- `go_to` 支持 `dry_run`，并且总是返回 `path` / `path_length`。
- 剧情在同一张图内瞬移玩家时记一条 `transfer_by_event`。

### 移动与界面

- `walk` / `go_to` 在有窗口占用画面时返回 `busy` + `blocked_by`（`message`、`choice`、`transfer`），不再误报 `unreachable`。
- 地图场景也会计算 `state.ui`，光标驱动的覆盖菜单可以看到；`input` 会报告光标所在的窗口。

### 战斗

- `skill` / `item` 选择失败时先关掉窗口再返回，不会让后续指令一直报 `skill_not_found`。
- 角色指令的匹配顺序改为 `command_index` → symbol → 可见文本，`attack` 还能兜底第一个可用项。
- `auto` 支持 `policy: "skill_first"`；默认的 `attack` 不变，文档也写明 `auto` 是「重复指令」，不是引擎自动战斗。
- `effect.turn` / `effect.turns` 给出回合数，`state.battle.log` 暴露战斗日志。
- `escape` 返回 `nearest_threat`（坐标 + 方向），方便逃跑后立刻离开原位。

## v0.1.1

- `/game` 必须带 token，没有就返回 401。
- 插件新增可选 `Token` 参数，供读不到 `~/.mv-ai-bridge` 的环境使用。
- `checkpoint` 只允许在静止的地图场景保存。

## v0.1.0

- 首个公开版本：游戏内插件、MCP 服务器、按键级输入、结构化状态，以及打包成单文件的发行包。
