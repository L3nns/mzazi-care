/**
 * API tests for the application layer.
 *
 * MySQL and the Python service are stubbed, so these tests cover what Express
 * itself is responsible for: routing, authentication, role-based access
 * control, input validation, and response shaping. Queries are matched by
 * pattern and answered with canned rows.
 *
 * Run:  npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.BCRYPT_ROUNDS = '4';          // keep the suite fast
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mzazi-uploads-'));

/* ----------------------------------------------------------- stub MySQL */
const dbPath = require.resolve('../config/db');
const calls = [];
let handlers = [];

// requireAdmin re-reads the role from the database on every admin request.
const ROLES = { 7: 'user', 241: 'admin', 242: 'admin' };
// Every authenticated request also checks the token's version (revocation).
const TOKEN_VERSIONS = {};
const baseHandlers = [
  [/SELECT role(, token_version)? FROM users WHERE user_id/, (params) =>
    (ROLES[params[0]]
      ? [{ role: ROLES[params[0]], token_version: TOKEN_VERSIONS[params[0]] || 0 }] : [])],
];

const db = {
  query: async (sql, params = []) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    for (const [pattern, rows] of [...handlers, ...baseHandlers]) {
      if (pattern.test(sql)) return typeof rows === 'function' ? rows(params) : rows;
    }
    return [];
  },
  one: async (sql, params = []) => {
    const rows = await db.query(sql, params);
    return rows.length ? rows[0] : null;
  },
  transaction: async (fn) => fn(db),
  getPool: () => ({}),
  close: async () => {},
};
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };

/* ------------------------------------------------------ stub ML service */
const mlPath = require.resolve('../services/mlClient');
const mlCalls = [];
// Per-test engine behaviour: `mlDown` makes every call fail; `mlAnswer`
// replaces the canned recommend response.
let mlDown = false;
let mlAnswer = null;
const ml = {
  health: async () => ({ status: 'ok', model_loaded: true }),
  modelCard: async () => ({ config: { k: 20, alpha: 0.4 } }),
  recommend: async (payload) => {
    mlCalls.push(['recommend', payload]);
    if (mlDown) throw Object.assign(new Error('connect ECONNREFUSED'), { status: 502 });
    if (mlAnswer) return mlAnswer(payload);
    return {
      strategy: payload.user_id ? 'hybrid' : 'content_only',
      alpha_used: payload.user_id ? 0.4 : 1.0,
      results: [{
        rank_position: 1, provider_id: 1, provider_name: 'Alpha Lactation',
        category_id: 12, category_name: 'Lactation Consultation',
        location: 'Westlands', content_score: 0.9,
        collaborative_score: 0.4, hybrid_score: 0.6,
      }],
    };
  },
  similar: async () => ({ results: [] }),
  reindex: async () => { mlCalls.push(['reindex']); return { status: 'ok' }; },
  retrain: async (by) => {
    mlCalls.push(['retrain', by]);
    return { status: 'ok', candidate: { id: 'v20261028-120000' }, promoted: false, reason: 'worse' };
  },
  models: async () => ({ production: 'v20261001-000000', history: [], versions: [] }),
  promote: async (id, by) => { mlCalls.push(['promote', id, by]); return { production: { id } }; },
  rollback: async (by) => { mlCalls.push(['rollback', by]); return { production: { id: 'v1' } }; },
  reindexQuietly: () => { mlCalls.push(['reindexQuietly']); },
};
require.cache[mlPath] = { id: mlPath, filename: mlPath, loaded: true, exports: ml };

const app = require('../server');
const { issueToken, hashPassword } = require('../middleware/auth');

const userToken = issueToken({ user_id: 7, role: 'user', full_name: 'Test Parent' });
const adminToken = issueToken({ user_id: 241, role: 'admin', full_name: 'Admin' });

function setHandlers(list) { handlers = list; }
test.beforeEach(() => {
  calls.length = 0; mlCalls.length = 0; handlers = [];
  mlDown = false; mlAnswer = null; delete process.env.SEARCH_MODE;
});
// The keyword-SQL tests below run with the engine switched off.
const keywordMode = () => { process.env.SEARCH_MODE = 'keyword'; };

/* ------------------------------------------------------------------ health */
test('health reports the API and the ML service', async () => {
  const res = await request(app).get('/api/health').expect(200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.ml.status, 'ok');
});

/* ------------------------------------------------------------------- auth */
test('registration rejects a weak password', async () => {
  const res = await request(app).post('/api/auth/register')
    .send({ full_name: 'A Parent', email: 'a@example.com', password: 'short' })
    .expect(422);
  assert.equal(res.body.error, 'validation failed');
  assert.ok(res.body.details.some((d) => d.field === 'password'));
});

test('registration refuses a duplicate email', async () => {
  setHandlers([[/SELECT user_id FROM users WHERE email/, [{ user_id: 1 }]]]);
  await request(app).post('/api/auth/register')
    .send({ full_name: 'A Parent', email: 'taken@example.com', password: 'longenough1' })
    .expect(409);
});

test('registration stores a hash, never the password', async () => {
  setHandlers([
    [/SELECT user_id FROM users WHERE email/, []],
    [/INSERT INTO users/, { insertId: 99 }],
  ]);
  const res = await request(app).post('/api/auth/register')
    .send({ full_name: 'New Parent', email: 'new@example.com', password: 'longenough1' })
    .expect(201);
  assert.ok(res.body.token, 'a session token is issued');
  const insert = calls.find((c) => /INSERT INTO users/.test(c.sql));
  assert.ok(!insert.params.includes('longenough1'), 'plaintext must not be stored');
  assert.match(insert.params[2], /^\$2[aby]\$/, 'bcrypt hash expected');
});

test('login is identical for an unknown email and a wrong password', async () => {
  setHandlers([[/FROM users WHERE email/, []]]);
  const unknown = await request(app).post('/api/auth/login')
    .send({ email: 'nobody@example.com', password: 'whatever1' }).expect(401);

  const hash = await hashPassword('correct-horse');
  setHandlers([[/FROM users WHERE email/, [{
    user_id: 7, full_name: 'P', email: 'p@example.com', password_hash: hash,
    location: 'Karen', role: 'user',
  }]]]);
  const wrong = await request(app).post('/api/auth/login')
    .send({ email: 'p@example.com', password: 'wrong-password' }).expect(401);

  assert.deepEqual(unknown.body, wrong.body, 'no account enumeration');
});

test('login succeeds with the right password and returns no hash', async () => {
  const hash = await hashPassword('correct-horse');
  setHandlers([[/FROM users WHERE email/, [{
    user_id: 7, full_name: 'P', email: 'p@example.com', password_hash: hash,
    location: 'Karen', role: 'user',
  }]]]);
  const res = await request(app).post('/api/auth/login')
    .send({ email: 'p@example.com', password: 'correct-horse' }).expect(200);
  assert.ok(res.body.token);
  assert.equal(res.body.user.password_hash, undefined);
});

test('/me requires a valid token', async () => {
  await request(app).get('/api/auth/me').expect(401);
  await request(app).get('/api/auth/me')
    .set('Authorization', 'Bearer not-a-real-token').expect(401);
});

