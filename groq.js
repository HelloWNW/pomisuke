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
      vocabulary: vocabFile?.content ?? '(まだ無し)',
      facts: factFile?.content ?? '(まだ無し)',
      userMessage,
      reply
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
    newFacts = reviewReplyForFacts(userMessage, reply, reviewerModel, promptTemplate);
  }

  if (debug) {
    return { reply, newFacts: await newFacts, reasoning: reasoning || null, model: chosenModel, notesRead };
  }
  return { reply, newFacts };
}

module.exports = { chatWithPomisuke, listModels, getDefaultModel, LOCAL_MODEL_ID };
