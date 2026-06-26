/**
 * ConversationStore
 *
 * セッションキー (sessionId) の決定ルール:
 *   - グループ / ルーム → groupId または roomId  （複数人で1セッション共有）
 *   - 個人DM           → userId                 （1対1セッション）
 *
 * Structure per session:
 *   sessions[sessionId] = {
 *     active: true/false,
 *     messages: [{ role, content }],
 *     compactedSummary: string|null,
 *     pomisukeMsgIds: Set<string>,   // ぽみすけが送ったLINEメッセージID
 *     lastPomisukeLineId: string|null
 *   }
 */

const MAX_MESSAGES = 6;

class ConversationStore {
  constructor() {
    this.sessions = {};
  }

  /** グループ/ルーム/DMからセッションIDを決定 */
  static resolveSessionId(source) {
    return source.groupId ?? source.roomId ?? source.userId;
  }

  _init(sessionId) {
    if (!this.sessions[sessionId]) {
      this.sessions[sessionId] = {
        active: false,
        messages: [],
        compactedSummary: null,
        pomisukeMsgIds: new Set(),
        lastPomisukeLineId: null
      };
    }
    return this.sessions[sessionId];
  }

  startSession(sessionId) {
    this.sessions[sessionId] = {
      active: true,
      messages: [],
      compactedSummary: null,
      pomisukeMsgIds: new Set(),
      lastPomisukeLineId: null
    };
    return this.sessions[sessionId];
  }

  isActive(sessionId) {
    const s = this.sessions[sessionId];
    return s ? s.active : false;
  }

  registerPomisukeMsg(sessionId, msgId) {
    this._init(sessionId).pomisukeMsgIds.add(msgId);
  }

  isPomisukeMsg(sessionId, msgId) {
    const s = this.sessions[sessionId];
    return s ? s.pomisukeMsgIds.has(msgId) : false;
  }

  addUserMessage(sessionId, content) {
    this._init(sessionId).messages.push({ role: 'user', content });
  }

  addAssistantMessage(sessionId, content) {
    this._init(sessionId).messages.push({ role: 'assistant', content });
  }

  getMessagesForAPI(sessionId) {
    const s = this.sessions[sessionId];
    if (!s) return [];
    const msgs = [];
    if (s.compactedSummary) {
      msgs.push({ role: 'user',      content: `[過去の会話の要約]\n${s.compactedSummary}` });
      msgs.push({ role: 'assistant', content: 'わかったぷよ〜！過去のこと覚えてるぽみねえ。' });
    }
    return [...msgs, ...s.messages];
  }

  async maybeCompact(sessionId, groqClient) {
    const s = this.sessions[sessionId];
    if (!s) return false;

    const userTurns = s.messages.filter(m => m.role === 'user').length;
    if (userTurns < MAX_MESSAGES) return false;

    const historyText = s.messages
      .map(m => `${m.role === 'user' ? 'ユーザー' : 'ぽみすけ'}: ${m.content}`)
      .join('\n');
    const previousSummary = s.compactedSummary
      ? `[前回の要約]\n${s.compactedSummary}\n\n`
      : '';

    try {
      const res = await groqClient.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{
          role: 'user',
          content: `以下の会話を、ぽみすけ（AIキャラ）との重要なやりとり・話題・ユーザーの好みや状況を保持しつつ、200字以内の日本語で要約してください。要約のみ出力してください。\n\n${previousSummary}[今回の会話]\n${historyText}`
        }],
        max_tokens: 300,
        temperature: 0.3
      });
      s.compactedSummary = res.choices[0]?.message?.content?.trim() ?? '';
      s.messages = [];
      return true;
    } catch (e) {
      console.error('Compaction error:', e);
      return false;
    }
  }

  setLastPomisukeLineId(sessionId, msgId) {
    this._init(sessionId).lastPomisukeLineId = msgId;
  }

  getSession(sessionId) {
    return this.sessions[sessionId] || null;
  }
}

module.exports = new ConversationStore();