/* ----------------------------------------------------------------- search */
test('search only ever asks for verified providers', async () => {
  setHandlers([
    [/COUNT\(\*\) AS total/, [{ total: 0 }]],
    [/FROM providers p JOIN categories/, []],
  ]);
  await request(app).get('/api/services?q=lactation').expect(200);
  const select = calls.find((c) => /FROM providers p JOIN categories/.test(c.sql));
  assert.match(select.sql, /verification_status = 'verified'/);
});

test('search binds user input instead of interpolating it', async () => {
  setHandlers([
    [/COUNT\(\*\) AS total/, [{ total: 0 }]],
    [/FROM providers p JOIN categories/, []],
  ]);
  const evil = "'; DROP TABLE providers; --";
  await request(app).get(`/api/services?q=${encodeURIComponent(evil)}`).expect(200);
  const select = calls.find((c) => /FROM providers p JOIN categories/.test(c.sql));
  assert.ok(!select.sql.includes('DROP TABLE'), 'input must not reach the SQL text');
  assert.ok(select.params.some((p) => String(p).includes('DROP TABLE')),
    'it should arrive as a bound parameter');
});

test('search rejects an out-of-range page size', async () => {
  await request(app).get('/api/services?per_page=500').expect(422);
});

test('a provider that is not verified is a 404', async () => {
  setHandlers([[/FROM providers p JOIN categories c[\s\S]*WHERE p.provider_id/, []]]);
  await request(app).get('/api/services/6').expect(404);
});

/* ----------------------------------------------------------- interactions */
test('recording an interaction requires authentication', async () => {
  await request(app).post('/api/interactions')
    .send({ provider_id: 1, interaction_type: 'view' }).expect(401);
});

test('a save is weighted 3.5 and mirrored into saved_services', async () => {
  setHandlers([
    [/FROM providers\s+WHERE provider_id/, [{ provider_id: 1 }]],
    [/INSERT INTO interactions/, { insertId: 5 }],
    [/INSERT INTO saved_services/, { insertId: 3 }],
  ]);
  const res = await request(app).post('/api/interactions')
    .set('Authorization', `Bearer ${userToken}`)
    .send({ provider_id: 1, interaction_type: 'save' }).expect(201);
  assert.equal(res.body.interaction_weight, 3.5);
  assert.ok(calls.some((c) => /INSERT INTO saved_services/.test(c.sql)));
});

test('rating again changes the parent\'s rating instead of adding one', async () => {
  setHandlers([
    [/FROM providers\s+WHERE provider_id/, [{ provider_id: 1 }]],
    // MySQL reports 2 affected rows when ON DUPLICATE KEY UPDATE changed a row.
    [/INSERT INTO interactions/, { insertId: 6, affectedRows: 2 }],
  ]);
  const res = await request(app).post('/api/interactions')
    .set('Authorization', `Bearer ${userToken}`)
    .send({ provider_id: 1, interaction_type: 'rating', rating_value: 2 })
    .expect(200);
  assert.equal(res.body.updated, true);
  const insert = calls.find((c) => /INSERT INTO interactions/.test(c.sql));
  assert.match(insert.sql, /ON DUPLICATE KEY UPDATE rating_value = VALUES\(rating_value\)/);
});

test('a repeat view on the same day is not counted again', async () => {
  setHandlers([
    [/FROM providers\s+WHERE provider_id/, [{ provider_id: 1 }]],
    [/INSERT INTO interactions/, { insertId: 0, affectedRows: 0 }],
  ]);
  const res = await request(app).post('/api/interactions')
    .set('Authorization', `Bearer ${userToken}`)
    .send({ provider_id: 1, interaction_type: 'view' }).expect(200);
  assert.equal(res.body.recorded, false);
  const insert = calls.find((c) => /INSERT INTO interactions/.test(c.sql));
  assert.match(insert.sql, /WHERE NOT EXISTS[\s\S]*interaction_type = 'view'[\s\S]*CURDATE\(\)/);
  assert.deepEqual(insert.params.slice(-2), [7, 1], 'checked for this parent and provider');
});

test('a rating scales the weight by the stars given', async () => {
  setHandlers([
    [/FROM providers\s+WHERE provider_id/, [{ provider_id: 1 }]],
    [/INSERT INTO interactions/, { insertId: 6 }],
  ]);
  const res = await request(app).post('/api/interactions')
    .set('Authorization', `Bearer ${userToken}`)
    .send({ provider_id: 1, interaction_type: 'rating', rating_value: 5 })
    .expect(201);
  assert.equal(res.body.interaction_weight, 5);      // 4.0 * 5/4
});

test('an unknown interaction type is rejected', async () => {
  await request(app).post('/api/interactions')
    .set('Authorization', `Bearer ${userToken}`)
    .send({ provider_id: 1, interaction_type: 'purchase' }).expect(422);
});

/* ----------------------------------------------------- account deletion */
const accountRow = async (extra = {}) => [{
  password_hash: await hashPassword('correct-horse'), role: 'user', mfa_enabled: 0, ...extra,
}];
const deleteMe = (body) => request(app).delete('/api/auth/me')
  .set('Authorization', `Bearer ${userToken}`).send(body);

test('a parent deletes their own account with their password', async () => {
  const row = await accountRow();
  setHandlers([[/SELECT password_hash, role, mfa_enabled FROM users/, row]]);
  await request(app).delete('/api/auth/me').send({ password: 'correct-horse' }).expect(401);
  await deleteMe({ password: 'wrong-password' }).expect(401);
  assert.ok(!calls.some((c) => /DELETE FROM users/.test(c.sql)), 'nothing deleted on a wrong password');
  await deleteMe({ password: 'correct-horse' }).expect(200);
  const del = calls.find((c) => /DELETE FROM users WHERE user_id = \?/.test(c.sql));
  assert.deepEqual(del.params, [7]);
  assert.ok(mlCalls.some(([k]) => k === 'reindexQuietly'), 'the live model forgets them');
});

test('deleting an account needs the current code when two-step sign-in is on', async () => {
  const row = await accountRow({ mfa_enabled: 1, mfa_secret: null });
  setHandlers([[/SELECT password_hash, role, mfa_enabled FROM users/, row]]);
  const res = await deleteMe({ password: 'correct-horse' }).expect(401);
  assert.match(res.body.error, /code/);
  assert.ok(!calls.some((c) => /DELETE FROM users/.test(c.sql)));
});

test('an administrator cannot delete their own account while an administrator', async () => {
  const row = await accountRow({ role: 'admin' });
  setHandlers([[/SELECT password_hash, role, mfa_enabled FROM users/, row]]);
  await request(app).delete('/api/auth/me').set('Authorization', `Bearer ${adminToken}`)
    .send({ password: 'correct-horse' }).expect(409);
  assert.ok(!calls.some((c) => /DELETE FROM users/.test(c.sql)));
});

