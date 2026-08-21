# pomisuke

[English](#english) | [日本語](#japanese)

---

<a name="english"></a>
## English

A LINE chatbot template powered by Groq, deployable on Render's free plan.

### Architecture

```
LINE  →  Render (Express/Node.js)  →  Groq API  →  LLM (e.g. Qwen 3 / LLaMA)
```

### Features

- Personal chats: no mention needed, conversation continues indefinitely
- Group/room chats: `@botname` starts/resets a session; replying to Pomisuke's message continues it
- Sliding 10-message context window (5 user + 5 assistant) per session
- `/model` (or `/models`) — list and switch the Groq model per session, including a self-hosted option
- `リマインダー` — time-triggered reminders (add/list/delete), see below

### Setup

**1. ENV vars**

```
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=
GROQ_API_KEY=
GITHUB_TOKEN=
LOCAL_LLM_URL=
LOCAL_LLM_TOKEN=
ADMIN_SECRET=
```

`GITHUB_TOKEN` should be a fine-grained GitHub Personal Access Token scoped to
this repo only, with **Contents: Read and write** permission — it's used to
read and update the knowledge vault and bot config (see below).

`LOCAL_LLM_URL`/`LOCAL_LLM_TOKEN` are optional — only needed for the
`huihui-claude(無検閲)` option in `/model`, which routes to a self-hosted
OpenAI-compatible endpoint instead of Groq. `LOCAL_LLM_URL` should include the
`/v1` path (e.g. `https://your-host.example/v1`); `/chat/completions` is
appended automatically. If unset, that option still appears in `/model` but
replies with the same "model unavailable" fallback as a model that no longer
exists.

`ADMIN_SECRET` protects the `/admin` dashboard's API (`/api/admin/*`) — `/admin`
itself loads for anyone, but every action requires this secret, unlike the
public read-only `/vault`. Without it set, the admin API fails closed (503).

**2. Deploy to Render**

Connect your GitHub repo. Build: `npm install` / Start: `npm start` / Plan: Free.

**3. Set LINE webhook**

`https://<your-app>.onrender.com/webhook`

### Knowledge vault

Pomisuke's persona/world-setting can optionally live as an Obsidian vault in
[`vault/`](./vault) — open that folder (or the whole repo) in Obsidian to
browse and edit it with graph view and backlinks. `vault/world-setting/` is
curated canon linked from `index.md`; `vault/auto-log/` is a scratch log the
bot appends to automatically when Pomisuke improvises a new fact mid-conversation
(only active in **vault** prompt mode — see below). See
[`vault/README.md`](./vault/README.md) for details. The bot reads/writes the
vault directly via the GitHub API (no local git clone on the server).

Browse the knowledge graph and note contents (read-only) at `/vault` on the
deployed app — public, no auth. Edit vault notes at `/admin` instead (see below).

A second graph at `/knowledge` (also public, read-only) visualizes the same
idea one level more granular: instead of one node per `.md` file, each node
is one individual vocabulary word or Pomisuke fact from `vocabulary.md`/
`pomisuke-fact.md`, clustered around two category hubs.

### Bot configuration (admin panel)

Visit `/admin` on the deployed app to tune Pomisuke without editing code:
default model, general system prompt, per-model prompt/param overrides, and a
**Prompt Mode** switch — `normal` uses the static system prompt edited on the
page; `vault` rebuilds the prompt from `vault/world-setting/index.md` + linked
notes instead (the original vault-composed-prompt behavior). In vault mode, a
separate **Fact Reviewer** (its own model + editable prompt template) reads
each reply and appends any new, non-duplicate vocabulary/facts it finds
straight into `vocabulary.md`/`pomisuke-fact.md` — both ordinary linked vault
notes the main chat reads like any other. Config/model/param edits are a
two-step **Save** (browser-local draft only) → **Commit** (pushes
`config/bot-config.json` to `main`, which Render then redeploys) flow; vault
note edits save straight to GitHub per note. A built-in test-chat panel (same
10-message window as LINE, clears on any setting change or the Clear button)
lets you preview changes — including reasoning output, which notes were read,
and what the reviewer would write — before committing. Protected by
`ADMIN_SECRET` (see above).

### Reminders

Tap リマインダー in the ぽよマスター menu to add or delete a time-triggered
reminder, scoped to the current session just like everything else. リマインダー
を追加 asks 何を覚えるぽよ？ and waits for a free-text answer describing what
and when — Pomisuke's own default chat model (never the self-hosted
`huihui-claude(無検閲)` option, which has proven unreliable at strict
structured output) parses it into one of three shapes:

