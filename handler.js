const store = require('./store');
const { groq, chatWithPomisuke } = require('./groq');

// ── ぽよマスター 表記ゆれ正規表現 ────────────────────────────────────────
// 対応: ぽよマスター / ポヨマスター / ぽよますたー / ぽよますた / ポヨマスタ / ぽよマスタ
const POYOMASTER_RE = /[ぽポ][よヨ][まマ][すス][たタ][ーー]?/;

// ── devInfo trigger ───────────────────────────────────────────────────────
// /devInfo, \devInfo, devinfo (大文字小文字不問)
const DEVINFO_RE = /^[/\\]?devinfo$/i;

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

// ── Menu button ───────────────────────────────────────────────────────────
function buildMenuMessage() {
  const carshareUrl = process.env.CARSHARE_FORM_URL || 'https://example.com/carshare';
  const ledgerUrl   = process.env.LEDGER_FORM_URL   || 'https://example.com/ledger';

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
        { type: 'message', label: '⏰ リマインダー', text: 'リマインダー' }
      ]
    }
  };
}

// ── Main event handler ────────────────────────────────────────────────────
async function handleEvent(event, client) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userId     = event.source.userId;
  const sessionId  = store.constructor.resolveSessionId(event.source); // group/room → groupId, DM → userId
  const sourceType = event.source.type;          // 'user' | 'group' | 'room'
  const text       = event.message.text.trim();
  const msgId      = event.message.id;
  const quotedMsgId = event.message.quotedMessageId ?? null;

  log('INFO', userId, sessionId, `[${sourceType}] recv: "${text}"`);

  // ── 0. devInfo — 開発者用IDダンプ（ぽみすけ会話と完全分離） ─────────────
  // store は一切操作しない。会話履歴・コンパクションに含まれない。
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

  // ── 1. リマインダーボタン ────────────────────────────────────────────────
  if (text === 'リマインダー') {
    log('INFO', userId, sessionId, 'reminder button tapped');
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: 'リマインダーはまだ準備中だぷよ…もうちょっと待ってほしいぽみねえ！🙏' }]
    });
    return;
  }

  // ── 2. メンション系トリガー ──────────────────────────────────────────────
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
      store.setLastPomisukeLineId(sessionId, msgId);
      store.addUserMessage(sessionId, stripped);

      const reply = await chatWithPomisuke(store.getMessagesForAPI(sessionId));
      log('INFO', userId, sessionId, `pomisuke reply: "${reply}"`);
      store.addAssistantMessage(sessionId, reply);

      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: reply }]
      });

      const compacted = await store.maybeCompact(sessionId, groq);
      if (compacted) log('INFO', userId, sessionId, 'session compacted');
    }
    return;
  }

  // ── 3. ぽみすけのメッセージへの返信で会話継続 ───────────────────────────
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
    store.addUserMessage(sessionId, text);
    const reply = await chatWithPomisuke(store.getMessagesForAPI(sessionId));
    log('INFO', userId, sessionId, `pomisuke reply: "${reply}"`);
    store.addAssistantMessage(sessionId, reply);

    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: reply }]
    });

    const compacted = await store.maybeCompact(sessionId, groq);
    if (compacted) log('INFO', userId, sessionId, 'session compacted');
    return;
  }

  // ── それ以外は全て無視 ──────────────────────────────────────────────────
  log('INFO', userId, sessionId, 'ignored (no trigger matched)');
}

module.exports = { handleEvent };