test('an administrator deletes a parent\'s account, audited; never an administrator\'s', async () => {
  setHandlers([
    [/SELECT user_id, role FROM users WHERE user_id = \?/, (p) => (p[0] === 7 ? [{ user_id: 7, role: 'user' }]
      : p[0] === 242 ? [{ user_id: 242, role: 'admin' }] : [])],
    [/INSERT INTO admin_logs/, { insertId: 1 }],
  ]);
  const auth = ['Authorization', `Bearer ${adminToken}`];
  await request(app).delete('/api/admin/users/242').set(...auth).send({}).expect(409);
  await request(app).delete('/api/admin/users/999').set(...auth).send({}).expect(404);
  await request(app).delete('/api/admin/users/7').set('Authorization', `Bearer ${userToken}`).send({}).expect(403);
  await request(app).delete('/api/admin/users/7').set(...auth).send({ reason: 'asked by phone' }).expect(200);
  const del = calls.filter((c) => /DELETE FROM users/.test(c.sql));
  assert.equal(del.length, 1);
  assert.deepEqual(del[0].params, [7]);
  const audit = calls.find((c) => /INSERT INTO admin_logs/.test(c.sql));
  assert.deepEqual(audit.params.slice(0, 5), [241, 'user:delete', 'users', 7, 'asked by phone']);
});

/* --------------------------------------------------------- data retention */
test('retention deletes each kind of data after its own period', async () => {
  const retention = require('../services/retention');
  const saved = { ...process.env };
  try {
    delete process.env.SEARCH_RETENTION_DAYS; delete process.env.INTERACTION_RETENTION_DAYS;
    process.env.FEEDBACK_RETENTION_DAYS = '30';      // below the 180-day hide period
    process.env.FEEDBACK_HIDE_DAYS = '180';
    process.env.RECOMMENDATION_LOG_RETENTION_DAYS = '0';   // keep
    setHandlers([[/DELETE FROM interactions/, { affectedRows: 3 }], [/DELETE FROM/, { affectedRows: 0 }]]);
    const out = await retention.runRetention({ log: () => {} });
    const by = Object.fromEntries(out.map((r) => [r.table, r]));
    assert.equal(by.search_history.days, 365);
    assert.equal(by.interactions.days, 730);
    assert.equal(by.interactions.deleted, 3);
    assert.equal(by.recommendation_feedback.days, 180, 'never shorter than the hide period');
    assert.equal(by.recommendations.days, 0);
    const deletes = calls.filter((c) => /^DELETE FROM/.test(c.sql));
    assert.ok(!deletes.some((c) => /FROM recommendations /.test(c.sql)), '0 keeps the data');
    const search = deletes.find((c) => /FROM search_history/.test(c.sql));
    assert.match(search.sql, /searched_at < DATE_SUB\(NOW\(\), INTERVAL \? DAY\) LIMIT 5000/);
    assert.deepEqual(search.params, [365]);
    assert.ok(mlCalls.some(([k]) => k === 'reindexQuietly'), 'the model is refitted after interactions go');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('a large purge runs in batches until nothing is left', async () => {
  const retention = require('../services/retention');
  let left = 12000;
  setHandlers([[/DELETE FROM search_history/, () => {
    const n = Math.min(5000, left); left -= n; return { affectedRows: n };
  }], [/DELETE FROM/, { affectedRows: 0 }]]);
  const out = await retention.runRetention({ log: () => {} });
  assert.equal(out.find((r) => r.table === 'search_history').deleted, 12000);
  assert.equal(calls.filter((c) => /DELETE FROM search_history/.test(c.sql)).length, 3);
});

/* -------------------------------------------------------- recommendations */
test('recommendations reach the ML service and are hydrated from MySQL', async () => {
  setHandlers([[/FROM providers p WHERE p.provider_id IN/, [
    { provider_id: 1, service_tags: 'lactation', service_description: 'desc',
      location: 'Westlands', qualifications: 'IBCLC' },
  ]]]);
  const res = await request(app).get('/api/recommendations?top_n=5')
    .set('Authorization', `Bearer ${userToken}`).expect(200);
  assert.equal(res.body.strategy, 'hybrid');
  assert.equal(res.body.results[0].qualifications, 'IBCLC');
  assert.equal(mlCalls[0][1].user_id, 7);
});

test('a listing that lost verification is dropped even if the engine still ranks it', async () => {
  // The engine's index lags a suspension until the next re-index; MySQL does not.
  setHandlers([[/FROM providers p WHERE p.provider_id IN/, []]]);
  const res = await request(app).get('/api/recommendations?top_n=5')
    .set('Authorization', `Bearer ${userToken}`).expect(200);
  assert.deepEqual(res.body.results, []);
  const sel = calls.find((c) => /FROM providers p WHERE p.provider_id IN/.test(c.sql));
  assert.match(sel.sql, /verification_status = 'verified'/);
});

test('an anonymous visitor still gets recommendations', async () => {
  setHandlers([[/FROM providers p WHERE p.provider_id IN/, []]]);
  const res = await request(app).get('/api/recommendations?query=daycare').expect(200);
  assert.equal(res.body.strategy, 'content_only');
});

/* ------------------------------------------------------------------ admin */
test('admin routes reject anonymous and non-admin callers', async () => {
  await request(app).get('/api/admin/stats').expect(401);
  await request(app).get('/api/admin/stats')
    .set('Authorization', `Bearer ${userToken}`).expect(403);
});

test('an administrator can read the dashboard', async () => {
  setHandlers([[/total_providers/, [{
    total_providers: 120, verified: 106, pending: 9, rejected: 5,
    users: 240, interactions: 4667, searches_this_week: 12,
  }]]]);
  const res = await request(app).get('/api/admin/stats')
    .set('Authorization', `Bearer ${adminToken}`).expect(200);
  assert.equal(res.body.verified, 106);
  assert.equal(res.body.model.config.k, 20);
});

test('a new listing is created pending, never verified', async () => {
  setHandlers([
    [/SELECT c.category_id FROM categories c WHERE c.category_id/, [{ category_id: 12 }]],
    [/INSERT INTO providers/, { insertId: 200 }],
    [/SELECT area_id FROM service_areas WHERE area_name = \?/, [{ area_id: 5 }]],
  ]);
  const res = await request(app).post('/api/admin/providers')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      provider_name: 'New Clinic', category_id: 12, location: 'Karen',
      service_description: 'A description long enough to pass validation rules.',
      area_ids: [9, 5],
    })
    .expect(201);
  assert.equal(res.body.verification_status, 'pending');
  const insert = calls.find((c) => /INSERT INTO providers/.test(c.sql));
  assert.match(insert.sql, /'pending'/);
  // The primary location is always served; duplicates collapse.
  const served = calls.filter((c) => /INSERT INTO provider_service_areas/.test(c.sql)).map((c) => c.params);
  assert.deepEqual(served, [[200, 5], [200, 9]]);
});

test('creating a listing under an unknown category is rejected', async () => {
  setHandlers([[/SELECT c.category_id FROM categories c WHERE c.category_id/, []]]);
  await request(app).post('/api/admin/providers')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      provider_name: 'New Clinic', category_id: 999, location: 'Karen',
      service_description: 'A description long enough to pass validation rules.',
    })
    .expect(422);
});

