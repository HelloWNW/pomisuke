const store = require('./store');
const { chatWithPomisuke, listModels, getDefaultModel, parseReminderRequest, LOCAL_MODEL_ID } = require('./groq');
const reminders = require('./reminders');

// ── ぽよマスター 表記ゆれ正規表現 ────────────────────────────────────────
// 対応: ぽよマスター / ポヨマスター / ぽよますたー / ぽよますた / ポヨマスタ / ぽよマスタ
const POYOMASTER_RE = /[ぽポ][よヨ][まマ][すス][たタ][ーー]?/;

// ── devInfo trigger ───────────────────────────────────────────────────────
// /devInfo, \devInfo, devinfo (大文字小文字不問)
const DEVINFO_RE = /^[/\\]?devinfo$/i;

// ── /model trigger ─────────────────────────────────────────────────────────
// 個人チャットはメンション不要、グループ/ルームは @ぽみすけ 必須（別コマンドのため
// isMenuTrigger とは独立に判定する）。
const MODEL_CMD_RE = /^\/models?(?:\s+(.+))?$/i;
const QUICK_REPLY_LIMIT = 13; // LINE quick reply の上限
const LABEL_MAX_LEN = 20;     // LINE quick reply label の上限

// ── /reminder trigger ────────────────────────────────────────────────────
// Quick-reply taps only (machine-generated exact text), never hand-typed —
// unlike /model, so no mention-gating ambiguity to resolve; always active,
// following devInfo's precedent instead.
const REMINDER_CMD_RE = /^\/reminder\s+(\S+)(?:\s+(.+))?$/i;

// ── Logger ────────────────────────────────────────────────────────────────
function log(prefix, userId, sessionId, msg) {
  const uid = userId    ? `uid=${userId}`       : null;
  const sid = sessionId ? `sid=${sessionId}`    : null;
  const ctx = [uid, sid].filter(Boolean).join(' ');
  console.log(`[${prefix}]${ctx ? ' ' + ctx : ''} ${msg}`);
}

// ── Trigger detection ─────────────────────────────────────────────────────

function isMenuTrigger(text) {
  if (typeof text !== 'string') return false;
  // /ぽよマスター系 (先頭に / \ ／ があってもなくても) or @ぽみすけ or @ぽよすけ
  return (
    /^[/\\／]/.test(text) && POYOMASTER_RE.test(text) ||
    POYOMASTER_RE.test(text) ||
    text.includes('@ぽみすけ') ||
    text.includes('@ぽよすけ')
  );
}

function stripMention(text) {
  return text
    .replace(/@ぽみすけ/g, '')
    .replace(/@ぽよすけ/g, '')
    .replace(POYOMASTER_RE, '')
    .replace(/^[/\\／]/, '')
    .trim();
}

function hasMention(text) {
  return text.includes('@ぽみすけ') || text.includes('@ぽよすけ');
}

/**
 * Parses a /model command. Personal chats: no mention needed. Group/room:
 * requires an @ぽみすけ mention (separate from isMenuTrigger, since /model
 * must be intercepted before the general mention-trigger handling).
 * @returns {string|null} the sub-argument text (e.g. "set <id>"), or null if
 *   this text isn't a /model command for this source type. '' means bare "/model".
 */
function parseModelCommand(text, sourceType) {
  let candidate = text.trim();
  if (sourceType !== 'user') {
    if (!hasMention(candidate)) return null;
    candidate = candidate.replace(/@ぽみすけ/g, '').replace(/@ぽよすけ/g, '').trim();
  }
  const match = MODEL_CMD_RE.exec(candidate);
  return match ? (match[1] ?? '').trim() : null;
}

function modelCommandText(sourceType, arg) {
  const cmd = arg ? `/model ${arg}` : '/model';
  return sourceType === 'user' ? cmd : `@ぽみすけ ${cmd}`;
}

// Display names too long/ugly to show as-is (e.g. the local model's raw file
// path). The full id is still what /model set uses regardless of display.
const MODEL_DISPLAY_OVERRIDES = {
  [LOCAL_MODEL_ID]: 'huihui-claude(無検閲)'
};

/** Drops the "provider/" prefix for display — the full id is still what /model set uses. */
function shortModelName(id) {
  if (MODEL_DISPLAY_OVERRIDES[id]) return MODEL_DISPLAY_OVERRIDES[id];
  const slash = id.indexOf('/');
  return slash === -1 ? id : id.slice(slash + 1);
}

