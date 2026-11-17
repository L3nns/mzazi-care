/**
 * Location understanding: finding a service area named in a query, and
 * distances between area centres. No app, no database.
 * Run:  npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { SERVICE_AREAS } = require('../config/migrate');
const areas = require('../services/areas');

const LIST = SERVICE_AREAS.map(([area_name, lat, lng], i) => ({ area_id: i + 1, area_name, lat, lng }));
const find = (text) => {
  const out = areas.extractLocation(text, LIST);
  return out && [out.area.area_name, out.rest];
};

test('an area named in English or Kiswahili is found and taken out of the query', () => {
  assert.deepEqual(find('I need a midwife near Kilimani'), ['Kilimani', 'I need a midwife']);
  assert.deepEqual(find('Childcare services in Westlands'), ['Westlands', 'Childcare services']);
  assert.deepEqual(find('natafuta yaya Karen'), ['Karen', 'natafuta yaya']);
  assert.deepEqual(find('kliniki ya mtoto karibu na Langata'), ['Langata', 'kliniki ya mtoto']);
  assert.deepEqual(find('daycare huko Embakasi please'), ['Embakasi', 'daycare please']);
});

test('case, spacing and position do not matter', () => {
  assert.deepEqual(find('LACTATION upper   hill'), ['Upper Hill', 'LACTATION']);
  assert.deepEqual(find('Kileleshwa'), ['Kileleshwa', '']);
});

test('the longest area name wins, so "South C" is not "South B"', () => {
  assert.deepEqual(find('nanny in South C'), ['South C', 'nanny']);
  assert.deepEqual(find('nanny in south b'), ['South B', 'nanny']);
});

test('a place inside another word is not a match', () => {
  assert.equal(find('karenina daycare'), null);
  assert.equal(find('help with breastfeeding'), null);
  assert.equal(find(''), null);
});

test('distances between area centres are plausible', () => {
  const by = Object.fromEntries(LIST.map((a) => [a.area_name, a]));
  const d = areas.haversineKm(by.Westlands, by.Parklands);
  assert.ok(d > 0.3 && d < 2, `Westlands-Parklands ${d}`);
  assert.ok(areas.haversineKm(by.Westlands, by.Karen) > 10);
});

test('widening an area filter includes only areas within the radius', () => {
  const near = areas.areasWithin('Westlands', 3, LIST);
  assert.ok(near.includes('Westlands') && near.includes('Parklands'));
  assert.ok(!near.includes('Karen') && !near.includes('Embakasi'));
  assert.deepEqual(areas.areasWithin('Westlands', null, LIST), ['Westlands']);
  assert.deepEqual(areas.areasWithin('Nowhere', 5, LIST), ['Nowhere']);
});

test('the area list used by the backend matches the ML service seed file', () => {
  const fs = require('fs');
  const path = require('path');
  const csv = fs.readFileSync(path.join(__dirname, '..', '..', 'database', 'seed', 'service_areas.csv'), 'utf8')
    .trim().split(/\r?\n/).slice(1).map((l) => l.split(','));
  assert.equal(csv.length, SERVICE_AREAS.length);
  for (const [name, lat, lng] of csv) {
    const row = SERVICE_AREAS.find(([n]) => n === name);
    assert.ok(row, `${name} missing from migrate.js`);
    assert.ok(Math.abs(row[1] - Number(lat)) < 1e-4 && Math.abs(row[2] - Number(lng)) < 1e-4, name);
  }
});