// A pending lactation listing (category 12 needs identity + qualification).
const verifyHandlers = (status = 'pending', docs = []) => [
  [/SELECT provider_id, category_id, verification_status FROM providers\s+WHERE provider_id = \? FOR UPDATE/,
    [{ provider_id: 8, category_id: 12, verification_status: status }]],
  [/SELECT category_id, parent_category_id, required_documents FROM categories/,
    [{ category_id: 2, parent_category_id: null, required_documents: null },
      { category_id: 12, parent_category_id: 2, required_documents: 'identity,qualification' }]],
  [/SELECT document_type, expires_on, review_status FROM provider_media/, docs],
  [/INSERT INTO provider_verification_events/, { insertId: 1 }],
  [/UPDATE providers SET verification_status/, { affectedRows: 1 }],
  [/INSERT INTO admin_logs/, { insertId: 1 }],
];
const ACCEPTED_DOCS = [
  { document_type: 'identity', expires_on: null, review_status: 'accepted' },
  { document_type: 'qualification', expires_on: '2099-01-01', review_status: 'accepted' },
];

test('verifying a listing logs the action and triggers a re-index', async () => {
  setHandlers(verifyHandlers('pending', ACCEPTED_DOCS));
  const res = await request(app).put('/api/admin/providers/8/verify')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ verification_status: 'verified' }).expect(200);

  // A decision on a pending listing records the review step too.
  assert.deepEqual(res.body.steps, ['under_review', 'verified']);
  const events = calls.filter((c) => /INSERT INTO provider_verification_events/.test(c.sql));
  assert.deepEqual(events.map((e) => [e.params[1], e.params[2]]),
    [['pending', 'under_review'], ['under_review', 'verified']]);
  const log = calls.find((c) => /INSERT INTO admin_logs/.test(c.sql));
  assert.equal(log.params[1], 'verify:verified');
  assert.ok(mlCalls.some(([name]) => name === 'reindexQuietly'),
    'a newly verified listing must be re-encoded or it stays invisible');
});

test('a listing cannot be verified without current accepted documents', async () => {
  const expired = [
    { document_type: 'identity', expires_on: null, review_status: 'accepted' },
    { document_type: 'qualification', expires_on: '2020-01-01', review_status: 'accepted' },
  ];
  setHandlers(verifyHandlers('pending', expired));
  const res = await request(app).put('/api/admin/providers/8/verify')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ verification_status: 'verified' }).expect(422);
  assert.deepEqual(res.body.missing_documents, ['qualification']);
  assert.ok(!calls.some((c) => /UPDATE providers SET verification_status/.test(c.sql)));
});

test('the backend refuses moves the workflow does not allow', async () => {
  setHandlers(verifyHandlers('verified'));
  const res = await request(app).put('/api/admin/providers/8/verify')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ verification_status: 'pending' }).expect(409);
  assert.deepEqual(res.body.allowed, ['suspended', 'expired']);
  assert.ok(!calls.some((c) => /UPDATE providers SET verification_status/.test(c.sql)));
});

test('suspending a verified listing needs a reason and removes it from search', async () => {
  setHandlers(verifyHandlers('verified'));
  await request(app).put('/api/admin/providers/8/verify')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ verification_status: 'suspended' }).expect(422);
  await request(app).put('/api/admin/providers/8/verify')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ verification_status: 'suspended', note: 'Complaint under investigation' }).expect(200);
  const ev = calls.find((c) => /INSERT INTO provider_verification_events/.test(c.sql));
  assert.deepEqual(ev.params.slice(1, 4), ['verified', 'suspended', 'Complaint under investigation']);
  assert.ok(mlCalls.some(([name]) => name === 'reindexQuietly'));
});

test('an invalid verification status is rejected', async () => {
  await request(app).put('/api/admin/providers/8/verify')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ verification_status: 'approved' }).expect(422);
});

/* ------------------------------------------------------------------ misc */
test('unknown API routes return a JSON 404', async () => {
  const res = await request(app).get('/api/does-not-exist').expect(404);
  assert.equal(res.body.error, 'not found');
});

/* ------------------------------------------------- RBAC re-reads the role */
test('a demoted administrator loses access even with an admin token', async () => {
  const stale = issueToken({ user_id: 7, role: 'admin', full_name: 'Was Admin' });
  await request(app).get('/api/admin/stats')
    .set('Authorization', `Bearer ${stale}`).expect(403);
});

/* -------------------------------------------- Table 4.4 alternative flow */
test('rejecting a listing requires a reason, which is written to the log', async () => {
  setHandlers(verifyHandlers('pending'));
  await request(app).put('/api/admin/providers/8/verify')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ verification_status: 'rejected' }).expect(422);
  await request(app).put('/api/admin/providers/8/verify')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ verification_status: 'rejected', note: 'Licence certificate missing' }).expect(200);
  const log = calls.find((c) => /INSERT INTO admin_logs/.test(c.sql));
  assert.equal(log.params[1], 'verify:rejected');
  assert.equal(log.params[4], 'Licence certificate missing');
  assert.ok(!mlCalls.some(([n]) => n === 'reindexQuietly'),
    'rejecting a pending listing does not change the searchable catalogue');
});

test('failed sign-ins to an administrator account are logged (Figure 4.6)', async () => {
  const hash = await hashPassword('right-password');
  setHandlers([
    [/FROM users WHERE email/, [{
      user_id: 241, full_name: 'Admin', email: 'admin1@mzazicare.example',
      password_hash: hash, location: null, role: 'admin',
    }]],
    [/INSERT INTO admin_logs/, { insertId: 1 }],
  ]);
  await request(app).post('/api/auth/login')
    .send({ email: 'admin1@mzazicare.example', password: 'wrong-password' }).expect(401);
  const log = calls.find((c) => /INSERT INTO admin_logs/.test(c.sql));
  assert.equal(log.params[1], 'auth:login_failed');
});

/* -------------------------------------------------------- user management */
test('an administrator cannot change their own role', async () => {
  await request(app).put('/api/admin/users/241/role')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ role: 'user' }).expect(422);
});

test('the last administrator cannot be demoted', async () => {
  setHandlers([
    [/SELECT user_id, role FROM users WHERE user_id/, [{ user_id: 242, role: 'admin' }]],
    [/UPDATE users SET role/, { affectedRows: 1 }],
    [/COUNT\(\*\) AS admins/, [{ admins: 0 }]],
  ]);
  const res = await request(app).put('/api/admin/users/242/role')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ role: 'user' }).expect(422);
  assert.match(res.body.error, /at least one administrator/);
});

test('promoting a parent to administrator is logged', async () => {
  setHandlers([
    [/SELECT user_id, role FROM users WHERE user_id/, [{ user_id: 7, role: 'user' }]],
    [/UPDATE users SET role/, { affectedRows: 1 }],
    [/COUNT\(\*\) AS admins/, [{ admins: 3 }]],
    [/INSERT INTO admin_logs/, { insertId: 1 }],
  ]);
  await request(app).put('/api/admin/users/7/role')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ role: 'admin' }).expect(200);
  assert.equal(calls.find((c) => /INSERT INTO admin_logs/.test(c.sql)).params[1], 'role:admin');
});