/** Builds the /model reply: a list + tap-to-select quick reply. */
function buildModelListMessage(models, currentModel, sourceType) {
  const shown = models.slice(0, QUICK_REPLY_LIMIT);
  const lines = shown.map(id => `${id === currentModel ? '＞' : '・'}${shortModelName(id)}`);
  const omittedNote = models.length > shown.length ? `\n…ほか${models.length - shown.length}件（多すぎて表示できないぽみ）` : '';

  return {
    type: 'text',
    text: `いま使えるモデル一覧だぷよ〜\n${lines.join('\n')}${omittedNote}`,
    quickReply: {
      items: shown.map(id => {
        const label = shortModelName(id);
        return {
          type: 'action',
          action: {
            type: 'message',
            label: label.length > LABEL_MAX_LEN ? label.slice(0, LABEL_MAX_LEN - 1) + '…' : label,
            text: modelCommandText(sourceType, `set ${id}`)
          }
        };
      })
    }
  };
}

// ── Reminder message builders ───────────────────────────────────────────
const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

/** Current date/time as a JST label for the reminder-parser prompt's context. */
function nowJstLabel() {
  const fake = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const hh = String(fake.getUTCHours()).padStart(2, '0');
  const mm = String(fake.getUTCMinutes()).padStart(2, '0');
  return `${fake.getUTCFullYear()}年${fake.getUTCMonth() + 1}月${fake.getUTCDate()}日(${WEEKDAY_JA[fake.getUTCDay()]}) ${hh}:${mm}`;
}

function buildReminderMenuMessage() {
  return {
    type: 'text',
    text: 'リマインダーだぽみ！なにする？',
    quickReply: {
      items: [
        { type: 'action', action: { type: 'message', label: '追加', text: '/reminder add' } },
        { type: 'action', action: { type: 'message', label: '削除', text: '/reminder delete' } }
      ]
    }
  };
}

function buildReminderConfirmMessage(spec, token) {
  return {
    type: 'text',
    text: `${spec.summary} でセットするぽみ。これでいい？`,
    quickReply: {
      items: [
        { type: 'action', action: { type: 'message', label: 'はい', text: `/reminder confirm ${token}` } },
        { type: 'action', action: { type: 'message', label: 'キャンセル', text: '/reminder cancel' } }
      ]
    }
  };
}

function buildReminderDeleteListMessage(list) {
  if (!list.length) {
    return { type: 'text', text: 'リマインダーはまだ無いぽみ' };
  }
  const shown = list.slice(0, QUICK_REPLY_LIMIT);
  const omittedNote = list.length > shown.length ? `\n…ほか${list.length - shown.length}件（多すぎて表示できないぽみ）` : '';
  return {
    type: 'text',
    text: `リマインダー一覧だぽみ〜\n${shown.map(r => `・${r.summary}`).join('\n')}${omittedNote}`,
    quickReply: {
      items: shown.map(r => ({
        type: 'action',
        action: {
          type: 'message',
          label: r.summary.length > LABEL_MAX_LEN ? r.summary.slice(0, LABEL_MAX_LEN - 1) + '…' : r.summary,
          text: `/reminder delete-select ${r.id}`
        }
      }))
    }
  };
}

function buildReminderDeleteConfirmMessage(record) {
  return {
    type: 'text',
    text: `${record.summary} を削除するぽみ。本当にいい？`,
    quickReply: {
      items: [
        { type: 'action', action: { type: 'message', label: 'はい', text: `/reminder delete-confirm ${record.id}` } },
        { type: 'action', action: { type: 'message', label: 'キャンセル', text: '/reminder cancel' } }
      ]
    }
  };
}

// ── LINE reply + reply-chain registration ─────────────────────────────────
// Captures the sent message's ID so that a future reply quoting it is
// recognized as a chat continuation (see step 4 below).
// LINE's reply token has a short validity window (informally ~1 minute) —
// once a wait has already crossed the "still thinking" threshold, a much
// longer generation risks that token expiring before the real answer is
// ready. usePush switches delivery to pushMessage (no such expiry) for
// exactly those delayed replies; fast replies keep using replyMessage.
async function sendReply(client, event, sessionId, text, usePush = false) {
  const res = usePush
    ? await client.pushMessage({ to: sessionId, messages: [{ type: 'text', text }] })
    : await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text }] });
  const sentId = res?.sentMessages?.[0]?.id;
  if (sentId) store.registerPomisukeMsg(sessionId, sentId);
}

