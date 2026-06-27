/**
 * notify.js
 * Builds LINE textV2 push messages for GAS webhook notifications.
 */

// ── User registry (resolved at runtime from env) ──────────────────────────
function getUserRegistry() {
  return {
    A: process.env.USER_ID_A || '',
    S: process.env.USER_ID_S || '',
    N: process.env.USER_ID_N || '',
  };
}

function resolveUserId(key) {
  return getUserRegistry()[key] || null;
}

function mentionEntry(userId) {
  if (!userId) return null;
  return { type: 'mention', mentionee: { type: 'user', userId } };
}

function textV2(text, subs = {}) {
  const filtered = {};
  for (const [k, v] of Object.entries(subs)) {
    if (v !== null) filtered[k] = v;
  }
  return { type: 'textV2', text, substitution: filtered };
}

/** Format integer with commas. */
function fmt(n) {
  if (n == null || n === '') return '';
  return Number(n).toLocaleString('ja-JP');
}

/** Format fuel to fixed 2 decimal places (no commas). */
function fmtFuel(n) {
  if (n == null || n === '') return '';
  return Number(n).toFixed(2);
}

/** Format efficiency to fixed 1 decimal place. */
function fmtEff(n) {
  if (n == null || n === '') return '';
  return Number(n).toFixed(1);
}

function buildCarStart(data) {
  const { userKeys = [], startOdo, startTime } = data;

  const subs = {};
  const mentionTokens = userKeys.map((k, i) => {
    const key = `u${i}`;
    subs[key] = mentionEntry(resolveUserId(k));
    return `{${key}}`;
  }).join(', ');

  return textV2(
    `🚗 ｺﾃー！！行くｺﾃよー\n` +
    `━━━━━━━━━━━━\n` +
    `使用者　: ${mentionTokens}\n` +
    `\n` +
    `開始距離: ${fmt(startOdo)} km\n` +
    `開始時刻: ${startTime}`,
    subs
  );
}

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
    `使用者　: ${mentionTokens}\n` +
    `\n` +
    `走行距離:\n` +
    `　${fmt(startOdo)} → ${fmt(endOdo)} km（+${fmt(distance)} km）\n` +
    `燃費　　: ${fmtEff(efficiency)} km/L\n` +
    `返却時刻: ${endTime}`,
    subs
  );
}

function buildCarRefuel(data) {
  const { refuelerKey, amount, totalFuel, breakdown = [] } = data;

  const subs = { refueler: mentionEntry(resolveUserId(refuelerKey)) };
  breakdown.forEach(({ key }) => {
    subs[`u_${key}`] = mentionEntry(resolveUserId(key));
  });

  const maxPctLen = Math.max(...breakdown.map(b => `${b.pct}%`.length));

  const lines = breakdown.map(({ key, fuel, pct, isRefueler, owe }) => {
    const marker  = isRefueler ? '*' : ' ';
    const pctStr  = `${pct}%`.padEnd(maxPctLen, '\u2005'); // narrow no-break space
    const oweStr  = owe != null ? `${fmt(owe)}円` : '';
    return `{u_${key}}${marker}\n　${fmtFuel(fuel)} L（${pctStr}）-  ${oweStr}`;
  });

  return textV2(
    `⛽ ｺﾃー！！お腹いっぱいｺﾃ！\n` +
    `━━━━━━━━━━━━\n` +
    `給油者　　: {refueler}\n` +
    `金額　　　: ${fmt(amount)}円\n` +
    `使用燃料量: ${fmtFuel(totalFuel)} L\n` +
    `\n` +
    lines.join('\n'),
    subs
  );
}

function buildCarRewrite(data) {
  const { requesterKey, before, after, changes = [] } = data;

  // Strip the label's trailing colon; format as "・label\n　　value"
  const changeLines = changes.map(c => {
    const colonIdx = c.indexOf(':');
    if (colonIdx !== -1) {
      const label = c.slice(0, colonIdx).trim();
      const value = c.slice(colonIdx + 1).trim();
      return `・${label}\n　　${value}`;
    }
    return `・${c}`;
  }).join('\n');

  function fmtTrip(t) {
    if (!t) return '　(データなし)';
    const eff = t.eff != null ? fmtEff(t.eff) : '?';
    return (
      `　${t.time}\n` +
      `　${t.users}\n` +
      `　${fmt(t.startOdo)}→${fmt(t.endOdo)}km\n` +
      `　${eff} km/L`
    );
  }

  return textV2(
    `📝 カーシェア記録が書き直しｺﾃ！\n` +
    `━━━━━━━━━━━━\n` +
    `申請者　: {req}\n` +
    `\n` +
    `対象　　:\n${fmtTrip(before)}\n` +
    `\n` +
    `変更内容:\n${changeLines}\n` +
    `\n` +
    `変更後　:\n${fmtTrip(after)}`,
    { req: mentionEntry(resolveUserId(requesterKey)) }
  );
}

