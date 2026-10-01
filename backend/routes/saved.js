/** Shortlisted providers (FR-07). */
const express = require('express');
const { param } = require('express-validator');
const { query } = require('../config/db');
const { handleValidation } = require('../middleware/validate');
const { asyncRoute } = require('../middleware/errors');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, asyncRoute(async (req, res) => {
  const rows = await query(
    `SELECT s.saved_id, s.saved_at, p.provider_id, p.provider_name,
            p.category_id, c.category_name, p.location, p.service_tags,
            p.verification_status
     FROM saved_services s
     JOIN providers p ON p.provider_id = s.provider_id
     JOIN categories c ON c.category_id = p.category_id
     WHERE s.user_id = ? ORDER BY s.saved_at DESC`,
    [req.user.user_id],
  );
  res.json({ saved: rows, count: rows.length });
}));

router.delete(
  '/:providerId',
  requireAuth,
  [param('providerId').isInt({ min: 1 }).toInt()],
  handleValidation,
  asyncRoute(async (req, res) => {
    const result = await query(
      'DELETE FROM saved_services WHERE user_id = ? AND provider_id = ?',
      [req.user.user_id, req.params.providerId],
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'not shortlisted' });
    return res.json({ status: 'removed', provider_id: req.params.providerId });
  }),
);

module.exports = router;