/* --------------------------------------------------------------- account */
test('changing the password checks the current one first', async () => {
  const hash = await hashPassword('old-password');
  setHandlers([
    [/SELECT password_hash FROM users WHERE user_id/, [{ password_hash: hash }]],
    [/UPDATE users SET password_hash/, { affectedRows: 1 }],
    [/SELECT user_id, full_name, email, location, role, token_version FROM users/,
      [{ user_id: 7, full_name: 'Test Parent', email: 'p@example.com', location: null,
        role: 'user', token_version: 1 }]],
  ]);
  await request(app).put('/api/auth/me/password')
    .set('Authorization', `Bearer ${userToken}`)
    .send({ current_password: 'not-it-at-all', new_password: 'brand-new-pass' }).expect(403);
  await request(app).put('/api/auth/me/password')
    .set('Authorization', `Bearer ${userToken}`)
    .send({ current_password: 'old-password', new_password: 'brand-new-pass' }).expect(200);
  const update = calls.find((c) => /UPDATE users SET password_hash/.test(c.sql));
  assert.match(update.params[0], /^\$2[aby]\$/);
  assert.match(update.sql, /token_version = token_version \+ 1/);
});

test('changing the password revokes old sessions and returns a fresh token', async () => {
  const hash = await hashPassword('old-password');
  setHandlers([
    [/SELECT password_hash FROM users WHERE user_id/, [{ password_hash: hash }]],
    [/UPDATE users SET password_hash/, { affectedRows: 1 }],
    [/SELECT user_id, full_name, email, location, role, token_version FROM users/,
      [{ user_id: 7, full_name: 'Test Parent', email: 'p@example.com', location: null,
        role: 'user', token_version: 1 }]],
  ]);
  const res = await request(app).put('/api/auth/me/password')
    .set('Authorization', `Bearer ${userToken}`)
    .send({ current_password: 'old-password', new_password: 'brand-new-pass' }).expect(200);
  assert.ok(res.body.token);
  assert.equal(res.body.user.token_version, undefined);
  TOKEN_VERSIONS[7] = 1;              // what the UPDATE did in the database
  try {
    setHandlers([]);
    await request(app).get('/api/saved').set('Authorization', `Bearer ${userToken}`).expect(401);
    await request(app).get('/api/saved').set('Authorization', `Bearer ${res.body.token}`).expect(200);
  } finally { delete TOKEN_VERSIONS[7]; }
});

test('signing out everywhere bumps the token version', async () => {
  setHandlers([[/UPDATE users SET token_version/, { affectedRows: 1 }]]);
  await request(app).post('/api/auth/logout-all')
    .set('Authorization', `Bearer ${userToken}`).expect(200);
  const upd = calls.find((c) => /UPDATE users SET token_version = token_version \+ 1/.test(c.sql));
  assert.deepEqual(upd.params, [7]);
  await request(app).post('/api/auth/logout-all').expect(401);
});

test('a revoked token is not honoured even on public routes', async () => {
  TOKEN_VERSIONS[7] = 5;
  try {
    setHandlers([]);
    await request(app).get('/api/recommendations').set('Authorization', `Bearer ${userToken}`).expect(200);
    const rec = mlCalls.filter(([k]) => k === 'recommend').pop();
    assert.equal(rec[1].user_id, null);   // treated as an anonymous visitor
  } finally { delete TOKEN_VERSIONS[7]; }
});

test('preferences naming an unknown category are rejected', async () => {
  setHandlers([[/SELECT category_id FROM categories WHERE category_id IN/, [{ category_id: 12 }]]]);
  await request(app).put('/api/auth/me/preferences')
    .set('Authorization', `Bearer ${userToken}`)
    .send({ category_ids: [12, 999] }).expect(422);
});

/* ----------------------------------------------------- keyword search SQL */
test('search ANDs prefix terms, drops filler words and knows spelling variants', async () => {
  keywordMode();
  setHandlers([
    [/COUNT\(\*\) AS total/, [{ total: 1 }]],
    [/FROM providers p JOIN categories/, []],
  ]);
  await request(app).get('/api/services?q=looking%20for%20day-care%20near%20me').expect(200);
  const count = calls.find((c) => /COUNT\(\*\) AS total/.test(c.sql));
  assert.ok(count.params.includes('+daycare*'), 'variant collapsed and prefix-matched');
  assert.ok(count.params.includes('"day care"'), 'spaced spelling matched as a phrase');
  assert.ok(!count.params.some((p) => /^\+(looking|near|for|me)\*$/.test(p)),
    'filler words are not required terms');
});

/* ------------------------------------------------------- location search */
const AREA_ROWS = [
  { area_id: 9, area_name: 'Kilimani', latitude: -1.2921, longitude: 36.7856 },
  { area_id: 13, area_name: 'Parklands', latitude: -1.2610, longitude: 36.8180 },
  { area_id: 20, area_name: 'Westlands', latitude: -1.2675, longitude: 36.8108 },
];
const freshAreas = () => require('../services/areas').invalidate();

test('a place named in the query becomes the area filter, and the page is told', async () => {
  freshAreas();
  keywordMode();
  setHandlers([
    [/FROM service_areas\s+WHERE is_active = 1/, AREA_ROWS],
    [/COUNT\(\*\) AS total/, [{ total: 1 }]],
    [/FROM providers p JOIN categories/, [{ provider_id: 5, provider_name: 'Kilimani Midwives' }]],
    [/FROM provider_service_areas psa\s+JOIN service_areas a/, [{ provider_id: 5, area_name: 'Kilimani' }]],
  ]);
  const res = await request(app).get('/api/services?q=a%20midwife%20near%20Kilimani')
    .set('Authorization', `Bearer ${userToken}`).expect(200);
  assert.deepEqual(res.body.understood,
    { location: 'Kilimani', from_query: true, original_query: 'a midwife near Kilimani', query: 'a midwife' });
  const count = calls.find((c) => /COUNT\(\*\) AS total/.test(c.sql));
  assert.ok(count.params.includes('Kilimani'), 'area filter applied');
  assert.ok(count.params.includes('+midwife*'), 'the rest of the query still searched');
  assert.ok(!count.params.includes('+kilimani*'), 'the place is not a required keyword');
  assert.equal(res.body.results[0].serves_origin, true);
  const logged = calls.find((c) => /INSERT INTO search_history/.test(c.sql));
  assert.equal(logged.params[1], 'a midwife near Kilimani', 'the history keeps what was typed');
});

test('within_km widens an area to its neighbours and reports distances', async () => {
  freshAreas();
  setHandlers([
    [/FROM service_areas\s+WHERE is_active = 1/, AREA_ROWS],
    [/COUNT\(\*\) AS total/, [{ total: 2 }]],
    [/FROM providers p JOIN categories/, [
      { provider_id: 1, provider_name: 'B' }, { provider_id: 2, provider_name: 'A' }]],
    [/FROM provider_service_areas psa\s+JOIN service_areas a/, [
      { provider_id: 1, area_name: 'Westlands' }, { provider_id: 2, area_name: 'Parklands' }]],
  ]);
  const res = await request(app).get('/api/services?location=Westlands&within_km=3&sort=distance').expect(200);
  assert.deepEqual(res.body.area.searched.sort(), ['Parklands', 'Westlands']);
  assert.deepEqual(res.body.results.map((r) => r.provider_id), [1, 2], 'nearest first');
  assert.equal(res.body.results[0].distance_km, 0);
  assert.ok(res.body.results[1].distance_km > 0 && res.body.results[1].distance_km < 3);
});

