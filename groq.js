const Groq = require('groq-sdk');
const knowledge = require('./knowledge');
const { getConfig, FALLBACK_CONFIG } = require('./config');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Legacy marker convention — no longer instructed via the system prompt (see
// reviewReplyForFacts below for the current two-stage approach), but still
// stripped defensively in case a model emits it anyway out of habit.
const FACT_MARKER_RE = /^<<NEW_FACT:\s*(.+?)>>$/gm;

// Audio/moderation/TTS models aren't valid chat-completion models — excluded
// from the selectable list so /model can't be pointed at something that'll
// break chat. This is a best-effort blocklist, not exhaustive (Groq's catalog
// changes); chatWithPomisuke's error handling below is the real safety net.
const NON_CHAT_MODEL_RE = /whisper|tts|guard|moderation|orpheus|playai/i;
const MODEL_LIST_CACHE_TTL_MS = 60 * 60 * 1000;

// ── Local self-hosted model (always offered, not part of Groq's catalog) ──
// Routes to a self-hosted OpenAI-compatible (llama.cpp) endpoint instead of
// Groq. URL/token come from env vars — never hardcode credentials in source.
// Infra plumbing, deliberately NOT part of the editable config: which file is
// physically loaded on the user's home server, and the streaming requirement
// that works around a Cloudflare 524 timeout, aren't chat-tuning knobs.
const LOCAL_MODEL_ID = 'local/huihui-claude';
const LOCAL_MODEL_PATH = 'C:\\LLM\\models\\Huihui-Qwen3.5-27B-Claude-4.6-Opus-abliterated.Q2_K.gguf';
const LOCAL_LLM_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

let modelListCache = null; // {models: string[], expiresAt: number}

/** @returns {Promise<string[]>} sorted chat-capable model IDs, cached 1h. Always includes LOCAL_MODEL_ID. */
async function listModels() {
  if (modelListCache && modelListCache.expiresAt > Date.now()) {
    return modelListCache.models;
  }
  const res = await groq.models.list();
  const models = res.data
    .map(m => m.id)
    .filter(id => !NON_CHAT_MODEL_RE.test(id))
    .sort();
  models.push(LOCAL_MODEL_ID);
  modelListCache = { models, expiresAt: Date.now() + MODEL_LIST_CACHE_TTL_MS };
  return models;
}

/** @returns {Promise<string>} the configured default model. */
async function getDefaultModel() {
  return (await getConfig()).defaultModel;
}

/**
 * Calls the self-hosted llama.cpp server instead of Groq. Throws on any
 * failure. Streamed (not a single non-streaming response) because the
 * server sits behind a Cloudflare-proxied tunnel, which kills the connection
 * with a 524 if the origin doesn't send *any* response within ~100s —
 * streaming establishes the response immediately and keeps data flowing, so
 * a multi-minute generation survives even though the total wait is long.
 * @param {string} systemPrompt
 * @param {Array} messages
 * @param {object} [localParams] - e.g. {max_tokens, timeout_ms} from config.modelOverrides
 * @returns {Promise<{choices: [{message: {content: string, reasoning_content?: string}}]}>}
 */
async function callLocalLLM(systemPrompt, messages, localParams = {}) {
  const baseUrl = process.env.LOCAL_LLM_URL;
  const token = process.env.LOCAL_LLM_TOKEN;
  if (!baseUrl || !token) throw new Error('LOCAL_LLM_URL/LOCAL_LLM_TOKEN not configured');

  const { timeout_ms, ...bodyParams } = localParams;
  const timeoutMs = timeout_ms ?? LOCAL_LLM_DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LOCAL_MODEL_PATH,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        stream: true,
        max_tokens: 3000,
        ...bodyParams
        // frequency_penalty/presence_penalty were tried here to counter
        // repetition loops, but live testing against this specific (Q2_K
        // quantized) model showed they make output *worse* — the model is
        // already at the edge of coherence, and any sampling penalty pushed
        // it into a different kind of breakdown (echoing its own system
        // prompt, leaking meta-reasoning into the reply) rather than fixing
        // the loop. Left out on purpose; see chatWithPomisuke's empty-reply
        // fallback for how an occasional loop is handled instead.
      }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`local LLM ${res.status}: ${await res.text()}`);
    return await readSseCompletion(res.body);
  } finally {
    clearTimeout(timeout);
  }
}

