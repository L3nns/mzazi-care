/**
 * Service areas: the neighbourhoods providers serve, managed by
 * administrators (service_areas), plus the location understanding search
 * needs - finding an area named inside a query ("a midwife near Kilimani",
 * "yaya Westlands", "kliniki ya mtoto karibu na Karen") and approximate
 * distances between area centres.
 *
 * Distances are between NEIGHBOURHOOD CENTRES, not addresses, and are always
 * shown as approximate.
 */
const { query } = require('../config/db');

const CACHE_MS = 60_000;
let cache = { at: 0, areas: null };

/** Active areas with coordinates where known. Cached for a minute. */
async function listAreas({ fresh = false } = {}) {
  if (!fresh && cache.areas && Date.now() - cache.at < CACHE_MS) return cache.areas;
  const rows = await query(
    `SELECT area_id, area_name, latitude, longitude FROM service_areas
     WHERE is_active = 1 ORDER BY area_name`);
  const areas = rows.map((r) => ({
    area_id: Number(r.area_id),
    area_name: r.area_name,
    lat: r.latitude === null ? null : Number(r.latitude),
    lng: r.longitude === null ? null : Number(r.longitude),
  }));
  cache = { at: Date.now(), areas };
  return areas;
}

const invalidate = () => { cache = { at: 0, areas: null }; };

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Words that tie a place to the request, in English and Kiswahili.
const CONNECTORS = ['near me in', 'near', 'in', 'at', 'around', 'within', 'close to',
  'karibu na', 'karibu', 'katika', 'huko', 'eneo la', 'mtaa wa'];

/**
 * Finds a service area named in free text. Longest names first, so "South C"
 * is not read as "South". Returns { area, rest } where rest is the query with
 * the place (and a connector such as "near" or "karibu na") removed, or null.
 */
function extractLocation(text, areas) {
  const t = String(text || '');
  if (!t.trim() || !areas?.length) return null;
  const names = [...areas].sort((a, b) => b.area_name.length - a.area_name.length);
  for (const a of names) {
    const name = escapeRe(a.area_name).replace(/\s+/g, '\\s+');
    const re = new RegExp(`(^|[^\\p{L}])(${name})(?=$|[^\\p{L}])`, 'iu');
    const m = re.exec(t);
    if (!m) continue;
    const start = m.index + m[1].length;
    let before = t.slice(0, start);
    const after = t.slice(start + m[2].length);
    const conn = new RegExp(`(?:^|\\s)(?:${CONNECTORS.map(escapeRe).join('|')})\\s*$`, 'iu');
    before = before.replace(conn, ' ');
    const rest = `${before} ${after}`.replace(/\s+/g, ' ').replace(/^[\s,.-]+|[\s,.-]+$/g, '');
    return { area: a, rest };
  }
  return null;
}

/** Great-circle distance in km. */
function haversineKm(a, b) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const hasCoords = (a) => a && a.lat !== null && a.lng !== null;

/** Areas whose centre lies within `km` of the named area's centre (itself included). */
function areasWithin(areaName, km, areas) {
  const origin = areas.find((a) => a.area_name.toLowerCase() === String(areaName).toLowerCase());
  if (!origin) return [areaName];
  if (!hasCoords(origin) || !km) return [origin.area_name];
  return areas.filter((a) => a === origin || (hasCoords(a) && haversineKm(origin, a) <= km))
    .map((a) => a.area_name);
}

/**
 * For each provider id, the areas it serves, and - when the origin area has
 * coordinates - the approximate distance from the origin to the nearest of
 * them. Returns Map(provider_id -> { areas, serves_origin, distance_km }).
 */
async function providerAreaInfo(providerIds, originName, areas) {
  const out = new Map();
  if (!providerIds.length) return out;
  const rows = await query(
    `SELECT psa.provider_id, a.area_name FROM provider_service_areas psa
     JOIN service_areas a ON a.area_id = psa.area_id
     WHERE psa.provider_id IN (${providerIds.map(() => '?').join(',')})`, providerIds);
  const byName = new Map(areas.map((a) => [a.area_name.toLowerCase(), a]));
  const origin = originName ? byName.get(String(originName).toLowerCase()) : null;
  for (const id of providerIds) out.set(Number(id), { areas: [], serves_origin: false, distance_km: null });
  for (const r of rows) out.get(Number(r.provider_id))?.areas.push(r.area_name);
  for (const info of out.values()) {
    if (!origin) continue;
    info.serves_origin = info.areas.some((n) => n.toLowerCase() === origin.area_name.toLowerCase());
    if (!hasCoords(origin)) continue;
    const ds = info.areas.map((n) => byName.get(n.toLowerCase())).filter(hasCoords)
      .map((a) => haversineKm(origin, a));
    if (ds.length) info.distance_km = Math.round(Math.min(...ds) * 10) / 10;
  }
  return out;
}

/** SQL condition: provider p serves one of the named areas (or names it as its location). */
function servesAreaSql(names) {
  const ph = names.map(() => '?').join(', ');
  return {
    sql: `(p.location IN (${ph}) OR p.provider_id IN (
            SELECT psa.provider_id FROM provider_service_areas psa
            JOIN service_areas a ON a.area_id = psa.area_id WHERE a.area_name IN (${ph})))`,
    params: [...names, ...names],
  };
}

module.exports = {
  listAreas, invalidate, extractLocation, haversineKm, areasWithin, providerAreaInfo,
  servesAreaSql, CONNECTORS,
};