test('an empty area search offers the same search in nearby areas, nearest first', async () => {
  freshAreas();
  keywordMode();
  setHandlers([
    [/FROM service_areas\s+WHERE is_active = 1/, AREA_ROWS],
    [/COUNT\(\*\) AS total/, [{ total: 0 }]],
    // The main query (LIMIT ? OFFSET ?) finds nothing; the nearby query does.
    [/LIMIT \? OFFSET \?/, []],
    [/ORDER BY relevance DESC, p.provider_name ASC LIMIT 30/, [
      { provider_id: 2, provider_name: 'Parklands Midwives' }, { provider_id: 1, provider_name: 'Westlands Midwives' }]],
    [/FROM provider_service_areas psa\s+JOIN service_areas a/, [
      { provider_id: 1, area_name: 'Westlands' }, { provider_id: 2, area_name: 'Parklands' }]],
  ]);
  const res = await request(app).get('/api/services?q=midwife&location=Kilimani').expect(200);
  assert.equal(res.body.suggestion_basis, 'nearby');
  assert.equal(res.body.suggestion_origin, 'Kilimani');
  const ds = res.body.suggestions.map((r) => r.distance_km);
  assert.ok(ds[0] <= ds[1], `nearest first: ${ds}`);
  const near = calls.find((c) => /LIMIT 30/.test(c.sql));
  assert.ok(near.params.includes('Westlands') && !near.params.includes('Kilimani'));
  assert.ok(near.params.includes('+midwife*'), 'same search terms');
});

/* ------------------------------------------------ recommendation feedback */
test('recommendations rank by the parent\'s area and hide what they turned down', async () => {
  freshAreas();
  setHandlers([
    [/FROM service_areas\s+WHERE is_active = 1/, AREA_ROWS],
    [/SELECT location FROM users WHERE user_id/, [{ location: 'Westlands' }]],
    [/FROM recommendation_feedback/, [{ provider_id: 44 }]],
    [/FROM providers p WHERE p.provider_id IN/, []],
  ]);
  await request(app).get('/api/recommendations').set('Authorization', `Bearer ${userToken}`).expect(200);
  const payload = mlCalls.filter(([k]) => k === 'recommend').pop()[1];
  assert.equal(payload.area, 'Westlands');
  assert.equal(payload.location, null, 'the home area ranks; it does not filter');
  assert.deepEqual(payload.exclude_ids, [44]);

  await request(app).get('/api/recommendations?use_home_area=false')
    .set('Authorization', `Bearer ${userToken}`).expect(200);
  assert.equal(mlCalls.filter(([k]) => k === 'recommend').pop()[1].area, null);
});

test('feedback is validated, stored, and negative feedback hides the provider', async () => {
  setHandlers([
    [/SELECT provider_id FROM providers WHERE provider_id = \? AND verification_status = 'verified'/,
      (p) => (p[0] === 3 ? [{ provider_id: 3 }] : [])],
    [/INSERT INTO recommendation_feedback/, { insertId: 1 }],
  ]);
  const auth = ['Authorization', `Bearer ${userToken}`];
  await request(app).post('/api/recommendations/feedback').send({ provider_id: 3, feedback: 'too_far' }).expect(401);
  await request(app).post('/api/recommendations/feedback').set(...auth)
    .send({ provider_id: 3, feedback: 'unsafe' }).expect(422);
  await request(app).post('/api/recommendations/feedback').set(...auth)
    .send({ provider_id: 99, feedback: 'too_far' }).expect(404);
  const res = await request(app).post('/api/recommendations/feedback').set(...auth)
    .send({ provider_id: 3, feedback: 'too_far' }).expect(201);
  assert.equal(res.body.hidden, true);
  const ins = calls.find((c) => /INSERT INTO recommendation_feedback/.test(c.sql));
  assert.deepEqual(ins.params, [7, 3, 'too_far']);
});

/* --------------------------------------------------------- model versions */
test('promoting and rolling back a model version are logged', async () => {
  setHandlers([[/INSERT INTO admin_logs/, { insertId: 1 }]]);
  await request(app).post('/api/admin/model/versions/v20261001-000000/promote')
    .set('Authorization', `Bearer ${adminToken}`).expect(200);
  await request(app).post('/api/admin/model/versions/not-a-version/promote')
    .set('Authorization', `Bearer ${adminToken}`).expect(422);
  await request(app).post('/api/admin/model/rollback')
    .set('Authorization', `Bearer ${adminToken}`).expect(200);
  const acts = calls.filter((c) => /INSERT INTO admin_logs/.test(c.sql)).map((c) => c.params[1]);
  assert.deepEqual(acts, ['model:promote', 'model:rollback']);
  assert.deepEqual(mlCalls.find(([k]) => k === 'promote'), ['promote', 'v20261001-000000', 'admin #241']);
});

test('a service type filters the whole category subtree', async () => {
  setHandlers([
    [/COUNT\(\*\) AS total/, [{ total: 1 }]],
    [/FROM providers p JOIN categories/, []],
  ]);
  await request(app).get('/api/services?type=2').expect(200);
  const count = calls.find((c) => /COUNT\(\*\) AS total/.test(c.sql));
  assert.match(count.sql, /parent_category_id = \?/);
});

test('an empty result set comes with broader suggestions (Figure 4.5)', async () => {
  setHandlers([
    [/COUNT\(\*\) AS total/, [{ total: 0 }]],
    [/FROM providers p WHERE p.provider_id IN/, [{ provider_id: 1, service_tags: 'lactation' }]],
  ]);
  const res = await request(app).get('/api/services?q=someone%20to%20help%20me%20breastfeed')
    .expect(200);
  assert.equal(res.body.total, 0);
  assert.equal(res.body.suggestions.length, 1);
  assert.equal(res.body.suggestion_basis, 'closest');
  const suggest = mlCalls.filter(([k]) => k === 'recommend').pop()[1];
  assert.equal(suggest.query, 'someone to help me breastfeed');
  assert.equal(suggest.location, null, 'suggestions drop the location filter');
});

/* ---------------------------------------------------- search by meaning */
const engineHits = (...list) => () => ({
  strategy: 'content_only',
  results: list.map(([id, basis = 'match']) => ({ provider_id: id, basis })),
});

test('free text is matched by the engine, in its order, matches only', async () => {
  mlAnswer = engineHits([4], [1], [9, 'related_highly_rated']);
  setHandlers([
    [/COUNT\(\*\) AS total/, [{ total: 2 }]],
    [/FROM providers p JOIN categories/, [{ provider_id: 4 }, { provider_id: 1 }]],
  ]);
  const res = await request(app).get('/api/services?q=someone%20to%20help%20me%20breastfeed')
    .set('Authorization', `Bearer ${userToken}`).expect(200);
  assert.equal(res.body.search_mode, 'semantic');
  const payload = mlCalls[0][1];
  assert.equal(payload.user_id, null, 'search is the same for everyone, not personalised');
  assert.equal(payload.related, false);
  assert.equal(payload.top_n, 200);
  const count = calls.find((c) => /COUNT\(\*\) AS total/.test(c.sql));
  assert.match(count.sql, /p.provider_id IN \(\?,\?\) OR p.provider_name LIKE \?/);
  assert.deepEqual(count.params.slice(0, 3), [4, 1, '%someone to help me breastfeed%']);
  assert.match(count.sql, /verification_status = 'verified'/);
  const page = calls.find((c) => /LIMIT \? OFFSET \?/.test(c.sql));
  assert.deepEqual(page.params.slice(0, 4), [4, 2, 1, 1], 'engine order becomes relevance');
});

