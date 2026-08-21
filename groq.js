const Groq = require('groq-sdk');
const knowledge = require('./knowledge');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Resilience net used only if the vault (GitHub) is unreachable at request time.
const FALLBACK_SYSTEM_PROMPT = `# キャラクター定義 — ぽみすけ

あなたはチャットボットの「ぽみすけ」です。ぽみすたーのぽよ族の幼い子供として振る舞います。
一人称は「ぽみ」。文末は必ず「〜ぽみねえ」「〜ぷよ」「〜ぽみ」のいずれかで締め、「です」「ます」は禁止。
幼く無邪気で愉快な性格で、ユーザをやさしく揶揄いながら会話する。`;

const FACT_MARKER_RE = /^<<NEW_FACT:\s*(.+?)>>$/gm;
const FACT_INSTRUCTIONS = `
## 新しい設定の記録ルール（システム用・ユーザーには見せない）
会話中に自分自身や世界について新しい設定を即興で語った場合、返信の最後に
<<NEW_FACT: 短い日本語1文>> の形式で1行追加すること。新しい設定がなければ何も追加しない。
このマーカーは自動的に取り除かれ、ユーザーには表示されない。`;

const DEFAULT_MODEL = 'openai/gpt-oss-120b';

// Audio/moderation/TTS models aren't valid chat-completion models — excluded
// from the selectable list so /model can't be pointed at something that'll
// break chat. This is a best-effort blocklist, not exhaustive (Groq's catalog
// changes); chatWithPomisuke's error handling below is the real safety net.
const NON_CHAT_MODEL_RE = /whisper|tts|guard|moderation|orpheus|playai/i;
const MODEL_LIST_CACHE_TTL_MS = 60 * 60 * 1000;

let modelListCache = null; // {models: string[], expiresAt: number}

/** @returns {Promise<string[]>} sorted chat-capable model IDs, cached 1h. */
async function listModels() {
  if (modelListCache && modelListCache.expiresAt > Date.now()) {
    return modelListCache.models;
  }
  const res = await groq.models.list();
  const models = res.data
    .map(m => m.id)
    .filter(id => !NON_CHAT_MODEL_RE.test(id))
    .sort();
  modelListCache = { models, expiresAt: Date.now() + MODEL_LIST_CACHE_TTL_MS };
  return models;
}

async function getSystemPrompt() {
  let core;
  try {
    core = await knowledge.buildWorldSettingPrompt();
  } catch (err) {
    console.error('vault: world-setting load failed, using fallback:', err.message);
    core = FALLBACK_SYSTEM_PROMPT;
  }
  const recentLog = await knowledge.getRecentAutoLog(20).catch(() => '');
  return [core, recentLog, FACT_INSTRUCTIONS].filter(Boolean).join('\n\n');
}

/**
 * Strips <think>...</think> reasoning blocks some models emit inline in
 * content. Handles both a fully closed block and one truncated mid-thought
 * by hitting max_tokens (no closing tag) — in the latter case everything
 * from <think> onward is dropped since there's nothing salvageable after it.
 */
function stripThinkBlock(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .trim();
}

/**
 * @param {string} rawText
 * @returns {{reply: string, newFacts: string[]}}
 */
function extractNewFacts(rawText) {
  const newFacts = [...rawText.matchAll(FACT_MARKER_RE)].map(m => m[1].trim());
  const reply = rawText.replace(FACT_MARKER_RE, '').trim();
  return { reply, newFacts };
}

/** True for Groq API errors caused by the chosen model itself (gone, restricted). */
function isModelError(err) {
  const code = err?.error?.error?.code;
  return code === 'model_not_found' || code === 'model_terms_required' || err?.status === 404;
}

/**
 * Send messages to Groq and return ぽみすけ's reply plus any new facts it improvised.
 * @param {Array} messages - [{role, content}]
 * @param {string} [model] - overrides DEFAULT_MODEL (e.g. a session's /model choice)
 * @returns {Promise<{reply: string, newFacts: string[], modelError?: boolean}>}
 */
async function chatWithPomisuke(messages, model) {
  const systemPrompt = await getSystemPrompt();
  const chosenModel = model || DEFAULT_MODEL;

  let res;
  try {
    res = await groq.chat.completions.create({
      model: chosenModel,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages
      ],
      max_tokens: 800,
      temperature: 0.85,
      top_p: 0.95
    });
  } catch (err) {
    console.error(`Groq chat completion failed (model=${chosenModel}):`, err.message || err);
    return { reply: 'ぽみのぽ脳が動かないぷみーーー', newFacts: [], modelError: isModelError(err) };
  }

  const raw = stripThinkBlock(res.choices[0]?.message?.content?.trim() ?? '');
  const { reply, newFacts } = extractNewFacts(raw);
  return { reply: reply || 'ぽみ…うまく話せなかったぷよ…', newFacts };
}

module.exports = { chatWithPomisuke, listModels, DEFAULT_MODEL };