/** Accumulates an OpenAI-style SSE chat-completion stream into one message. */
async function readSseCompletion(stream) {
  let content = '';
  let reasoningContent = '';
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep a possibly-incomplete last line for the next chunk

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;

      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta;
        if (delta?.content) content += delta.content;
        if (delta?.reasoning_content) reasoningContent += delta.reasoning_content;
      } catch {
        // Malformed/partial SSE line — ignore and keep reading.
      }
    }
  }

  return { choices: [{ message: { content, reasoning_content: reasoningContent || undefined } }] };
}

/**
 * Splits off a <think>...</think> reasoning block some models emit inline in
 * content, so it can be logged server-side instead of shown to the user.
 * Handles both a fully closed block and one truncated mid-thought by hitting
 * max_tokens (no closing tag) — in the latter case everything from <think>
 * onward is reasoning, since there's nothing salvageable after it.
 * @returns {{content: string, thinking: string|null}}
 */
function extractThinkBlock(text) {
  const closed = /<think>([\s\S]*?)<\/think>/i.exec(text);
  if (closed) return { content: text.replace(closed[0], '').trim(), thinking: closed[1].trim() };
  const openEnded = /<think>([\s\S]*)$/i.exec(text);
  if (openEnded) return { content: text.slice(0, openEnded.index).trim(), thinking: openEnded[1].trim() };
  return { content: text.trim(), thinking: null };
}

// The local model sometimes restates a condensed version of its reasoning
// directly in content under a header like "思考プロセス"/"最終出力"/"Final Answer",
// instead of keeping it in reasoning_content or leaving it out entirely (even
// when told not to — see the local model's additionalPrompt override, which
// alone isn't reliable). Best-effort, not exhaustive: if a recognizable
// "here's the real answer" marker line is present, keep only what follows
// the LAST one; otherwise the text passes through unchanged.
const FINAL_ANSWER_MARKER_RE = /^#{0,3}\s*(?:\*\*)?(?:最終(?:出力|回答|解答|的な回答)|final\s*(?:answer|output))(?:\*\*)?\s*[:：]?\s*$/im;

function stripLeakedReasoningHeader(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FINAL_ANSWER_MARKER_RE.test(lines[i].trim())) {
      return lines.slice(i + 1).join('\n').trim();
    }
  }
  return text;
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

const NONE_RE = /^none$/i;
const VOCAB_LINE_RE = /^VOCAB:\s*(.+)$/i;
const FACT_LINE_RE = /^FACT:\s*(.+)$/i;
// Groq rejected an oversized reviewer request (413) once vocabulary.md/
// pomisuke-fact.md/reply content got large enough — most likely an
// abnormally long reply (e.g. a repetition-loop response from the local
// model) rather than the vault files themselves, since those stay small
// under normal growth. Cap everything embedded in the reviewer prompt
// regardless of which piece caused it.
const MAX_REVIEW_TEXT_CHARS = 1000; // per userMessage/reply
const MAX_REVIEW_CONTEXT_CHARS = 3000; // per vocabulary/facts file, most-recent tail kept

function truncateForReview(text, maxChars = MAX_REVIEW_TEXT_CHARS) {
  if (!text || text.length <= maxChars) return text;
  return '…(省略)\n' + text.slice(-maxChars);
}
// Lazy-load the reviewer conversation: the reply already goes out
// unblocked, and this additionally delays even *starting* the reviewer
// call so it never competes with the reply for resources right away.
// Skipped in debug mode (dashboard test-chat), where immediate feedback
// matters more than lazy-loading.
const FACT_REVIEW_DELAY_MS = 5000;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function renderReviewPrompt(template, vars) {
  return Object.entries(vars).reduce(
    (text, [key, value]) => text.split(`{{${key}}}`).join(value),
    template
  );
}

