/**
 * Versioned schema migrations.
 *
 * Each migration has a fixed version number and is recorded in
 * schema_migrations once applied, so it runs exactly once per database. A
 * migration may also declare `present`: a check that its change already exists
 * (a database created from a newer schema.sql). Such a migration is recorded
 * without being run. Migrations run on server start and by hand:
 *   npm run migrate
 *
 * Add new migrations at the end with the next version number. Never edit or
 * renumber one that has been released.
 */
const { query, one } = require('./db');

const columnExists = (table, column) => async () => !!await one(
  `SELECT 1 AS present FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column]);
const indexExists = (table, index) => async () => !!await one(
  `SELECT 1 AS present FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`, [table, index]);

const tableExists = (table) => async () => !!await one(
  `SELECT 1 AS present FROM information_schema.tables
   WHERE table_schema = DATABASE() AND table_name = ?`, [table]);
const enumHas = (table, column, value) => async () => {
  const row = await one(
    `SELECT column_type FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column]);
  return !!row && String(row.column_type || row.COLUMN_TYPE).includes(`'${value}'`);
};

// Documents each seeded category requires before a listing can be verified.
// Clinical services need professional registration; childcare facilities need
// business and facility documents; everything else needs identity and a
// qualification. Administrators can change these per category afterwards.
const CLINICAL = 'identity,qualification,professional_registration';
const TRAINED = 'identity,qualification';
const DEFAULT_DOCUMENTS = {
  'Prenatal Care': CLINICAL,
  'Antenatal Classes': TRAINED,
  'Obstetric Consultation': CLINICAL,
  'Midwifery Services': CLINICAL,
  'Birth Doula Support': TRAINED,
  'Postnatal Support': TRAINED,
  'Postnatal Home Care': CLINICAL,
  'Lactation Consultation': TRAINED,
  'Breastfeeding Support Groups': TRAINED,
  'Maternal Mental Health': CLINICAL,
  'Maternal Nutrition': CLINICAL,
  'Prenatal and Postnatal Fitness': TRAINED,
  'Pediatric Care': CLINICAL,
  'Child Immunisation': CLINICAL,
  'Child Nutrition and Feeding': CLINICAL,
  'Early Childhood Development': TRAINED,
  'Child Special Needs Support': CLINICAL,
  'Nanny Placement': 'identity,business_registration',
  'Daycare and Childcare Centres': 'identity,business_registration,facility_licence',
  'Parenting Guidance and Coaching': TRAINED,
};

// Approximate neighbourhood centres. They support "about N km" and a distance
// feature in ranking; they are never presented as a provider's address.
// The same list is in database/seed/service_areas.csv for the ML service.
const SERVICE_AREAS = [
  ['Buruburu', -1.2856, 36.8786], ['Donholm', -1.2945, 36.8908], ['Embakasi', -1.3193, 36.8981],
  ['Gigiri', -1.2335, 36.8017], ['Karen', -1.3197, 36.7073], ['Kasarani', -1.2216, 36.8977],
  ['Kikuyu', -1.2463, 36.6629], ['Kileleshwa', -1.2833, 36.7833], ['Kilimani', -1.2921, 36.7856],
  ['Langata', -1.3626, 36.7419], ['Lavington', -1.2797, 36.7700], ['Ngong Road', -1.2990, 36.7800],
  ['Parklands', -1.2610, 36.8180], ['Roysambu', -1.2180, 36.8790], ['Ruaka', -1.2069, 36.7774],
  ['Runda', -1.2177, 36.8099], ['South B', -1.3086, 36.8365], ['South C', -1.3197, 36.8270],
  ['Upper Hill', -1.2966, 36.8148], ['Westlands', -1.2675, 36.8108],
];

