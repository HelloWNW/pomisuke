/**
 * knowledge.js
 *
 * Reads/writes Pomisuke's Obsidian vault (vault/) via the GitHub Contents
 * API. Render's filesystem is ephemeral, so the bot never keeps a local git
 * clone — every read/write goes straight against GitHub, with a short-TTL
 * in-memory cache to avoid hitting the API on every message.
 */

const GITHUB_OWNER = 'HelloWNW';
const GITHUB_REPO = 'pomisuke';
const GITHUB_BRANCH = 'main';
const API_BASE = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents`;
const CACHE_TTL_MS = 5 * 60 * 1000;

const WORLD_SETTING_DIR = 'vault/world-setting';
const VOCABULARY_PATH = `${WORLD_SETTING_DIR}/vocabulary.md`;
const POMISUKE_FACT_PATH = `${WORLD_SETTING_DIR}/pomisuke-fact.md`;

// ── In-memory cache ──────────────────────────────────────────────────────
const cache = new Map(); // path -> { value, expiresAt }

function getCached(path) {
  const entry = cache.get(path);
  if (!entry || entry.expiresAt < Date.now()) return undefined;
  return entry.value;
}

function setCached(path, value) {
  cache.set(path, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function clearCache() {
  cache.clear();
}

// ── Low-level GitHub Contents API ────────────────────────────────────────

function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'pomisuke-linebot'
  };
}

/** @returns {Promise<{content: string, sha: string} | null>} */
async function githubGet(path) {
  const url = `${API_BASE}/${path}?ref=${GITHUB_BRANCH}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return { content: Buffer.from(json.content, 'base64').toString('utf-8'), sha: json.sha };
}

