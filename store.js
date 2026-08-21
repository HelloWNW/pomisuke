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
 *     messages: [{ role, content }],   // 直近 MAX_HISTORY 件のみ保持（スライディングウィンドウ）
 *     pomisukeMsgIds: Set<string>,      // ぽみすけが送ったLINEメッセージID（返信チェーン判定用）
 *     model: string|null                // /model で選択されたモデル（未選択なら既定値を使用）
 *   }
 */

const MAX_HISTORY = 10; // ぽみすけ5件 + ユーザー5件

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
        pomisukeMsgIds: new Set(),
        model: null
      };
    }
    return this.sessions[sessionId];
  }

  startSession(sessionId) {
    const model = this.sessions[sessionId]?.model ?? null; // /model choice survives a session reset
    this.sessions[sessionId] = {
      active: true,
      messages: [],
      pomisukeMsgIds: new Set(),
      model
    };
    return this.sessions[sessionId];
  }

  getModel(sessionId) {
    return this.sessions[sessionId]?.model ?? null;
  }

  setModel(sessionId, model) {
    this._init(sessionId).model = model;
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

  _trim(session) {
    if (session.messages.length > MAX_HISTORY) {
      session.messages = session.messages.slice(-MAX_HISTORY);
    }
  }

  addUserMessage(sessionId, content) {
    const s = this._init(sessionId);
    s.messages.push({ role: 'user', content });
    this._trim(s);
  }

  addAssistantMessage(sessionId, content) {
    const s = this._init(sessionId);
    s.messages.push({ role: 'assistant', content });
    this._trim(s);
  }

  getMessagesForAPI(sessionId) {
    const s = this.sessions[sessionId];
    return s ? s.messages : [];
  }

  getSession(sessionId) {
    return this.sessions[sessionId] || null;
  }
}

module.exports = new ConversationStore();
