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
const media = require('../services/media');
const {
  keywordSql, hydrate, popularSql, CATEGORY_TREE_SQL, RATING_COLUMNS,
} = require('../services/catalog');

const router = express.Router();

// req.user is populated when a token is present; anonymous browsing still works.
router.use(optionalAuth);

const SORTS = {
  relevance: null,                      // keyword score when there is a query
  rating: 'avg_rating IS NULL, avg_rating DESC, rating_count DESC, p.provider_name ASC',
  popular: 'interaction_count DESC, p.provider_name ASC',
  newest: 'p.created_at DESC, p.provider_name ASC',
  name: 'p.provider_name ASC',
};

router.get(
  '/',
  [
    q('q').optional().trim().isLength({ max: 120 }),
    q('category').optional({ values: 'falsy' }).isInt({ min: 1 }).toInt(),
    q('type').optional({ values: 'falsy' }).isInt({ min: 1 }).toInt(),
    q('location').optional().trim().isLength({ max: 120 }),
    q('sort').optional().isIn(Object.keys(SORTS)),
    q('page').optional().isInt({ min: 1, max: 500 }).toInt(),
    q('per_page').optional().isInt({ min: 1, max: 50 }).toInt(),
  ],
  handleValidation,
  asyncRoute(async (req, res) => {
    const { q: text, category, type, location } = req.query;
    const page = req.query.page || 1;
    const perPage = req.query.per_page || 12;

    const where = ["p.verification_status = 'verified'"];
    const params = [];
    let scoreSql = null;
    let scoreParams = [];
    if (text) {
      const kw = keywordSql(text);
      where.push(kw.where);
      params.push(...kw.params);
      scoreSql = kw.score;
      scoreParams = kw.scoreParams;
    }
    // "Service type" (FR-05) is the top level of the category tree.
    if (type) { where.push(CATEGORY_TREE_SQL); params.push(type, type); }
    if (category) { where.push(CATEGORY_TREE_SQL); params.push(category, category); }
    if (location) { where.push('p.location = ?'); params.push(location); }
    const whereSql = where.join(' AND ');

    const sortKey = req.query.sort || 'relevance';
    const order = SORTS[sortKey]
      || (scoreSql ? 'relevance DESC, p.provider_name ASC' : SORTS.rating);

    const [{ total }] = await query(
      `SELECT COUNT(*) AS total
       FROM providers p JOIN categories c ON c.category_id = p.category_id
       WHERE ${whereSql}`, params,
    );
    const rows = await query(
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
      [...scoreParams, ...params, String(perPage), String((page - 1) * perPage)],
    );

    // Record the search so the preference vector keeps growing. Awaited, so a
    // recommendation request that follows sees it; a failure never fails search.
    if (req.user && (text || category || type || location)) {
      await query(
        `INSERT INTO search_history (user_id, query_text, category_filter, location_filter)
         VALUES (?, ?, ?, ?)`,
        [req.user.user_id, text || null,
          category || type ? String(category || type) : null, location || null],
      ).catch((err) => console.warn('[search] could not log query:', err.message));
    }

    // Figure 4.5: where nothing satisfies the filters, present broader and
    // popular suggestions rather than an empty result set.
    let suggestions = [];
    let suggestionBasis = null;
    if (total === 0 && (text || category || type || location)) {
      try {
        const rec = await ml.recommend({
          user_id: req.user ? Number(req.user.user_id) : null,
          query: text || null, top_n: 6, category_id: category || type || null,
          location: null, persist: false,
        });
        suggestions = rec.results || [];
        suggestionBasis = rec.strategy === 'popularity_fallback' ? 'popular' : 'closest';
      } catch (err) {
        console.warn('[search] suggestions from the engine failed:', err.message);
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
      ...(suggestionBasis ? { suggestions, suggestion_basis: suggestionBasis } : {}),
    });
  }),
);

/** Distinct areas, for the location filter. */
router.get('/locations', asyncRoute(async (_req, res) => {
  const rows = await query(
    `SELECT location, COUNT(*) AS provider_count FROM providers
     WHERE verification_status = 'verified' AND location IS NOT NULL
     GROUP BY location ORDER BY location`,
  );
  res.json({ locations: rows });
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
    } catch (err) {
      console.warn('[ml] similar failed:', err.message);
    }

    return res.json({
      provider,
      media: images.map((m) => ({ ...m, url: `/api/services/media/${m.media_id}` })),
      saved,
      my_rating: myRating,
      similar,
    });
  }),
);

module.exports = router;
