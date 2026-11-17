/**
 * Personalised recommendations (FR-08 to FR-11) - the client side of Figure 4.3.
 *
 * Express does not rank anything itself. It asks the Python service for scores
 * and hydrates the results with catalogue details for display. It also owns
 * two things the engine must not decide alone: which providers are eligible
 * (re-checked in hydrate) and what this parent has told us to stop showing.
 */
const express = require('express');
const { query: q, body } = require('express-validator');
const { query, one } = require('../config/db');
const { handleValidation } = require('../middleware/validate');
const { asyncRoute } = require('../middleware/errors');
const { optionalAuth, requireAuth } = require('../middleware/auth');
const ml = require('../services/mlClient');
const { log } = require('../services/logger');
const areas = require('../services/areas');
const { hydrate, popularSql } = require('../services/catalog');

const router = express.Router();

// A parent who says a suggestion is not for them does not see it again for
// this long. "Relevant" is stored but changes nothing yet.
const FEEDBACK = ['relevant', 'not_relevant', 'too_far', 'wrong_category', 'already_contacted'];
const NEGATIVE = FEEDBACK.filter((f) => f !== 'relevant');
const HIDE_DAYS = Number(process.env.FEEDBACK_HIDE_DAYS || 180);

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
    // false: do not use the parent's home area to rank (location personalisation off).
    q('use_home_area').optional().isBoolean().toBoolean(),
  ],
  handleValidation,
  asyncRoute(async (req, res) => {
    const userId = req.user ? Number(req.user.user_id) : null;
    let text = req.query.query || null;
    let location = req.query.location || null;
    let understood = null;
    const areaList = await areas.listAreas();
    if (text && !location) {
      const found = areas.extractLocation(text, areaList);
      if (found) {
        location = found.area.area_name;
        understood = { location, from_query: true, query: found.rest || null };
        text = found.rest || null;
      }
    }

    // The area used to RANK by distance: the one asked for, else the parent's
    // own area (if they gave one and have not switched this off). An explicit
    // area is also a hard filter; the home area never is.
    let rankArea = location;
    let excludeIds = [];
    if (userId) {
      if (!rankArea && req.query.use_home_area !== false) {
        const u = await one('SELECT location FROM users WHERE user_id = ?', [userId]);
        rankArea = u?.location || null;
      }
      excludeIds = (await query(
        `SELECT DISTINCT provider_id FROM recommendation_feedback
         WHERE user_id = ? AND feedback IN (${NEGATIVE.map(() => '?').join(', ')})
           AND created_at > DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [userId, ...NEGATIVE, HIDE_DAYS])).map((r) => Number(r.provider_id));
    }

    // An anonymous visitor with no query gets popular, highly rated services
    // from the engine rather than an error.
    const payload = {
      user_id: userId,
      query: text,
      top_n: req.query.top_n || 10,
      category_id: req.query.category || req.query.type || null,
      location,
      area: rankArea,
      alpha: req.query.alpha ?? null,
      exclude_ids: excludeIds,
      persist: userId !== null,
    };

    let data;
    try {
      data = await ml.recommend(payload);
    } catch (err) {
      // Degrade to popularity so the page still renders (Section 4.11).
      log.warn('engine unavailable, recommending by popularity', { err });
      const results = await popularSql({
        topN: payload.top_n, category: payload.category_id,
        location: payload.location, excludeUser: userId,
      });
      return res.json({
        strategy: 'popularity_fallback_sql', degraded: true,
        results: (await hydrate(results)).map((r) => ({
          ...r, reasons: [{ code: 'popular', text: 'Popular with parents' }],
        })),
        ...(understood ? { understood } : {}),
      });
    }

    return res.json({
      ...data,
      results: await hydrate(data.results || []),
      ...(understood ? { understood } : {}),
    });
  }),
);

/** "Not relevant", "Too far away"... on one recommended provider. */
router.post(
  '/feedback',
  requireAuth,
  [body('provider_id').isInt({ min: 1 }).toInt(), body('feedback').isIn(FEEDBACK)],
  handleValidation,
  asyncRoute(async (req, res) => {
    const provider = await one(
      "SELECT provider_id FROM providers WHERE provider_id = ? AND verification_status = 'verified'",
      [req.body.provider_id]);
    if (!provider) return res.status(404).json({ error: 'provider not found' });
    await query(
      'INSERT INTO recommendation_feedback (user_id, provider_id, feedback) VALUES (?, ?, ?)',
      [req.user.user_id, req.body.provider_id, req.body.feedback]);
    return res.status(201).json({
      status: 'recorded',
      hidden: NEGATIVE.includes(req.body.feedback),
    });
  }),
);

module.exports = router;
