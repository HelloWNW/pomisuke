/**
 * ConversationStore
 * 
 * Structure per user:
 *   sessions[userId] = {
 *     active: true/false,           // whether a session is ongoing
 *     messages: [                    // full message array for current session
 *       { role, content, msgId }
 *     ],
 *     compactedSummary: string|null, // compacted memory of older turns
 *     pomisukeMsgIds: Set<string>,   // LINE message IDs that ぽみすけ sent
 *     lastPomisukeLineId: string|null // ID of last @ぽみすけ trigger message
 *   }
 */

const MAX_MESSAGES = 6;       // messages kept before compaction triggers
const COMPACT_KEEP = 0;       // how many recent messages to keep after compaction (all go to summary)

class ConversationStore {
  constructor() {
    // In-memory store — resets on dyno restart (free tier acceptable)
    this.sessions = {};
  }

  _init(userId) {
    if (!this.sessions[userId]) {
      this.sessions[userId] = {
        active: false,
        messages: [],
        compactedSummary: null,
        pomisukeMsgIds: new Set(),
        lastPomisukeLineId: null
      };
    }
    return this.sessions[userId];
  }

  /** Start or reset a session for the user */
  startSession(userId) {
    this.sessions[userId] = {
      active: true,
      messages: [],
      compactedSummary: null,
      pomisukeMsgIds: new Set(),
      lastPomisukeLineId: null
    };
    return this.sessions[userId];
  }

  /** Check if a session is active */
  isActive(userId) {
    const s = this.sessions[userId];
    return s ? s.active : false;
  }

  /** Register a message ID as belonging to ぽみすけ */
  registerPomisukeMsg(userId, msgId) {
    const s = this._init(userId);
    s.pomisukeMsgIds.add(msgId);
  }

  /** Check if a msgId was sent by ぽみすけ */
  isPomisukeMsg(userId, msgId) {
    const s = this.sessions[userId];
    return s ? s.pomisukeMsgIds.has(msgId) : false;
  }

  /** Add a turn (user + assistant pair) */
  addUserMessage(userId, content) {
    const s = this._init(userId);
    s.messages.push({ role: 'user', content });
  }

  addAssistantMessage(userId, content) {
    const s = this._init(userId);
    s.messages.push({ role: 'assistant', content });
  }

  /** Return messages ready for Groq (with optional compacted prefix) */
  getMessagesForAPI(userId) {
    const s = this.sessions[userId];
    if (!s) return [];

    const msgs = [];
    if (s.compactedSummary) {
      msgs.push({
        role: 'user',
        content: `[過去の会話の要約]\n${s.compactedSummary}`
      });
      msgs.push({
        role: 'assistant',
        content: 'わかったぷよ〜！過去のこと覚えてるぽみねえ。'
      });
    }
    return [...msgs, ...s.messages];
  }

  /** 
   * Check and perform compaction if message count hits MAX_MESSAGES.
   * Returns true if compaction happened.
   */
  async maybeCompact(userId, groqClient) {
    const s = this.sessions[userId];
    if (!s) return false;

    // Count user turns only for threshold
    const userTurns = s.messages.filter(m => m.role === 'user').length;
    if (userTurns < MAX_MESSAGES) return false;

    // Compact all current messages into a summary
    const toCompact = [...s.messages];
    const historyText = toCompact
      .map(m => `${m.role === 'user' ? 'ユーザー' : 'ぽみすけ'}: ${m.content}`)
      .join('\n');

    const previousSummary = s.compactedSummary
      ? `[前回の要約]\n${s.compactedSummary}\n\n`
      : '';

    try {
      const res = await groqClient.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'user',
            content: `以下の会話を、ぽみすけ（AIキャラ）との重要なやりとり・話題・ユーザーの好みや状況を保持しつつ、200字以内の日本語で要約してください。要約のみ出力してください。\n\n${previousSummary}[今回の会話]\n${historyText}`
          }
        ],
        max_tokens: 300,
        temperature: 0.3
      });

      s.compactedSummary = res.choices[0]?.message?.content?.trim() ?? '';
      s.messages = []; // clear compacted messages
      return true;
    } catch (e) {
      console.error('Compaction error:', e);
      return false;
    }
  }

  /**
   * Load up to 6 messages from a reply-chain context (for old-message replies).
   * Returns a temporary message array for a one-shot API call.
   */
  buildContextFromQuotedHistory(userId, contextMessages) {
    // contextMessages: array of { role, content } already extracted from LINE quote chain
    // Limit to 6, then optionally compact inline
    const limited = contextMessages.slice(-MAX_MESSAGES);
    return limited;
  }

  setLastPomisukeLineId(userId, msgId) {
    const s = this._init(userId);
    s.lastPomisukeLineId = msgId;
  }

  getSession(userId) {
    return this.sessions[userId] || null;
  }
}

module.exports = new ConversationStore();