/** @returns {{vocab: string[], facts: string[]}} */
function parseReviewOutput(text) {
  const vocab = [];
  const facts = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || NONE_RE.test(line)) continue;
    const vocabMatch = VOCAB_LINE_RE.exec(line);
    if (vocabMatch) { vocab.push(vocabMatch[1].trim()); continue; }
    const factMatch = FACT_LINE_RE.exec(line);
    if (factMatch) { facts.push(factMatch[1].trim()); continue; }
  }
  return { vocab, facts };
}

/**
 * Second, separate conversation: a reviewer model reads Pomisuke's own reply
 * (from the main chat call) plus the vault's current vocabulary/fact notes,
 * and decides whether it stated something new worth logging — decoupled
 * from the main persona chat, which no longer self-reports via a marker
 * convention. New entries are written straight into the world-setting notes
 * the main chat already reads (not a separate low-trust scratch log), with
 * a code-level dedup backstop in knowledge.js beyond whatever the reviewer's
 * own judgment caught. Groq-only (not the local model, which is unstable
 * enough already without also acting as a judge). Never throws — any
 * failure just means no facts get logged for that turn.
 * @returns {Promise<{vocab: string[], facts: string[]}>} entries actually written (post-dedup)
 */
async function reviewReplyForFacts(userMessage, reply, reviewerModel, promptTemplate) {
  try {
    const [vocabFile, factFile] = await Promise.all([
      knowledge.readVocabulary().catch(() => null),
      knowledge.readPomisukeFacts().catch(() => null)
    ]);
    const prompt = renderReviewPrompt(promptTemplate, {
      vocabulary: truncateForReview(vocabFile?.content, MAX_REVIEW_CONTEXT_CHARS) || '(まだ無し)',
      facts: truncateForReview(factFile?.content, MAX_REVIEW_CONTEXT_CHARS) || '(まだ無し)',
      userMessage: truncateForReview(userMessage, MAX_REVIEW_TEXT_CHARS),
      reply: truncateForReview(reply, MAX_REVIEW_TEXT_CHARS)
    });
    const res = await groq.chat.completions.create({
      model: reviewerModel,
      messages: [{ role: 'user', content: prompt }],
      max_completion_tokens: 300,
      temperature: 0.3
    });
    const text = res.choices[0]?.message?.content?.trim() ?? '';
    const { vocab, facts } = parseReviewOutput(text);

    const [writtenVocab, writtenFacts] = await Promise.all([
      knowledge.appendVocabulary(vocab),
      knowledge.appendPomisukeFacts(facts)
    ]);
    return { vocab: writtenVocab, facts: writtenFacts };
  } catch (err) {
    console.error(`Fact review failed (model=${reviewerModel}):`, err.message || err);
    return { vocab: [], facts: [] };
  }
}

