/**
 * The API description (docs/api/openapi.yaml) and the routes Express actually
 * serves must agree: every route documented, nothing documented that does not
 * exist. Run:  npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const SPEC = path.join(__dirname, '..', '..', 'docs', 'api', 'openapi.yaml');

/** "METHOD /path/{param}" for every route mounted on the app. */
function servedRoutes(app) {
  const out = new Set();
  const norm = (p) => p.replace(/:(\w+)/g, '{$1}').replace(/\/$/, '') || '/';
  for (const layer of app._router.stack) {
    if (layer.route) {
      for (const m of Object.keys(layer.route.methods)) out.add(`${m.toUpperCase()} ${norm(layer.route.path)}`);
    } else if (layer.name === 'router' && layer.handle.stack) {
      // Express 4 keeps the mount path only as a regexp: ^\/api\/auth\/?(?=\/|$)
      const mount = layer.regexp.source
        .replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\\\//g, '/');
      for (const l of layer.handle.stack) {
        if (!l.route) continue;
        for (const m of Object.keys(l.route.methods)) out.add(`${m.toUpperCase()} ${norm(mount + l.route.path)}`);
      }
    }
  }
  out.delete('GET *');          // the single-page fallback, not an API route
  return out;
}

/** "METHOD /path" for every operation in the spec (paths are relative to /api). */
function documentedRoutes(yaml) {
  const out = new Set();
  let current = null;
  for (const line of yaml.split(/\r?\n/)) {
    const p = line.match(/^ {2}(\/\S*):\s*$/);
    if (p) { current = p[1]; continue; }
    const m = line.match(/^ {4}(get|post|put|patch|delete):\s*$/);
    if (m && current) out.add(`${m[1].toUpperCase()} /api${current === '/' ? '' : current}`);
    if (/^\S/.test(line)) current = null;
  }
  return out;
}

test('every served route is documented, and every documented route is served', () => {
  const app = require('../server');
  const served = servedRoutes(app);
  const documented = documentedRoutes(fs.readFileSync(SPEC, 'utf8'));
  const missing = [...served].filter((r) => !documented.has(r)).sort();
  const stale = [...documented].filter((r) => !served.has(r)).sort();
  assert.deepEqual(missing, [], `not in openapi.yaml:\n  ${missing.join('\n  ')}`);
  assert.deepEqual(stale, [], `in openapi.yaml but not served:\n  ${stale.join('\n  ')}`);
  assert.ok(served.size > 40, `only ${served.size} routes found - the route walk is broken`);
});

test('the spec is served to developers', async () => {
  const request = require('supertest');
  const res = await request(require('../server')).get('/api/openapi.yaml').expect(200);
  assert.match(res.text, /^openapi: 3\.0\.\d/m);
});
