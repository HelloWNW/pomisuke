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

- Mention-triggered sessions (`@botname`)
- Reply-based conversation threading
- Automatic context compaction (every 6 turns → summarized into memory)

### Setup

**1. ENV vars**

```
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=
GROQ_API_KEY=
```

**2. Deploy to Render**

Connect your GitHub repo. Build: `npm install` / Start: `npm start` / Plan: Free.

**3. Set LINE webhook**

`https://<your-app>.onrender.com/webhook`

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

- メンション起動（`@botname`）でセッション開始・リセット
- 返信チェーンによる会話継続
- 6ターンごとに自動コンパクション（要約してメモリ節約）

### セットアップ

**1. 環境変数**

```
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=
GROQ_API_KEY=
```

**2. Render にデプロイ**

GitHub リポジトリを接続。Build: `npm install` / Start: `npm start` / プラン: Free。

**3. LINE Webhook URL を設定**

`https://<your-app>.onrender.com/webhook`

### 注意

- Render 無料プランは 15 分無通信でスリープ。[UptimeRobot](https://uptimerobot.com) で ping を送ると回避できる。
- セッションはメモリ管理のため、再デプロイでリセットされる。