const REMINDER_PARSE_INSTRUCTIONS = `あなたはリマインダーの内容を解析する係です。
現在の日時（日本時間）: {{now}}

ユーザーがリマインダーとして伝えた内容:
「{{answer}}」

これを解析し、以下のいずれかの形式で JSON オブジェクトを1つだけ出力してください。
前置き・説明・コードブロック記号は一切不要、JSON のみを出力すること。
「明日」「来週の水曜」など相対的な日付の言葉は、現在の日時を基準に具体的な
年月日に変換すること（日付の言葉が無ければ null のままにする）。時刻や日付の
足し算・引き算（「〜分後」「〜時間ごと」等の量そのもの）は変換せず、amount/unit
としてそのまま渡すこと — 実際の計算はプログラム側で行う。

1. 特定の日時に1回だけ:
{"understood":true,"type":"once_absolute","text":"<何を伝えるか>","year":数値|null,"month":数値|null,"day":数値|null,"hour":数値|null,"minute":数値|null,"second":数値|null}

2. 一定時間後に1回だけ（"30分後","2時間後"など）:
{"understood":true,"type":"once_relative","text":"<何を伝えるか>","amount":数値,"unit":"seconds"|"minutes"|"hours"|"days"}

3. 一定間隔で繰り返し（"3時間ごとに","1分半ごとに"など）:
{"understood":true,"type":"recurring_interval","text":"<何を伝えるか>","amount":数値,"unit":"seconds"|"minutes"|"hours"|"days","start":{"year":数値|null,"month":数値|null,"day":数値|null,"hour":数値|null,"minute":数値|null,"second":数値|null}|null}

4. 曜日・週・月・年の周期で繰り返し（"毎週水曜","隔週","第四金曜日","毎年9月4日"など）:
{"understood":true,"type":"recurring_calendar","text":"<何を伝えるか>","freq":"WEEKLY"|"MONTHLY"|"YEARLY","interval":数値（隔週なら2、それ以外は通常1）,"byweekday":"MO"|"TU"|"WE"|"TH"|"FR"|"SA"|"SU"|null,"bysetpos":1〜4またはnull（"第n〜曜日"の場合のみ指定）,"bymonth":数値|null,"bymonthday":数値|null,"start":{...}|null}

内容が理解できない・曖昧すぎる場合は必ずこれだけ出力:
{"understood":false}

例:
「15時に薬飲むの教えて」→ {"understood":true,"type":"once_absolute","text":"薬飲む","year":null,"month":null,"day":null,"hour":15,"minute":0,"second":0}
「1分半ごとに教えて」→ {"understood":true,"type":"recurring_interval","text":"教えて","amount":1.5,"unit":"minutes","start":null}
「第四金曜日に教えて」→ {"understood":true,"type":"recurring_calendar","text":"教えて","freq":"MONTHLY","interval":1,"byweekday":"FR","bysetpos":4,"bymonth":null,"bymonthday":null,"start":null}
「毎年9月4日に教えて」→ {"understood":true,"type":"recurring_calendar","text":"教えて","freq":"YEARLY","interval":1,"byweekday":null,"bysetpos":null,"bymonth":9,"bymonthday":4,"start":null}`;

const REMINDER_TYPES = new Set(['once_absolute', 'once_relative', 'recurring_interval', 'recurring_calendar']);
const REMINDER_UNITS = new Set(['seconds', 'minutes', 'hours', 'days']);
const REMINDER_FREQS = new Set(['WEEKLY', 'MONTHLY', 'YEARLY']);
const REMINDER_WEEKDAYS = new Set(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);

function isNullableInt(v) {
  return v === null || (typeof v === 'number' && Number.isInteger(v));
}

/** Strict shape/enum validation — never trust the model's JSON blindly. */
function validateReminderParse(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.understood === false) return { understood: false };
  if (obj.understood !== true || typeof obj.text !== 'string' || !obj.text.trim()) return null;
  if (!REMINDER_TYPES.has(obj.type)) return null;

  const validDateFields = f => f === null || (
    typeof f === 'object' && isNullableInt(f.year) && isNullableInt(f.month) && isNullableInt(f.day) &&
    isNullableInt(f.hour) && isNullableInt(f.minute) && isNullableInt(f.second)
  );

  if (obj.type === 'once_absolute') {
    return validDateFields(obj) ? obj : null;
  }
  if (obj.type === 'once_relative') {
    if (typeof obj.amount !== 'number' || obj.amount <= 0 || !REMINDER_UNITS.has(obj.unit)) return null;
    return obj;
  }
  if (obj.type === 'recurring_interval') {
    if (typeof obj.amount !== 'number' || obj.amount <= 0 || !REMINDER_UNITS.has(obj.unit)) return null;
    if (!validDateFields(obj.start ?? null)) return null;
    return obj;
  }
  if (obj.type === 'recurring_calendar') {
    if (!REMINDER_FREQS.has(obj.freq)) return null;
    if (obj.interval != null && !(typeof obj.interval === 'number' && obj.interval >= 1)) return null;
    if (obj.byweekday != null && !REMINDER_WEEKDAYS.has(obj.byweekday)) return null;
    if (obj.bysetpos != null && !(Number.isInteger(obj.bysetpos) && obj.bysetpos >= 1 && obj.bysetpos <= 4)) return null;
    if (!isNullableInt(obj.bymonth ?? null) || !isNullableInt(obj.bymonthday ?? null)) return null;
    if (!validDateFields(obj.start ?? null)) return null;
    return obj;
  }
  return null;
}

