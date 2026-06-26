const store = require('./store');
const { groq, chatWithPomisuke } = require('./groq');

// ── ぽよマスター 表記ゆれ正規表現 ────────────────────────────────────────
// 対応: ぽよマスター / ポヨマスター / ぽよますたー / ぽよますた / ポヨマスタ / ぽよマスタ
const POYOMASTER_RE = /[ぽポ][よヨ][まマ][すス][たタ][ーー]?/;

// ── devInfo trigger ───────────────────────────────────────────────────────
const DEVINFO_RE = /^[/\\]?devinfo$/i;

// ── Logger ────────────────────────────────────────────────────────────────
// prefix は [INFO] / [DEVINFO] / [WARN] / [ERROR] など
function log(prefix, userId, groupId, msg) {
  const uid = userId  ? `uid=${userId}`   : null;
  const gid = groupId ? `gid=${groupId}`  : null;
  const ctx = [uid, gid].filter(Boolean).join(' ');
  console.log(`[${prefix}]${ctx ? ' ' + ctx : ''} ${msg}`);
}

// ── Trigger detection ─────────────────────────────────────────────────────

function isMenuTrigger(text) {
  if (typeof text !== 'string') return false;
  return (
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
    .replace(/^[/／]/, '')
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

// ── グループメンバーID全件取得（ページネーション対応） ────────────────────
async function fetchAllMemberIds(client, groupId) {
  const ids = [];
  let start = undefined;
  do {
    const res = await client.getGroupMembersIds(groupId, start);
    if (res.memberIds) ids.push(...res.memberIds);
    start = res.next ?? null;
  } while (start);
  return ids;
}

// ── Main event handler ────────────────────────────────────────────────────
async function handleEvent(event, client) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userId      = event.source.userId;
  const groupId     = event.source.groupId ?? event.source.roomId ?? null;
  const sourceType  = event.source.type;           // 'user' | 'group' | 'room'
  const text        = event.message.text.trim();
  const msgId       = event.message.id;
  const quotedMsgId = event.message.quotedMessageId ?? null;

  log('INFO', userId, groupId, `[${sourceType}] recv: "${text}"`);

  // ── 0. devInfo — 開発者用IDダンプ（ぽみすけ会話と完全分離） ─────────────
  // store は一切操作しない。会話履歴・コンパクションに含まれない。
  if (DEVINFO_RE.test(text)) {
    log('DEVINFO', userId, groupId, 'devInfo triggered');

    const lines = [];

    if (groupId) {
      // グループ/ルーム: メンバー全員のIDを取得して列挙
      lines.push(`groupId: ${groupId}`);
      try {
        const memberIds = await fetchAllMemberIds(client, groupId);
        log('DEVINFO', userId, groupId, `member count: ${memberIds.length}`);
        memberIds.forEach((mid, i) => {
          lines.push(`  member[${i}] userId: ${mid}`);
        });
      } catch (err) {
        log('ERROR', userId, groupId, `getGroupMembersIds failed: ${err.message}`);
        lines.push(`  (メンバーID取得失敗: ${err.message})`);
      }
    } else {
      // 個人チャット
      lines.push(`userId: ${userId}`);
    }

    const replyText = lines.join('\n');
    console.log(`[DEVINFO] reply:\n${replyText}`);

    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: replyText }]
    });
    return;
  }

  // ── 1. リマインダーボタン ────────────────────────────────────────────────
  if (text === 'リマインダー') {
    log('INFO', userId, groupId, 'reminder button tapped');
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
      log('INFO', userId, groupId, 'mention-only → menu');
      store.startSession(userId);
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [
          { type: 'text', text: 'ぽみぽみぽみすたーだぷよ〜！ぽよマスターのぽみすけだぽみ！なにする？' },
          buildMenuMessage()
        ]
      });
    } else {
      // メンション + テキスト → チャットセッション開始
      log('INFO', userId, groupId, `mention+text → chat start: "${stripped}"`);
      store.startSession(userId);
      store.setLastPomisukeLineId(userId, msgId);
      store.addUserMessage(userId, stripped);

      const reply = await chatWithPomisuke(store.getMessagesForAPI(userId));
      log('INFO', userId, groupId, `pomisuke reply: "${reply}"`);
      store.addAssistantMessage(userId, reply);

      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: reply }]
      });

      const compacted = await store.maybeCompact(userId, groq);
      if (compacted) log('INFO', userId, groupId, 'session compacted');
    }
    return;
  }

  // ── 3. ぽみすけのメッセージへの返信のみ反応 ─────────────────────────────
  if (quotedMsgId && store.isPomisukeMsg(userId, quotedMsgId)) {
    if (!store.isActive(userId)) {
      log('INFO', userId, groupId, 'reply to pomisuke but session inactive');
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: 'セッションが終わってるぽみ…@ぽみすけ か /ぽよマスター で呼んでぷよ！' }]
      });
      return;
    }

    log('INFO', userId, groupId, `reply-chain: "${text}"`);
    store.addUserMessage(userId, text);
    const reply = await chatWithPomisuke(store.getMessagesForAPI(userId));
    log('INFO', userId, groupId, `pomisuke reply: "${reply}"`);
    store.addAssistantMessage(userId, reply);

    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: reply }]
    });

    const compacted = await store.maybeCompact(userId, groq);
    if (compacted) log('INFO', userId, groupId, 'session compacted');
    return;
  }

  // ── それ以外は全て無視 ──────────────────────────────────────────────────
  log('INFO', userId, groupId, 'ignored (no trigger matched)');
}

module.exports = { handleEvent };
