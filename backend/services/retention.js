/**
 * Data retention: personal data is kept only as long as it is useful, then
 * deleted. Runs daily inside the backend, or by hand:  npm run retention
 *
 * Each period is in days and can be changed in .env; 0 keeps that data
 * indefinitely. The defaults are stated in frontend/privacy.html - change both
 * together.
 *
 *   SEARCH_RETENTION_DAYS              365  search history (feeds the profile:
 *                                           only the 20 most recent are used)
 *   RECOMMENDATION_LOG_RETENTION_DAYS   90  recommendations shown, with scores
 *   FEEDBACK_RETENTION_DAYS            365  "Not for me" answers; never below
 *                                           FEEDBACK_HIDE_DAYS, which they power
 *   INTERACTION_RETENTION_DAYS         730  views, clicks, saves, ratings: the
 *                                           recommender's training data
 *
 * Accounts and saved services are kept until the parent deletes the account.
 * The admin audit trail is not personal activity data and is not purged here.
 */
const { query } = require('../config/db');
const ml = require('./mlClient');
const { log: logger } = require('./logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 5000;     // short deletes, so a large purge never locks a table for long

const days = (name, fallback) => {
  const v = process.env[name];
  const n = v === undefined || v === '' ? fallback : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

/** The rules in force, read from the environment each run. */
function rules() {
  const hideDays = days('FEEDBACK_HIDE_DAYS', 180);
  let feedback = days('FEEDBACK_RETENTION_DAYS', 365);
  // Feedback hides a provider for FEEDBACK_HIDE_DAYS; purging it sooner would
  // bring the provider back early.
  if (feedback && feedback < hideDays) feedback = hideDays;
  return [
    { table: 'search_history', column: 'searched_at', days: days('SEARCH_RETENTION_DAYS', 365) },
    { table: 'recommendations', column: 'generated_at', days: days('RECOMMENDATION_LOG_RETENTION_DAYS', 90) },
    { table: 'recommendation_feedback', column: 'created_at', days: feedback },
    { table: 'interactions', column: 'created_at', days: days('INTERACTION_RETENTION_DAYS', 730) },
  ];
}

/** Deletes everything past its period. Returns [{ table, days, deleted }]. */
async function runRetention({ log = (msg) => logger.info(msg) } = {}) {
  const out = [];
  for (const r of rules()) {
    if (!r.days) { out.push({ table: r.table, days: 0, deleted: 0 }); continue; }
    let deleted = 0;
    for (;;) {
      // Table and column names come from the fixed list above, never from input.
      const res = await query(
        `DELETE FROM ${r.table} WHERE ${r.column} < DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT ${BATCH}`,
        [r.days]);
      deleted += res.affectedRows || 0;
      if ((res.affectedRows || 0) < BATCH) break;
    }
    out.push({ table: r.table, days: r.days, deleted });
    if (deleted) log(`[retention] ${r.table}: ${deleted} row(s) older than ${r.days} days deleted`);
  }
  // Interactions are the model's training data: refit so the engine forgets them too.
  if (out.some((r) => r.table === 'interactions' && r.deleted)) ml.reindexQuietly();
  return out;
}

/** Runs now and then daily. The timer does not keep the process alive. */
function schedule(log = (msg) => logger.info(msg)) {
  const run = () => runRetention({ log })
    .catch((err) => logger.warn('retention run failed', { err }));
  run();
  setInterval(run, DAY_MS).unref();
}

module.exports = { runRetention, schedule, rules };

if (require.main === module) {
  require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
  require('dotenv').config();
  runRetention({ log: console.log })
    .then((out) => {
      for (const r of out) {
        const period = r.days ? `${r.days} days` : 'kept';
        console.log(`[retention] ${r.table.padEnd(24)} ${period.padEnd(9)} ${r.deleted} deleted`);
      }
      return require('../config/db').close();
    })
    .catch((err) => { console.error('[retention] failed:', err.message); process.exit(1); });
}