/** @returns {Promise<{sha: string}>} */
async function githubPut(path, content, message, sha) {
  const url = `${API_BASE}/${path}`;
  const body = {
    message,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch: GITHUB_BRANCH,
    ...(sha ? { sha } : {})
  };
  const res = await fetch(url, { method: 'PUT', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`GitHub PUT ${path} failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return { sha: json.content.sha };
}

/** @returns {Promise<Array<{name: string, path: string, type: string}>>} */
async function githubList(path) {
  const url = `${API_BASE}/${path}?ref=${GITHUB_BRANCH}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub LIST ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ── Public cached API ────────────────────────────────────────────────────

/** @returns {Promise<{content: string, sha: string} | null>} */
async function readFile(path) {
  const cached = getCached(path);
  if (cached !== undefined) return cached;
  const result = await githubGet(path);
  setCached(path, result);
  return result;
}

/** @returns {Promise<Array<{name: string, path: string}>>} */
async function listFiles(folderPath) {
  const cached = getCached(`list:${folderPath}`);
  if (cached !== undefined) return cached;
  const entries = await githubList(folderPath);
  const files = entries
    .filter(e => e.type === 'file' && e.name.endsWith('.md'))
    .map(e => ({ name: e.name, path: e.path }));
  setCached(`list:${folderPath}`, files);
  return files;
}

/** Create-or-update a file, auto-fetching its current sha if not provided. */
async function writeFile(path, content, message) {
  const existing = await githubGet(path);
  const result = await githubPut(path, content, message, existing?.sha);
  setCached(path, { content, sha: result.sha });
  return result;
}

// Serializes writes to the shared vocabulary/fact notes so concurrent LINE
// events don't race on `sha` and clobber each other's entries.
let vaultWriteQueue = Promise.resolve();

function queueVaultWrite(fn) {
  vaultWriteQueue = vaultWriteQueue.then(fn).catch(err => console.error('vault write failed:', err.message));
  return vaultWriteQueue;
}

/** Existing left-hand keys/words from "- key<sep>value" bullet lines. */
function extractBulletKeys(content, separator) {
  const keys = new Set();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('- ')) continue;
    const idx = trimmed.indexOf(separator);
    if (idx === -1) continue;
    keys.add(trimmed.slice(2, idx).trim());
  }
  return keys;
}

/**
 * Appends new bullet-line entries to a note, skipping any whose key/word
 * (the part before `separator`) already exists — a code-level backstop
 * dedup check on top of whatever the caller already did (e.g. an LLM
 * reviewer that saw the current content).
 * @returns {Promise<string[]>} the entries actually written (post-dedup)
 */
async function appendUniqueBulletEntries(path, entries, separator, commitLabel) {
  if (!entries.length) return [];
  return queueVaultWrite(async () => {
    const existing = await githubGet(path);
    const existingKeys = extractBulletKeys(existing?.content ?? '', separator);
    const newEntries = entries.filter(entry => {
      const idx = entry.indexOf(separator);
      const key = (idx === -1 ? entry : entry.slice(0, idx)).trim();
      return !existingKeys.has(key);
    });
    if (!newEntries.length) return [];
    const content = (existing?.content ?? '').replace(/\n+$/, '') + '\n' +
      newEntries.map(e => `- ${e}`).join('\n') + '\n';
    const result = await githubPut(path, content, `${commitLabel}: +${newEntries.length}`, existing?.sha);
    setCached(path, { content, sha: result.sha });
    return newEntries;
  });
}

/** @param {string[]} entries - each "word = meaning" */
async function appendVocabulary(entries) {
  return appendUniqueBulletEntries(VOCABULARY_PATH, entries, '=', 'vocabulary');
}

/** @param {string[]} entries - each "key: info" */
async function appendPomisukeFacts(entries) {
  return appendUniqueBulletEntries(POMISUKE_FACT_PATH, entries, ':', 'pomisuke-fact');
}

/** @returns {Promise<{content: string, sha: string} | null>} */
async function readVocabulary() {
  return readFile(VOCABULARY_PATH);
}

/** @returns {Promise<{content: string, sha: string} | null>} */
async function readPomisukeFacts() {
  return readFile(POMISUKE_FACT_PATH);
}

// ── Wikilink parsing (pure, no I/O) ──────────────────────────────────────

const WIKILINK_RE = /\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g;

/** @returns {Array<{target: string, alias: string | null}>} */
function extractWikilinks(markdown) {
  return [...markdown.matchAll(WIKILINK_RE)].map(m => ({ target: m[1].trim(), alias: m[2]?.trim() ?? null }));
}

/** [[x|y]] -> y, [[x]] -> x — for LLM-facing text. */
function stripWikilinkSyntax(markdown) {
  return markdown.replace(WIKILINK_RE, (_, target, alias) => alias ?? target);
}

/** [[x|y]] -> [y](#x), [[x]] -> [x](#x) — for viewer rendering. */
function wikilinksToMdLinks(markdown) {
  return markdown.replace(WIKILINK_RE, (_, target, alias) => `[${alias ?? target}](#${target})`);
}

// ── Higher-level helpers ─────────────────────────────────────────────────

/**
 * Reads index.md, follows its [[wikilinks]] one level deep, concatenates.
 * @returns {Promise<{prompt: string, notesRead: string[]}>}
 */
async function buildWorldSettingPrompt() {
  const indexPath = `${WORLD_SETTING_DIR}/index.md`;
  const index = await readFile(indexPath);
  if (!index) throw new Error(`${indexPath} not found`);

  const links = extractWikilinks(index.content);
  const notesRead = ['index.md'];
  const sections = await Promise.all(
    links.map(async ({ target }) => {
      const note = await readFile(`${WORLD_SETTING_DIR}/${target}.md`);
      if (note) notesRead.push(`${target}.md`);
      return note ? stripWikilinkSyntax(note.content) : null;
    })
  );

  const prompt = [stripWikilinkSyntax(index.content), ...sections.filter(Boolean)].join('\n\n');
  return { prompt, notesRead };
}

/** @returns {Promise<{nodes: Array, edges: Array}>} */
async function buildGraph() {
  const [worldFiles, autoLogFiles] = await Promise.all([
    listFiles(WORLD_SETTING_DIR),
    listFiles('vault/auto-log')
  ]);

  const allFiles = [
    ...worldFiles.map(f => ({ ...f, folder: 'world-setting' })),
    ...autoLogFiles.map(f => ({ ...f, folder: 'auto-log' }))
  ];

  const idOf = name => name.replace(/\.md$/, '');
  const knownIds = new Set(allFiles.map(f => idOf(f.name)));

  const nodes = allFiles.map(f => ({ id: idOf(f.name), label: idOf(f.name), folder: f.folder, missing: false }));
  const edges = [];
  const missingIds = new Set();

  await Promise.all(
    allFiles.map(async f => {
      const file = await readFile(f.path);
      if (!file) return;
      for (const { target } of extractWikilinks(file.content)) {
        const targetId = target.split('/').pop();
        if (!knownIds.has(targetId)) missingIds.add(targetId);
        edges.push({ from: idOf(f.name), to: targetId });
      }
    })
  );

  for (const id of missingIds) {
    nodes.push({ id, label: id, folder: null, missing: true });
  }

  return { nodes, edges };
}

module.exports = {
  readFile,
  listFiles,
  writeFile,
  appendVocabulary,
  appendPomisukeFacts,
  readVocabulary,
  readPomisukeFacts,
  clearCache,
  extractWikilinks,
  stripWikilinkSyntax,
  wikilinksToMdLinks,
  buildWorldSettingPrompt,
  buildGraph
};