const MIGRATIONS = [
  {
    version: 1,
    name: 'admin_logs.notes',
    present: columnExists('admin_logs', 'notes'),
    sql: ['ALTER TABLE admin_logs ADD COLUMN notes VARCHAR(500) NULL AFTER entity_id'],
  },
  {
    version: 2,
    name: 'admin_logs.idx_log_entity',
    present: indexExists('admin_logs', 'idx_log_entity'),
    sql: ['ALTER TABLE admin_logs ADD INDEX idx_log_entity (entity_affected, entity_id)'],
  },
  {
    version: 3,
    name: 'admin_logs.idx_log_time',
    present: indexExists('admin_logs', 'idx_log_time'),
    sql: ['ALTER TABLE admin_logs ADD INDEX idx_log_time (performed_at)'],
  },
  {
    version: 4,
    name: 'users.token_version (session revocation)',
    present: columnExists('users', 'token_version'),
    sql: ['ALTER TABLE users ADD COLUMN token_version INT NOT NULL DEFAULT 0 AFTER role'],
  },
  {
    version: 5,
    name: 'providers.verification_status: eight-state workflow',
    present: enumHas('providers', 'verification_status', 'under_review'),
    sql: [`ALTER TABLE providers MODIFY verification_status
      ENUM('draft','pending','under_review','needs_more_information',
           'verified','rejected','suspended','expired') NOT NULL DEFAULT 'pending'`],
  },
  {
    version: 6,
    name: 'provider_verification_events',
    present: tableExists('provider_verification_events'),
    sql: [`CREATE TABLE provider_verification_events (
      event_id     INT AUTO_INCREMENT PRIMARY KEY,
      provider_id  INT NOT NULL,
      from_status  VARCHAR(30) NULL,
      to_status    VARCHAR(30) NOT NULL,
      reason       VARCHAR(500) NULL,
      actor_id     INT NULL,
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_vev_provider FOREIGN KEY (provider_id)
        REFERENCES providers(provider_id) ON DELETE CASCADE,
      CONSTRAINT fk_vev_actor FOREIGN KEY (actor_id)
        REFERENCES users(user_id) ON DELETE SET NULL,
      INDEX idx_vev_provider (provider_id, created_at)
    ) ENGINE=InnoDB`],
  },
  {
    version: 7,
    name: 'provider_media: verification document metadata',
    present: columnExists('provider_media', 'document_type'),
    sql: [
      `ALTER TABLE provider_media
         ADD COLUMN document_type VARCHAR(40) NULL AFTER media_type,
         ADD COLUMN version INT NOT NULL DEFAULT 1 AFTER document_type,
         ADD COLUMN expires_on DATE NULL AFTER version,
         ADD COLUMN review_status ENUM('pending','accepted','rejected') NULL AFTER expires_on,
         ADD COLUMN reviewed_by INT NULL AFTER review_status,
         ADD COLUMN reviewed_at DATETIME NULL AFTER reviewed_by,
         ADD COLUMN review_note VARCHAR(500) NULL AFTER reviewed_at,
         ADD COLUMN uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER review_note,
         ADD CONSTRAINT fk_media_reviewer FOREIGN KEY (reviewed_by)
           REFERENCES users(user_id) ON DELETE SET NULL,
         ADD INDEX idx_media_expiry (media_type, review_status, expires_on)`,
      `UPDATE provider_media SET document_type = 'other', review_status = 'pending'
         WHERE media_type = 'evidence' AND document_type IS NULL`,
    ],
  },
  {
    version: 8,
    name: 'categories.required_documents',
    present: columnExists('categories', 'required_documents'),
    sql: ['ALTER TABLE categories ADD COLUMN required_documents VARCHAR(255) NULL AFTER parent_category_id'],
  },
  {
    version: 9,
    name: 'categories.required_documents: defaults for the seeded categories',
    sql: Object.entries(DEFAULT_DOCUMENTS).map(([name, docs]) => ({
      sql: `UPDATE categories SET required_documents = ?
            WHERE category_name = ? AND required_documents IS NULL`,
      params: [docs, name],
    })),
  },
  {
    version: 10,
    name: 'users: two-step sign-in (TOTP)',
    present: columnExists('users', 'mfa_enabled'),
    sql: [`ALTER TABLE users
      ADD COLUMN mfa_secret VARCHAR(255) NULL AFTER token_version,
      ADD COLUMN mfa_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER mfa_secret,
      ADD COLUMN mfa_last_step BIGINT NULL AFTER mfa_enabled`],
  },
  {
    version: 11,
    name: 'service_areas and provider_service_areas',
    present: tableExists('service_areas'),
    sql: [
      `CREATE TABLE service_areas (
        area_id    INT AUTO_INCREMENT PRIMARY KEY,
        area_name  VARCHAR(120) NOT NULL,
        latitude   DECIMAL(8,5) NULL,
        longitude  DECIMAL(8,5) NULL,
        is_active  TINYINT(1) NOT NULL DEFAULT 1,
        UNIQUE KEY uq_area_name (area_name)
      ) ENGINE=InnoDB`,
      `CREATE TABLE provider_service_areas (
        provider_id INT NOT NULL,
        area_id     INT NOT NULL,
        PRIMARY KEY (provider_id, area_id),
        CONSTRAINT fk_psa_provider FOREIGN KEY (provider_id)
          REFERENCES providers(provider_id) ON DELETE CASCADE,
        CONSTRAINT fk_psa_area FOREIGN KEY (area_id)
          REFERENCES service_areas(area_id) ON DELETE CASCADE,
        INDEX idx_psa_area (area_id)
      ) ENGINE=InnoDB`,
    ],
  },
  {
    version: 12,
    name: 'service_areas: Nairobi areas, and each provider serves its own area',
    sql: [
      ...SERVICE_AREAS.map(([name, lat, lng]) => ({
        sql: `INSERT INTO service_areas (area_name, latitude, longitude) VALUES (?, ?, ?)
              ON DUPLICATE KEY UPDATE latitude = COALESCE(latitude, VALUES(latitude)),
                                      longitude = COALESCE(longitude, VALUES(longitude))`,
        params: [name, lat, lng],
      })),
      // Any other area a listing already names becomes an area without coordinates.
      `INSERT IGNORE INTO service_areas (area_name)
        SELECT DISTINCT TRIM(location) FROM providers WHERE location IS NOT NULL AND TRIM(location) <> ''`,
      `INSERT IGNORE INTO provider_service_areas (provider_id, area_id)
        SELECT p.provider_id, a.area_id FROM providers p
        JOIN service_areas a ON a.area_name = TRIM(p.location)`,
    ],
  },
  {
    version: 13,
    name: 'recommendation_feedback',
    present: tableExists('recommendation_feedback'),
    sql: [`CREATE TABLE recommendation_feedback (
      feedback_id  INT AUTO_INCREMENT PRIMARY KEY,
      user_id      INT NOT NULL,
      provider_id  INT NOT NULL,
      feedback     ENUM('relevant','not_relevant','too_far','wrong_category','already_contacted') NOT NULL,
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_rf_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
      CONSTRAINT fk_rf_provider FOREIGN KEY (provider_id) REFERENCES providers(provider_id) ON DELETE CASCADE,
      INDEX idx_rf_user (user_id, created_at)
    ) ENGINE=InnoDB`],
  },
  {
    version: 14,
    name: 'interactions: one rating per parent per provider',
    present: indexExists('interactions', 'uq_one_rating'),
    sql: [
      // Keep each parent's latest rating of a provider; earlier ones were
      // counted again in every average.
      `DELETE older FROM interactions older
        JOIN interactions newer
          ON newer.user_id = older.user_id AND newer.provider_id = older.provider_id
         AND newer.interaction_type = 'rating' AND older.interaction_type = 'rating'
         AND newer.interaction_id > older.interaction_id`,
      // VIRTUAL, not STORED: MySQL refuses a stored generated column whose base
      // columns carry ON DELETE CASCADE foreign keys. NULL for every other
      // interaction type, so views, clicks and saves are unaffected.
      `ALTER TABLE interactions
        ADD COLUMN rating_pair VARCHAR(24)
          AS (IF(interaction_type = 'rating', CONCAT(user_id, ':', provider_id), NULL)) VIRTUAL,
        ADD UNIQUE KEY uq_one_rating (rating_pair)`,
    ],
  },
  {
    version: 15,
    name: 'admin_logs: keep the audit trail when an account is deleted',
    // Was ON DELETE CASCADE: deleting a former administrator's account erased
    // their record of administrator actions.
    present: async () => (await one(
      `SELECT delete_rule FROM information_schema.referential_constraints
       WHERE constraint_schema = DATABASE() AND table_name = 'admin_logs'
         AND constraint_name = 'fk_log_admin'`))?.delete_rule === 'SET NULL',
    sql: [
      'ALTER TABLE admin_logs DROP FOREIGN KEY fk_log_admin',
      'ALTER TABLE admin_logs MODIFY admin_id INT NULL',
      `ALTER TABLE admin_logs ADD CONSTRAINT fk_log_admin FOREIGN KEY (admin_id)
         REFERENCES users(user_id) ON DELETE SET NULL`,
    ],
  },
];

async function migrate(log = (msg) => require('../services/logger').log.info(msg)) {
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INT PRIMARY KEY,
      name       VARCHAR(120) NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`);
  const done = new Set((await query('SELECT version FROM schema_migrations'))
    .map((r) => Number(r.version)));
  const applied = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    const already = m.present ? await m.present() : false;
    if (!already) {
      for (const step of m.sql) {
        if (typeof step === 'string') await query(step);
        else await query(step.sql, step.params);
      }
      applied.push(m.name);
      log(`[migrate] ${m.version} applied: ${m.name}`);
    }
    await query('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [m.version, m.name]);
  }
  return applied;
}

if (require.main === module) {
  require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
  require('dotenv').config();
  migrate()
    .then((applied) => {
      console.log(applied.length ? `[migrate] ${applied.length} migration(s) applied` : '[migrate] up to date');
      return require('./db').close();
    })
    .catch((err) => { console.error('[migrate] failed:', err.message); process.exit(1); });
}

module.exports = { migrate, MIGRATIONS, SERVICE_AREAS };