// ══════════════════════════════════════════════════════════════════════════
// LEDGER TEMPLATES
// ══════════════════════════════════════════════════════════════════════════

function buildLedgerRecord(data) {
  const { requesterKey, lenderKey, borrowerKeys = [], amount, purpose } = data;

  const subs = {
    req:    mentionEntry(resolveUserId(requesterKey)),
    lender: mentionEntry(resolveUserId(lenderKey)),
  };
  borrowerKeys.forEach((k, i) => {
    subs[`b${i}`] = mentionEntry(resolveUserId(k));
  });

  const borrowerTokens = borrowerKeys.map((_, i) => `{b${i}}`).join(', ');

  return textV2(
    `💰 貸借対照表に記帳されたぷよ！\n` +
    `━━━━━━━━━━━━\n` +
    `申請者: {req}\n` +
    `貸主　: {lender}\n` +
    `\n` +
    `借主　: ${borrowerTokens}\n` +
    `金額　: ${fmt(amount)}円\n` +
    `用途　: ${purpose}`,
    subs
  );
}

function buildLedgerRewrite(data) {
  const { requesterKey, before, after, changes = [], reason } = data;

  const changeLines = changes.map(c => {
    const colonIdx = c.indexOf(':');
    if (colonIdx !== -1) {
      const label = c.slice(0, colonIdx).trim();
      const value = c.slice(colonIdx + 1).trim();
      return `・${label}\n　　${value}`;
    }
    return `・${c}`;
  }).join('\n');

  function fmtRecord(r) {
    if (!r) return '　(データなし)';
    const suffix = r.id ? ` [${r.id}]` : '';
    return (
      `　${r.time}\n` +
      `　${r.lender}→${r.borrowers}\n` +
      `　${fmt(r.amount)}円\n` +
      `　${r.purpose}${suffix}`
    );
  }

  return textV2(
    `✏️ 貸借対照表が書き直されたぷよ\n` +
    `━━━━━━━━━━━━\n` +
    `申請者: {req}\n` +
    `\n` +
    `対象　:\n${fmtRecord(before)}\n` +
    `\n` +
    `変更内容:\n${changeLines}\n` +
    `理由　　:\n　${reason}\n` +
    `\n` +
    `変更後　:\n${fmtRecord(after)}`,
    { req: mentionEntry(resolveUserId(requesterKey)) }
  );
}

// ══════════════════════════════════════════════════════════════════════════
// ERROR TEMPLATE
// ══════════════════════════════════════════════════════════════════════════

function buildError(data) {
  const { source, message } = data;
  const sourceLabel = source === 'carshare' ? 'カーシェア' : '貸借対照表';
  return textV2(
    `⚠️ ${sourceLabel}でエラーぷよ\n` +
    `━━━━━━━━━━━━\n` +
    `${message}`
  );
}

// ══════════════════════════════════════════════════════════════════════════
// ROUTER
// ══════════════════════════════════════════════════════════════════════════

function buildNotification(app, event, data) {
  if (app === 'carshare') {
    switch (event) {
      case 'start':   return buildCarStart(data);
      case 'return':  return buildCarReturn(data);
      case 'refuel':  return buildCarRefuel(data);
      case 'rewrite': return buildCarRewrite(data);
      case 'error':   return buildError({ ...data, source: 'carshare' });
      default: return null;
    }
  }
  if (app === 'ledger') {
    switch (event) {
      case 'record':  return buildLedgerRecord(data);
      case 'rewrite': return buildLedgerRewrite(data);
      case 'error':   return buildError({ ...data, source: 'ledger' });
      default: return null;
    }
  }
  return null;
}

module.exports = { buildNotification, getUserRegistry };
