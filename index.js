require('dotenv').config();
const path = require('path');
const express = require('express');
const line = require('@line/bot-sdk');
const { handleEvent } = require('./handler');
const { buildNotification } = require('./notify');
const knowledge = require('./knowledge');

// ── LINE SDK config ───────────────────────────────────────────────────────
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: lineConfig.channelAccessToken
});

// ── Express app ───────────────────────────────────────────────────────────
const app = express();

// Root
app.get('/', (req, res) => {
  res.send('ぽみすけ bot is running ぷよ！');
});

// Health check（GAS・UptimeRobot のping用）
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// LINE webhook — raw body required for signature verification
app.post(
  '/webhook',
  line.middleware(lineConfig),
  async (req, res) => {
    res.sendStatus(200);
    const events = req.body.events ?? [];
    await Promise.all(
      events.map(event =>
        handleEvent(event, client).catch(err => {
          console.error('Event handling error:', err);
        })
      )
    );
  }
);

// ── Knowledge vault viewer (public, read-only) ─────────────────────────────
app.get('/vault', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'vault.html'));
});

app.get('/api/vault/graph', async (req, res) => {
  try {
    res.json(await knowledge.buildGraph());
  } catch (err) {
    console.error('vault graph error:', err);
    res.status(502).json({ error: 'vault unreachable' });
  }
});

app.get('/api/vault/notes/:folder/:file', async (req, res) => {
  const { folder, file } = req.params;
  if (!['world-setting', 'auto-log'].includes(folder) || !/^[\w-]+\.md$/.test(file)) {
    return res.status(400).json({ error: 'invalid path' });
  }
  const result = await knowledge.readFile(`vault/${folder}/${file}`).catch(() => null);
  if (!result) return res.status(404).json({ error: 'not found' });
  res.json({ path: `${folder}/${file}`, content: result.content });
});

// ── GAS notification endpoint ─────────────────────────────────────────────
// GAS sends POST /gas-notify with:
//   { secret, app: 'carshare'|'ledger', event: string, data: object }
// Secured by a shared secret set in both GAS script properties and Render env.
app.use('/gas-notify', express.json());
app.post('/gas-notify', async (req, res) => {
  // Verify shared secret
  const secret = process.env.GAS_NOTIFY_SECRET;
  if (secret && req.body.secret !== secret) {
    console.warn('gas-notify: invalid secret');
    return res.sendStatus(401);
  }

  const { app: gasApp, event, data } = req.body;
  const groupId = process.env.LINE_GROUP_ID;
  if (!groupId) {
    console.error('gas-notify: LINE_GROUP_ID not set');
    return res.sendStatus(500);
  }

  const message = buildNotification(gasApp, event, data);
  if (!message) {
    console.warn(`gas-notify: unknown event ${gasApp}/${event}`);
    return res.sendStatus(400);
  }

  try {
    await client.pushMessage({ to: groupId, messages: [message] });
    console.log(`gas-notify: sent ${gasApp}/${event}`);
    res.sendStatus(200);
  } catch (err) {
    console.error('gas-notify: push failed', err);
    res.sendStatus(500);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ぽみすけ bot listening on port ${PORT} ぷよ！`);
});
