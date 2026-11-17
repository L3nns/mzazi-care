/**
 * Document expiry monitoring.
 *
 * Once a day (and on start-up) this finds verified listings whose required
 * evidence has lapsed - an accepted document of a required type has passed
 * its expiry date and nothing valid replaces it - and moves them to
 * `expired`, which takes them out of search and recommendations at once. The
 * change is recorded in provider_verification_events with no actor, because
 * the system made it.
 *
 * Listings that never had documents on file (the seeded catalogue) are not
 * touched: missing evidence is a data-quality finding, not an expiry.
 *
 * Run by hand:  npm run expiry-check
 */
const { query, transaction } = require('../config/db');
const verification = require('./verification');
const ml = require('./mlClient');
const { log: logger } = require('./logger');

const defaultLog = (msg) => logger.info(msg);

const DAY_MS = 24 * 60 * 60 * 1000;
const WARN_DAYS = Number(process.env.DOCUMENT_WARN_DAYS || 30);

async function categoryMap(db = { query }) {
  const rows = await db.query(
    'SELECT category_id, parent_category_id, required_documents FROM categories');
  return new Map(rows.map((r) => [Number(r.category_id), r]));
}

/** Expires lapsed listings. Returns [{ provider_id, lapsed: [types] }]. */
async function runExpiryCheck({ today = new Date(), log = defaultLog } = {}) {
  const cats = await categoryMap();
  const providers = await query(
    "SELECT provider_id, provider_name, category_id FROM providers WHERE verification_status = 'verified'");
  if (!providers.length) return [];
  const docs = await query(
    `SELECT provider_id, document_type, expires_on, review_status FROM provider_media
     WHERE media_type = 'evidence' AND review_status = 'accepted'`);
  const byProvider = new Map();
  docs.forEach((d) => {
    const list = byProvider.get(Number(d.provider_id)) || [];
    list.push(d);
    byProvider.set(Number(d.provider_id), list);
  });

  const expired = [];
  for (const p of providers) {
    const own = byProvider.get(Number(p.provider_id));
    if (!own) continue;
    const lapsed = verification.lapsedDocuments(
      verification.requiredFor(p.category_id, cats), own, today);
    if (!lapsed.length) continue;
    const reason = `Required document expired: ${lapsed
      .map((t) => verification.DOCUMENT_TYPES[t]).join(', ')}`;
    // Re-checked under a row lock, so a listing an administrator changed in
    // the meantime is left alone.
    const changed = await transaction(async (tx) => {
      const [row] = await tx.query(
        'SELECT verification_status FROM providers WHERE provider_id = ? FOR UPDATE', [p.provider_id]);
      if (!row || row.verification_status !== 'verified') return false;
      await tx.query("UPDATE providers SET verification_status = 'expired' WHERE provider_id = ?",
        [p.provider_id]);
      await tx.query(
        `INSERT INTO provider_verification_events (provider_id, from_status, to_status, reason, actor_id)
         VALUES (?, 'verified', 'expired', ?, NULL)`, [p.provider_id, reason]);
      return true;
    });
    if (changed) {
      expired.push({ provider_id: Number(p.provider_id), lapsed });
      log(`[expiry] listing ${p.provider_id} (${p.provider_name}) expired: ${lapsed.join(', ')}`);
    }
  }
  if (expired.length) ml.reindexQuietly();
  return expired;
}

/** Accepted documents expiring within `days`, soonest first, for the dashboard. */
async function expiringSoon(days = WARN_DAYS, today = new Date()) {
  return query(
    `SELECT m.media_id, m.provider_id, p.provider_name, p.verification_status,
            m.document_type, m.version, m.expires_on,
            DATEDIFF(m.expires_on, ?) AS days_left
     FROM provider_media m JOIN providers p ON p.provider_id = m.provider_id
     WHERE m.media_type = 'evidence' AND m.review_status = 'accepted'
       AND m.expires_on IS NOT NULL AND m.expires_on <= DATE_ADD(?, INTERVAL ? DAY)
     ORDER BY m.expires_on ASC, m.media_id ASC LIMIT 100`,
    [verification.localDay(today), verification.localDay(today), days],
  );
}

/** Runs the check now and then daily. The timer does not keep the process alive. */
function schedule(log = defaultLog) {
  const run = () => runExpiryCheck({ log })
    .catch((err) => logger.warn('expiry check failed', { err }));
  run();
  setInterval(run, DAY_MS).unref();
}

if (require.main === module) {
  require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
  require('dotenv').config();
  runExpiryCheck()
    .then((out) => {
      console.log(out.length ? `[expiry] ${out.length} listing(s) expired` : '[expiry] nothing lapsed');
      return require('../config/db').close();
    })
    .catch((err) => { console.error('[expiry] failed:', err.message); process.exit(1); });
}

module.exports = { runExpiryCheck, expiringSoon, schedule, categoryMap, WARN_DAYS };
