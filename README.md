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

### 注意

- Render 無料プランは 15 分無通信でスリープ。[UptimeRobot](https://uptimerobot.com) で ping を送ると回避できる。
- セッションはメモリ管理のため、再デプロイでリセットされる。
