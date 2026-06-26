/**
 * notify.js
 * Builds LINE textV2 push messages for GAS webhook notifications.
 * User identities are resolved from environment variables only — no names in code.
 *
 * ENV vars required:
 *   USER_ID_A        LINE userId for user A
 *   USER_ID_S        LINE userId for user B
 *   USER_ID_N        LINE userId for user C
 *   LINE_GROUP_ID    Target group chat ID
 *
 * GAS sends a POST to /gas-notify with a JSON body:
 *   { app: 'carshare' | 'ledger', event: string, data: object }
 */

// ── User registry (resolved at runtime from env) ──────────────────────────
// Keys are the internal GAS names used in data payloads.
// Values come exclusively from environment variables.
function getUserRegistry() {
  return {
    A: process.env.USER_ID_A || '',
    S: process.env.USER_ID_S || '',
    N: process.env.USER_ID_N || '',
  };
}

/**
 * Resolve a GAS user key to a LINE userId.
 * GAS sends data with keys like "A", "S", "N" — never names.
 */
function resolveUserId(key) {
  const reg = getUserRegistry();
  return reg[key] || null;
}

/**
 * Build a mention substitution entry for textV2.
 * Returns null if userId is not configured.
 */
function mentionEntry(userId) {
  if (!userId) return null;
  return { type: 'mention', mentionee: { type: 'user', userId } };
}

/**
 * Build a textV2 message object.
 * @param {string} text  - Message text with {placeholders}
 * @param {object} subs  - substitution map (only mention entries, nulls filtered out)
 */
function textV2(text, subs = {}) {
  const filtered = {};
  for (const [k, v] of Object.entries(subs)) {
    if (v !== null) filtered[k] = v;
  }
  return {
    type: 'textV2',
    text,
    substitution: filtered,
  };
}

/**
 * Format a number with commas.
 */
function fmt(n) {
  if (n == null || n === '') return '';
  return Number(n).toLocaleString('ja-JP');
}

// ══════════════════════════════════════════════════════════════════════════
// CARSHARE TEMPLATES
// ══════════════════════════════════════════════════════════════════════════

/**
 * 使用開始
 * data: { userKeys: ['A','S'], startOdo: number, startTime: string }
 */
function buildCarStart(data) {
  const { userKeys = [], startOdo, startTime } = data;

  // Build mention placeholders for each user key
  const subs = {};
  const mentionTokens = userKeys.map((k, i) => {
    const key = `u${i}`;
    subs[key] = mentionEntry(resolveUserId(k));
    return `{${key}}`;
  }).join(', ');

  return textV2(
    `🚗 ｺﾃー！！行くｺﾃよー\n` +
    `━━━━━━━━━━━━\n` +
    `使用者: ${mentionTokens}\n` +
    `開始走行距離: ${fmt(startOdo)} km\n` +
    `開始時刻: ${startTime}`,
    subs
  );
}

/**
 * 返却
 * data: { userKeys: ['A'], startOdo, endOdo, distance, efficiency, endTime }
 */
function buildCarReturn(data) {
  const { userKeys = [], startOdo, endOdo, distance, efficiency, endTime } = data;

  const subs = {};
  const mentionTokens = userKeys.map((k, i) => {
    const key = `u${i}`;
    subs[key] = mentionEntry(resolveUserId(k));
    return `{${key}}`;
  }).join(', ');

  return textV2(
    `🏠 ｺﾃー！！帰ってきたｺﾃ！\n` +
    `━━━━━━━━━━━━\n` +
    `使用者: ${mentionTokens}\n` +
    `走行距離: ${fmt(startOdo)} → ${fmt(endOdo)} km（+${fmt(distance)} km）\n` +
    `燃費: ${efficiency} km/L\n` +
    `返却時刻: ${endTime}`,
    subs
  );
}

/**
 * 給油
 * data: {
 *   refuelerKey: 'N',
 *   amount: number,
 *   totalFuel: number,
 *   breakdown: [{ key: 'A', fuel: number, pct: number }, ...]
 * }
 */
function buildCarRefuel(data) {
  const { refuelerKey, amount, totalFuel, breakdown = [] } = data;

  const subs = { refueler: mentionEntry(resolveUserId(refuelerKey)) };

  // Build per-user lines using placeholder keys for the refueler marker
  const lines = breakdown.map(({ key, fuel, pct, isRefueler }) => {
    const marker = isRefueler ? '*' : ' ';
    // Use generic placeholder letters to avoid names in code
    return `{u_${key}}${marker}: ${fuel} L（${pct}%）`;
  });

  // Add mention subs for each breakdown user
  breakdown.forEach(({ key }) => {
    subs[`u_${key}`] = mentionEntry(resolveUserId(key));
  });

  return textV2(
    `⛽ ｺﾃー！！お腹いっぱいｺﾃ！\n` +
    `━━━━━━━━━━━━\n` +
    `給油者: {refueler}\n` +
    `金額: ${fmt(amount)}円\n` +
    `使用燃料量: ${totalFuel} L\n` +
    lines.join('\n'),
    subs
  );
}

