/**
 * Catalogue browsing, search and filtering (FR-03 to FR-06).
 *
 * Only `verified` listings are ever returned here. Pending and rejected rows
 * exist in the table but are invisible outside the admin routes (Table 4.4).
 */
const fs = require('fs');
const express = require('express');
const { query: q, param } = require('express-validator');
const { query, one } = require('../config/db');
const { handleValidation } = require('../middleware/validate');
const { asyncRoute } = require('../middleware/errors');
const { optionalAuth } = require('../middleware/auth');
const ml = require('../services/mlClient');
const { log } = require('../services/logger');
const media = require('../services/media');
const {
  keywordSql, semanticSql, hydrate, popularSql, CATEGORY_TREE_SQL, RATING_COLUMNS,
} = require('../services/catalog');
const areas = require('../services/areas');

const router = express.Router();

// How far (between area centres) an empty area search looks for alternatives.
const NEARBY_KM = Number(process.env.NEARBY_KM || 6);
// The most engine matches one search ranks (the engine's own limit).
const SEMANTIC_CANDIDATES = 200;
// Below this best-match similarity the results are shown as "closest", not as
// matches. 0.40 is the dev-split choice in the search benchmark; used to label,
// never to hide, since real questions also score this low (FINDINGS.md, S5).
const WEAK_MATCH = Number(process.env.SEARCH_WEAK_MATCH || 0.4);
// How many of the closest services a weak match shows. The relevance floor is
// a share of the best match, so a weak best match lets almost everything
// through ("fundi wa magari" listed 38 services).
const WEAK_LIMIT = 5;

/**
 * How free text is matched. By meaning, through the engine, unless
 * SEARCH_MODE=keyword or the engine cannot be reached; then by keyword SQL,
 * which needs every term to appear. The labelled benchmark found keyword-only
 * search returned nothing for 69% of answerable queries (nDCG@10 0.27 against
 * 0.80): docs/research/FINDINGS.md, S1. Area and category filters are applied
 * in SQL afterwards, so they behave the same in both modes.
 */
async function textMatch(text) {
  if ((process.env.SEARCH_MODE || 'semantic') !== 'keyword') {
    try {
      const rec = await ml.recommend({
        user_id: null, query: text, top_n: SEMANTIC_CANDIDATES,
        related: false, exclude_saved: false, persist: false,
      });
      // popularity_fallback: nothing in the catalogue matches the text.
      let ids = rec.strategy === 'popularity_fallback' ? []
        : (rec.results || []).filter((r) => r.basis === 'match').map((r) => Number(r.provider_id));
      const weak = ids.length > 0 && typeof rec.query_similarity === 'number'
        && rec.query_similarity < WEAK_MATCH;
      if (weak) ids = ids.slice(0, WEAK_LIMIT);
      return { mode: 'semantic', quality: ids.length ? (weak ? 'weak' : 'good') : null, ...semanticSql(ids, text) };
    } catch (err) {
      log.warn('engine search failed, using keyword search', { err });
    }
  }
  return { mode: 'keyword', ...keywordSql(text) };
}

// req.user is populated when a token is present; anonymous browsing still works.
router.use(optionalAuth);

const SORTS = {
  relevance: null,                      // keyword score when there is a query
  rating: 'avg_rating IS NULL, avg_rating DESC, rating_count DESC, p.provider_name ASC',
  popular: 'interaction_count DESC, p.provider_name ASC',
  newest: 'p.created_at DESC, p.provider_name ASC',
  name: 'p.provider_name ASC',
  distance: null,                       // sorted after the query, from area centres
};

