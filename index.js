require('dotenv').config();
const logStream = require('./logStream'); // patches console.* — require before anything else logs
const path = require('path');
const express = require('express');
const line = require('@line/bot-sdk');
const { handleEvent } = require('./handler');
const { buildNotification } = require('./notify');
const knowledge = require('./knowledge');
const config = require('./config');
const store = require('./store');
const { chatWithPomisuke, listModels, LOCAL_MODEL_ID } = require('./groq');
const reminders = require('./reminders');
const reminderScheduler = require('./reminderScheduler');

const ADMIN_TEST_SESSION_ID = '__admin_test__';

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

// ── Knowledge graph viewer (public, read-only) ──────────────────────────────
// Obsidian-style like /vault, but each node is one vocabulary word or one
// Pomisuke fact (from vocabulary.md/pomisuke-fact.md), not a whole .md file.
app.get('/knowledge', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'knowledge.html'));
});

app.get('/api/knowledge/graph', async (req, res) => {
  try {
    res.json(await knowledge.buildFactsGraph());
  } catch (err) {
    console.error('knowledge graph error:', err);
    res.status(502).json({ error: 'vault unreachable' });
  }
});

// ── Admin tuning dashboard (protected — unlike /vault, this can rewrite the
// bot's live persona/params for everyone and a Commit triggers a redeploy) ──
function requireAdminSecret(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).json({ error: 'admin panel not configured' });
  if (req.get('X-Admin-Secret') !== secret) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use('/api/admin', express.json(), requireAdminSecret);

app.get('/api/admin/config', async (req, res) => {
  try {
    const [cfg, availableModels] = await Promise.all([config.getLiveConfig(), listModels()]);
    // Reviewer conversations are Groq-only (see groq.js's reviewReplyForFacts) —
    // the local model isn't offered as a reviewer choice.
    const reviewerModels = availableModels.filter(id => id !== LOCAL_MODEL_ID);
    res.json({ config: cfg, availableModels, reviewerModels });
  } catch (err) {
    console.error('admin config fetch error:', err);
    res.status(502).json({ error: 'config unreachable' });
  }
});

app.post('/api/admin/config', async (req, res) => {
  const c = req.body?.config;
  if (!c || typeof c.systemPrompt !== 'string' || !c.defaultModel ||
      typeof c.generalParams !== 'object' || typeof c.modelOverrides !== 'object') {
    return res.status(400).json({ error: 'invalid config shape' });
  }
  try {
    await config.writeConfig(c, 'admin: update bot config');
    res.json({ ok: true });
  } catch (err) {
    console.error('admin config commit error:', err);
    res.status(502).json({ error: 'commit failed' });
  }
});

// Test-chat playground — reuses store.js's normal session methods (same
// MAX_HISTORY=10 sliding window LINE sessions use) against one fixed
// pseudo-session id, and can test a draft (uncommitted) config via configOverride.
app.post('/api/admin/test-chat', async (req, res) => {
  const { message, draftConfig } = req.body ?? {};
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message required' });
  }
  try {
    store.addUserMessage(ADMIN_TEST_SESSION_ID, message);
    const result = await chatWithPomisuke(
      store.getMessagesForAPI(ADMIN_TEST_SESSION_ID),
      draftConfig?.defaultModel,
      { configOverride: draftConfig, debug: true }
    );
    store.addAssistantMessage(ADMIN_TEST_SESSION_ID, result.reply);
    res.json(result);
  } catch (err) {
    console.error('admin test-chat error:', err);
    res.status(502).json({ error: 'test chat failed' });
  }
});

app.post('/api/admin/test-chat/clear', (req, res) => {
  store.startSession(ADMIN_TEST_SESSION_ID);
  res.json({ ok: true });
});

// Live server log stream — every console.log/warn/error in the process
// (real LINE traffic included, not just the dashboard's own test messages),
// so you can watch for model/API errors as they happen. Plain streamed
// text over fetch, not EventSource — EventSource can't send the
// X-Admin-Secret header this route needs, same as every other /api/admin/*.
app.get('/api/admin/logs/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  for (const line of logStream.getRecentLines()) {
    res.write(line + '\n');
  }
  const write = chunk => res.write(chunk);
  logStream.subscribe(write);
  req.on('close', () => logStream.unsubscribe(write));
});

// Vault note editor — read/write individual notes directly (each Save commits
// immediately, separate from the config draft/commit flow above). The public
// /api/vault/notes/:folder/:file route above stays read-only and untouched.
app.get('/api/admin/vault/notes', async (req, res) => {
  try {
    const graph = await knowledge.buildGraph();
    res.json({ notes: graph.nodes.filter(n => !n.missing) });
  } catch (err) {
    console.error('admin vault list error:', err);
    res.status(502).json({ error: 'vault unreachable' });
  }
});

app.get('/api/admin/vault/notes/:folder/:file', async (req, res) => {
  const { folder, file } = req.params;
  if (!['world-setting', 'auto-log'].includes(folder) || !/^[\w-]+\.md$/.test(file)) {
    return res.status(400).json({ error: 'invalid path' });
  }
  const result = await knowledge.readFile(`vault/${folder}/${file}`).catch(() => null);
  if (!result) return res.status(404).json({ error: 'not found' });
  res.json({ path: `${folder}/${file}`, content: result.content });
});

app.put('/api/admin/vault/notes/:folder/:file', async (req, res) => {
  const { folder, file } = req.params;
  if (!['world-setting', 'auto-log'].includes(folder) || !/^[\w-]+\.md$/.test(file)) {
    return res.status(400).json({ error: 'invalid path' });
  }
  const { content } = req.body ?? {};
  if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
  try {
    await knowledge.writeFile(`vault/${folder}/${file}`, content, `admin: edit ${folder}/${file}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('admin vault save error:', err);
    res.status(502).json({ error: 'save failed' });
  }
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

// Fire-and-forget — must not block server startup; a GitHub read failure
// degrades to an empty reminder list, same fallback posture as config.js.
reminders.initReminders()
  .then(() => reminderScheduler.start(client))
  .catch(err => console.error('reminders: init failed, scheduler not started:', err.message));
