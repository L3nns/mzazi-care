/**
 * Brings a database created from an older schema.sql up to date. Each step
 * checks information_schema first, so running it twice is harmless. It runs
 * on server start and can be run by hand:  npm run migrate
 */
const { query, one } = require('./db');

const STEPS = [
  {
    name: 'admin_logs.notes',
    needed: async () => !await one(
      `SELECT 1 AS present FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'admin_logs' AND column_name = 'notes'`),
    sql: 'ALTER TABLE admin_logs ADD COLUMN notes VARCHAR(500) NULL AFTER entity_id',
  },
  {
    name: 'admin_logs.idx_log_entity',
    needed: async () => !await one(
      `SELECT 1 AS present FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = 'admin_logs'
         AND index_name = 'idx_log_entity'`),
    sql: 'ALTER TABLE admin_logs ADD INDEX idx_log_entity (entity_affected, entity_id)',
  },
  {
    name: 'admin_logs.idx_log_time',
    needed: async () => !await one(
      `SELECT 1 AS present FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = 'admin_logs'
         AND index_name = 'idx_log_time'`),
    sql: 'ALTER TABLE admin_logs ADD INDEX idx_log_time (performed_at)',
  },
];

async function migrate(log = console.log) {
  const applied = [];
  for (const step of STEPS) {
    if (await step.needed()) {
      await query(step.sql);
      applied.push(step.name);
      log(`[migrate] applied ${step.name}`);
    }
  }
  return applied;
}

if (require.main === module) {
  require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
  require('dotenv').config();
  migrate()
    .then((applied) => {
      console.log(applied.length ? `[migrate] ${applied.length} step(s) applied` : '[migrate] up to date');
      return require('./db').close();
    })
    .catch((err) => { console.error('[migrate] failed:', err.message); process.exit(1); });
}

module.exports = { migrate };
