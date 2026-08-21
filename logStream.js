/**
 * logStream.js
 *
 * Wraps console.log/warn/error so every log line in the process (LINE
 * traffic, Groq/local-LLM errors, vault writes, everything) is also kept in
 * a small ring buffer and broadcast to any connected admin dashboard
 * viewers — a live "tail -f" for /admin, not just results from the
 * dashboard's own test-chat messages. Render runs this app as a single
 * process (WEB_CONCURRENCY=1), so one in-memory buffer is enough — no
 * cross-process coordination needed.
 */

const MAX_BUFFER_LINES = 500;
const buffer = [];
const subscribers = new Set(); // Set<(line: string) => void>

function formatArg(arg) {
  if (arg instanceof Error) return arg.stack || arg.message;
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function pushLine(level, args) {
  const line = `[${level}] ${args.map(formatArg).join(' ')}`;
  buffer.push(line);
  if (buffer.length > MAX_BUFFER_LINES) buffer.shift();
  for (const write of subscribers) {
    try {
      write(line + '\n');
    } catch {
      // Dead subscriber — the route's own 'close' handler will unsubscribe it.
    }
  }
}

for (const level of ['log', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    pushLine(level, args);
  };
}

function getRecentLines() {
  return buffer.slice();
}

function subscribe(write) {
  subscribers.add(write);
}

function unsubscribe(write) {
  subscribers.delete(write);
}

module.exports = { getRecentLines, subscribe, unsubscribe };