/**
 * Asks the chatbot's own (Groq) model to turn a free-form Japanese answer
 * into one of the structured reminder shapes above. The model only ever
 * extracts literal/relative-date-word fields — it never does precise time
 * arithmetic ("now + 90 minutes"), which stays in reminders.js/code, since
 * LLMs are unreliable at exact arithmetic. Never trusted blindly: any
 * parse failure or shape mismatch is treated identically to
 * {understood:false}.
 * @param {string} answerText
 * @param {string} nowJstLabel - e.g. "2026年8月20日(木) 10:00"
 * @param {string} [sessionModel] - the session's current /model choice, if any
 * @returns {Promise<{understood: false} | object>}
 */
async function parseReminderRequest(answerText, nowJstLabel, sessionModel) {
  let model = sessionModel && sessionModel !== LOCAL_MODEL_ID ? sessionModel : null;
  if (!model) {
    const config = await getConfig();
    model = config.defaultModel && config.defaultModel !== LOCAL_MODEL_ID ? config.defaultModel : 'groq/compound';
  }

  const prompt = REMINDER_PARSE_INSTRUCTIONS
    .split('{{now}}').join(nowJstLabel)
    .split('{{answer}}').join(answerText);

  try {
    const res = await groq.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_completion_tokens: 300,
      temperature: 0.2
    });
    const text = res.choices[0]?.message?.content?.trim() ?? '';
    const jsonMatch = /\{[\s\S]*\}/.exec(text); // tolerate stray text around the JSON, defensively
    if (!jsonMatch) return { understood: false };
    const parsed = JSON.parse(jsonMatch[0]);
    return validateReminderParse(parsed) ?? { understood: false };
  } catch (err) {
    console.error(`Reminder parse failed (model=${model}):`, err.message || err);
    return { understood: false };
  }
}

/**
 * Builds the system prompt for a turn: the base prompt (static config text,
 * or the vault-composed one in vault mode) plus the chosen model's
 * additionalPrompt override, if any.
 * @returns {Promise<{systemPrompt: string, notesRead: string[]|null}>}
 */
async function buildSystemPrompt(config, override) {
  let basePrompt;
  let notesRead = null;

  if (config.promptMode === 'vault') {
    try {
      const result = await knowledge.buildWorldSettingPrompt();
      basePrompt = result.prompt;
      notesRead = result.notesRead;
    } catch (err) {
      console.error('vault: world-setting load failed, using systemPrompt fallback:', err.message);
      basePrompt = config.systemPrompt;
    }
  } else {
    basePrompt = config.systemPrompt;
  }

  const systemPrompt = override.additionalPrompt ? basePrompt + override.additionalPrompt : basePrompt;
  return { systemPrompt, notesRead };
}

