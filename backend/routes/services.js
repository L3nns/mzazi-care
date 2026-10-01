/**
 * Catalogue browsing, search and filtering (FR-03 to FR-06).
 *
 * Only `verified` listings are ever returned here. Pending and rejected rows
 * exist in the table but are invisible outside the admin routes.
 */
const express = require('express');
const { query: q, param } = require('express-validator');
const { query, one } = require('../config/db');
const { handleValidation } = require('../middleware/validate');
const { asyncRoute } = require('../middleware/errors');
const { optionalAuth } = require('../middleware/auth');
const ml = require('../services/mlClient');

const router = express.Router();

// req.user is populated when a token is present; anonymous browsing still works.
router.use(optionalAuth);

const SORTS = {
  relevance: 'p.provider_name ASC',
  name: 'p.provider_name ASC',
  newest: 'p.created_at DESC',
  popular: 'interaction_count DESC',
};

router.get(
  '/',
  [
    q('q').optional().trim().isLength({ max: 120 }),
    q('category').optional().isInt({ min: 1 }).toInt(),
    q('location').optional().trim().isLength({ max: 120 }),
    q('sort').optional().isIn(Object.keys(SORTS)),
    q('page').optional().isInt({ min: 1, max: 500 }).toInt(),
    q('per_page').optional().isInt({ min: 1, max: 50 }).toInt(),
  ],
  handleValidation,
  asyncRoute(async (req, res) => {
    const { q: text, category, location } = req.query;
    const page = req.query.page || 1;
    const perPage = req.query.per_page || 12;
    const sort = SORTS[req.query.sort] || SORTS.relevance;

    const where = ["p.verification_status = 'verified'"];
    const params = [];
    if (text) {
      where.push('(p.provider_name LIKE ? OR p.service_description LIKE ? OR p.service_tags LIKE ?)');
      params.push(`%${text}%`, `%${text}%`, `%${text}%`);
    }
    if (category) { where.push('p.category_id = ?'); params.push(category); }
    if (location) { where.push('p.location = ?'); params.push(location); }
    const whereSql = where.join(' AND ');

    const [{ total }] = await query(
      `SELECT COUNT(*) AS total FROM providers p WHERE ${whereSql}`, params,
    );
    const rows = await query(
      `SELECT p.provider_id, p.provider_name, p.category_id, c.category_name,
              p.service_description, p.service_tags, p.location,
              p.qualifications, p.verification_status, p.created_at,
              (SELECT COUNT(*) FROM interactions i
                WHERE i.provider_id = p.provider_id) AS interaction_count
       FROM providers p JOIN categories c ON c.category_id = p.category_id
       WHERE ${whereSql}
       ORDER BY ${sort}
       LIMIT ? OFFSET ?`,
      [...params, String(perPage), String((page - 1) * perPage)],
    );

    // Record the search so the preference vector and k-NN matrix keep growing.
    if (req.user && (text || category || location)) {
      query(
        `INSERT INTO search_history (user_id, query_text, category_filter, location_filter)
         VALUES (?, ?, ?, ?)`,
        [req.user.user_id, text || null, category ? String(category) : null,
          location || null],
      ).catch((err) => console.warn('[search] could not log query:', err.message));
    }

    res.json({
      total,
      page,
      per_page: perPage,
      pages: Math.ceil(total / perPage),
      results: rows,
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

router.get(
  '/:id',
  [param('id').isInt({ min: 1 }).toInt()],
  handleValidation,
  asyncRoute(async (req, res) => {
    const provider = await one(
      `SELECT p.provider_id, p.provider_name, p.category_id, c.category_name,
              p.service_description, p.service_tags, p.location, p.qualifications,
              p.contact_email, p.verification_status, p.created_at
       FROM providers p JOIN categories c ON c.category_id = p.category_id
       WHERE p.provider_id = ? AND p.verification_status = 'verified'`,
      [req.params.id],
    );
    if (!provider) return res.status(404).json({ error: 'provider not found' });

    const media = await query(
      'SELECT media_id, file_path, media_type FROM provider_media WHERE provider_id = ?',
      [req.params.id],
    );

    let saved = false;
    if (req.user) {
      saved = Boolean(await one(
        'SELECT saved_id FROM saved_services WHERE user_id = ? AND provider_id = ?',
        [req.user.user_id, req.params.id],
      ));
    }

    // Content neighbours come from the ML service; a failure here must not
    // break the profile page.
    let similar = [];
    try {
      ({ results: similar = [] } = await ml.similar(req.params.id, 4));
    } catch (err) {
      console.warn('[ml] similar failed:', err.message);
    }

    return res.json({ provider, media, saved, similar });
  }),
);

module.exports = router;
