# 更新履歴

[English](CHANGELOG.md) | [简体中文](CHANGELOG.zh-CN.md) | [日本語](CHANGELOG.ja.md)

## v0.1.2

実機で遊びながら作った最初の版です。ブリッジは WSL、ゲームは Windows、そして実際に戦闘まで行いました。

### 接続

- `install` が現在の token を `plugins.js` に書き込みます。ブリッジとゲームが同じホームディレクトリを共有する必要がなくなりました（WSL + Windows でもそのまま動きます）。
- `serve` は home / token / session の絶対パスを表示します。
- `/health` に `rejected_last_minute` を追加し、接続元の種類（`game`、`extension`、`none`、`web`）ごとに集計します。

### ゲームの読み取り

- `state.message_history` は直近 3 行の台詞を保持し、`effect.pages` は 1 回の `advance` で現れた全ページを返します。
- `state.nearby` は近くのイベントを距離順に `kind`（`action`、`touch`、`transfer`、`shop`、`other`）付きで列挙します。扉・ベッド・カウンターが見えるようになりました。
- `go_to` は `dry_run` に対応し、常に `path` / `path_length` を返します。
- 同じマップ内でイベントに飛ばされたときは `transfer_by_event` を記録します。

### 移動と UI

- ウィンドウが画面を占有している間、`walk` / `go_to` は `busy` と `blocked_by`（`message`、`choice`、`transfer`）を返します。`unreachable` と誤って報告しません。
- マップシーンでも `state.ui` を計算するため、カーソル操作のオーバーレイメニューが見えます。`input` はカーソルがあるウィンドウを返します。

### 戦闘

- `skill` / `item` の選択に失敗したときは、ウィンドウを閉じてからエラーを返します。以降のコマンドが `skill_not_found` で固まりません。
- アクターコマンドの照合は `command_index` → symbol → 表示テキストの順になり、`attack` は最初の有効な項目にフォールバックします。
- `auto` は `policy: "skill_first"` に対応しました。既定の `attack` は変わらず、`auto` がエンジンの自動戦闘ではなく「コマンドの繰り返し」であることも明記しました。
- `effect.turn` / `effect.turns` でターン数が分かり、`state.battle.log` で戦闘ログを読めます。
- `escape` は `nearest_threat`（座標 + 方向）を返すので、逃げた直後にその場を離れられます。

## v0.1.1

- `/game` は token 必須。無い場合は 401。
- `~/.mv-ai-bridge` を読めない環境向けに、任意の `Token` プラグインパラメータを追加。
- `checkpoint` は落ち着いたマップシーンでのみ保存を許可。

## v0.1.0

- 最初の公開版：ゲーム内プラグイン、MCP サーバー、ボタン単位の入力、構造化された状態、そして単一ファイルにまとめた配布パッケージ。
