/**
 * The request id reaches the ML service: the real mlClient, inside the real
 * request middleware, calling a local HTTP server that records headers.
 * Run:  npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const request = require('supertest');

test('the request id is forwarded to the ML service', async () => {
  const seen = [];
  const engine = http.createServer((req, res) => {
    seen.push(req.headers['x-request-id']);
    res.setHeader('Content-Type', 'application/json');
    res.end('{"status":"ok"}');
  });
  await new Promise((resolve) => engine.listen(0, '127.0.0.1', resolve));
  process.env.ML_SERVICE_URL = `http://127.0.0.1:${engine.address().port}`;
  try {
    const ml = require('../services/mlClient');
    const { requestLogger } = require('../services/logger');
    const app = express();
    app.use(requestLogger);
    app.get('/x', async (_req, res) => res.json(await ml.health()));
    await request(app).get('/x').set('X-Request-Id', 'trace-42').expect(200);
    assert.deepEqual(seen, ['trace-42']);
    // Outside a request there is no id to send.
    await ml.health();
    assert.equal(seen[1], undefined);
  } finally {
    engine.close();
  }
});
