/**
 * Behavioural signals (FR-07, FR-12).
 *
 * Every row written here becomes a cell in the user-item matrix that the
 * collaborative component trains on, so this endpoint is the feedback loop
 * described in Figure 4.3, steps 16-18.
 */
const express = require('express');
const { body, param } = require('express-validator');
const { query, one } = require('../config/db');
const { handleValidation } = require('../middleware/validate');
const { asyncRoute } = require('../middleware/errors');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Section 4.8.1: a save pulls the preference vector 3.5x harder than a view.
const WEIGHTS = { view: 1.0, click: 2.0, save: 3.5, rating: 4.0 };

router.post(
  '/',
  requireAuth,
  [
    body('provider_id').isInt({ min: 1 }).toInt(),
    body('interaction_type').isIn(Object.keys(WEIGHTS)),
    body('rating_value').optional({ nullable: true }).isInt({ min: 1, max: 5 }).toInt(),
  ],
  handleValidation,
  asyncRoute(async (req, res) => {
    const { provider_id, interaction_type, rating_value = null } = req.body;

    if (interaction_type === 'rating' && rating_value === null) {
      return res.status(422).json({ error: 'rating_value is required for a rating' });
    }
    const provider = await one(
      `SELECT provider_id FROM providers
       WHERE provider_id = ? AND verification_status = 'verified'`,
      [provider_id],
    );
    if (!provider) return res.status(404).json({ error: 'provider not found' });

    const weight = WEIGHTS[interaction_type] * (rating_value ? rating_value / 4 : 1);
    const result = await query(
      `INSERT INTO interactions
         (user_id, provider_id, interaction_type, rating_value, interaction_weight)
       VALUES (?, ?, ?, ?, ?)`,
      [req.user.user_id, provider_id, interaction_type, rating_value, weight.toFixed(2)],
    );

    // A save is also a row in saved_services (the ERD keeps both).
    if (interaction_type === 'save') {
      await query(
        `INSERT INTO saved_services (user_id, provider_id) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE saved_at = CURRENT_TIMESTAMP`,
        [req.user.user_id, provider_id],
      );
    }

    return res.status(201).json({
      interaction_id: result.insertId,
      provider_id,
      interaction_type,
      interaction_weight: Number(weight.toFixed(2)),
    });
  }),
);

router.get('/me', requireAuth, asyncRoute(async (req, res) => {
  const rows = await query(
    `SELECT i.interaction_id, i.provider_id, p.provider_name, i.interaction_type,
            i.rating_value, i.interaction_weight, i.created_at
     FROM interactions i JOIN providers p ON p.provider_id = i.provider_id
     WHERE i.user_id = ? ORDER BY i.created_at DESC LIMIT 100`,
    [req.user.user_id],
  );
  res.json({ interactions: rows });
}));

module.exports = router;
