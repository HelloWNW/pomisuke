/**
 * reminders.js
 *
 * Time-triggered reminders, persisted to data/reminders.json via
 * knowledge.js's generic GitHub Contents API read/write (same pattern as
 * config.js). All reminder times are Japan Standard Time (fixed +9:00, no
 * DST) — see the fake-UTC helpers below for how that's made to work
 * correctly with the `rrule` library, which only understands real Date/UTC
 * internals and has no timezone database of its own.
 */

const { RRule } = require('rrule');
const knowledge = require('./knowledge');

const REMINDERS_PATH = 'data/reminders.json';
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DEFAULT_HOUR = 9; // when a reminder's time-of-day is unstated

let cache = null; // { version, reminders: [...] } — kept in sync in-process, no periodic re-read
let writeQueue = Promise.resolve();

// ── JST <-> "fake UTC" ────────────────────────────────────────────────────
// rrule only operates on a Date's real UTC getters/constructor and has no
// concept of timezones. Since JST has no DST, a fixed-offset trick works:
// build/read Dates whose UTC *components* directly ARE the JST wall-clock
// numbers ("fake UTC"), do all RRule construction/math entirely within that
// space, and only cross to/from real UTC at the two boundaries below.

/** JST wall-clock parts -> a Date in fake-UTC space (for RRule construction/rendering). */
function fakeUtcFromJstParts({ year, month, day, hour = DEFAULT_HOUR, minute = 0, second = 0 }) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

/** A real UTC instant -> the equivalent fake-UTC Date (its getters read as JST wall-clock). */
function fakeUtcFromRealMs(realMs) {
  return new Date(realMs + JST_OFFSET_MS);
}

/** A fake-UTC Date -> the real UTC instant it represents. */
function realMsFromFakeUtc(fakeUtcDate) {
  return fakeUtcDate.getTime() - JST_OFFSET_MS;
}

// ── Persistence ───────────────────────────────────────────────────────────

async function initReminders() {
  try {
    const file = await knowledge.readFile(REMINDERS_PATH);
    cache = file ? JSON.parse(file.content) : { version: 1, reminders: [] };
  } catch (err) {
    console.error('initReminders: failed to load, starting empty:', err.message);
    cache = { version: 1, reminders: [] };
  }
  return cache;
}

function ensureInitialized() {
  if (!cache) cache = { version: 1, reminders: [] };
  return cache;
}

function persist(message) {
  writeQueue = writeQueue
    .then(() => knowledge.writeFile(REMINDERS_PATH, JSON.stringify(cache, null, 2), message))
    .catch(err => console.error('reminders: persist failed:', err.message));
  return writeQueue;
}