// ── Auto-log (fire-and-forget) ───────────────────────────────────────────
// Render runs this app as a persistent process, not a frozen-after-response
// serverless function, so a detached promise keeps running after we return.
// newFactsOrPromise is the (possibly still-pending) fact-review conversation
// — chatWithPomisuke kicks it off without awaiting, to avoid delaying the
// user's reply. The actual vocabulary.md/pomisuke-fact.md writes already
// happened inside reviewReplyForFacts by the time this resolves; this just
// logs the outcome.
async function logNewFactsAsync(sessionId, userId, newFactsOrPromise) {
  const { vocab, facts } = await newFactsOrPromise;
  if (!vocab?.length && !facts?.length) return;
  log('INFO', userId, sessionId, `vault: +${vocab.length} vocab, +${facts.length} fact(s)`);
}

// ── Menu button ───────────────────────────────────────────────────────────
function buildMenuMessage() {
  const carshareUrl  = process.env.CARSHARE_FORM_URL || 'https://example.com/carshare';
  const ledgerUrl    = process.env.LEDGER_FORM_URL   || 'https://example.com/ledger';
  const baseUrl      = process.env.RENDER_EXTERNAL_URL || 'https://pomisuke.onrender.com';
  const knowledgeUrl = `${baseUrl}/knowledge`;

  return {
    type: 'template',
    altText: 'ぽみすけメニューだぷよ！',
    template: {
      type: 'buttons',
      title: 'ぽよマスターだぷよ！',
      text: 'なにをするぽみ？',
      actions: [
        { type: 'uri',     label: '🚗 カーシェア',  uri: carshareUrl },
        { type: 'uri',     label: '💰 貸借対照表',  uri: ledgerUrl },
        { type: 'message', label: '⏰ リマインダー', text: 'リマインダー' },
        { type: 'uri',     label: '🧠 ぽ脳',        uri: knowledgeUrl }
      ]
    }
  };
}

const THINKING_DELAY_MS = 5000;
const THINKING_TEXT = '考え中だぽみ！ぽ脳フル回転だぷーー';

// ── Chat turn (shared by every continuation path) ─────────────────────────
async function runChatTurn(client, event, sessionId, userId, text) {
  store.addUserMessage(sessionId, text);
  const model = store.getModel(sessionId) || undefined;

  // Slow backends (esp. the local LLM) can take a while — let the user know
  // it's still working instead of leaving them staring at silence.
  let thinkingSent = false;
  const thinkingTimer = setTimeout(() => {
    thinkingSent = true;
    client.pushMessage({ to: sessionId, messages: [{ type: 'text', text: THINKING_TEXT }] })
      .catch(err => log('WARN', userId, sessionId, `thinking-ping push failed: ${err.message}`));
  }, THINKING_DELAY_MS);

  let result;
  try {
    result = await chatWithPomisuke(store.getMessagesForAPI(sessionId), model);
  } finally {
    clearTimeout(thinkingTimer);
  }

  const { reply, newFacts, modelError } = result;
  if (modelError) {
    log('WARN', userId, sessionId, `model "${model}" failed, reverting session to default`);
    store.setModel(sessionId, null);
  }
  log('INFO', userId, sessionId, `pomisuke reply: "${reply}"`);
  store.addAssistantMessage(sessionId, reply);
  await sendReply(client, event, sessionId, reply, thinkingSent);
  logNewFactsAsync(sessionId, userId, newFacts);
}