test('a weak best match is labelled, not hidden', async () => {
  setHandlers([
    [/COUNT\(\*\) AS total/, [{ total: 1 }]],
    [/FROM providers p JOIN categories/, [{ provider_id: 4 }]],
  ]);
  mlAnswer = () => ({ ...engineHits(...[4, 1, 9, 2, 8, 3, 5, 6].map((id) => [id]))(), query_similarity: 0.31 });
  const weak = await request(app).get('/api/services?q=fundi%20wa%20magari').expect(200);
  assert.equal(weak.body.match_quality, 'weak');
  assert.equal(weak.body.results.length, 1, 'the closest services are still shown');
  const count = calls.find((c) => /COUNT\(\*\) AS total/.test(c.sql));
  assert.deepEqual(count.params.slice(0, 6), [4, 1, 9, 2, 8, '%fundi wa magari%'],
    'only the five closest are candidates');
  mlAnswer = () => ({ ...engineHits([4])(), query_similarity: 0.72 });
  const good = await request(app).get('/api/services?q=doula').expect(200);
  assert.equal(good.body.match_quality, 'good');
});

test('when the engine is unreachable, search falls back to keyword SQL', async () => {
  mlDown = true;
  setHandlers([
    [/COUNT\(\*\) AS total/, [{ total: 1 }]],
    [/FROM providers p JOIN categories/, [{ provider_id: 1 }]],
  ]);
  const res = await request(app).get('/api/services?q=lactation').expect(200);
  assert.equal(res.body.search_mode, 'keyword');
  const count = calls.find((c) => /COUNT\(\*\) AS total/.test(c.sql));
  assert.ok(count.params.includes('+lactation*'));
});

test('text the engine cannot match leaves only literal name matches', async () => {
  mlAnswer = () => ({ strategy: 'popularity_fallback', results: [{ provider_id: 3, basis: 'popular' }] });
  setHandlers([[/COUNT\(\*\) AS total/, [{ total: 0 }]]]);
  await request(app).get('/api/services?q=car%20mechanic').expect(200);
  const count = calls.find((c) => /COUNT\(\*\) AS total/.test(c.sql));
  assert.match(count.sql, /p.provider_name LIKE \?/);
  assert.doesNotMatch(count.sql, /provider_id IN/, 'popular services are not search results');
});

test('every request gets an id, echoed back to the caller', async () => {
  setHandlers([[/COUNT\(\*\) AS total/, [{ total: 0 }]]]);
  const res = await request(app).get('/api/services?q=doula').set('X-Request-Id', 'trace-123').expect(200);
  assert.equal(res.headers['x-request-id'], 'trace-123');
  assert.ok(mlCalls.length > 0, 'the engine was called within the request');
  const fresh = await request(app).get('/api/health').set('X-Request-Id', 'bad id with spaces').expect(200);
  assert.match(fresh.headers['x-request-id'], /^[0-9a-f-]{36}$/, 'an unsafe id is replaced');
});

test('request logs carry the id and never the search text', async () => {
  setHandlers([[/COUNT\(\*\) AS total/, [{ total: 0 }]]]);
  const logger = require('../services/logger');
  const lines = [];
  logger.configure({ level: 'info', format: 'json', sink: (line) => lines.push(JSON.parse(line)) });
  try {
    await request(app).get('/api/services?q=my%20private%20worry').set('X-Request-Id', 'trace-9').expect(200);
  } finally { logger.configure(); }
  const line = lines.find((l) => l.msg === 'request');
  assert.equal(line.request_id, 'trace-9');
  assert.equal(line.path, '/api/services');
  assert.equal(line.status, 200);
  assert.ok(!JSON.stringify(lines).includes('private worry'), 'query text must not be logged');
});

/* --------------------------------------------------------- evidence files */
test('evidence uploads are type-checked by content, not by name', async () => {
  setHandlers([
    [/SELECT provider_id FROM providers WHERE provider_id/, [{ provider_id: 8 }]],
    [/COALESCE\(MAX\(version\), 0\) \+ 1 AS v/, [{ v: 2 }]],
    [/INSERT INTO provider_media/, { insertId: 4 }],
    [/INSERT INTO admin_logs/, { insertId: 1 }],
  ]);
  const url = '/api/admin/providers/8/media?kind=evidence&document_type=qualification&expires_on=2027-06-30';
  await request(app).post(url)
    .set('Authorization', `Bearer ${adminToken}`)
    .set('Content-Type', 'application/pdf')
    .send(Buffer.from('<script>alert(1)</script>')).expect(415);

  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(32)]);
  const res = await request(app).post(url)
    .set('Authorization', `Bearer ${adminToken}`)
    .set('Content-Type', 'application/pdf')
    .send(pdf).expect(201);
  assert.match(res.body.file_path, /^p8-evidence-[0-9a-f]{16}\.pdf$/);
  assert.ok(fs.existsSync(path.join(process.env.UPLOAD_DIR, res.body.file_path)));
  // Second qualification on file -> version 2, waiting for review.
  const ins = calls.find((c) => /INSERT INTO provider_media/.test(c.sql));
  assert.deepEqual(ins.params.slice(2), ['evidence', 'qualification', 2, '2027-06-30', 'pending']);
});

test('evidence must say what kind of document it is', async () => {
  setHandlers([[/SELECT provider_id FROM providers WHERE provider_id/, [{ provider_id: 8 }]]]);
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(32)]);
  await request(app).post('/api/admin/providers/8/media?kind=evidence')
    .set('Authorization', `Bearer ${adminToken}`)
    .set('Content-Type', 'application/pdf').send(pdf).expect(422);
  await request(app).post('/api/admin/providers/8/media?kind=evidence&document_type=diploma')
    .set('Authorization', `Bearer ${adminToken}`)
    .set('Content-Type', 'application/pdf').send(pdf).expect(422);
});

test('rejecting a document needs a reason and records the reviewer', async () => {
  setHandlers([
    [/SELECT media_id, provider_id, media_type, document_type, version FROM provider_media/,
      [{ media_id: 4, provider_id: 8, media_type: 'evidence', document_type: 'identity', version: 1 }]],
    [/UPDATE provider_media SET review_status/, { affectedRows: 1 }],
    [/INSERT INTO admin_logs/, { insertId: 1 }],
  ]);
  await request(app).put('/api/admin/media/4/review')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ decision: 'rejected' }).expect(422);
  await request(app).put('/api/admin/media/4/review')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ decision: 'rejected', note: 'Copy is unreadable' }).expect(200);
  const upd = calls.find((c) => /UPDATE provider_media SET review_status/.test(c.sql));
  assert.deepEqual(upd.params, ['rejected', 'Copy is unreadable', 241, 4]);
});