function generateId() {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Public API ────────────────────────────────────────────────────────────

function listReminders(sessionId) {
  return ensureInitialized().reminders.filter(r => r.sessionId === sessionId);
}

async function addReminder(record) {
  const c = ensureInitialized();
  const full = { id: generateId(), createdAt: new Date().toISOString(), lastFiredAt: null, ...record };
  c.reminders.push(full);
  await persist(`reminder: add ${full.id}`);
  return full;
}

async function deleteReminder(sessionId, id) {
  const c = ensureInitialized();
  const before = c.reminders.length;
  c.reminders = c.reminders.filter(r => !(r.sessionId === sessionId && r.id === id));
  if (c.reminders.length === before) return false;
  await persist(`reminder: delete ${id}`);
  return true;
}

function getDueReminders(nowMs) {
  return ensureInitialized().reminders.filter(r => new Date(r.nextFireAt).getTime() <= nowMs);
}

/** Recurring reminder just fired — reschedule to the next real future occurrence. */
async function advanceRecurring(record, nowMs) {
  const rule = RRule.fromString(record.rrule);
  const nextFake = rule.after(fakeUtcFromRealMs(nowMs), false);
  if (!nextFake) {
    await deleteReminder(record.sessionId, record.id);
    return null;
  }
  record.nextFireAt = new Date(realMsFromFakeUtc(nextFake)).toISOString();
  record.lastFiredAt = new Date(nowMs).toISOString();
  await persist(`reminder: advance ${record.id}`);
  return record;
}

// ── Resolving the LLM's parsed spec into a storable record ────────────────

function intervalToMs(amount, unit) {
  const perUnit = { seconds: 1000, minutes: 60 * 1000, hours: 60 * 60 * 1000, days: 24 * 60 * 60 * 1000 };
  return amount * (perUnit[unit] ?? perUnit.minutes);
}

const UNIT_LABEL = { seconds: '秒', minutes: '分', hours: '時間', days: '日' };
const KANJI_NUM = { 1: '一', 2: '二', 3: '三', 4: '四' };
const WEEKDAY_LABEL = { MO: '月曜', TU: '火曜', WE: '水曜', TH: '木曜', FR: '金曜', SA: '土曜', SU: '日曜' };
const RRULE_WEEKDAY = { MO: RRule.MO, TU: RRule.TU, WE: RRule.WE, TH: RRule.TH, FR: RRule.FR, SA: RRule.SA, SU: RRule.SU };

function formatJstTime(fakeUtcDate) {
  const hh = String(fakeUtcDate.getUTCHours()).padStart(2, '0');
  const mm = String(fakeUtcDate.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatJstDate(fakeUtcDate) {
  return `${fakeUtcDate.getUTCMonth() + 1}/${fakeUtcDate.getUTCDate()}`;
}

/**
 * Resolves date/time fields the LLM extracted (any of which may be null)
 * against "now" (already in fake-UTC/JST space) — this is the ONLY place
 * defaulting/rollover logic lives; the LLM never computes dates itself.
 */
function resolveDateTimeFields(fields, nowFakeUtc) {
  const f = fields || {};
  const bareTime = f.year == null && f.month == null && f.day == null;

  const year = f.year ?? nowFakeUtc.getUTCFullYear();
  const month = f.month ?? (nowFakeUtc.getUTCMonth() + 1);
  const day = f.day ?? nowFakeUtc.getUTCDate();
  const hour = f.hour ?? DEFAULT_HOUR;
  const minute = f.minute ?? 0;
  const second = f.second ?? 0;

  let resolved = fakeUtcFromJstParts({ year, month, day, hour, minute, second });

  // A bare time-of-day ("15:00に") that's already passed today rolls to
  // tomorrow. A fully/partially explicit date is taken literally, even if
  // it's in the past — an accepted simplification (see plan notes).
  if (bareTime && resolved.getTime() <= nowFakeUtc.getTime()) {
    resolved = new Date(resolved.getTime() + 24 * 60 * 60 * 1000);
  }

  return resolved;
}

/**
 * Default start anchor for a calendar-style recurrence with no explicit
 * start time ("from now" per the spec): today's date at DEFAULT_HOUR, not
 * the exact current moment. A "4th Friday" or "every Wednesday" reminder
 * shouldn't be permanently pinned to whatever odd minute it happened to be
 * set up at — unlike a pure interval ("every 3 hours from now"), where
 * ticking relative to the exact request moment IS what's wanted (see the
 * recurring_interval branch below, which uses nowFake directly).
 */
function defaultCalendarStart(nowFake) {
  return fakeUtcFromJstParts({
    year: nowFake.getUTCFullYear(),
    month: nowFake.getUTCMonth() + 1,
    day: nowFake.getUTCDate(),
    hour: DEFAULT_HOUR,
    minute: 0,
    second: 0
  });
}

function describeCalendarRule({ freq, interval, byweekday, bysetpos, bymonth, bymonthday }) {
  if (freq === 'WEEKLY') {
    if (byweekday) return `${WEEKDAY_LABEL[byweekday] || byweekday}ごと（毎週）`;
    return interval >= 2 ? `${interval}週間ごと` : '毎週';
  }
  if (freq === 'MONTHLY') {
    if (byweekday && bysetpos) {
      return `第${KANJI_NUM[bysetpos] || bysetpos}${WEEKDAY_LABEL[byweekday] || byweekday}日`;
    }
    return interval >= 2 ? `${interval}か月ごと` : '毎月';
  }
  if (freq === 'YEARLY') {
    if (bymonth && bymonthday) return `毎年${bymonth}月${bymonthday}日`;
    return '毎年';
  }
  return '定期的に';
}

/**
 * @param {object} parsed - validated output of groq.parseReminderRequest
 * @param {number} nowMs - real UTC ms, captured before the LLM call
 * @returns {{kind: 'once'|'recurring', nextFireAt: string, rrule: string|null, summary: string, text: string}}
 */
function resolveReminderSpec(parsed, nowMs) {
  const nowFake = fakeUtcFromRealMs(nowMs);
  const text = parsed.text;

  if (parsed.type === 'once_absolute') {
    const fake = resolveDateTimeFields(parsed, nowFake);
    return {
      kind: 'once',
      nextFireAt: new Date(realMsFromFakeUtc(fake)).toISOString(),
      rrule: null,
      summary: `${formatJstDate(fake)} ${formatJstTime(fake)} に「${text}」`,
      text
    };
  }

  if (parsed.type === 'once_relative') {
    const realMs = nowMs + intervalToMs(parsed.amount, parsed.unit);
    const fake = fakeUtcFromRealMs(realMs);
    return {
      kind: 'once',
      nextFireAt: new Date(realMs).toISOString(),
      rrule: null,
      summary: `${formatJstDate(fake)} ${formatJstTime(fake)}（${parsed.amount}${UNIT_LABEL[parsed.unit]}後）に「${text}」`,
      text
    };
  }

  if (parsed.type === 'recurring_interval') {
    const startFake = parsed.start ? resolveDateTimeFields(parsed.start, nowFake) : nowFake;
    const totalSeconds = Math.max(60, Math.round(intervalToMs(parsed.amount, parsed.unit) / 1000));
    const rule = new RRule({ freq: RRule.SECONDLY, interval: totalSeconds, dtstart: startFake });
    const nextFake = rule.after(nowFake, false) || startFake;
    return {
      kind: 'recurring',
      nextFireAt: new Date(realMsFromFakeUtc(nextFake)).toISOString(),
      rrule: rule.toString(),
      summary: `${parsed.amount}${UNIT_LABEL[parsed.unit]}ごとに「${text}」`,
      text
    };
  }

  if (parsed.type === 'recurring_calendar') {
    const startFake = parsed.start ? resolveDateTimeFields(parsed.start, nowFake) : defaultCalendarStart(nowFake);
    const byweekday = parsed.byweekday
      ? (parsed.bysetpos ? RRULE_WEEKDAY[parsed.byweekday].nth(parsed.bysetpos) : RRULE_WEEKDAY[parsed.byweekday])
      : undefined;
    const rule = new RRule({
      freq: RRule[parsed.freq],
      interval: parsed.interval || 1,
      byweekday,
      bymonth: parsed.bymonth || undefined,
      bymonthday: parsed.bymonthday || undefined,
      dtstart: startFake
    });
    const nextFake = rule.after(nowFake, false) || startFake;
    return {
      kind: 'recurring',
      nextFireAt: new Date(realMsFromFakeUtc(nextFake)).toISOString(),
      rrule: rule.toString(),
      summary: `${describeCalendarRule(parsed)} ${formatJstTime(startFake)} に「${text}」`,
      text
    };
  }

  throw new Error(`resolveReminderSpec: unknown type "${parsed.type}"`);
}

module.exports = {
  initReminders,
  listReminders,
  addReminder,
  deleteReminder,
  getDueReminders,
  advanceRecurring,
  resolveReminderSpec
};