router.get(
  '/',
  [
    q('q').optional().trim().isLength({ max: 120 }),
    q('category').optional({ values: 'falsy' }).isInt({ min: 1 }).toInt(),
    q('type').optional({ values: 'falsy' }).isInt({ min: 1 }).toInt(),
    q('location').optional().trim().isLength({ max: 120 }),
    // Widen an area filter to neighbouring areas whose centre is this close.
    q('within_km').optional({ values: 'falsy' }).isFloat({ min: 1, max: 50 }).toFloat(),
    q('sort').optional().isIn(Object.keys(SORTS)),
    q('page').optional().isInt({ min: 1, max: 500 }).toInt(),
    q('per_page').optional().isInt({ min: 1, max: 50 }).toInt(),
  ],
  handleValidation,
  asyncRoute(async (req, res) => {
    let { q: text, location } = req.query;
    const { category, type } = req.query;
    const withinKm = req.query.within_km || null;
    const page = req.query.page || 1;
    const perPage = req.query.per_page || 12;

    // "A midwife near Kilimani": a place named in the query becomes the area
    // filter, unless the parent already chose one. The response says so, so
    // the page can show it as a removable filter rather than guess silently.
    const areaList = await areas.listAreas();
    let understood = null;
    if (text && !location) {
      const found = areas.extractLocation(text, areaList);
      if (found) {
        location = found.area.area_name;
        understood = { location, from_query: true, original_query: text, query: found.rest || null };
        text = found.rest || undefined;
      }
    }

    const where = ["p.verification_status = 'verified'"];
    const params = [];
    let scoreSql = null;
    let scoreParams = [];
    let searchMode = null;
    let matchQuality = null;
    if (text) {
      const match = await textMatch(text);
      where.push(match.where);
      params.push(...match.params);
      scoreSql = match.score;
      scoreParams = match.scoreParams;
      searchMode = match.mode;
      matchQuality = match.quality || null;
    }
    // "Service type" (FR-05) is the top level of the category tree.
    if (type) { where.push(CATEGORY_TREE_SQL); params.push(type, type); }
    if (category) { where.push(CATEGORY_TREE_SQL); params.push(category, category); }
    // Everything except the area, kept for the "nearby areas" fallback below.
    const baseWhere = [...where];
    const baseParams = [...params];
    let areaNames = [];
    if (location) {
      areaNames = withinKm ? areas.areasWithin(location, withinKm, areaList) : [location];
      const cond = areas.servesAreaSql(areaNames);
      where.push(cond.sql); params.push(...cond.params);
    }
    const whereSql = where.join(' AND ');

    // Distance order needs every match ranked before paging, so it is done here.
    const sortKey = req.query.sort || 'relevance';
    const byDistance = sortKey === 'distance' && location;
    const order = SORTS[sortKey]
      || (scoreSql ? 'relevance DESC, p.provider_name ASC' : SORTS.rating);

    const [{ total }] = await query(
      `SELECT COUNT(*) AS total
       FROM providers p JOIN categories c ON c.category_id = p.category_id
       WHERE ${whereSql}`, params,
    );
    let rows = await query(
      `SELECT p.provider_id, p.provider_name, p.category_id, c.category_name,
              c.parent_category_id, p.service_description, p.service_tags, p.location,
              p.qualifications, p.verification_status, p.created_at,
              (SELECT COUNT(*) FROM interactions i
                WHERE i.provider_id = p.provider_id) AS interaction_count,
              ${RATING_COLUMNS},
              ${scoreSql || '0'} AS relevance
       FROM providers p JOIN categories c ON c.category_id = p.category_id
       WHERE ${whereSql}
       ORDER BY ${order}
       LIMIT ? OFFSET ?`,
      [...scoreParams, ...params,
        String(byDistance ? 500 : perPage), String(byDistance ? 0 : (page - 1) * perPage)],
    );

    // Which areas each result serves, and roughly how far it is from the
    // chosen area. Distances are between neighbourhood centres.
    if (location && rows.length) {
      const info = await areas.providerAreaInfo(rows.map((r) => r.provider_id), location, areaList);
      rows = rows.map((r) => ({ ...r, ...info.get(Number(r.provider_id)) }));
      if (byDistance) {
        const d = (r) => (r.serves_origin ? 0 : (r.distance_km ?? Infinity));
        rows.sort((a, b) => d(a) - d(b) || a.provider_name.localeCompare(b.provider_name));
        rows = rows.slice((page - 1) * perPage, page * perPage);
      }
    }

    // Record the search so the preference vector keeps growing. Awaited, so a
    // recommendation request that follows sees it; a failure never fails search.
    if (req.user && (req.query.q || category || type || location)) {
      await query(
        `INSERT INTO search_history (user_id, query_text, category_filter, location_filter)
         VALUES (?, ?, ?, ?)`,
        [req.user.user_id, req.query.q || null,
          category || type ? String(category || type) : null, location || null],
      ).catch((err) => log.warn('could not record search', { err }));
    }

    // Figure 4.5: where nothing satisfies the filters, present broader and
    // popular suggestions rather than an empty result set.
    let suggestions = [];
    let suggestionBasis = null;
    // Nothing in the chosen area: first offer the same search in neighbouring
    // areas (up to NEARBY_KM between centres), nearest first.
    if (total === 0 && location) {
      const nearby = areas.areasWithin(location, NEARBY_KM, areaList)
        .filter((n) => !areaNames.includes(n));
      if (nearby.length) {
        const cond = areas.servesAreaSql(nearby);
        let near = await query(
          `SELECT p.provider_id, p.provider_name, p.category_id, c.category_name,
                  p.service_tags, p.location, p.verification_status, ${RATING_COLUMNS},
                  ${scoreSql || '0'} AS relevance
           FROM providers p JOIN categories c ON c.category_id = p.category_id
           WHERE ${[...baseWhere, cond.sql].join(' AND ')}
           ORDER BY relevance DESC, p.provider_name ASC LIMIT 30`,
          [...scoreParams, ...baseParams, ...cond.params],
        );
        if (near.length) {
          const info = await areas.providerAreaInfo(near.map((r) => r.provider_id), location, areaList);
          near = near.map((r) => ({ ...r, ...info.get(Number(r.provider_id)) }))
            .sort((a, b) => (a.distance_km ?? 99) - (b.distance_km ?? 99));
          suggestions = near.slice(0, 6);
          suggestionBasis = 'nearby';
        }
      }
    }
    if (total === 0 && !suggestions.length && (text || category || type || location)) {
      try {
        const rec = await ml.recommend({
          user_id: req.user ? Number(req.user.user_id) : null,
          query: text || null, top_n: 6, category_id: category || type || null,
          location: null, persist: false,
        });
        suggestions = rec.results || [];
        suggestionBasis = rec.strategy === 'popularity_fallback' ? 'popular' : 'closest';
      } catch (err) {
        log.warn('engine suggestions failed', { err });
      }
      if (!suggestions.length) {
        suggestions = await popularSql({ topN: 6, category: category || type || null });
        suggestionBasis = 'popular';
      }
      suggestions = await hydrate(suggestions);
    }

    res.json({
      total,
      page,
      per_page: perPage,
      pages: Math.ceil(total / perPage),
      results: rows,
      ...(searchMode ? { search_mode: searchMode } : {}),
      // "weak": nothing clearly matches the text; the page says so.
      ...(matchQuality && rows.length ? { match_quality: matchQuality } : {}),
      ...(understood ? { understood } : {}),
      ...(location ? { area: { name: location, searched: areaNames, within_km: withinKm } } : {}),
      ...(suggestionBasis ? { suggestions, suggestion_basis: suggestionBasis } : {}),
      ...(suggestionBasis === 'nearby' ? { suggestion_origin: location } : {}),
    });
  }),
);

