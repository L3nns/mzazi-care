/**
 * Personalised recommendations (FR-08 to FR-11) - the client side of Figure 4.3.
 *
 * Express does not rank anything itself. It asks the Python service for scores
 * and hydrates the results with catalogue details for display.
 */
const express = require('express');
const { query: q } = require('express-validator');
const { handleValidation } = require('../middleware/validate');
const { asyncRoute } = require('../middleware/errors');
const { optionalAuth } = require('../middleware/auth');
const ml = require('../services/mlClient');
const { hydrate, popularSql } = require('../services/catalog');

const router = express.Router();

router.get(
  '/',
  optionalAuth,
  [
    q('query').optional().trim().isLength({ max: 160 }),
    q('top_n').optional().isInt({ min: 1, max: 30 }).toInt(),
    q('category').optional({ values: 'falsy' }).isInt({ min: 1 }).toInt(),
    q('type').optional({ values: 'falsy' }).isInt({ min: 1 }).toInt(),
    q('location').optional().trim().isLength({ max: 120 }),
    q('alpha').optional().isFloat({ min: 0, max: 1 }).toFloat(),
  ],
  handleValidation,
  asyncRoute(async (req, res) => {
    const userId = req.user ? Number(req.user.user_id) : null;
    // An anonymous visitor with no query gets popular, highly rated services
    // from the engine rather than an error.
    const payload = {
      user_id: userId,
      query: req.query.query || null,
      top_n: req.query.top_n || 10,
      category_id: req.query.category || req.query.type || null,
      location: req.query.location || null,
      alpha: req.query.alpha ?? null,
      persist: userId !== null,
    };

    let data;
    try {
      data = await ml.recommend(payload);
    } catch (err) {
      // Degrade to popularity so the page still renders (Section 4.11).
      console.warn('[ml] recommend failed, falling back to popularity:', err.message);
      const results = await popularSql({
        topN: payload.top_n, category: payload.category_id,
        location: payload.location, excludeUser: userId,
      });
      return res.json({ strategy: 'popularity_fallback_sql', degraded: true, results });
    }

    return res.json({ ...data, results: await hydrate(data.results || []) });
  }),
);

module.exports = router;