// ── Main event handler ────────────────────────────────────────────────────
async function handleEvent(event, client) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userId     = event.source.userId;
  const sessionId  = store.constructor.resolveSessionId(event.source); // group/room → groupId, DM → userId
  const sourceType = event.source.type;          // 'user' | 'group' | 'room'
  const text       = event.message.text.trim();
  const quotedMsgId = event.message.quotedMessageId ?? null;

  log('INFO', userId, sessionId, `[${sourceType}] recv: "${text}"`);

  // ── 0. devInfo — 開発者用IDダンプ（ぽみすけ会話と完全分離） ─────────────
  // store は一切操作しない。会話履歴に含まれない。
  if (DEVINFO_RE.test(text)) {
    log('DEVINFO', userId, sessionId, 'triggered');

    const groupId = event.source.groupId ?? event.source.roomId ?? null;
    const lines = [];

    if (groupId) {
      lines.push(`groupId: ${groupId}`);
      // グループメンバー全員取得を試みる（403等で失敗した場合は送信者IDのみ返す）
      try {
        const ids = [];
        let start = undefined;
        do {
          const res = await client.getGroupMembersIds(groupId, start);
          if (res.memberIds) ids.push(...res.memberIds);
          start = res.next ?? null;
        } while (start);

        log('DEVINFO', userId, sessionId, `member count: ${ids.length}`);
        ids.forEach((mid, i) => lines.push(`  member[${i}] userId: ${mid}`));
      } catch (err) {
        // 403など取得不可 → 送信者IDだけ返す（前回仕様にフォールバック）
        log('WARN', userId, sessionId, `getGroupMembersIds failed (${err.message}), fallback to sender only`);
        lines.push(`userId (sender): ${userId}`);
      }
    } else {
      // 個人チャット
      lines.push(`userId: ${userId}`);
    }

    const replyText = lines.join('\n');
    log('DEVINFO', userId, sessionId, `reply:\n${replyText}`);
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: replyText }]
    });
    return;
  }

  // ── 1. リマインダー ────────────────────────────────────────────────────
  // 全ステップとも /model・メンショントリガーより先に判定し、リターンする —
  // 特に「回答待ち」状態は次のメッセージを必ず先取りする必要がある。
  if (text === 'リマインダー') {
    log('INFO', userId, sessionId, 'reminder menu opened');
    store.setAwaitingReminderAnswer(sessionId, false);
    store.setPendingReminder(sessionId, null);
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [buildReminderMenuMessage()]
    });
    return;
  }

  const reminderCmdMatch = REMINDER_CMD_RE.exec(text);
  if (reminderCmdMatch) {
    const [, action, arg] = reminderCmdMatch;

    if (action === 'add') {
      store.setAwaitingReminderAnswer(sessionId, true);
      log('INFO', userId, sessionId, 'reminder add: awaiting answer');
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: '何を覚えるぽよ？' }]
      });
      return;
    }

    if (action === 'delete') {
      const list = reminders.listReminders(sessionId);
      log('INFO', userId, sessionId, `reminder delete: listing ${list.length}`);
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [buildReminderDeleteListMessage(list)]
      });
      return;
    }

    if (action === 'confirm') {
      const pending = store.getPendingReminder(sessionId);
      if (!pending || pending.token !== arg) {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: 'もう終わってるか違う内容だぽみ' }]
        });
        return;
      }
      await reminders.addReminder({
        sessionId, userId,
        text: pending.text, kind: pending.kind,
        nextFireAt: pending.nextFireAt, rrule: pending.rrule, summary: pending.summary
      });
      store.setPendingReminder(sessionId, null);
      log('INFO', userId, sessionId, `reminder confirmed: ${pending.summary}`);
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: 'ぷみーーー！覚えたぽみ！' }]
      });
      return;
    }

    if (action === 'cancel') {
      store.setAwaitingReminderAnswer(sessionId, false);
      store.setPendingReminder(sessionId, null);
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: 'やめたぽみ' }]
      });
      return;
    }

    if (action === 'delete-select') {
      const record = reminders.listReminders(sessionId).find(r => r.id === arg);
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [record ? buildReminderDeleteConfirmMessage(record) : { type: 'text', text: 'もう無いみたいだぽみ' }]
      });
      return;
    }

    if (action === 'delete-confirm') {
      const removed = await reminders.deleteReminder(sessionId, arg);
      log('INFO', userId, sessionId, `reminder delete-confirm: ${arg} removed=${removed}`);
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: removed ? '消したぽみ！' : 'もう無いみたいだぽみ' }]
      });
      return;
    }
    // Unrecognized /reminder subcommand falls through to the normal triggers below.
  }

  if (store.isAwaitingReminderAnswer(sessionId)) {
    store.setAwaitingReminderAnswer(sessionId, false); // single-shot — retry means tapping 追加 again
    const now = Date.now(); // captured before the LLM call, so relative-interval math isn't inflated by latency
    const sessionModel = store.getModel(sessionId) || undefined;

    const parsed = await parseReminderRequest(text, nowJstLabel(), sessionModel);
    let spec = null;
    if (parsed.understood) {
      try {
        spec = reminders.resolveReminderSpec(parsed, now);
      } catch (err) {
        log('WARN', userId, sessionId, `reminder resolve failed: ${err.message}`);
      }
    }

    if (!spec) {
      log('INFO', userId, sessionId, `reminder answer not understood: "${text}"`);
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: 'ぽみはぺだからわからなかったぽみねえ' }]
      });
      return;
    }

    const token = Math.random().toString(36).slice(2, 10);
    store.setPendingReminder(sessionId, { ...spec, token });
    log('INFO', userId, sessionId, `reminder parsed: ${spec.summary}`);
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [buildReminderConfirmMessage(spec, token)]
    });
    return;
  }

  // ── 1.5. /model — 使用モデルの一覧・切り替え ──────────────────────────────
  // isMenuTrigger より先に判定（"@ぽみすけ /model" が通常のチャット開始として
  // 扱われてしまうのを防ぐため）。
  const modelArg = parseModelCommand(text, sourceType);
  if (modelArg !== null) {
    let models;
    try {
      models = await listModels();
    } catch (err) {
      console.error('listModels failed:', err.message);
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: 'モデル一覧を取得できなかったぽみ…もう一回試してぷよ！' }]
      });
      return;
    }

    const setMatch = /^set\s+(\S+)$/i.exec(modelArg);
    if (setMatch) {
      const requested = setMatch[1];
      if (!models.includes(requested)) {
        log('INFO', userId, sessionId, `/model set: invalid model "${requested}"`);
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: `そのモデルは無いぽみ…「${modelCommandText(sourceType, '')}」でもう一回確認してぷよ！` }]
        });
        return;
      }
      store.setModel(sessionId, requested);
      log('INFO', userId, sessionId, `/model set: ${requested}`);
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: 'ぷみーーー！' }]
      });
      return;
    }

    log('INFO', userId, sessionId, '/model: list requested');
    const currentModel = store.getModel(sessionId) || await getDefaultModel();
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [buildModelListMessage(models, currentModel, sourceType)]
    });
    return;
  }

  // ── 2. メンション系トリガー ──────────────────────────────────────────────
  // グループ/ルームでは会話を開始・リセットする唯一の手段（レガシー仕様維持）。
  // 個人チャットでは任意（メンションしなくても3で会話は続く）。
  if (isMenuTrigger(text)) {
    const stripped = stripMention(text);

    if (stripped.length === 0) {
      // メンションのみ → メニュー表示
      log('INFO', userId, sessionId, 'mention-only → menu');
      store.startSession(sessionId);
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [
          { type: 'text', text: 'ぽみぽみぽみすたーだぷよ〜！ぽよマスターのぽみすけだぽみ！なにする？' },
          buildMenuMessage()
        ]
      });
    } else {
      // メンション + テキスト → チャットセッション開始
      log('INFO', userId, sessionId, `mention+text → chat start: "${stripped}"`);
      store.startSession(sessionId);
      await runChatTurn(client, event, sessionId, userId, stripped);
    }
    return;
  }

  // ── 3. 個人チャット: メンション不要で会話継続（常時アクティブ） ───────────
  if (sourceType === 'user') {
    if (!store.isActive(sessionId)) store.startSession(sessionId);
    log('INFO', userId, sessionId, `personal chat: "${text}"`);
    await runChatTurn(client, event, sessionId, userId, text);
    return;
  }

  // ── 4. グループ/ルーム: ぽみすけのメッセージへの返信で会話継続 ───────────
  // 誰が返信してもセッション継続（userIdではなくsessionId単位で管理）
  if (quotedMsgId && store.isPomisukeMsg(sessionId, quotedMsgId)) {
    if (!store.isActive(sessionId)) {
      log('INFO', userId, sessionId, 'reply to pomisuke but session inactive');
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: 'セッションが終わってるぽみ…@ぽみすけ か /ぽよマスター で呼んでぷよ！' }]
      });
      return;
    }

    log('INFO', userId, sessionId, `reply-chain: "${text}"`);
    await runChatTurn(client, event, sessionId, userId, text);
    return;
  }

  // ── それ以外は全て無視 ──────────────────────────────────────────────────
  log('INFO', userId, sessionId, 'ignored (no trigger matched)');
}

module.exports = { handleEvent };
