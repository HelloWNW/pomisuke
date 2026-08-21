/**
 * reminderScheduler.js
 *
 * Polls reminders.js for anything due and pushes it via the LINE client.
 * A 60s interval matches the stated 1-minute minimum granularity; an
 * immediate check runs first so anything overdue from a Render sleep or
 * redeploy fires (late, not dropped) the moment the process comes back up.
 */

const reminders = require('./reminders');

const CHECK_INTERVAL_MS = 60 * 1000;

async function checkOnce(client) {
  const now = Date.now();
  const due = reminders.getDueReminders(now);

  for (const record of due) {
    try {
      await client.pushMessage({
        to: record.sessionId,
        messages: [{ type: 'text', text: `⏰ ${record.text}` }]
      });
    } catch (err) {
      console.error(`reminderScheduler: push failed for ${record.id}:`, err.message);
    }

    try {
      if (record.kind === 'once') {
        await reminders.deleteReminder(record.sessionId, record.id);
      } else {
        await reminders.advanceRecurring(record, now);
      }
    } catch (err) {
      console.error(`reminderScheduler: post-fire update failed for ${record.id}:`, err.message);
    }
  }
}

function start(client) {
  checkOnce(client).catch(err => console.error('reminderScheduler: initial check failed:', err.message));
  setInterval(() => {
    checkOnce(client).catch(err => console.error('reminderScheduler: check failed:', err.message));
  }, CHECK_INTERVAL_MS);
}

module.exports = { start };