/**
 * 書き直し（カーシェア）
 * data: {
 *   requesterKey: 'S',
 *   before: string,   // formatted trip string
 *   after: string,    // formatted trip string after change
 *   changes: string[] // ['使用者: X → Y', ...]
 * }
 */
function buildCarRewrite(data) {
  const { requesterKey, before, after, changes = [] } = data;

  const changeLines = changes.map(c => `・${c}`).join('\n');

  return textV2(
    `📝 カーシェア記録が書き直されたｺﾃ！\n` +
    `━━━━━━━━━━━━\n` +
    `申請者: {req}\n` +
    `対象:\n${before}\n` +
    `変更内容:\n${changeLines}\n` +
    `変更後:\n${after}`,
    { req: mentionEntry(resolveUserId(requesterKey)) }
  );
}

// ══════════════════════════════════════════════════════════════════════════
// LEDGER TEMPLATES
// ══════════════════════════════════════════════════════════════════════════

/**
 * 記帳
 * data: {
 *   requesterKey: 'N',
 *   lenderKey: 'N',
 *   borrowerKeys: ['S', 'A'],
 *   amount: number,
 *   purpose: string,
 *   perPerson: number
 * }
 */
function buildLedgerRecord(data) {
  const { requesterKey, lenderKey, borrowerKeys = [], amount, purpose, balances = [] } = data;

  const subs = {
    req:    mentionEntry(resolveUserId(requesterKey)),
    lender: mentionEntry(resolveUserId(lenderKey)),
  };

  borrowerKeys.forEach((k, i) => {
    subs[`b${i}`] = mentionEntry(resolveUserId(k));
  });

  const borrowerTokens = borrowerKeys.map((_, i) => `{b${i}}`).join(', ');

  // Balance lines: each user's net change
  balances.forEach(({ key }) => {
    if (!subs[`bal_${key}`]) {
      subs[`bal_${key}`] = mentionEntry(resolveUserId(key));
    }
  });
  const balanceLines = balances.map(({ key, delta }) => {
    const sign = delta >= 0 ? '+' : '';
    return `{bal_${key}}: ${sign}${fmt(delta)}円`;
  }).join('\n');

  return textV2(
    `💰 貸借対照表に記帳されたぷよ！\n` +
    `━━━━━━━━━━━━\n` +
    `申請者: {req}\n` +
    `貸主: {lender}\n` +
    `借主: ${borrowerTokens}\n` +
    `金額: ${fmt(amount)}円\n` +
    `用途: ${purpose}\n` +
    `━━━━━━━━━━━━\n` +
    balanceLines,
    subs
  );
}

/**
 * 書き直し（貸借対照表）
 * data: {
 *   requesterKey: 'S',
 *   before: string,
 *   after: string,
 *   changes: string[],
 *   reason: string
 * }
 */
function buildLedgerRewrite(data) {
  const { requesterKey, before, after, changes = [], reason } = data;

  const changeLines = changes.map(c => `・${c}`).join('\n');

  return textV2(
    `✏️ 貸借対照表の記帳が書き直されたぷよ\n` +
    `━━━━━━━━━━━━\n` +
    `申請者: {req}\n` +
    `対象:\n${before}\n` +
    `変更内容:\n${changeLines}\n` +
    `理由: ${reason}\n` +
    `変更後:\n${after}`,
    { req: mentionEntry(resolveUserId(requesterKey)) }
  );
}

// ══════════════════════════════════════════════════════════════════════════
// ROUTER
// ══════════════════════════════════════════════════════════════════════════

/**
 * Route a GAS notification payload to the correct template builder.
 * Returns a LINE message object or null if the event is unrecognised.
 *
 * @param {string} app   - 'carshare' | 'ledger'
 * @param {string} event - event name
 * @param {object} data  - event data
 */
function buildNotification(app, event, data) {
  if (app === 'carshare') {
    switch (event) {
      case 'start':   return buildCarStart(data);
      case 'return':  return buildCarReturn(data);
      case 'refuel':  return buildCarRefuel(data);
      case 'rewrite': return buildCarRewrite(data);
      default: return null;
    }
  }
  if (app === 'ledger') {
    switch (event) {
      case 'record':  return buildLedgerRecord(data);
      case 'rewrite': return buildLedgerRewrite(data);
      default: return null;
    }
  }
  return null;
}

module.exports = { buildNotification, getUserRegistry };