- **Absolute**: "8月25日の15時に宿題やる" — a specific date/time, down to the second if given.
- **Relative**: "30分後に宿題やる" — a one-time interval from now.
- **Recurring**: "毎週水曜に宿題やる", "第四金曜日に...", "3時間ごとに...", "1分半ごとに..." (fractional minutes supported, 1-minute floor) — weekly, biweekly, a specific weekday, the Nth weekday of the month, yearly, or a plain repeating interval.

All parsed dates/intervals are resolved and computed in code (via the
[`rrule`](https://www.npmjs.com/package/rrule) library for recurrence), never
trusted to the LLM for arithmetic — the model only extracts constrained
fields. You'll always get a confirmation prompt showing exactly what was
understood before it's saved; if the answer can't be parsed at all, Pomisuke
replies with a fixed line: `ぽみはぺだからわからなかったぽみねえ`.
リマインダーを削除 lists your active reminders (tap one, then confirm) to
remove them. Reminders are JST-only (fixed +9:00, no DST) and persisted to
`data/reminders.json` via the same GitHub-API mechanism as the knowledge
vault/config, so they survive Render sleep/redeploy; a background check runs
every 60 seconds plus once immediately at startup, so anything that came due
while the server was asleep still fires (late, not dropped).

### Notes

- Free Render instances sleep after 15 min of inactivity — use [UptimeRobot](https://uptimerobot.com) to keep alive.
- In-memory session store resets on redeploy.

---

<a name="japanese"></a>
## 日本語

Groq を使った LINE チャットボットのテンプレート。Render 無料プランで動く。

### 構成

```
LINE  →  Render (Express/Node.js)  →  Groq API  →  LLM (例: Qwen 3 / LLaMA)
```

### 機能

- 個人チャットはメンション不要、会話は継続し続ける
- グループ/ルームは `@ぽみすけ` でセッション開始・リセット、返信チェーンで継続（レガシー仕様）
- 直近10件（ユーザー5件＋ぽみすけ5件）のスライディングウィンドウで文脈を保持
- `/model`（`/models` も可）— セッションごとに使用モデルを一覧・切り替え（セルフホストのオプションも選択可）
- `リマインダー` — 時間指定のリマインダー機能（追加・一覧・削除）、詳細は後述

### セットアップ

**1. 環境変数**

```
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=
GROQ_API_KEY=
GITHUB_TOKEN=
LOCAL_LLM_URL=
LOCAL_LLM_TOKEN=
ADMIN_SECRET=
```

`GITHUB_TOKEN` はこのリポジトリのみに絞った GitHub Fine-grained PAT で、
**Contents: Read and write** 権限が必要（ナレッジ vault とボット設定の読み書きに使用）。

`LOCAL_LLM_URL`/`LOCAL_LLM_TOKEN` は任意設定 — `/model` の
`huihui-claude(無検閲)` オプション専用で、Groq の代わりにセルフホストの
OpenAI 互換エンドポイントを呼び出す。`LOCAL_LLM_URL` は `/v1` を含めること
（例: `https://your-host.example/v1`）、`/chat/completions` は自動で付加される。
未設定の場合も `/model` には表示されるが、選ぶと既存モデルが無い場合と同じ
フォールバック応答になる。

`ADMIN_SECRET` は `/admin` ダッシュボードの API（`/api/admin/*`）を保護する —
`/admin` 自体は誰でも開けるが、操作にはこのシークレットが必須（公開・読み取り
専用の `/vault` とは異なる）。未設定の場合、admin API はフェイルクローズ（503）する。

**2. Render にデプロイ**

GitHub リポジトリを接続。Build: `npm install` / Start: `npm start` / プラン: Free。

**3. LINE Webhook URL を設定**

`https://<your-app>.onrender.com/webhook`

### ナレッジ vault

ぽみすけの人格・世界観は、任意で [`vault/`](./vault) 以下に Obsidian vault として
管理できる。このフォルダ（またはリポジトリ全体）を Obsidian で開けば、グラフビューや
バックリンクで編集できる。`vault/world-setting/` は `index.md` からリンクされた正式な
設定、`vault/auto-log/` はぽみすけが会話中に即興で語った新しい設定を自動で書き足す
スクラッチログ（**vault** プロンプトモードの時のみ有効 — 後述）。詳細は
[`vault/README.md`](./vault/README.md) を参照。サーバー側はローカルに git clone せず、
GitHub API 経由で直接読み書きする。

デプロイ後は `/vault` でナレッジグラフとノートの中身を閲覧できる（読み取り専用・認証なし）。
vault ノートの編集は `/admin` から行う（後述）。

`/knowledge`（同じく公開・読み取り専用）はもう一段細かいグラフ — `.md` ファイル単位
ではなく、`vocabulary.md`／`pomisuke-fact.md` 内の語彙・設定エントリ1つ1つがノードに
なり、2つのカテゴリハブを中心にクラスタ表示される。

### ボット設定（管理パネル）

デプロイ後 `/admin` にアクセスすると、コードを触らずにぽみすけを調整できる:
デフォルトモデル、汎用システムプロンプト、モデルごとのプロンプト/パラメータ上書き、
そして **プロンプトモード** の切り替え — `normal` はページ上で編集した静的な
システムプロンプトを使用、`vault` は `vault/world-setting/index.md` とリンク先
ノートを組み立ててプロンプトを構成する（元々の vault 合成プロンプトの挙動）。
vault モードでは、別枠の **Fact Reviewer**（専用モデル＋編集可能なプロンプト
テンプレート）が各返信を確認し、重複していない新しい語彙・設定を見つけたら
`vocabulary.md`／`pomisuke-fact.md` に直接追記する — どちらも他のノートと同様に
メインチャットが読む普通の vault ノート。設定・モデル・パラメータの編集は
**Save**（ブラウザ内の下書きのみ）→ **Commit**（`config/bot-config.json` を
`main` に push、Render が再デプロイ）の2段階フロー。vault ノートの編集は
ノートごとに直接 GitHub へ保存される。テストチャットパネル（LINE と同じ直近10件
のウィンドウ、設定変更や Clear ボタンでクリアされる）で、コミット前に reasoning
の内容、（vault モードでは）どのノートを読んだか、reviewer が何を書き込むかを
含めてプレビューできる。`ADMIN_SECRET` で保護される（上記参照）。

### リマインダー

ぽよマスターメニューの「リマインダー」をタップすると、時間指定のリマインダーを
追加・削除できる（他の機能と同様、現在のセッション単位）。「リマインダーを追加」
をタップすると「何を覚えるぽよ？」と聞かれ、何をいつ、を自由文で答えるのを待つ —
ぽみすけの通常の会話用デフォルトモデル（構造化出力が不安定と分かっている
セルフホストの `huihui-claude(無検閲)` オプションは対象外）がその回答を
次の3パターンのいずれかに解析する:

- **絶対時刻**: 「8月25日の15時に宿題やる」— 具体的な日時（秒まで指定があればそこまで）。
- **相対時刻**: 「30分後に宿題やる」— 今からの一度きりの間隔。
- **繰り返し**: 「毎週水曜に宿題やる」「第四金曜日に…」「3時間ごとに…」
  「1分半ごとに…」（小数分もOK、最小1分）— 毎週・隔週・特定の曜日・第N◯曜日・
  毎年・単純な繰り返し間隔に対応。

解析された日時・間隔は全てコード側で確定・計算される（繰り返しの計算には
[`rrule`](https://www.npmjs.com/package/rrule) ライブラリを使用）— LLM に
算術を任せることはせず、モデルは制約付きのフィールド抽出のみを行う。保存前に
必ず、理解した内容そのままの確認プロンプトが表示される。回答が全く解析できない
場合は、固定文言 `ぽみはぺだからわからなかったぽみねえ` を返す。
「リマインダーを削除」で有効なリマインダー一覧が表示され（タップして確認すると
削除）。リマインダーは JST 固定（+9:00、DST なし）で、ナレッジ vault や設定と
同じ GitHub API 経由で `data/reminders.json` に保存されるため、Render の
スリープ・再デプロイをまたいでも残る。60秒ごと＋起動直後に1回、バックグラウンドで
チェックが走るため、サーバーがスリープしている間に来たリマインダーも
（遅れて、だが漏れなく）発火する。

### 注意

- Render 無料プランは 15 分無通信でスリープ。[UptimeRobot](https://uptimerobot.com) で ping を送ると回避できる。
- セッションはメモリ管理のため、再デプロイでリセットされる。
