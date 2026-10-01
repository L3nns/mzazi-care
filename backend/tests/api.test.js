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
const path = require('node:path');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.BCRYPT_ROUNDS = '4';          // keep the suite fast

/* ----------------------------------------------------------- stub MySQL */
const dbPath = require.resolve('../config/db');
const calls = [];
let handlers = [];

const db = {
  query: async (sql, params = []) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    for (const [pattern, rows] of handlers) {
      if (pattern.test(sql)) return typeof rows === 'function' ? rows(params) : rows;
    }
    return [];
  },
  one: async (sql, params = []) => {
    const rows = await db.query(sql, params);
    return rows.length ? rows[0] : null;
  },
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
    [/SELECT category_id FROM categories/, [{ category_id: 12 }]],
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
  setHandlers([[/SELECT category_id FROM categories/, []]]);
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
    [/SELECT provider_id FROM providers WHERE provider_id/, [{ provider_id: 8 }]],
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