/** Service areas, with how many verified providers serve each, for the area filter. */
router.get('/locations', asyncRoute(async (_req, res) => {
  const rows = await query(
    `SELECT a.area_name AS location,
            (a.latitude IS NOT NULL) AS has_coordinates,
            COUNT(DISTINCT p.provider_id) AS provider_count
     FROM service_areas a
     LEFT JOIN provider_service_areas psa ON psa.area_id = a.area_id
     LEFT JOIN providers p ON p.provider_id = psa.provider_id AND p.verification_status = 'verified'
     WHERE a.is_active = 1
     GROUP BY a.area_id, a.area_name, a.latitude ORDER BY a.area_name`,
  );
  res.json({ locations: rows.map((r) => ({ ...r, has_coordinates: !!r.has_coordinates })) });
}));

/** Public profile images. Evidence documents are never served from here. */
router.get(
  '/media/:mediaId',
  [param('mediaId').isInt({ min: 1 }).toInt()],
  handleValidation,
  asyncRoute(async (req, res) => {
    const row = await one(
      `SELECT m.file_path FROM provider_media m
       JOIN providers p ON p.provider_id = m.provider_id
       WHERE m.media_id = ? AND m.media_type = 'image'
         AND p.verification_status = 'verified'`, [req.params.mediaId],
    );
    const file = row && media.resolve(row.file_path);
    if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'not found' });
    res.type(media.mimeFor(row.file_path));
    res.set('Cache-Control', 'public, max-age=3600');
    return res.sendFile(file);
  }),
);

router.get(
  '/:id',
  [param('id').isInt({ min: 1 }).toInt()],
  handleValidation,
  asyncRoute(async (req, res) => {
    const provider = await one(
      `SELECT p.provider_id, p.provider_name, p.category_id, c.category_name,
              c.parent_category_id, pc.category_name AS parent_category_name,
              p.service_description, p.service_tags, p.location, p.qualifications,
              p.contact_email, p.verification_status, p.created_at,
              ${RATING_COLUMNS}
       FROM providers p JOIN categories c ON c.category_id = p.category_id
       LEFT JOIN categories pc ON pc.category_id = c.parent_category_id
       WHERE p.provider_id = ? AND p.verification_status = 'verified'`,
      [req.params.id],
    );
    if (!provider) return res.status(404).json({ error: 'provider not found' });

    const images = await query(
      `SELECT media_id, media_type FROM provider_media
       WHERE provider_id = ? AND media_type = 'image' ORDER BY media_id`,
      [req.params.id],
    );

    const served = (await query(
      `SELECT a.area_name FROM provider_service_areas psa
       JOIN service_areas a ON a.area_id = psa.area_id
       WHERE psa.provider_id = ? AND a.is_active = 1 ORDER BY a.area_name`, [req.params.id]))
      .map((r) => r.area_name);

    let saved = false;
    let myRating = null;
    if (req.user) {
      saved = Boolean(await one(
        'SELECT saved_id FROM saved_services WHERE user_id = ? AND provider_id = ?',
        [req.user.user_id, req.params.id],
      ));
      const r = await one(
        `SELECT rating_value FROM interactions
         WHERE user_id = ? AND provider_id = ? AND interaction_type = 'rating'
         ORDER BY created_at DESC, interaction_id DESC LIMIT 1`,
        [req.user.user_id, req.params.id],
      );
      myRating = r ? r.rating_value : null;
    }

    // Content neighbours come from the ML service; a failure here must not
    // break the profile page.
    let similar = [];
    try {
      ({ results: similar = [] } = await ml.similar(req.params.id, 4));
      similar = await hydrate(similar);
    } catch (err) {
      log.warn('engine similar-providers failed', { err });
    }

    return res.json({
      provider: { ...provider, service_areas: served },
      media: images.map((m) => ({ ...m, url: `/api/services/media/${m.media_id}` })),
      saved,
      my_rating: myRating,
      similar,
    });
  }),
);

module.exports = router;
