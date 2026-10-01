/**
 * Administrative module (FR-13 to FR-18) - Figure 4.4 and Figure 4.6.
 *
 * Every route here is behind requireAuth + requireAdmin, and every mutation is
 * written to admin_logs so the audit trail in the ERD is real.
 */
const express = require('express');
const { body, param, query: q } = require('express-validator');
const { query, one } = require('../config/db');
const { handleValidation } = require('../middleware/validate');
const { asyncRoute } = require('../middleware/errors');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const ml = require('../services/mlClient');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const logAction = (adminId, action, entity, entityId) =>
  query(
    `INSERT INTO admin_logs (admin_id, action_type, entity_affected, entity_id)
     VALUES (?, ?, ?, ?)`, [adminId, action, entity, entityId],
  ).catch((err) => console.warn('[admin] could not log action:', err.message));

/* ------------------------------------------------------------ dashboard */
router.get('/stats', asyncRoute(async (_req, res) => {
  const [counts] = await query(
    `SELECT
       (SELECT COUNT(*) FROM providers) AS total_providers,
       (SELECT COUNT(*) FROM providers WHERE verification_status = 'verified') AS verified,
       (SELECT COUNT(*) FROM providers WHERE verification_status = 'pending') AS pending,
       (SELECT COUNT(*) FROM providers WHERE verification_status = 'rejected') AS rejected,
       (SELECT COUNT(*) FROM users WHERE role = 'user') AS users,
       (SELECT COUNT(*) FROM interactions) AS interactions,
       (SELECT COUNT(*) FROM search_history
         WHERE searched_at > DATE_SUB(NOW(), INTERVAL 7 DAY)) AS searches_this_week`,
  );
  let model = null;
  try { model = await ml.modelCard(); } catch { /* service may be down */ }
  res.json({ ...counts, model });
}));

router.get('/logs', asyncRoute(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = await query(
    `SELECT l.log_id, l.admin_id, u.full_name AS admin_name, l.action_type,
            l.entity_affected, l.entity_id, l.performed_at
     FROM admin_logs l LEFT JOIN users u ON u.user_id = l.admin_id
     ORDER BY l.performed_at DESC LIMIT ?`, [String(limit)],
  );
  res.json({ logs: rows });
}));

