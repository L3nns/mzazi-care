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
const baseHandlers = [
  [/SELECT role FROM users WHERE user_id/, (params) =>
    (ROLES[params[0]] ? [{ role: ROLES[params[0]] }] : [])],
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
const ml = {
  health: async () => ({ status: 'ok', model_loaded: true }),
  modelCard: async () => ({ config: { k: 20, alpha: 0.4 } }),
  recommend: async (payload) => {
    mlCalls.push(['recommend', payload]);
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
  retrain: async () => { mlCalls.push(['retrain']); return { status: 'ok' }; },
  reindexQuietly: () => { mlCalls.push(['reindexQuietly']); },
};
require.cache[mlPath] = { id: mlPath, filename: mlPath, loaded: true, exports: ml };

const app = require('../server');
const { issueToken, hashPassword } = require('../middleware/auth');

const userToken = issueToken({ user_id: 7, role: 'user', full_name: 'Test Parent' });
const adminToken = issueToken({ user_id: 241, role: 'admin', full_name: 'Admin' });

function setHandlers(list) { handlers = list; }
test.beforeEach(() => { calls.length = 0; mlCalls.length = 0; handlers = []; });

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
  ]);
  const res = await request(app).post('/api/admin/providers')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      provider_name: 'New Clinic', category_id: 12, location: 'Karen',
      service_description: 'A description long enough to pass validation rules.',
    })
    .expect(201);
  assert.equal(res.body.verification_status, 'pending');
  const insert = calls.find((c) => /INSERT INTO providers/.test(c.sql));
  assert.match(insert.sql, /'pending'/);
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

test('verifying a listing logs the action and triggers a re-index', async () => {
  setHandlers([
    [/SELECT provider_id, verification_status FROM providers WHERE provider_id/,
      [{ provider_id: 8, verification_status: 'pending' }]],
    [/UPDATE providers SET verification_status/, { affectedRows: 1 }],
    [/INSERT INTO admin_logs/, { insertId: 1 }],
  ]);
  await request(app).put('/api/admin/providers/8/verify')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ verification_status: 'verified' }).expect(200);

  const log = calls.find((c) => /INSERT INTO admin_logs/.test(c.sql));
  assert.equal(log.params[1], 'verify:verified');
  assert.ok(mlCalls.some(([name]) => name === 'reindexQuietly'),
    'a newly verified listing must be re-encoded or it stays invisible');
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
  setHandlers([
    [/SELECT provider_id, verification_status FROM providers WHERE provider_id/,
      [{ provider_id: 8, verification_status: 'pending' }]],
    [/UPDATE providers SET verification_status/, { affectedRows: 1 }],
    [/INSERT INTO admin_logs/, { insertId: 1 }],
  ]);
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
  ]);
  await request(app).put('/api/auth/me/password')
    .set('Authorization', `Bearer ${userToken}`)
    .send({ current_password: 'not-it-at-all', new_password: 'brand-new-pass' }).expect(403);
  await request(app).put('/api/auth/me/password')
    .set('Authorization', `Bearer ${userToken}`)
    .send({ current_password: 'old-password', new_password: 'brand-new-pass' }).expect(200);
  const update = calls.find((c) => /UPDATE users SET password_hash/.test(c.sql));
  assert.match(update.params[0], /^\$2[aby]\$/);
});

test('preferences naming an unknown category are rejected', async () => {
  setHandlers([[/SELECT category_id FROM categories WHERE category_id IN/, [{ category_id: 12 }]]]);
  await request(app).put('/api/auth/me/preferences')
    .set('Authorization', `Bearer ${userToken}`)
    .send({ category_ids: [12, 999] }).expect(422);
});

/* ----------------------------------------------------- keyword search SQL */
test('search ANDs prefix terms, drops filler words and knows spelling variants', async () => {
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
  assert.equal(mlCalls[0][1].query, 'someone to help me breastfeed');
  assert.equal(mlCalls[0][1].location, null, 'suggestions drop the location filter');
});

/* --------------------------------------------------------- evidence files */
test('evidence uploads are type-checked by content, not by name', async () => {
  setHandlers([
    [/SELECT provider_id FROM providers WHERE provider_id/, [{ provider_id: 8 }]],
    [/INSERT INTO provider_media/, { insertId: 4 }],
    [/INSERT INTO admin_logs/, { insertId: 1 }],
  ]);
  await request(app).post('/api/admin/providers/8/media?kind=evidence')
    .set('Authorization', `Bearer ${adminToken}`)
    .set('Content-Type', 'application/pdf')
    .send(Buffer.from('<script>alert(1)</script>')).expect(415);

  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(32)]);
  const res = await request(app).post('/api/admin/providers/8/media?kind=evidence')
    .set('Authorization', `Bearer ${adminToken}`)
    .set('Content-Type', 'application/pdf')
    .send(pdf).expect(201);
  assert.match(res.body.file_path, /^p8-evidence-[0-9a-f]{16}\.pdf$/);
  assert.ok(fs.existsSync(path.join(process.env.UPLOAD_DIR, res.body.file_path)));
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
