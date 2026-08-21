const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SYSTEM_PROMPT = `# キャラクター定義 — ぽみすけ

あなたはチャットボットの「ぽみすけ」です。ぽみすたーのぽよ族の幼い子供として振る舞います。

## 基本情報
- 名前: ぽみすけ
- 一人称: ぽみ
- 種族: ぽみすたー（ぽよ族）
- 性格: 幼く無邪気で愉快、ユーザをやさしく揶揄う

## 語尾ルール（最重要）
- 文末は必ず「〜ぽみねえ」「〜ぷよ」「〜ぽみ」のいずれかで締める。
- 「です」「ます」で終わる文は禁止。
- 語尾を自然に使い分けること（同じ語尾の連続を避ける）。

例:
- 「それはぺだぽみねえ〜」
- 「ぽみはもう知ってたぷよ！」
- 「ぽみぽみぽみすたーだぽみ！」

## 語彙（固有語）
- ぽみぽみぽみすたー = こんにちは
- ぽよまつり = あそび・楽しいこと
- ぺ = 悪いこと / bad
- ぱ = 良いこと / good

## 話し方の指針
- 一文は日本語で30単語以内。
- 幼い子どもらしい短くかわいい言い回しを優先。
- ユーザーへの興味を積極的に示し、個人的な質問を1ターンに最大1問行う。
- どんな話題・難易度にも答えるが、回答は子どもらしいシンプルな視点で語る。
- 不適切なテキストがあれば、やんわり注意する（怒らずかわいく）。

## 禁止事項
- 文末に「です」「ます」を使うこと。
- 一文が30単語を超えること。
- ぽよ語彙を使わない返答（毎ターン最低1回は固有語・語尾を使う）。`;

const FACT_MARKER_RE = /^<<NEW_FACT:\s*(.+?)>>$/gm;

const DEFAULT_MODEL = 'openai/gpt-oss-120b';

// Audio/moderation/TTS models aren't valid chat-completion models — excluded
// from the selectable list so /model can't be pointed at something that'll
// break chat. This is a best-effort blocklist, not exhaustive (Groq's catalog
// changes); chatWithPomisuke's error handling below is the real safety net.
const NON_CHAT_MODEL_RE = /whisper|tts|guard|moderation|orpheus|playai/i;
const MODEL_LIST_CACHE_TTL_MS = 60 * 60 * 1000;

// ── Local self-hosted model (always offered, not part of Groq's catalog) ──
// Routes to a self-hosted OpenAI-compatible (llama.cpp) endpoint instead of
// Groq. URL/token come from env vars — never hardcode credentials in source.
const LOCAL_MODEL_ID = 'local/huihui-claude';
const LOCAL_MODEL_PATH = 'C:\\LLM\\models\\Huihui-Qwen3.5-27B-Claude-4.6-Opus-abliterated.Q2_K.gguf';
// This specific (Q2_K quantized) model tends to leak its reasoning into the
// actual reply — restating analysis under a "思考プロセス"/"Final Answer"-style
// header before the real answer, instead of keeping it in reasoning_content.
// Appended only for this model, not Groq's.
const LOCAL_LLM_EXTRA_INSTRUCTIONS = `

## 出力ルール（重要・このモデル専用）
返信には、ぽみすけとしての最終的なセリフ本文だけを出力すること。
「思考プロセス」「最終出力」「Final Answer」のような見出しや、検討過程・分析・
下書きを本文に含めてはいけない。前置きや説明は一切不要。キャラクターのセリフ
以外の文字は一切書かないこと。`;
// The server's context window is 4096 tokens total (prompt + completion) —
// 3000 leaves headroom for the system prompt + history. At ~18 tok/s
// measured on this box, a full 3000-token completion can take ~3 minutes,
// so the timeout is sized well above that rather than cutting generation
// short — see runChatTurn's push-instead-of-reply handling in handler.js
// for how a wait this long still reliably delivers the final answer.
const LOCAL_LLM_MAX_TOKENS = 3000;
const LOCAL_LLM_TIMEOUT_MS = 5 * 60 * 1000;

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

/**
 * Calls the self-hosted llama.cpp server instead of Groq. Throws on any
 * failure. Streamed (not a single non-streaming response) because the
 * server sits behind a Cloudflare-proxied tunnel, which kills the connection
 * with a 524 if the origin doesn't send *any* response within ~100s —
 * streaming establishes the response immediately and keeps data flowing, so
 * a multi-minute generation survives even though the total wait is long.
 * @returns {Promise<{choices: [{message: {content: string, reasoning_content?: string}}]}>}
 */
async function callLocalLLM(systemPrompt, messages) {
  const baseUrl = process.env.LOCAL_LLM_URL;
  const token = process.env.LOCAL_LLM_TOKEN;
  if (!baseUrl || !token) throw new Error('LOCAL_LLM_URL/LOCAL_LLM_TOKEN not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOCAL_LLM_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LOCAL_MODEL_PATH,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        max_tokens: LOCAL_LLM_MAX_TOKENS,
        stream: true
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
  const chosenModel = model || DEFAULT_MODEL;

  let res;
  try {
    if (chosenModel === LOCAL_MODEL_ID) {
      res = await callLocalLLM(SYSTEM_PROMPT + LOCAL_LLM_EXTRA_INSTRUCTIONS, messages);
    } else {
      const requestOptions = {
        model: chosenModel,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...messages
        ],
        max_completion_tokens: 800,
        temperature: 0.85,
        top_p: 0.95
      };
      // qwen3.6's reasoning mode burns the whole token budget on internal
      // chain-of-thought before answering (Pomisuke is casual dialogue, not
      // complex reasoning/math/code) — Groq's "none" disables it for this
      // model family specifically. Other families use different reasoning
      // effort scales (e.g. gpt-oss: low/medium/high), so this is scoped.
      if (/^qwen\//i.test(chosenModel)) {
        requestOptions.reasoning_effort = 'none';
      }
      res = await groq.chat.completions.create(requestOptions);
    }
  } catch (err) {
    console.error(`Chat completion failed (model=${chosenModel}):`, err.message || err);
    // Local endpoint: any failure (down, unreachable, timeout) is treated as
    // "model doesn't exist" per spec — always reverts the session to default.
    const modelError = chosenModel === LOCAL_MODEL_ID ? true : isModelError(err);
    return { reply: 'ぽみのぽ脳が動かないぷみーーー', newFacts: [], modelError };
  }

  const message = res.choices[0]?.message ?? {};
  const { content: withoutThink, thinking } = extractThinkBlock(message.content?.trim() ?? '');
  // Some backends (e.g. the local llama.cpp server) return reasoning in its
  // own field instead of inline <think> tags.
  const reasoning = [thinking, message.reasoning_content?.trim()].filter(Boolean).join('\n---\n');
  if (reasoning) console.log(`[reasoning] model=${chosenModel}:\n${reasoning}`);

  const { reply, newFacts } = extractNewFacts(withoutThink);
  return { reply: reply || 'ぽみ…うまく話せなかったぷよ…', newFacts };
}

module.exports = { chatWithPomisuke, listModels, DEFAULT_MODEL, LOCAL_MODEL_ID };
