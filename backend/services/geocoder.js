/**
 * Place search for the map ("Yaya Centre", "Kilimani", "Kenyatta Hospital").
 *
 * The platform's own service areas are matched first, with no third party.
 * Anything else goes to OpenStreetMap's Nominatim, limited to the Nairobi
 * area, under its usage policy (https://operations.osmfoundation.org/policies/nominatim/):
 * at most one request a second from this server, an identifying User-Agent,
 * and results cached rather than asked for again.
 *
 *   GEOCODER          nominatim | off         (default nominatim)
 *   GEOCODER_CONTACT  email in the User-Agent (set it in production)
 *   NOMINATIM_URL     another Nominatim server (default the OSM one)
 *
 * The text a parent types for a place is sent to that service; the privacy
 * notice says so. It is never logged here.
 */
const areasSvc = require('./areas');

const GAP_MS = 1100;                 // a little over the one-a-second limit
const MAX_WAITING = 5;               // beyond this, ask the parent to try again
const TIMEOUT_MS = 6000;
const CACHE_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
// Results this close to a better one are the same place ("CBA ATM, Yaya Centre").
const SAME_PLACE_KM = 0.3;
// Nairobi and its edges: lon_min, lat_max, lon_max, lat_min.
const VIEWBOX = '36.60,-1.10,37.15,-1.50';

const cache = new Map();             // key -> { at, results }; insertion order = age
let chain = Promise.resolve();
let last = 0;
let waiting = 0;

const enabled = () => (process.env.GEOCODER || 'nominatim').toLowerCase() !== 'off';

function busy() {
  const err = new Error('place search is busy, try again in a moment');
  err.status = 503;
  return err;
}

/** Resolves when this caller may send the next request (one a second, in order). */
function slot() {
  if (waiting >= MAX_WAITING) return Promise.reject(busy());
  waiting += 1;
  const turn = chain.then(async () => {
    const wait = last + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
  });
  chain = turn.catch(() => {});
  return turn.finally(() => { waiting -= 1; });
}

/** "Yaya Centre, Argwings Kodhek Road, Kilimani, Nairobi, ..." -> the first three parts. */
const shortName = (display) => String(display || '').split(',').map((s) => s.trim())
  .filter(Boolean).slice(0, 3).join(', ');

async function nominatim(text) {
  const key = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.results;

  await slot();
  const base = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
  const url = `${base}/search?format=jsonv2&limit=5&countrycodes=ke&bounded=1`
    + `&viewbox=${VIEWBOX}&q=${encodeURIComponent(text)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let rows;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': `MzaziCare/1.0 (${process.env.GEOCODER_CONTACT || 'capstone prototype'})`,
        'Accept-Language': 'en',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = new Error(`place search returned ${res.status}`);
      err.status = res.status === 429 ? 503 : 502;
      throw err;
    }
    rows = await res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error('place search timed out');
      e.status = 504;
      throw e;
    }
    if (!err.status) err.status = 502;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const results = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const place = { name: shortName(r.display_name), lat: Number(r.lat), lng: Number(r.lon), source: 'openstreetmap' };
    if (!place.name || !Number.isFinite(place.lat) || !Number.isFinite(place.lng)) continue;
    if (results.some((k) => areasSvc.haversineKm(k, place) < SAME_PLACE_KM)) continue;
    results.push(place);
  }
  cache.set(key, { at: Date.now(), results });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return results;
}

/** The service areas nearest a point, with distances between centres. */
function nearestAreas(point, areas, n = 3) {
  return areas.filter((a) => a.lat !== null && a.lng !== null)
    .map((a) => ({ area_name: a.area_name, distance_km: Math.round(areasSvc.haversineKm(point, a) * 10) / 10 }))
    .sort((x, y) => x.distance_km - y.distance_km)
    .slice(0, n);
}

/**
 * Places matching `text`: the platform's own areas if any match (no third
 * party is asked), otherwise the geocoder. Each carries its nearest areas.
 */
async function searchPlaces(text, areas) {
  const q = String(text || '').trim();
  const lower = q.toLowerCase();
  const located = areas.filter((a) => a.lat !== null && a.lng !== null);
  const named = areasSvc.extractLocation(q, located);
  const own = named ? [named.area]
    : located.filter((a) => a.area_name.toLowerCase().startsWith(lower));
  let results;
  let source;
  if (own.length) {
    source = 'areas';
    results = own.map((a) => ({ name: a.area_name, lat: a.lat, lng: a.lng, source: 'area', area_name: a.area_name }));
  } else if (enabled()) {
    source = 'openstreetmap';
    results = await nominatim(q);
  } else {
    source = 'none';
    results = [];
  }
  return {
    source,
    results: results.map((r) => ({ ...r, nearest: nearestAreas(r, areas) })),
  };
}

/** Tests only: forget the cache and the pacing. */
function reset() { cache.clear(); chain = Promise.resolve(); last = 0; waiting = 0; }

module.exports = { searchPlaces, nearestAreas, shortName, reset, GAP_MS };
