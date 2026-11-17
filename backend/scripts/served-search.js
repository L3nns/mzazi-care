/**
 * Runs every query in ml-service/research/queries.csv through the real search
 * route (GET /api/services), in-process against the configured MySQL
 * database, and records what a parent would see. The search benchmark
 * (ml-service/research/search_benchmark.py) reads the output as its served
 * arms, so those arms are the production code, not a copy.
 *
 *   node scripts/served-search.js --mode=semantic   (the default route)
 *   node scripts/served-search.js --mode=keyword    (the route before Phase 7)
 *   npm run benchmark:served                        (both)
 *
 * Writes model/research/served_search_<mode>.json.
 *
 * Also writes a fingerprint of the verified catalogue, so the benchmark can
 * refuse to compare against a database that differs from the CSV seed.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const MODE = (process.argv.find((a) => a.startsWith('--mode=')) || '--mode=semantic').slice(7);
if (!['semantic', 'keyword'].includes(MODE)) throw new Error(`unknown --mode=${MODE}`);
process.env.SEARCH_MODE = MODE;
const express = require('express');
const { query, close } = require('../config/db');
const ml = require('../services/mlClient');
const { errorHandler } = require('../middleware/errors');

const ROOT = path.join(__dirname, '..', '..');
const QUERIES = path.join(ROOT, 'ml-service', 'research', 'queries.csv');
const OUT_DIR = process.env.MZAZI_MODEL_DIR || path.join(ROOT, 'model');
const OUT = path.join(OUT_DIR, 'research', `served_search_${MODE}.json`);

/** Minimal CSV reader: the query file quotes fields that hold commas. */
function readCsv(file) {
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const cells = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quoted && ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') quoted = !quoted;
      else if (ch === ',' && !quoted) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells);
  }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

async function fingerprint() {
  const rows = await query(
    `SELECT provider_id, provider_name, category_id, location, service_description, service_tags
     FROM providers WHERE verification_status = 'verified' ORDER BY provider_id`);
  const links = await query(
    `SELECT psa.provider_id, a.area_name FROM provider_service_areas psa
     JOIN service_areas a ON a.area_id = psa.area_id ORDER BY psa.provider_id, a.area_name`)
    .catch(() => []);
  const areas = {};
  for (const l of links) (areas[l.provider_id] ||= []).push(l.area_name);
  const catalogue = {};
  for (const r of rows) {
    catalogue[r.provider_id] = md5([r.provider_name, r.category_id, r.location || '',
      r.service_description || '', r.service_tags || ''].join('|'));
  }
  return { catalogue, areas };
}

async function main() {
  const queries = readCsv(QUERIES);
  const app = express();
  app.use('/api/services', require('../routes/services'));
  app.use(errorHandler);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/services`;

  let engine = null;
  try { engine = await ml.health(); } catch { /* suggestions fall back to SQL */ }

  const out = [];
  try {
    // One untimed request first, so connection set-up is not charged to q001.
    await fetch(`${base}?q=warmup&per_page=10`);
    for (const row of queries) {
      const t0 = process.hrtime.bigint();
      const res = await fetch(`${base}?q=${encodeURIComponent(row.query)}&per_page=10`);
      const body = await res.json();
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (res.status !== 200) throw new Error(`${row.qid}: HTTP ${res.status} ${JSON.stringify(body)}`);
      out.push({
        qid: row.qid,
        total: body.total,
        search_mode: body.search_mode || null,
        results: body.results.map((r) => r.provider_id),
        understood: body.understood || null,
        suggestion_basis: body.suggestion_basis || null,
        suggestions: (body.suggestions || []).map((r) => r.provider_id),
        ms: Math.round(ms * 100) / 100,
      });
    }
    const fp = await fingerprint();
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({
      generated_at: new Date().toISOString(),
      mode: MODE,
      engine: engine ? { reachable: true, version: engine.version || null, encoder: engine.encoder || null }
        : { reachable: false },
      ...fp,
      queries: out,
    }, null, 1));
    const fellBack = out.filter((q) => q.search_mode && q.search_mode !== MODE).length;
    console.log(`${MODE}: ${out.length} queries -> ${OUT}`);
    if (fellBack) console.log(`WARNING: ${fellBack} queries were answered by keyword search (engine unreachable)`);
    console.log(`engine for suggestions: ${engine ? `reachable (${engine.version || 'unversioned'})` : 'NOT reachable - suggestions came from SQL'}`);
  } finally {
    server.close();
    await close();
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
