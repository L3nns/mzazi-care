/**
 * Personalised recommendations (FR-08 to FR-11) - the client side of Figure 4.3.
 *
 * Express does not rank anything itself. It asks the Python service for scores
 * and hydrates the results with catalogue details for display.
 */
const express = require('express');
const { query: q } = require('express-validator');
const { query } = require('../config/db');
const { handleValidation } = require('../middleware/validate');
const { asyncRoute } = require('../middleware/errors');
const { optionalAuth } = require('../middleware/auth');
const ml = require('../services/mlClient');

const router = express.Router();

router.get(
  '/',
  optionalAuth,
  [
    q('query').optional().trim().isLength({ max: 160 }),
    q('top_n').optional().isInt({ min: 1, max: 30 }).toInt(),
    q('category').optional().isInt({ min: 1 }).toInt(),
    q('location').optional().trim().isLength({ max: 120 }),
    q('alpha').optional().isFloat({ min: 0, max: 1 }).toFloat(),
  ],
  handleValidation,
  asyncRoute(async (req, res) => {
    const payload = {
      user_id: req.user ? Number(req.user.user_id) : null,
      query: req.query.query || null,
      top_n: req.query.top_n || 10,
      category_id: req.query.category || null,
      location: req.query.location || null,
      alpha: req.query.alpha ?? null,
      persist: Boolean(req.user),
    };
    if (payload.user_id === null && !payload.query) {
      // Anonymous visitor with no query: show what is popular rather than 422.
      payload.query = null;
      payload.user_id = null;
    }

    let data;
    try {
      data = await ml.recommend(payload);
    } catch (err) {
      // Degrade to popularity so the page still renders (Section 4.11).
      console.warn('[ml] recommend failed, falling back to popularity:', err.message);
      const rows = await query(
        `SELECT p.provider_id, p.provider_name, p.category_id, c.category_name,
                p.location, COUNT(i.interaction_id) AS interaction_count
         FROM providers p
         JOIN categories c ON c.category_id = p.category_id
         LEFT JOIN interactions i ON i.provider_id = p.provider_id
         WHERE p.verification_status = 'verified'
         GROUP BY p.provider_id
         ORDER BY interaction_count DESC
         LIMIT ?`, [String(payload.top_n)],
      );
      return res.json({
        strategy: 'popularity_fallback_sql',
        degraded: true,
        results: rows.map((r, i) => ({ ...r, rank_position: i + 1 })),
      });
    }

    if (!data.results?.length) return res.json({ ...data, results: [] });

    const ids = data.results.map((r) => r.provider_id);
    const details = await query(
      `SELECT p.provider_id, p.service_tags, p.service_description, p.location,
              p.qualifications
       FROM providers p WHERE p.provider_id IN (${ids.map(() => '?').join(',')})`,
      ids,
    );
    const byId = Object.fromEntries(details.map((d) => [d.provider_id, d]));
    return res.json({
      ...data,
      results: data.results.map((r) => ({ ...r, ...(byId[r.provider_id] || {}) })),
    });
  }),
);

module.exports = router;
