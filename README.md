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
```

`GITHUB_TOKEN` should be a fine-grained GitHub Personal Access Token scoped to
this repo only, with **Contents: Read and write** permission — it's used to
read and update the knowledge vault (see below).

`LOCAL_LLM_URL`/`LOCAL_LLM_TOKEN` are optional — only needed for the
`huihui-claude(無検閲)` option in `/model`, which routes to a self-hosted
OpenAI-compatible endpoint instead of Groq. `LOCAL_LLM_URL` should include the
`/v1` path (e.g. `https://your-host.example/v1`); `/chat/completions` is
appended automatically. If unset, that option still appears in `/model` but
replies with the same "model unavailable" fallback as a model that no longer
exists.

**2. Deploy to Render**

Connect your GitHub repo. Build: `npm install` / Start: `npm start` / Plan: Free.

**3. Set LINE webhook**

`https://<your-app>.onrender.com/webhook`

### Knowledge vault

Pomisuke's persona/world-setting lives as an Obsidian vault in [`vault/`](./vault) —
open that folder (or the whole repo) in Obsidian to browse and edit it with
graph view and backlinks. `vault/world-setting/` is curated canon (linked from
`index.md`, and that's what becomes the bot's system prompt); `vault/auto-log/`
is a scratch log the bot appends to automatically when Pomisuke improvises a
new fact mid-conversation. See [`vault/README.md`](./vault/README.md) for
details. The bot reads/writes the vault directly via the GitHub API (no local
git clone on the server), so edits take effect after they're pushed to `main`.

Browse the resulting knowledge graph and note contents at `/vault` on the
deployed app (public, read-only).

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
```

`GITHUB_TOKEN` はこのリポジトリのみに絞った GitHub Fine-grained PAT で、
**Contents: Read and write** 権限が必要（ナレッジ vault の読み書きに使用）。

`LOCAL_LLM_URL`/`LOCAL_LLM_TOKEN` は任意設定 — `/model` の
`huihui-claude(無検閲)` オプション専用で、Groq の代わりにセルフホストの
OpenAI 互換エンドポイントを呼び出す。`LOCAL_LLM_URL` は `/v1` を含めること
（例: `https://your-host.example/v1`）、`/chat/completions` は自動で付加される。
未設定の場合も `/model` には表示されるが、選ぶと既存モデルが無い場合と同じ
フォールバック応答になる。

**2. Render にデプロイ**

GitHub リポジトリを接続。Build: `npm install` / Start: `npm start` / プラン: Free。

**3. LINE Webhook URL を設定**

`https://<your-app>.onrender.com/webhook`

### ナレッジ vault

ぽみすけの人格・世界観は [`vault/`](./vault) 以下に Obsidian vault として管理する。
このフォルダ（またはリポジトリ全体）を Obsidian で開けば、グラフビューやバックリンクで
編集できる。`vault/world-setting/` は正式な設定（`index.md` からリンクされたものが
そのままシステムプロンプトになる）、`vault/auto-log/` はぽみすけが会話中に即興で語った
新しい設定を自動で書き足すスクラッチログ。詳細は [`vault/README.md`](./vault/README.md)
を参照。サーバー側はローカルに git clone せず、GitHub API 経由で直接読み書きするため、
編集内容は `main` に push した後に反映される。

デプロイ後は `/vault` でナレッジグラフとノートの中身を閲覧できる（公開・読み取り専用）。

### 注意

- Render 無料プランは 15 分無通信でスリープ。[UptimeRobot](https://uptimerobot.com) で ping を送ると回避できる。
- セッションはメモリ管理のため、再デプロイでリセットされる。
