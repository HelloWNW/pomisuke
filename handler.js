const store = require('./store');
const { groq, chatWithPomisuke } = require('./groq');

// ── ぽよマスター 表記ゆれ正規表現 ────────────────────────────────────────
// 対応: ぽよマスター / ポヨマスター / ぽよますたー / ぽよますた / ポヨマスタ / ぽよマスタ
const POYOMASTER_RE = /[ぽポ][よヨ][まマ][すス][たタ][ーー]?/;

// ── Trigger detection ─────────────────────────────────────────────────────

function isMenuTrigger(text) {
  if (typeof text !== 'string') return false;
  // /ぽよマスター 系 or @ぽみすけ or @ぽよすけ
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
    .replace(/^[/／]/, '')   // 先頭のスラッシュ除去
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

  const userId      = event.source.userId;
  const text        = event.message.text.trim();
  const msgId       = event.message.id;
  const quotedMsgId = event.message.quotedMessageId ?? null;

  // ── 1. リマインダーボタン ────────────────────────────────────────────────
  if (text === 'リマインダー') {
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
      store.startSession(userId);
      store.setLastPomisukeLineId(userId, msgId);
      store.addUserMessage(userId, stripped);

      const reply = await chatWithPomisuke(store.getMessagesForAPI(userId));
      store.addAssistantMessage(userId, reply);

      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: reply }]
      });

      await store.maybeCompact(userId, groq);
    }
    return;
  }

  // ── 3. ぽみすけのメッセージへの返信のみ反応 ─────────────────────────────
  // quotedMsgId がぽみすけ発言のIDと一致する場合だけ応答。
  // 他ユーザーのメッセージへの返信は無視。
  if (quotedMsgId && store.isPomisukeMsg(userId, quotedMsgId)) {
    if (!store.isActive(userId)) {
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: 'セッションが終わってるぽみ…@ぽみすけ か /ぽよマスター で呼んでぷよ！' }]
      });
      return;
    }

    store.addUserMessage(userId, text);
    const reply = await chatWithPomisuke(store.getMessagesForAPI(userId));
    store.addAssistantMessage(userId, reply);

    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: reply }]
    });

    await store.maybeCompact(userId, groq);
    return;
  }

  // ── それ以外は全て無視 ──────────────────────────────────────────────────
  // 他ユーザーのメッセージへの返信・通常のグループ発言はスルー
}

module.exports = { handleEvent };
