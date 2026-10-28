# 更新日志

[English](CHANGELOG.md) | [简体中文](CHANGELOG.zh-CN.md) | [日本語](CHANGELOG.ja.md)

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