/**
 * Send messages to Groq (or the local LLM) and return ぽみすけ's reply. In
 * vault mode, also kicks off a separate fact-review conversation (see
 * reviewReplyForFacts) that writes newly-discovered vocabulary/facts
 * straight into the vault — `newFacts` is the resolved {vocab, facts} in
 * debug mode (so the admin dashboard can show it immediately), or an
 * unresolved Promise otherwise, so the extra round trip never delays the
 * user-facing reply (handler.js's logNewFactsAsync awaits it in the
 * background).
 * @param {Array} messages - [{role, content}]
 * @param {string} [model] - overrides config.defaultModel (e.g. a session's /model choice)
 * @param {object} [opts]
 * @param {object} [opts.configOverride] - test a draft (uncommitted) config instead of the live one
 * @param {boolean} [opts.debug] - include reasoning/model/notesRead, and resolve newFacts, in the return value
 * @returns {Promise<{reply: string, newFacts: {vocab: string[], facts: string[]}|Promise<{vocab: string[], facts: string[]}>, modelError?: boolean, reasoning?: string|null, model?: string, notesRead?: string[]|null}>}
 */
async function chatWithPomisuke(messages, model, opts = {}) {
  const { configOverride, debug } = opts;
  const config = configOverride || await getConfig();
  const chosenModel = model || config.defaultModel;
  const override = config.modelOverrides?.[chosenModel] ?? {};

  const { systemPrompt, notesRead } = await buildSystemPrompt(config, override);

  let res;
  try {
    if (chosenModel === LOCAL_MODEL_ID) {
      res = await callLocalLLM(systemPrompt, messages, override.params ?? {});
    } else {
      const requestOptions = {
        model: chosenModel,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages
        ],
        ...config.generalParams,
        ...override.params
      };
      res = await groq.chat.completions.create(requestOptions);
    }
  } catch (err) {
    console.error(`Chat completion failed (model=${chosenModel}):`, err.message || err);
    // Local endpoint: any failure (down, unreachable, timeout) is treated as
    // "model doesn't exist" per spec — always reverts the session to default.
    const modelError = chosenModel === LOCAL_MODEL_ID ? true : isModelError(err);
    const failResult = { reply: 'ぽみのぽ脳が動かないぷみーーー', newFacts: { vocab: [], facts: [] }, modelError };
    if (debug) Object.assign(failResult, { reasoning: null, model: chosenModel, notesRead });
    return failResult;
  }

  const message = res.choices[0]?.message ?? {};
  let { content: withoutThink, thinking } = extractThinkBlock(message.content?.trim() ?? '');
  // Some backends (e.g. the local llama.cpp server) return reasoning in its
  // own field instead of inline <think> tags.
  const reasoning = [thinking, message.reasoning_content?.trim()].filter(Boolean).join('\n---\n');
  if (reasoning) console.log(`[reasoning] model=${chosenModel}:\n${reasoning}`);

  if (chosenModel === LOCAL_MODEL_ID) {
    withoutThink = stripLeakedReasoningHeader(withoutThink);
  }

  const { reply: strippedReply } = extractNewFacts(withoutThink); // strips any stray legacy markers, defensively
  const reply = strippedReply || 'ぽみ…うまく話せなかったぷよ…';

  let newFacts = Promise.resolve({ vocab: [], facts: [] });
  if (config.promptMode === 'vault') {
    const userMessage = messages[messages.length - 1]?.content ?? '';
    const reviewerModel = config.factReviewerModel || 'groq/compound';
    const promptTemplate = config.factReviewerPromptTemplate || FALLBACK_CONFIG.factReviewerPromptTemplate;
    const runReview = () => reviewReplyForFacts(userMessage, reply, reviewerModel, promptTemplate);
    newFacts = debug ? runReview() : delay(FACT_REVIEW_DELAY_MS).then(runReview);
  }

  if (debug) {
    return { reply, newFacts: await newFacts, reasoning: reasoning || null, model: chosenModel, notesRead };
  }
  return { reply, newFacts };
}

module.exports = { chatWithPomisuke, listModels, getDefaultModel, parseReminderRequest, LOCAL_MODEL_ID };