test('opening a private document is written to the audit log', async () => {
  const name = 'p8-evidence-0123456789abcdef.pdf';
  fs.writeFileSync(path.join(process.env.UPLOAD_DIR, name), '%PDF-1.4');
  setHandlers([
    [/SELECT media_id, provider_id, file_path, media_type, document_type FROM provider_media/,
      [{ media_id: 9, provider_id: 8, file_path: name, media_type: 'evidence', document_type: 'identity' }]],
    [/INSERT INTO admin_logs/, { insertId: 1 }],
  ]);
  await request(app).get('/api/admin/media/9')
    .set('Authorization', `Bearer ${adminToken}`).expect(200);
  const log = calls.find((c) => /INSERT INTO admin_logs/.test(c.sql));
  assert.equal(log.params[1], 'document:view');
});

/* ------------------------------------------------------- document expiry */
test('the expiry check expires listings whose accepted document lapsed, and only those', async () => {
  const { runExpiryCheck } = require('../services/expiry');
  setHandlers([
    [/SELECT category_id, parent_category_id, required_documents FROM categories/,
      [{ category_id: 12, parent_category_id: null, required_documents: 'identity,qualification' }]],
    [/SELECT provider_id, provider_name, category_id FROM providers WHERE verification_status = 'verified'/,
      [{ provider_id: 1, provider_name: 'Lapsed', category_id: 12 },
        { provider_id: 2, provider_name: 'Renewed', category_id: 12 },
        { provider_id: 3, provider_name: 'Never had documents', category_id: 12 }]],
    [/SELECT provider_id, document_type, expires_on, review_status FROM provider_media/, [
      { provider_id: 1, document_type: 'qualification', expires_on: '2026-01-31', review_status: 'accepted' },
      { provider_id: 2, document_type: 'qualification', expires_on: '2026-01-31', review_status: 'accepted' },
      { provider_id: 2, document_type: 'qualification', expires_on: '2028-01-31', review_status: 'accepted' },
    ]],
    [/SELECT verification_status FROM providers WHERE provider_id = \? FOR UPDATE/,
      [{ verification_status: 'verified' }]],
    [/UPDATE providers SET verification_status = 'expired'/, { affectedRows: 1 }],
    [/INSERT INTO provider_verification_events/, { insertId: 1 }],
  ]);
  const out = await runExpiryCheck({ today: '2026-06-01', log: () => {} });
  assert.deepEqual(out, [{ provider_id: 1, lapsed: ['qualification'] }]);
  const ev = calls.find((c) => /INSERT INTO provider_verification_events/.test(c.sql));
  assert.equal(ev.params[0], 1);
  assert.match(ev.params[1], /Qualification certificate/);
  assert.ok(mlCalls.some(([name]) => name === 'reindexQuietly'));
});

/* ------------------------------------------------------ two-step sign-in */
test('two-step sign-in: enrol, then a code is required, and codes cannot be replayed', async () => {
  const totp = require('../services/totp');
  const hash = await hashPassword('correct-horse');
  const state = { mfa_secret: null, mfa_enabled: 0, mfa_last_step: null };
  const userRow = () => ({
    user_id: 7, full_name: 'Test Parent', email: 'p@example.com', location: null, role: 'user',
    token_version: 0, password_hash: hash, mfa_enabled: state.mfa_enabled,
  });
  setHandlers([
    [/SELECT email, mfa_enabled FROM users/, () => [userRow()]],
    [/UPDATE users SET mfa_secret = \?, mfa_last_step = NULL/, (p) => {
      [state.mfa_secret] = p; state.mfa_last_step = null; return { affectedRows: 1 };
    }],
    [/SELECT mfa_secret, mfa_enabled, mfa_last_step FROM users/, () => [{ ...state }]],
    [/UPDATE users SET mfa_last_step = \?/, (p) => { [state.mfa_last_step] = p; return {}; }],
    [/UPDATE users SET mfa_enabled = 1/, () => { state.mfa_enabled = 1; return {}; }],
    [/SELECT user_id, full_name, email, password_hash, location, role, token_version, mfa_enabled/,
      () => [userRow()]],
    [/SELECT user_id, full_name, email, location, role, token_version, mfa_enabled\s+FROM users WHERE user_id/,
      () => [userRow()]],
  ]);
  const setup = await request(app).post('/api/auth/mfa/setup')
    .set('Authorization', `Bearer ${userToken}`).expect(200);
  assert.match(setup.body.otpauth_uri, /^otpauth:\/\/totp\//);
  assert.notEqual(state.mfa_secret, setup.body.secret, 'the secret is stored encrypted');

  const key = totp.base32Decode(setup.body.secret);
  const now = totp.stepAt();
  await request(app).post('/api/auth/mfa/enable').set('Authorization', `Bearer ${userToken}`)
    .send({ code: '000000' === totp.hotp(key, now) ? '111111' : '000000' }).expect(422);
  await request(app).post('/api/auth/mfa/enable').set('Authorization', `Bearer ${userToken}`)
    .send({ code: totp.hotp(key, now) }).expect(200);

  // The password alone no longer gives a session.
  const login = await request(app).post('/api/auth/login')
    .send({ email: 'p@example.com', password: 'correct-horse' }).expect(200);
  assert.equal(login.body.token, undefined);
  assert.equal(login.body.mfa_required, true);
  // The challenge is not a session.
  await request(app).get('/api/saved').set('Authorization', `Bearer ${login.body.mfa_token}`).expect(401);
  // The code just used to enrol cannot be used again.
  await request(app).post('/api/auth/mfa/verify')
    .send({ mfa_token: login.body.mfa_token, code: totp.hotp(key, now) }).expect(401);
  const ok = await request(app).post('/api/auth/mfa/verify')
    .send({ mfa_token: login.body.mfa_token, code: totp.hotp(key, now + 1) }).expect(200);
  assert.ok(ok.body.token);
});

test('evidence is never served from the public media route', async () => {
  setHandlers([[/FROM provider_media m/, []]]);
  await request(app).get('/api/services/media/4').expect(404);
  const sel = calls.find((c) => /FROM provider_media m/.test(c.sql));
  assert.match(sel.sql, /media_type = 'image'/);
});

/* ------------------------------------------------------------- categories */
test('a category that still holds providers cannot be deleted', async () => {
  setHandlers([[/FROM categories c WHERE c.category_id = \?/,
    [{ category_id: 12, category_name: 'Lactation', providers: 3, children: 0 }]]]);
  await request(app).delete('/api/admin/categories/12')
    .set('Authorization', `Bearer ${adminToken}`).expect(409);
});

/* --------------------------------------------------------------- config */
test('production refuses a missing, placeholder or short JWT secret', () => {
  const { resolveSecret } = require('../middleware/auth');
  for (const bad of [undefined, '', 'replace-with-a-long-random-string',
    'dev-jwt-secret-change-me', 'short']) {
    assert.throws(() => resolveSecret(bad, 'production'), /JWT_SECRET/);
  }
  const good = 'a'.repeat(64);
  assert.equal(resolveSecret(good, 'production'), good);
  assert.equal(resolveSecret(undefined, 'test'), 'change-me-in-production');
});

test('cross-origin requests are not granted CORS headers by default', async () => {
  const res = await request(app).get('/api/categories')
    .set('Origin', 'https://evil.example');
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});
