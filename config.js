/**
 * config.js
 *
 * Reads/writes Pomisoke's tunable bot configuration (persona prompt, default
 * model, per-model overrides, request params) from config/bot-config.json in
 * the repo, via knowledge.js's generic GitHub Contents API helpers. This is
 * the source of truth the admin dashboard (/admin) edits.
 */

const knowledge = require('./knowledge');

const CONFIG_PATH = 'config/bot-config.json';
const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;

// Matches today's pre-dashboard hardcoded behavior exactly, so a fresh clone
// or an unreachable GitHub API degrades to identical behavior, not a crash.
const FALLBACK_CONFIG = {
  version: 1,
  promptMode: 'normal',
  defaultModel: 'openai/gpt-oss-20b',
  // Only consulted in vault mode — the model that reviews Pomisuke's own
  // replies for new facts, in a separate conversation from the main chat.
  factReviewerModel: 'groq/compound',
  // {{vocabulary}}/{{facts}}/{{userMessage}}/{{reply}} are substituted in
  // groq.js's reviewReplyForFacts. The reviewer classifies new info as
  // VOCAB (word = meaning, appended to vocabulary.md) or FACT (key: info,
  // appended to pomisuke-fact.md) — both are world-setting notes the main
  // chat reads in vault mode, not a separate low-trust scratch log.
  factReviewerPromptTemplate: `あなたはキャラクター「ぽみすけ」の発言をレビューし、新しい設定を記録する係です。

現在登録済みの語彙（vocabulary.md）:
{{vocabulary}}

現在登録済みの設定（pomisuke-fact.md）:
{{facts}}

ユーザー: {{userMessage}}
ぽみすけ: {{reply}}

上記の返信の中に、まだ登録されていない新しい語彙や設定が含まれているか確認してください。
既に登録済みの内容と同じ・似ている場合は新しいものとして扱わないこと。

- 新しい固有語彙（言葉とその意味）が見つかった場合: \`VOCAB: <言葉> = <意味>\` の形式で1行出力すること。
- 新しいキャラクター設定（key: info の形）が見つかった場合: \`FACT: <キー>: <内容>\` の形式で1行出力すること。
- 複数見つかった場合は複数行出力してよい。
- 新しい情報が無い場合や、全て重複する場合は \`NONE\` とだけ出力すること。`,
  systemPrompt: `# キャラクター定義 — ぽみすけ

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
- ぽよ語彙を使わない返答（毎ターン最低1回は固有語・語尾を使う）。`,
  generalParams: {
    max_completion_tokens: 800,
    temperature: 0.85,
    top_p: 0.95
  },
  modelOverrides: {
    'local/huihui-claude': {
      additionalPrompt: `

## 出力ルール（重要・このモデル専用）
返信には、ぽみすけとしての最終的なセリフ本文だけを出力すること。
「思考プロセス」「最終出力」「Final Answer」のような見出しや、検討過程・分析・
下書きを本文に含めてはいけない。前置きや説明は一切不要。キャラクターのセリフ
以外の文字は一切書かないこと。`,
      params: { max_tokens: 3000 }
    },
    'qwen/qwen3.6-27b': {
      additionalPrompt: '',
      params: { reasoning_effort: 'none' }
    }
  }
};

let cache = null; // { value, expiresAt }

/** @returns {Promise<object>} the bot config, cached ~5min, falling back gracefully. */
async function getConfig() {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  try {
    const file = await knowledge.readFile(CONFIG_PATH);
    const value = file ? JSON.parse(file.content) : FALLBACK_CONFIG;
    cache = { value, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS };
    return value;
  } catch (err) {
    console.error('getConfig: failed to load bot-config.json, using fallback:', err.message);
    return cache?.value ?? FALLBACK_CONFIG;
  }
}

/** Cache-busting read, so the admin dashboard always sees the true committed state. */
async function getLiveConfig() {
  knowledge.clearCache();
  cache = null;
  return getConfig();
}

/** Writes the config to GitHub and updates the in-process cache immediately. */
async function writeConfig(newConfig, message) {
  await knowledge.writeFile(CONFIG_PATH, JSON.stringify(newConfig, null, 2), message);
  cache = { value: newConfig, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS };
}

module.exports = { getConfig, getLiveConfig, writeConfig, FALLBACK_CONFIG, CONFIG_PATH };
