<h1 align="center">RPG Maker MV AI Bridge</h1>

<p align="center"><b>AI エージェントが RPG Maker MV を遊ぶ。</b><br>
タイル、イベント、会話、戦闘状態を読み、ボタンを押して操作します。スクリーンショットも視覚モデルも不要です。</p>

<p align="center">
  <a href="https://github.com/K-ame/rpgmaker-mv-ai-bridge/releases"><img src="https://img.shields.io/github/v/release/K-ame/rpgmaker-mv-ai-bridge?color=2ea44f" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/K-ame/rpgmaker-mv-ai-bridge" alt="License"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-339933" alt="Node 20+">
  <img src="https://img.shields.io/badge/protocol-MCP-6E56CF" alt="Model Context Protocol">
</p>

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

ゲーム内プラグイン（ローカル WebSocket で状態を公開し、プレイヤー入力を受け取る）と、それをツールに変換する
MCP サーバーの 2 つでできています。[ビルド済み zip](https://github.com/K-ame/rpgmaker-mv-ai-bridge/releases) か
[ソースからビルド](#インストール)で導入できます。

- **プレイのみ。** 状態を読み、ボタンを押すだけです。データベースの編集やプレイヤーのワープは行いません。
  一部の便利機能（`manage.formation`、`manage.use_item`、`checkpoint.load`）はランタイム API を直接呼ぶため、
  プラグイン層の副作用をバイパスします。各ツールの説明に `bypasses:` と明記しています。
- **ネイティブ MCP。** stdio と Streamable HTTP に対応し、特定のエージェントフレームワークに依存しません。
- **長時間セッション向け。** 複合アクションは次の判断ポイントで停止し、チェックポイントで部屋のやり直しができ、
  ノートはコンテキストのリセットを越えて残ります。

## 仕組み

```
MCP クライアント（エージェント）
      │  stdio または Streamable HTTP（Bearer トークン）
      ▼
mv-ai-bridge  ── WebSocket ws://127.0.0.1:7321/game ──  MV_AI_Bridge.js（ゲーム内）
                                                              │
                                                        RPG Maker MV ランタイム
```

1 つのプロセスが両方の役割を提供します。

- `ws://<host>:<port>/game` — ゲーム側プラグイン用（ゲームからブリッジへ接続します）。
- `http://<host>:<port>/mcp` — MCP クライアント用（Streamable HTTP、JSON 応答）。
- `http://<host>:<port>/health` — 状態確認用。ゲームタイトルと最後に観測したゲーム状態を返すため、
  真偽値だけの応答ではなく、トークンが必要です。ブリッジとプラグインのバージョン、接続状態
  （`disconnected`、`handshaking`、`ready`、`incompatible`）、ノートファイルの状態、遅れて届いた実行結果も
  返します。`rejected_last_minute` は直近 60 秒に拒否されたゲーム接続を発生元の種類（`game`、`extension`、
  `web`、`none`）別に数え、トークン不一致と無関係な localhost 探索を区別します。
  `connection.replaced_connections` はゲーム接続が新しい接続に置き換えられた回数です。複数の `Game.exe` が
  同じ `/game` を奪い合うと状態が飛ぶので、まずこの数字を見てください。

ブリッジは既定でループバックにのみバインドし、Bearer トークンを要求します。`--host` がループバックでない場合、
MCP エンドポイントがネットワークから到達可能になるため `serve` は警告を表示します。

## 動作環境

- Node.js 20 以上。
- PC 版（NW.js）の RPG Maker MV ゲーム。MV 1.5+ / 1.6.x。RPG Maker MZ はランタイムが異なるため非対応です。
- Windows、macOS、Linux。ゲームとブリッジは同じマシンで動作させてください。

## インストール

**ビルド済み（ビルド不要）:** [Releases](https://github.com/K-ame/rpgmaker-mv-ai-bridge/releases) から最新の zip を取得してください。プラグイン、1 ファイルにまとめたブリッジ、
`install.bat` / `install.sh`、`serve.bat` が入っています。必要なのは Node.js 20 以上だけです。

またはソースからビルド:

```bash
git clone https://github.com/K-ame/rpgmaker-mv-ai-bridge.git
cd rpgmaker-mv-ai-bridge
npm install
npm run build

# プラグインをゲームへコピーし、plugins.js に登録する
node dist/cli/index.js install "/path/to/MyGame"
```

`install` は `www/js/plugins/MV_AI_Bridge.js` を書き込み、`www/js/plugins.js` の末尾にエントリを追加します
（他のすべてのプラグインの挙動を包み込むため）。現在のトークンをそのエントリの `Token` パラメータに書き込み、
一度だけのバックアップを `plugins.js.mv-ai-bridge.bak` に残します。`plugins.js` が純粋な JSON でない場合は、
手動追加用のスニペットを表示します。元に戻す方法は[アンインストール](#アンインストール)を参照してください。

`node dist/cli/index.js doctor "/path/to/MyGame"` を実行すると、Node のバージョン、プロジェクト構成、
プラグインの配置、トークン、セッション状態を確認できます。`plugins.js` のトークンがブリッジのトークン
ファイルと一致しない場合は失敗します（ゲームが拒否されるため）。プラグインとブリッジのバージョンが
異なる場合は警告します。

## 起動

```bash
node dist/cli/index.js serve            # HTTP MCP + ゲーム用 WebSocket
node dist/cli/index.js serve --stdio    # stdin/stdout でも MCP を提供
node dist/cli/index.js serve --no-stdio # HTTP のみ
```

既定のアドレスは `127.0.0.1:7321` です。ブリッジは現在のトークンと URL を
`~/.mv-ai-bridge/session.json` に書き出し、`node dist/cli/index.js session` で表示できます。
その後ゲームを起動してください。プラグインは数秒おきにソケットへ再接続します。

stdio MCP は `--stdio` を明示した場合にのみ有効になり、stdin から自動推測されることはありません。
そのため、バックグラウンドやパイプ経由の実行でも stdout は汚れません。
MCP クライアントから子プロセスとして起動する場合:

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

HTTP で接続する場合、トークンは `~/.mv-ai-bridge/token` にあります。

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

## ファイル

| パス | 用途 |
| --- | --- |
| `~/.mv-ai-bridge/token` | `/mcp`、`/health`、ゲーム接続 `/game` 用の Bearer トークン。初回起動時に作成。 |
| `~/.mv-ai-bridge/session.json` | 実行中のブリッジのアドレス、現在のトークン、pid、バージョン。ゲーム側プラグインはここからトークンを優先的に読みます。 |
| `~/.mv-ai-bridge/notes.json` | エージェント用の永続ノート。ゲームタイトルごとに管理。 |

`notes.json` はアトミックに書き込まれ、直前のコピーを `notes.json.bak` に保持します。読み取れない場合は
まずバックアップから復元し、破損ファイルは `notes.json.corrupt-<タイムスタンプ>` として残します。

`MV_AI_BRIDGE_HOME` を設定すると、このディレクトリを変更できます。

### WSL + Windows

ブリッジを WSL で、ゲームを Windows で動かすと HOME が別々になります。ブリッジは
`/home/<user>/.mv-ai-bridge/token` を、プラグインは `C:\Users\<user>\.mv-ai-bridge\token` を読むため、
トークンが食い違います。すると `/game` 接続がすべて 401 になり、ゲーム画面は正常なのに `/health` は
`connected: false` のままです。次のいずれかで解決します。

- `serve` を実行する側で `install` を実行する（WSL 同士または Windows 同士）。`plugins.js` に書かれた
  トークンが一致し、プラグインの `Token` パラメータはファイルより優先されます。
- ブリッジの `MV_AI_BRIDGE_HOME` を、ゲーム側から読める Windows のディレクトリに設定する。
- トークンファイルをもう一方の側へコピーする。

`serve` の起動バナーはブリッジのホーム、トークンファイル、セッションファイルの絶対パスを表示するので、
どちら側が持っているかが分かります。`/health` の `rejected_last_minute` は直近 1 分の拒否を発生元の種類
（`game`、`extension`、`web`、`none`）別に数え、トークン不一致とブラウザ拡張の探索を区別できます。
`connection.replaced_connections` は古いゲーム接続が新しい接続に置き換えられた回数で、複数の `Game.exe` を
同時に動かすと増え、状態も飛びます。

## ツール

どの呼び出しも同じエンベロープを返します。

```json
{
  "ok": true,
  "status": "done",
  "action": "walk",
  "action_id": 42,
  "effect": { "steps_done": 3 },
  "interrupted_by": null,
  "reason": null,
  "tick": 12345,
  "state": { "scene": "map", "map": { "id": 100, "name": "Cave 3", "area": ["Cave 1", "Cave 2"] } },
  "new_log": [],
  "warnings": []
}
```

`status` は次のいずれかです。

- `done` — 目標に到達した、またはアクションが自然に終了した。
- `partial` — 予算切れや移動の阻害。`effect` にどこまで進んだかが入ります。
- `interrupted` — メッセージ、選択肢、戦闘、マップ移動、シーン切り替えに制御を奪われた。`interrupted_by` が理由を示します。
- `error` — アクションを開始できなかった（`ok: false`）。

`partial` と `interrupted` は正常なプレイ結果であり、ツールの失敗ではありません。

`timeout` はアクションが実行されなかった証明ではありません。エラーエンベロープには `action_id` と
`effect: {outcome: "unknown", retry_safe, hint}` が入ります。`retry_safe` が true になるのは読み取り専用
アクションだけです。ブリッジが待つのをやめた後に届いたゲームの応答は、次の呼び出しの `warnings` に一度だけ
表示されます（"finished after the bridge stopped waiting"）。再試行する前に `observe` で状態を読み直して
ください。`reason: "game_not_ready"` はソケットは接続済みだが互換性のあるハンドシェイクが未完了であること
（`effect.connection` が理由を示します）、`game_not_connected` はゲーム接続が無いことを意味します。

| ツール | 動作 |
| --- | --- |
| `observe` | シーン、マップ、プレイヤーのタイルと向き、表示中のメッセージ、選択肢、パーティ（HP／所持金に加え、`party.inventory`：重要アイテムが先、通常アイテムが後、それぞれ合計付き。完全な一覧は `manage` の roster）、戦闘、近くのイベント。`state.nearby` は近い順に 5 件のイベントを `{event_id, name, x, y, distance, kind}` で返し、`kind` は `action`（決定キー）、`touch`（踏むと発動）、`transfer`（扉や階段）、`shop`、`other` のいずれかです。コマンド 0 個のベッドや施錠された扉のような装飾イベントも含まれます（それらが目的のトリガーであることが多いため）。`state.message_history` はフレームループが見た直近 3 行のセリフを保持し、呼び出しの合間にカットシーンが自動で進めた行も含みます。`objective` は `note` の key `objective` の値をそのまま返すため、長いセッションでも目標を見失いません。マップ上では `threats`（8 タイル以内の戦闘イベント。距離、移動中か、追跡するか）、`balloons`（8 タイル以内のクエストマーカー `!` / `?`。距離、balloon ID、元画像）と `world_frozen`（`FreezeWhileThinking` がマップを止めている間 true）も返します。戦闘中は入力フェーズ全体で `party_commands`、`actor_commands`、入力中のアクター、スキルタイプごとの全スキル（MP/TP コストと使用可否）、戦闘アイテム、`enemy_targets` / `actor_targets`（インデックスが `target_index` に対応）を返し、今フォーカスされているウィンドウだけに留まりません（`skill_window` / `item_window` 自体はそのコマンドを選んだ後にだけ現れます）。`battle.log` は直近の `Window_BattleLog` 行です。メニューやショップなどマップ外のシーンでは、表示中の各ウィンドウのカーソル、項目、ショップ価格を返します。セーブ画面では各スロットの `exists` / `timestamp` / `playtime` も返します。マップ上では、独自のオーバーレイウィンドウ（ワールドマップの目的地リスト、HUD メニューなど）が開いているとき `state.ui` に載ります。標準のメッセージ／マップ名ウィンドウは `state.message` / `state.map` と重複するため除外します。メッセージが開いているのに本文が空の場合は、本文を画像で描いています：`message.image_text` は（ゲームが使っていれば）`DTextPicture` の文字列、`message.pictures` は表示中のピクチャ名、`text_source` は `image_text` か `picture` です。 |
| `look` | ローカルマップを文字グリッドで返します（`@` 自分、`E` イベント、`.` 通行可、`#` 通行不可）。マップ座標の `origin` とイベント一覧付き。`detail: "full"` はセルごとの通行可否に切り替えます。マップ外のセルは切り詰め、マップを超える半径は境界まで切り詰めて実際の `radius` を返します。`overview: true` でマップ全体を返します。マップ外のシーンでは `bad_scene` と現在のシーン名を返します。 |
| `list_events` | 近くのイベントの名前、距離、トリガー種別、`interact_from`（`adjacent` / `here`）、`action_trigger`、`commands` / `empty`（有効なページにコマンドがなく、決定キーを押しても反応しない）、`hazard`（現在有効なページが直接または公共イベント経由で戦闘を開始する）、`chases`（移動ルートがプレイヤーを追う）。さらに `balloon`（頭上マーカー：1 `!`、2 `?`、0 なし。重ね画像や実行中の balloon から判定）、`page`（有効ページ番号と総数）、`note`（イベント注釈）、`page_note`（有効ページのコメント命令。note 型プラグインのタグはここに入る）を返します。後ろ二つは内容がある場合のみ。条件付きページがあるイベントでは `pages` に各ページの `index`、`active`、`trigger` と待機条件を列挙します：スイッチ（`switches`：`id`、`name`、`on`）、変数の下限（`variable`：`id`、`name`、`needs`、`value`）、セルフスイッチ（`self_switch`：`key`、`on`）、必要アイテム（`item`：`id`、`name`、`held`）、必要アクター（`actor`：`id`、`name`、`in_party`）。NPC や扉が反応しない理由、次のストーリー状態が何に依存するかがここで分かります。条件のないイベントは従来どおり簡潔なままです。転送イベントには `destination`（`map_id`、`x`、`y`、マップ名 `name`。有効ページを優先し、無ければ 201 を持つ別ページと `page_index`・条件）も付くので、扉の行き先を調べるために `Map###.json` を開く必要はありません。結果が空のときは `effect.diagnostic` が読み込み済みイベント数、半径制限、転送／メッセージ中かを示し、読み込み中の空結果と取り違えません。 |
| `walk` | 指定方向へ最大 N タイル歩く。歩き切れなかった場合（壁や途中で遮られた場合）は `partial` を返します。`interrupted_by` は `message`（先に advance）、`choice`（先に select）、`event`、`transfer`、新しいシーン名を区別します。メッセージ・選択肢・イベント・転送がすでに画面を占有している場合は、歩行が黙って止まる前に `busy` と `blocked_by` を返します。`avoid_hazard: N` は戦闘イベントの N タイル圏内に踏み込む前に停止します。マップ外のシーン（メニュー、セーブなど）では `bad_scene` と現在のシーン名を返します。 |
| `go_to` | A* で指定タイルまで経路探索して移動。`effect.path` は方向コード列（2 下、4 左、6 右、8 上）で `path_length` がその長さ、ルートのキャッシュや描画に使えます。`dry_run: true` は移動せず経路だけ返します。目標タイルは立地可能である必要があり、ベッド・カウンター・壁には移動できません。失敗時は `nearest_reachable {x, y, distance, steps}`、`blocked_by`（`wall`、`event`、`one_way_tile`、`avoidance_zone` など）、`target_passable`、`events_at_target` を返すので、やみくもに再試行せず到達可能な目標へ切り替えてください。到着に成功したとき、目標タイルにイベントがあれば `effect.events_at_target`（トリガー種別、ページ、`interact_from`、扉なら `destination`）と先頭の `effect.arrived_event` を返します。決定キーで起動するイベントは到着後も OK が必要、踏みつけイベントは一歩が必要なので、「着いたのに何も起きない」を説明できます。ウィンドウが画面を占有している場合は、マップのせいにせず `busy` と `blocked_by`（`choice` / `message` / `event` / `transfer`）を返します。`avoid_hazard: N` は戦闘イベントを迂回し、次の一歩が近づく場合に停止します。マップ外のシーンでは `bad_scene` を返します。 |
| `talk_to` | 決定キーでマップイベントを開始：隣接タイルからイベントの方を向くか、`interact_from: "here"` のイベントならそのタイルまで歩いてから押します。カウンター越しの店員（`interact_from: "across_counter"`）はカウンターの前に立ち、カウンターの方を向いて押します。エラーは到達不能・対象外のページ・空のプレースホルダーページを区別します。マップ外のシーンでは `bad_scene` を返します。 |
| `interact` | 決定キーを 1 回押す。 |
| `advance` | 文字送りを早送りし、ページを進め、選択肢またはイベント終了で停止。まず `effect.pages` を読んでください。これは呼び出し中に現れた全ページで、イベントが 1 回で完走した場合は会話全体になることもあります（既に見た行を進めただけなら空のこともあります）。`effect.advanced_text` はフレームループが見たが `pages` から漏れた行のフォールバックで、通常は現れません。`page_delay_ms` はメッセージウィンドウのみに作用し、戦闘ログはゲーム自身のペースで流れます。戦闘中はコマンドを一切出しません。コマンド／対象ウィンドウが待機中なら `needs_command` を返し、`battleEnd` フェーズでは勝利／経験値ウィンドウを決定キーで進め（`stop: "battle_end"`）、マップへ戻った時点で終了します。 |
| `select` | 番号またはラベルで選択：メッセージの選択肢、イベントの Select Item ウィンドウ、または現在アクティブなメニュー／ショップ／戦闘ウィンドウ（インデックスは `observe.ui` と同じ）。開きかけのメニューシーンは待機します。セーブ画面では先に `select` でスロットをフォーカスする必要があり、直接 `input ok` を押すと拒否されます。 |
| `back` | キャンセルキー（メニューを閉じる、一つ戻る）。 |
| `battle` | 戦闘 UI を操作。`auto` は戦闘終了までコマンドを繰り返します。`policy: "attack"`（既定）は全員攻撃、`policy: "skill_first"` は MP の続く限り最初の使用可能スキルを使い、無ければ攻撃します。エンジンの自動戦闘ではなく、回復も行いません。コマンド指定時は入力中のアクターに 1 手だけ指示します。コマンドは `command_index`、symbol、表示ラベル（攻撃/attack など）の順に照合します。`skill` / `item` の失敗時は対象ウィンドウを閉じてからエラーを返します。`effect.turn` は現在のターン、`effect.turns` は呼び出し中に完了したターン数、`effect.log` は直近の戦闘ログ、`escape` は `nearest_threat`（座標と方向）を追加します。`busy` の拒否時は戦闘ウィンドウの状態を返します。 |
| `manage` | 戦闘外のパーティ操作。roster で装備・スキル・所持品、equip でスロット変更、formation で並び替え、use_item でアイテム使用。 |
| `title` | タイトル画面：ニューゲーム、最新セーブからの再開、オプション、戻る。引数名は `action`。 |
| `wait` | settled / message / choice / battle / シーン切り替え / 指定ミリ秒を待つ。 |
| `checkpoint` | メモリ上のスナップショットを保存・読込・一覧・削除。ディスクのセーブスロットには触れません。 |
| `input` | エンジンの生ボタン（`button`、`hold_ms`）。押下時間を正確に指定できます。`effect.effective` は今回の押下で実際に変化があったか（独自ウィンドウのカーソル移動を含む）を示し、`effect.window` は押下後にカーソルを持つウィンドウと `index` / `selected` を返します。メッセージ中にメニューを押すなど作用できない場合は `reason: "input_swallowed"` と `blocked_by` を返します。セーブ画面でスロット未選択のまま `ok` を押すと `save_slot_not_chosen` を返します。 |
| `log` | ポーリングされたイベントログ。メッセージ、選択肢、マップ移動、シーン切り替え、戦闘開始と終了、パーティと敵の状態・装備変化。セリフに要求や手がかり（「〜が必要」「〜しなければ」など）が出た場合は `hint` エントリも記録します。カットシーンがシーン切り替えなしで同じマップ内のプレイヤー位置を変えた場合は `transfer_by_event`（`from`、`to`、実行中のイベント `event_id`）を記録するので、古い座標目標が無効になったことが分かります。 |
| `game_data` | 読み取り専用のデータベース・進行状況参照。`kind: "switches"` / `"variables"` は既定で名前のある項目だけを返します（`id`、`name`、現在値）。`all: true` で名前のない項目も含め、`ids` で番号を指定できます。名前のあるスイッチ／変数は通常クエストやストーリー状態を表します。`kind: "items"` / `"weapons"` / `"armors"` / `"skills"` は `ids` で正確に取得（ヘルプ文付き）、または `query` で名前・説明・注釈を検索します（ヘルプ文に用途や条件が書かれていることが多い）。どちらも無い場合は id と名前だけの索引を返します。`kind: "shop"` は `event_id` とともに使い、そのショップイベントの商品を種別、id、名前、実際の価格で返します。`302` と続く `605` の商品をまとめて読み、商品を持つ全ページ（`pages[]`：`page_index`、`active`、`trigger`、`conditions`、そのページの商品）を返すので、条件付きページの品揃えも見えます。`effect.goods` は有効ページに商品があればそれ、無ければ商品を持つ最初のページです。`effect.page` と `effect.source`（`active_page` / `other_page`）が取得元を示します。スクリプトで設定され、ショップ命令に現れない商品は見えません。 |
| `note` | ブリッジ側マシン上の永続ノート。ゲームタイトルごとに管理。書き込みはアトミックで、直前のコピーを保持します。ファイルが壊れている場合は `warnings` で報告し、破損コピーを保存したうえで可能ならバックアップから復元します。key `objective` の値は毎回の `observe` に含まれます。例：`{"action":"set","key":"objective","text":"2000G を貯めてギルドに登録する。街を出る前に武器を買う"}`。 |

### エラー理由

アクションを開始できない場合、`ok` は `false` になり、`reason` は通常次のいずれかです。

| `reason` | 意味 |
| --- | --- |
| `game_not_connected` | ゲームプラグインのソケット接続がありません。 |
| `game_not_ready` | ソケットは接続済みですが、ハンドシェイクが無い・未完了・非互換です。`effect.connection` が状態、プロトコルバージョン、プラグインバージョンを示します。 |
| `timeout` | 時間内に応答なし。アクションが実行された可能性があります。`action_id`、`effect.outcome`（`unknown`）、`effect.retry_safe` を読み、再試行前に `observe` で確認してください。遅れて届いた応答は次の `warnings` に一度だけ現れます。 |
| `bad_scene` | そのアクションはマップ（または特定のシーン）でのみ動作し、現在のシーンが異なる。`effect.scene` がシーン名を示します。 |
| `not_on_map` | シーンはマップに見えるが、利用可能なマップデータが見つからない。通常は `Map###.json` の欠落や破損です。 |
| `needs_command` | 戦闘中にコマンド／対象ウィンドウが待機している状態で `advance` を呼んだ。先に `battle` でコマンドを出してください。 |
| `save_slot_not_chosen` | セーブ画面で `select` によりスロットを選ぶ前に `ok` を押した。 |
| `input_swallowed` | 現在そのボタンは作用できない。`blocked_by` が画面を占有しているもの（メッセージ、イベント、無効なウィンドウ）を示します。 |

その他の理由（`blocked`、`threat_nearby`、`busy`、`unreachable` など）はアクション固有の結果で、各アクションの説明に記載しています。

### 推測フィールド

次の 2 つはヒューリスティックであり、エンジンが直接公開するデータではありません。

- `balloon`（`list_events`）と `balloons`（`observe`）—— RPG Maker にクエストマーカーのフラグはありません。イベントページの重ね画像名が `bikkuri`（`!`）または `hatena` / `question`（`?`）に一致する場合、またはその時点で balloon が再生されている場合にマーカーとして報告します。別名の画像、ピクチャ、再生が終わった balloon によるマーカーは検出できません。
- `hint`（`log`）—— セリフが少数の要求・手がかりパターンに一致したときに追加されます。言い回しが異なるヒントは漏れることがあり、偶然一致した通常のセリフが記録されることもあります。

エンベロープのその他のフィールドは実行時オブジェクトから直接読み取ります。

### 会話の進行速度

`advance` は各ページを `page_delay_ms` の間だけ画面に残してから次へ進むため、文章が読みやすいペースになります。
既定値はプラグインのパラメータ `ReadDelay`（2000 ms）です。`page_delay_ms: 0` を渡すと最速で進みます。
この遅延はメッセージウィンドウにのみ作用します。戦闘ログは 1 行ずつゲーム自身のペースで流れ、このパラメータの影響を受けません。

### ログファイル

NW.js にはプレイヤー向けのコンソールがないため、プラグインのパラメータ `Debug` の出力は実際のプレイでは
ほとんど見えません。`LogFile` にパス（例：`www/mv-ai-bridge.log`、相対パスはゲームの作業ディレクトリ基準）を
設定すると、同じ診断情報をファイルへ書き出します：接続、各コマンドと引数、ジョブ終了時の状態とエラー。
`true` は `www/mv-ai-bridge.log` の短縮形です。ファイルは追記のみで、ローテーションは行いません。

### 思考中のフリーズ

プラグインのパラメータ `FreezeWhileThinking` を `true` にする（既定は `false`。`plugins.js` のエントリを編集するか、
`install` 後に変更）と、ゲームが落ち着いていてブリッジのアクションが動作していない間、マップの更新が止まります。
描画は続き、ブリッジのアクション（移動、メニュー）の実行中はフリーズが解除されます。
世界のシミュレーション（イベント移動、並列イベント）だけが停止し、このとき `observe` は
`state.world_frozen: true` を返します。

メッセージ、選択肢、戦闘、マップ移動の最中はフリーズしません。会話や戦闘のアニメーションは通常どおりです。
`avoid_hazard` の代替ではなく補助です。隣接タイルまで迫ったモンスターは、エージェントが動いた時点で戦闘になります。

### 徘徊するモンスター

多くの MV ゲームはフィールド上の敵を、戦闘を開始する普通のイベントとして実装しています（イベントページに直接、
または呼び出した公共イベント経由）。`list_events` は現在有効なページだけを調べて `hazard: true` を返し、
移動ルートがプレイヤーを追う場合は `chases: true` も返します。`observe` はマップ上で 8 タイル以内の戦闘イベントを
`threats` として列挙するため、最初の感知だけで戦うか迂回するかを決められます。

`walk` と `go_to` は `avoid_hazard: N` を受け付け、経路を戦闘イベントから N タイル離し、次の一歩が近づく場合は
`status: "partial"`、`reason: "threat_nearby"` で停止します。これはベストエフォートです。追跡範囲が安全距離以上の
モンスターは、立ち止まったプレイヤーには追いつきます。事故を減らすための機能であり、回避を保証するものではありません。

### 戦闘の戦術操作

ブリッジ自身は戦術を判断しません。選択肢をすべて提示し、エージェントが選んだ 1 手を実行します。
例外は `battle auto` ですが、意図的に小さく作っています。`policy: "attack"`（既定）は各アクターが攻撃を繰り返し、
`policy: "skill_first"` は MP の続く限り最初の使用可能スキルを使い、無ければ攻撃します。エンジンの自動戦闘では
ないため、回復・弱点ごとの対象変更・倒れた仲間への対応はしません。雑魚戦向けです。

`effect.turn` は呼び出し時のターン、`effect.turns` は呼び出し中に完了したターン数です（1 手だけの呼び出しは
確定と同時に戻るため 0）。`effect.log` は直近の `Window_BattleLog` 行です。`escape` の後は
`effect.nearest_threat` が最寄りの戦闘イベントの座標と方向を返します。追跡イベントはその場に留まると
すぐ再発動するため、逃げたらまずその場を離れてください。

- 戦闘中の `observe` は `state.battle.commands`（アクターコマンドウィンドウ。攻撃、スキルタイプごとの項目、
  防御、アイテム）、`state.battle.actor`（選択中のアクター）、`skill_types`（全スキルと
  `mp_cost` / `tp_cost` / `usable`）、戦闘 `items`、`targets` を返します。
- `battle` に `command_index`（または `action` と `skill_type_index`）、`skill_index`、`item_index`、
  `target_index` を渡すと、入力中のアクターに 1 手だけ指示し、ゲームが確定した時点で戻ります。
  次のアクターには再度 `observe` して指示します。
- コストはゲーム側のスキルプラグインが定義するため、`Skills.json` の `mp` ではなく
  `skillMpCost` / `skillTpCost` で読み取ります。`Skills.json` の `mp` は欠けていたり上書きされていたりします。
- 知覚は HP だけではありません。`observe` は全パーティメンバー、全敵、両方の対象ウィンドウに `states` を返し、
  イベントログは状態の付与・解除や装備スロットの変化を `actor_state` / `actor_equip` として記録し、
  敵の状態変化も同様に `enemy_state` として記録します。
  状態や装備解除で表現される衣装破損なども、1 ターンだけの効果であっても見逃しません。

### パーティ管理

`manage` は戦闘外の装備、並び順、アイテム使用を扱います。

- `roster`（読み取り専用）— 並び順、レベル、HP/MP/TP、状態、スロットごとの装備、習得スキル、所持品。
  `detail: "full"` を付けると、各スロットに装備できるアイテムも返します。
- `equip` — `actor_id` + `slot` + `item_id` で 1 スロットを変更（`item_id: 0` で外す）。
- `formation` — `swap: [i, j]` で 2 人の位置を交換。ランタイムの並び順 API を直接呼びます
  （`bypasses:` メニューでの並び替え時に料金や制限を課すパーティ変更プラグイン）。
- `use_item` — アイテムメニューで選ぶのではなく、エンジンのアクション処理でアイテムを使用します
  （`bypasses:` メニューの選択にフックするプラグイン、独自の確認や追加の対象ルール。
  使用者は行動可能なメンバーのうち `pha` が最も高いキャラクター）。

`roster` 以外は、メッセージ、選択肢、イベント、マップ移動が動いていない落ち着いたマップでのみ実行できます。

### メニューとショップ

メニューとショップは `input`、`back`、`observe` で操作します。マップと戦闘以外のシーンでは、`observe` に `ui`
ブロックが加わり、表示中の各ウィンドウのクラス名、`active` フラグ、カーソル位置、そのウィンドウ自身が持つ項目
（メニューコマンド、個数付きのアイテム一覧、価格付きのショップ商品）を返します。個々のメニュープラグインを
モデル化するのではなく、ゲームが構築したウィンドウオブジェクトを読むため、標準メニューも大幅に作り込まれた
メニューもエージェントからは同じように扱えます。`input` の `menu` でメニューを開き、方向キーで移動、`ok` で
決定、`back` で閉じます。

### チェックポイント

`checkpoint save` は `JsonEx` でランタイム状態全体をシリアライズし、メモリ上に保持します。
`checkpoint load` はそれを復元してマップシーンへ戻します。ランタイム状態を丸ごと置き換えるため、
メニューからロードしたときにだけ動くプラグインの処理はバイパスされます。
部屋や選択肢のやり直しに最適ですが、セーブスロットではありません。
ゲームプロセスとともに消え、ゲームのロードメニューにも現れません。

- `save` は「落ち着いたマップ」でのみ受け付けます。メッセージ、選択肢、イベント、移動、場所移動のいずれも
  進行中でない状態です。そうでない場合は `not_settled` を返し、`effect.blocked_by` に理由
  （`message`、`choice`、`event`、`transfer`、`moving`、`busy`）を入れます。マップシーン以外では `bad_scene` です。
  セーブ内容にはマップのインタープリタの進行状況が含まれますが、メッセージウィンドウや戦闘は含まれません。
  そのため、イベント進行中のスナップショットは、画面に出ていた文章が欠けた状態で復元されます。
  `wait`（`until: "settled"`）を使ってからやり直してください。
- `load` はどのシーンからでも（ゲームオーバー画面を含む）使えます。ゲーム本来のロードと同様、先にゲームオブジェクトを
  作り直します。セーブ内容に `$gameTemp`、`$gameMessage`、`$gameTroop` は含まれないため、ロード前に残っていた
  メッセージ、選択肢、予約済みのコモンイベントがロード後に持ち越されることはありません。

## アンインストール

1. `www/js/plugins/MV_AI_Bridge.js` を削除します。
2. `www/js/plugins.js` から `MV_AI_Bridge` のエントリを削除するか、`www/js/plugins.js.mv-ai-bridge.bak` で上書きします。
3. トークン、セッションファイル、ノートも消す場合は `~/.mv-ai-bridge/` を削除します。

Steam の「ゲームファイルの整合性を検証」は `plugins.js` を復元するため、結果的にエントリも消えます。
インストール前にゲームのライセンスを確認してください。商用ゲームの一部はファイルの変更を許可していません。

## セキュリティ

- `--host` を渡さない限り、ブリッジは `127.0.0.1` にのみバインドします。管理下にないネットワークへ公開しないでください。
- `/mcp`、`/health`、およびゲーム接続 `/game` は `~/.mv-ai-bridge/token` の Bearer トークンを要求します。
  ファイルを削除するとローテーションできますが、その後 `install` を再実行する（またはプラグインの `Token`
  パラメータを消す）まで、ゲームは新しいトークンを送れません。
- プラグインは `Token` パラメータがあればそれを、なければ `~/.mv-ai-bridge/session.json`（ポート一致時）の
  現在のトークン、さらに `token` ファイル（`MV_AI_BRIDGE_HOME` 対応）の順で読み、接続時に `?token=` として送ります。
  `install` は現在のトークンをそのパラメータへ平文で書き込むため、ゲームフォルダは非公開にしてください。
  トークンのない接続は 401 になります。
  どの Web ページからでも `127.0.0.1` への WebSocket は開け、新しい `/game` 接続は現在の接続を置き換えるため、
  この検証がないと、ユーザーが開いたページが本物のゲームを追い出し、偽の状態や会話をエージェントに送り込めてしまいます。
- 古いプラグインファイルのままのゲームはトークンを送らないため拒否されます。`install` を再実行して更新してください。
- ゲーム側プラグインはブリッジへ外向きに接続します。ゲーム側に受信ポートはありません。
- 書き込みアクションは同時に 1 つだけ実行されるため、エージェントが 2 つの移動処理を交互に実行することはできません。

## 開発

```bash
npm run build
npm test                 # ランダムポート上のモックゲーム。実ゲーム不要
node test/live.js observe '{}'   # 実行中のブリッジへ 1 回だけ呼び出す
```

`test/live.js` は `~/.mv-ai-bridge/session.json` を読み、ツールを 1 つ呼び出します。
手動用のツールであり、`npm test` には含まれません。

RPG Maker MV 1.6.1 で 2 つのプロジェクトを実機確認済みです。127 個の独自プラグインファイルを持ち、ブリッジは `plugins.js` の末尾に登録
（独自のメッセージ・戦闘・メニューシステム）した日本語の商用ゲームと、中国語の同人ゲームです。
実機ではマップ移動と経路探索、会話と選択肢、メニュー、戦闘、店、イベントログを操作しました。
`npm test` はモックゲームに対してブリッジのプロトコルを検証します。

## 既知の制限

- **ラップではなく丸ごと置き換えるプラグイン。** プラグインは最後に読み込む必要があります。
  `Input._currentState` への書き込みで入力を仮想化し、`SceneManager.updateMain` / `SceneManager.updateScene` を
  フックします。これらのシンボルを元の実装を呼ばずに置き換えるプラグインがあると、移動やフリーズが壊れます。
- **プロジェクト構成。** `install` は `www/js/plugins.js` と `www/js/plugins/` を前提とします。
  ランタイムがルート直下（`Game.exe` の隣に `js/`、`data/`）にある場合や、Enigma などで暗号化されている場合は、
  プラグインを手動でコピーし、`plugins.js` に手動でエントリを追加してください。
- **1 つのブリッジにつき 1 つのゲーム。** 1 プロセスが同時に接続できるゲームは 1 つです。
  2 つ目のゲームを同時に動かすには、そのゲームを別の `--port` でインストールし、同じポートで 2 つ目の
  ブリッジを起動します。
- **PC のみ。** NW.js デスクトップ版に対応します。モバイル、Cordova、ブラウザ版は非対応です。
- **ウィンドウ層を迂回する戦闘プラグイン。** 戦闘ツールは標準のコマンドウィンドウを操作します。
  独自の入力フローを持つ戦闘プラグインでは機能が低下するため、モデル化されていない画面には `input` を使ってください。
- **チェックポイントはメモリのみ。** 実行中のプロセス内に存在し、ロードメニューには現れず、
  ゲームを閉じると消えます。
- **`go_to` の目標は立地可能なタイルである必要があります。** ベッド、カウンター、壁などは移動できず、
  呼び出しは診断付きの `unreachable` を返します。`effect.nearest_reachable`（および `blocked_by`、
  `target_passable`、`events_at_target`）を読んで到達可能なタイルへ切り替えるか、`dry_run: true` で
  先にルートを確認してください。

## ライセンス

MIT。[LICENSE](LICENSE) を参照してください。
