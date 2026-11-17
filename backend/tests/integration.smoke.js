/**
 * Integration smoke test: the real Express app talking to the REAL Python
 * recommendation service over HTTP. MySQL is still stubbed (the CI box has no
 * database), so this proves the tier boundary works end to end - the part the
 * unit tests cannot cover.
 *
 * Start the ML service first, then:  node tests/integration.smoke.js
 */
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'smoke-secret';
process.env.ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://127.0.0.1:8012';
process.env.ML_SERVICE_TOKEN = process.env.ML_SERVICE_TOKEN || 'devtoken';

/* -------- stub only the database; the ML service is genuinely called -------- */
const dbPath = require.resolve('../config/db');
// hydrate() keeps only engine results whose verified row comes back, so the
// stub answers for whichever ids the engine returned.
const providerRows = (ids) => ids.map((id) => ({
  provider_id: Number(id), service_tags: 'tags', service_description: 'desc',
  location: 'Westlands', qualifications: 'qualified', verification_status: 'verified',
}));
const db = {
  query: async (sql, params = []) => {
    if (/FROM providers p WHERE p.provider_id IN/.test(sql)) return providerRows(params);
    if (/COUNT\(\*\) AS total/.test(sql)) return [{ total: 0 }];
    return [];
  },
  // The session check: user 7 exists and its token has not been revoked.
  one: async (sql) => (/SELECT role, token_version FROM users/.test(sql)
    ? { role: 'user', token_version: 0 } : null),
  getPool: () => ({}),
  close: async () => {},
};
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };

const app = require('../server');
const { issueToken } = require('../middleware/auth');
const token = issueToken({ user_id: 7, role: 'user', full_name: 'Smoke' });

(async () => {
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`  PASS  ${name}`); }
    catch (err) { failures += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
  };

  console.log('integration smoke test (Express -> Python service)\n');

  await check('API health reports the ML service as reachable', async () => {
    const res = await request(app).get('/api/health').expect(200);
    assert.equal(res.body.ml.status, 'ok', JSON.stringify(res.body.ml));
    assert.ok(res.body.ml.model_loaded, 'the model should be loaded');
  });

  await check('a signed-in user gets hybrid recommendations', async () => {
    const res = await request(app).get('/api/recommendations?top_n=5')
      .set('Authorization', `Bearer ${token}`).expect(200);
    assert.ok(['hybrid', 'content_only', 'collaborative_only']
      .includes(res.body.strategy), `unexpected strategy ${res.body.strategy}`);
    assert.ok(res.body.results.length > 0, 'expected some results');
    const first = res.body.results[0];
    for (const key of ['content_score', 'collaborative_score', 'hybrid_score']) {
      assert.ok(typeof first[key] === 'number', `${key} missing`);
    }
  });

  await check('a natural-language query reaches the encoder', async () => {
    const res = await request(app)
      .get('/api/recommendations?query=someone%20to%20help%20me%20breastfeed&top_n=4')
      .expect(200);
    assert.equal(res.body.strategy, 'content_only');
    assert.ok(res.body.results.length > 0);
    const names = res.body.results.map((r) => r.category_name).join(', ');
    assert.ok(/Lactation/i.test(names),
      `expected lactation services for that query, got: ${names}`);
  });

  await check('the front end is served', async () => {
    const res = await request(app).get('/index.html').expect(200);
    assert.match(res.text, /Mzazi Care/);
  });

  await check('a failing ML call degrades instead of erroring', async () => {
    const saved = process.env.ML_SERVICE_URL;
    process.env.ML_SERVICE_URL = 'http://127.0.0.1:9';   // nothing listening
    delete require.cache[require.resolve('../services/mlClient')];
    delete require.cache[require.resolve('../routes/recommendations')];
    delete require.cache[require.resolve('../server')];
    const freshApp = require('../server');
    const res = await request(freshApp).get('/api/recommendations?top_n=3').expect(200);
    assert.equal(res.body.degraded, true, 'should fall back, not 5xx');
    process.env.ML_SERVICE_URL = saved;
  });

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  // exitCode, not exit(): exiting while sockets close crashes Node on Windows.
  process.exitCode = failures ? 1 : 0;
})();
