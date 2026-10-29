# 更新履歴

[English](CHANGELOG.md) | [简体中文](CHANGELOG.zh-CN.md) | [日本語](CHANGELOG.ja.md)

## v0.2.0

信頼性と知覚のリリース。ブリッジが本当に準備完了かどうか、タイムアウト時に何が起きたか、そして AI が
迷わず次の一手を見つけるために必要なゲームデータを直接返します。

### 接続とエラー

- 明示的な接続状態：`disconnected`、`handshaking`、`ready`、`incompatible`。プラグインの `hello` を受けるまで
  状態を無視し、ハンドシェイクは 5 秒で `4001` により切断、プロトコル不一致は接続を保ったまま明確に拒否して
  再接続の連打を避けます。`/health` は状態、双方のプロトコルバージョン、プラグインバージョンを返します。
- `game_not_ready`（接続済みだが互換ハンドシェイク未完了）と `game_not_connected`（接続なし）を区別し、
  `effect.connection` に理由を載せます。
- タイムアウトには `action_id` と `effect: {outcome: "unknown", retry_safe, hint}` が付き、遅れて届いた
  ゲームの応答は `warnings` に一度だけ表示されます。
- `/health` が `connection.replaced_connections` を集計し、複数の `Game.exe` が `/game` を奪い合っても
  状態がランダムに飛ぶようには見えません。
- ループバック以外の `--host` では警告を表示します。

### 知覚

- `list_events` が条件付きイベントページを公開：各ページの `index`、`active`、`trigger` と、待機している
  スイッチ、変数の下限、セルフスイッチ、アイテム、アクターを名前と現在値付きで返します。
- 読み取り専用ツール `game_data` を追加：名前付きスイッチ／変数の現在値、アイテム／武器／防具／スキルの
  ヘルプ文検索、ショップイベントの商品と実際の価格。
- `observe` に `party.inventory` を追加（重要アイテムが先、通常アイテムが後、合計付き）。
- `list_events` と `nearby` の転送イベントが `destination`（`map_id`、`x`、`y`、マップ名）を返します。
  非アクティブページには `page_index` と条件が付き、空の `list_events` は読み込んだイベント数、半径、
  転送／メッセージ状態を `diagnostic` で説明し、イベントのない地図のようには見せません。
- `game_data` のショップが MV の実際の形（302 は 1 商品、続く 605 で追加）で解析され、商品のある全ページを
  その条件付きで返します。
- `go_to` が目標地点に着くと `events_at_target` / `arrived_event` を返し、「着いたのに反応がない」が OK が
  必要かもう一歩必要かを説明できます。
- 画像で描かれたメッセージ本文は `message.image_text`（DTextPicture）、表示中の画像名、
  `text_source`（`image_text` / `picture`）として公開されます。
- マップイベント実行中、メッセージ・ログ・`advance` に `context`（`map_id`、`event_id`、`common_event_id`、
  `command_index`）が付きます。観測できないフィールドは推測せず省略します。`talk_to` のエラーは失敗段階
  `stage`（`locate` / `trigger` / `move`）を示します。

### 永続化とツール

- `notes.json` はバージョン付きスキーマ、アトミック書き込み、`.bak` バックアップ、破損コピーからの復元を
  行い、警告を `note` と `/health` で返します。
- バンドル版 CLI がプラグインを見つけられない問題を修正（単一ファイルには `import.meta.url` がない）。
  `install` は `plugins.js` を先に検証してからコピーします。
- `doctor` は `plugins.js` とブリッジのトークンファイルが一致しない場合に失敗し、プラグイン／ブリッジの
  バージョン不一致では警告します。
- 全 MCP ツールに読み取り専用／破壊的／冪等の注釈を追加。
- バージョン確認は `package.json`、CLI、プラグイン、lockfile を照合します。

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