/* ------------------------------------------------------------- providers */
router.get(
  '/providers',
  [
    q('status').optional().isIn(['pending', 'verified', 'rejected']),
    q('page').optional().isInt({ min: 1 }).toInt(),
  ],
  handleValidation,
  asyncRoute(async (req, res) => {
    const page = req.query.page || 1;
    const perPage = 20;
    const where = [];
    const params = [];
    if (req.query.status) { where.push('p.verification_status = ?'); params.push(req.query.status); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [{ total }] = await query(
      `SELECT COUNT(*) AS total FROM providers p ${whereSql}`, params,
    );
    const rows = await query(
      `SELECT p.provider_id, p.provider_name, p.category_id, c.category_name,
              p.location, p.verification_status, p.contact_email, p.created_at
       FROM providers p JOIN categories c ON c.category_id = p.category_id
       ${whereSql} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
      [...params, String(perPage), String((page - 1) * perPage)],
    );
    res.json({ total, page, per_page: perPage, providers: rows });
  }),
);

router.get(
  '/providers/:id',
  [param('id').isInt({ min: 1 }).toInt()],
  handleValidation,
  asyncRoute(async (req, res) => {
    const provider = await one('SELECT * FROM providers WHERE provider_id = ?',
      [req.params.id]);
    if (!provider) return res.status(404).json({ error: 'provider not found' });
    return res.json({ provider });
  }),
);

const providerRules = [
  body('provider_name').trim().isLength({ min: 2, max: 150 }),
  body('category_id').isInt({ min: 1 }).toInt(),
  body('service_description').trim().isLength({ min: 20, max: 4000 }),
  body('service_tags').optional().trim().isLength({ max: 255 }),
  body('location').trim().isLength({ min: 2, max: 120 }),
  body('qualifications').optional().trim().isLength({ max: 2000 }),
  body('contact_email').optional({ values: 'falsy' }).isEmail().normalizeEmail(),
];

router.post(
  '/providers', providerRules, handleValidation,
  asyncRoute(async (req, res) => {
    const {
      provider_name, category_id, service_description, service_tags = null,
      location, qualifications = null, contact_email = null,
    } = req.body;
    if (!await one('SELECT category_id FROM categories WHERE category_id = ?', [category_id])) {
      return res.status(422).json({ error: 'unknown category_id' });
    }
    const result = await query(
      `INSERT INTO providers
         (provider_name, category_id, service_description, service_tags, location,
          qualifications, contact_email, verification_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [provider_name, category_id, service_description, service_tags, location,
        qualifications, contact_email],
    );
    // New listings start pending, so they are NOT recommendable yet (Table 4.4).
    await logAction(req.user.user_id, 'create', 'providers', result.insertId);
    return res.status(201).json({
      provider_id: result.insertId, verification_status: 'pending',
    });
  }),
);

router.put(
  '/providers/:id',
  [param('id').isInt({ min: 1 }).toInt(), ...providerRules],
  handleValidation,
  asyncRoute(async (req, res) => {
    const existing = await one('SELECT provider_id, verification_status FROM providers WHERE provider_id = ?',
      [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'provider not found' });
    const {
      provider_name, category_id, service_description, service_tags = null,
      location, qualifications = null, contact_email = null,
    } = req.body;
    await query(
      `UPDATE providers SET provider_name = ?, category_id = ?, service_description = ?,
              service_tags = ?, location = ?, qualifications = ?, contact_email = ?
       WHERE provider_id = ?`,
      [provider_name, category_id, service_description, service_tags, location,
        qualifications, contact_email, req.params.id],
    );
    await logAction(req.user.user_id, 'update', 'providers', req.params.id);
    // The content text changed, so the encoder must see it again.
    if (existing.verification_status === 'verified') ml.reindexQuietly();
    return res.json({ status: 'updated', provider_id: req.params.id });
  }),
);

router.put(
  '/providers/:id/verify',
  [
    param('id').isInt({ min: 1 }).toInt(),
    body('verification_status').isIn(['pending', 'verified', 'rejected']),
    body('note').optional().trim().isLength({ max: 500 }),
  ],
  handleValidation,
  asyncRoute(async (req, res) => {
    const { verification_status } = req.body;
    const provider = await one('SELECT provider_id FROM providers WHERE provider_id = ?',
      [req.params.id]);
    if (!provider) return res.status(404).json({ error: 'provider not found' });

    await query('UPDATE providers SET verification_status = ? WHERE provider_id = ?',
      [verification_status, req.params.id]);
    await logAction(req.user.user_id, `verify:${verification_status}`,
      'providers', req.params.id);

    // Figure 4.4 step 16-17: a newly verified listing has no column in the
    // user-item matrix, so only the content component can reach it. Re-index
    // immediately or it stays invisible until the next retrain.
    ml.reindexQuietly();

    return res.json({ status: 'updated', provider_id: req.params.id, verification_status });
  }),
);

router.delete(
  '/providers/:id',
  [param('id').isInt({ min: 1 }).toInt()],
  handleValidation,
  asyncRoute(async (req, res) => {
    const result = await query('DELETE FROM providers WHERE provider_id = ?',
      [req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'provider not found' });
    await logAction(req.user.user_id, 'delete', 'providers', req.params.id);
    ml.reindexQuietly();
    return res.json({ status: 'deleted', provider_id: req.params.id });
  }),
);

/* ------------------------------------------------------------ categories */
router.post(
  '/categories',
  [
    body('category_name').trim().isLength({ min: 2, max: 120 }),
    body('description').optional().trim().isLength({ max: 1000 }),
    body('parent_category_id').optional({ nullable: true }).isInt({ min: 1 }).toInt(),
  ],
  handleValidation,
  asyncRoute(async (req, res) => {
    const { category_name, description = null, parent_category_id = null } = req.body;
    const result = await query(
      `INSERT INTO categories (category_name, description, parent_category_id)
       VALUES (?, ?, ?)`, [category_name, description, parent_category_id],
    );
    await logAction(req.user.user_id, 'create', 'categories', result.insertId);
    return res.status(201).json({ category_id: result.insertId });
  }),
);

/* ----------------------------------------------------------------- model */
router.post('/model/reindex', asyncRoute(async (req, res) => {
  const out = await ml.reindex();
  await logAction(req.user.user_id, 'model:reindex', 'model', null);
  res.json(out);
}));

router.post('/model/retrain', asyncRoute(async (req, res) => {
  const out = await ml.retrain();
  await logAction(req.user.user_id, 'model:retrain', 'model', null);
  res.json(out);
}));

module.exports = router;
