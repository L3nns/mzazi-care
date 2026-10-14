/**
 * Administrative module (FR-13 to FR-18) - Figure 4.4 and Figure 4.6.
 *
 * Every route here is behind requireAuth + requireAdmin, and every mutation is
 * written to admin_logs in the same transaction as the change itself, so the
 * audit trail cannot miss an action that took effect.
 */
const fs = require('fs');
const express = require('express');
const { body, param, query: q } = require('express-validator');
const { query, one, transaction } = require('../config/db');
const { handleValidation } = require('../middleware/validate');
const { asyncRoute } = require('../middleware/errors');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const ml = require('../services/mlClient');
const media = require('../services/media');
const { CATEGORY_FILTER_JOIN } = require('../services/catalog');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const LOG_SQL = `INSERT INTO admin_logs (admin_id, action_type, entity_affected, entity_id, notes)
                 VALUES (?, ?, ?, ?, ?)`;
const logAction = (db, adminId, action, entity, entityId, notes = null) =>
  db.query(LOG_SQL, [adminId, action, entity, entityId ?? null, notes]);

const idParam = (name = 'id') => param(name).isInt({ min: 1 }).toInt();

/* ------------------------------------------------------------ dashboard */
router.get('/stats', asyncRoute(async (_req, res) => {
  const [counts] = await query(
    `SELECT
       (SELECT COUNT(*) FROM providers) AS total_providers,
       (SELECT COUNT(*) FROM providers WHERE verification_status = 'verified') AS verified,
       (SELECT COUNT(*) FROM providers WHERE verification_status = 'pending') AS pending,
       (SELECT COUNT(*) FROM providers WHERE verification_status = 'rejected') AS rejected,
       (SELECT COUNT(*) FROM users WHERE role = 'user') AS users,
       (SELECT COUNT(*) FROM users WHERE role = 'admin') AS admins,
       (SELECT COUNT(*) FROM interactions) AS interactions,
       (SELECT COUNT(*) FROM categories) AS categories,
       (SELECT COUNT(*) FROM search_history
         WHERE searched_at > DATE_SUB(NOW(), INTERVAL 7 DAY)) AS searches_this_week,
       (SELECT COUNT(*) FROM search_history) AS searches_total`,
  );
  let model = null;
  try { model = await ml.modelCard(); } catch { /* service may be down */ }
  res.json({ ...counts, model });
}));

router.get(
  '/logs',
  [q('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
    q('page').optional().isInt({ min: 1 }).toInt()],
  handleValidation,
  asyncRoute(async (req, res) => {
    const limit = req.query.limit || 50;
    const page = req.query.page || 1;
    const [{ total }] = await query('SELECT COUNT(*) AS total FROM admin_logs');
    const rows = await query(
      `SELECT l.log_id, l.admin_id, u.full_name AS admin_name, l.action_type,
              l.entity_affected, l.entity_id, l.notes, l.performed_at,
              CASE WHEN l.entity_affected = 'providers' THEN p.provider_name
                   WHEN l.entity_affected = 'categories' THEN c.category_name
                   WHEN l.entity_affected = 'users' THEN tu.full_name END AS entity_name
       FROM admin_logs l
       LEFT JOIN users u ON u.user_id = l.admin_id
       LEFT JOIN providers p ON l.entity_affected = 'providers' AND p.provider_id = l.entity_id
       LEFT JOIN categories c ON l.entity_affected = 'categories' AND c.category_id = l.entity_id
       LEFT JOIN users tu ON l.entity_affected = 'users' AND tu.user_id = l.entity_id
       ORDER BY l.performed_at DESC, l.log_id DESC LIMIT ? OFFSET ?`,
      [String(limit), String((page - 1) * limit)],
    );
    res.json({ total, page, per_page: limit, logs: rows });
  }),
);

/* ------------------------------------------------------------- providers */
router.get(
  '/providers',
  [
    q('status').optional({ values: 'falsy' }).isIn(['pending', 'verified', 'rejected']),
    q('q').optional().trim().isLength({ max: 120 }),
    q('category').optional({ values: 'falsy' }).isInt({ min: 1 }).toInt(),
    q('page').optional().isInt({ min: 1 }).toInt(),
    q('per_page').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  handleValidation,
  asyncRoute(async (req, res) => {
    const page = req.query.page || 1;
    const perPage = req.query.per_page || 20;
    const where = [];
    const params = [];
    if (req.query.status) { where.push('p.verification_status = ?'); params.push(req.query.status); }
    if (req.query.q) {
      where.push('(p.provider_name LIKE ? OR p.location LIKE ? OR p.contact_email LIKE ?)');
      params.push(...Array(3).fill(`%${req.query.q}%`));
    }
    if (req.query.category) {
      where.push('(p.category_id = ? OR c.parent_category_id = ?)');
      params.push(req.query.category, req.query.category);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [{ total }] = await query(
      `SELECT COUNT(*) AS total FROM providers p
       JOIN categories c ON c.category_id = p.category_id ${whereSql}`, params,
    );
    // The verification queue is worked oldest first; everything else newest first.
    const order = req.query.status === 'pending'
      ? 'p.created_at ASC, p.provider_id ASC' : 'p.created_at DESC, p.provider_id DESC';
    const rows = await query(
      `SELECT p.provider_id, p.provider_name, p.category_id, c.category_name,
              p.location, p.verification_status, p.contact_email, p.created_at,
              (SELECT COUNT(*) FROM provider_media m
                WHERE m.provider_id = p.provider_id AND m.media_type = 'evidence') AS evidence_count
       FROM providers p JOIN categories c ON c.category_id = p.category_id
       ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...params, String(perPage), String((page - 1) * perPage)],
    );
    res.json({
      total, page, per_page: perPage, pages: Math.max(1, Math.ceil(total / perPage)), providers: rows,
    });
  }),
);

router.get(
  '/providers/:id',
  [idParam()],
  handleValidation,
  asyncRoute(async (req, res) => {
    const provider = await one(
      `SELECT p.*, c.category_name FROM providers p
       JOIN categories c ON c.category_id = p.category_id WHERE p.provider_id = ?`,
      [req.params.id],
    );
    if (!provider) return res.status(404).json({ error: 'provider not found' });
    const files = await query(
      `SELECT media_id, file_path, media_type FROM provider_media
       WHERE provider_id = ? ORDER BY media_id`, [req.params.id],
    );
    const history = await query(
      `SELECT l.action_type, l.notes, l.performed_at, u.full_name AS admin_name
       FROM admin_logs l LEFT JOIN users u ON u.user_id = l.admin_id
       WHERE l.entity_affected = 'providers' AND l.entity_id = ?
       ORDER BY l.performed_at DESC, l.log_id DESC LIMIT 20`, [req.params.id],
    );
    return res.json({ provider, media: files, history });
  }),
);

const providerRules = [
  body('provider_name').trim().isLength({ min: 2, max: 150 }),
  body('category_id').isInt({ min: 1 }).toInt(),
  body('service_description').trim().isLength({ min: 20, max: 4000 }),
  body('service_tags').optional({ values: 'falsy' }).trim().isLength({ max: 255 }),
  body('location').trim().isLength({ min: 2, max: 120 }),
  body('qualifications').optional({ values: 'falsy' }).trim().isLength({ max: 2000 }),
  body('contact_email').optional({ values: 'falsy' }).isEmail().normalizeEmail(),
];

/** Tags are stored the way the seed stores them: lowercase, hyphenated, comma separated. */
const cleanTags = (tags) => {
  if (!tags) return null;
  const list = [...new Set(String(tags).split(',')
    .map((t) => t.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}-]/gu, ''))
    .filter(Boolean))];
  return list.length ? list.join(',').slice(0, 255) : null;
};

/** Providers attach to categories without children (the leaves of the tree). */
async function assignableCategory(categoryId) {
  return one(
    `SELECT c.category_id FROM categories c WHERE c.category_id = ?
       AND NOT EXISTS (SELECT 1 FROM categories k WHERE k.parent_category_id = c.category_id)`,
    [categoryId],
  );
}

router.post(
  '/providers', providerRules, handleValidation,
  asyncRoute(async (req, res) => {
    const {
      provider_name, category_id, service_description, service_tags,
      location, qualifications = null, contact_email = null,
    } = req.body;
    if (!await assignableCategory(category_id)) {
      return res.status(422).json({ error: 'unknown category_id, or a category that has sub-categories' });
    }
    const id = await transaction(async (tx) => {
      const result = await tx.query(
        `INSERT INTO providers
           (provider_name, category_id, service_description, service_tags, location,
            qualifications, contact_email, verification_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [provider_name, category_id, service_description, cleanTags(service_tags), location,
          qualifications || null, contact_email || null],
      );
      // New listings start pending, so they are NOT recommendable yet (Table 4.4).
      await logAction(tx, req.user.user_id, 'create', 'providers', result.insertId);
      return result.insertId;
    });
    return res.status(201).json({ provider_id: id, verification_status: 'pending' });
  }),
);

router.put(
  '/providers/:id',
  [idParam(), ...providerRules],
  handleValidation,
  asyncRoute(async (req, res) => {
    const existing = await one(
      'SELECT provider_id, verification_status FROM providers WHERE provider_id = ?',
      [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'provider not found' });
    const {
      provider_name, category_id, service_description, service_tags,
      location, qualifications = null, contact_email = null,
    } = req.body;
    if (!await assignableCategory(category_id)) {
      return res.status(422).json({ error: 'unknown category_id, or a category that has sub-categories' });
    }
    await transaction(async (tx) => {
      await tx.query(
        `UPDATE providers SET provider_name = ?, category_id = ?, service_description = ?,
                service_tags = ?, location = ?, qualifications = ?, contact_email = ?
         WHERE provider_id = ?`,
        [provider_name, category_id, service_description, cleanTags(service_tags), location,
          qualifications || null, contact_email || null, req.params.id],
      );
      await logAction(tx, req.user.user_id, 'update', 'providers', req.params.id);
    });
    // The content text changed, so the encoder must see it again.
    if (existing.verification_status === 'verified') ml.reindexQuietly();
    return res.json({ status: 'updated', provider_id: req.params.id });
  }),
);

router.put(
  '/providers/:id/verify',
  [
    idParam(),
    body('verification_status').isIn(['pending', 'verified', 'rejected']),
    body('note').optional({ values: 'falsy' }).trim().isLength({ max: 500 }),
  ],
  handleValidation,
  asyncRoute(async (req, res) => {
    const { verification_status } = req.body;
    const note = req.body.note || null;
    // Table 4.4 alternative flow: a rejection says what further information is needed.
    if (verification_status === 'rejected' && (!note || note.length < 5)) {
      return res.status(422).json({
        error: 'say what is missing when rejecting a listing',
        details: [{ field: 'note', message: 'required when rejecting (at least 5 characters)' }],
      });
    }
    const provider = await one(
      'SELECT provider_id, verification_status FROM providers WHERE provider_id = ?',
      [req.params.id]);
    if (!provider) return res.status(404).json({ error: 'provider not found' });

    await transaction(async (tx) => {
      await tx.query('UPDATE providers SET verification_status = ? WHERE provider_id = ?',
        [verification_status, req.params.id]);
      await logAction(tx, req.user.user_id, `verify:${verification_status}`,
        'providers', req.params.id, note);
    });

    // Figure 4.4 steps 16-17: the searchable catalogue changed, so the content
    // feature vectors are re-indexed. A newly verified listing has no column in
    // the user-item matrix, so only the content component can reach it.
    if (verification_status === 'verified' || provider.verification_status === 'verified') {
      ml.reindexQuietly();
    }
    return res.json({ status: 'updated', provider_id: req.params.id, verification_status });
  }),
);

router.delete(
  '/providers/:id',
  [idParam()],
  handleValidation,
  asyncRoute(async (req, res) => {
    const provider = await one(
      'SELECT provider_id, provider_name, verification_status FROM providers WHERE provider_id = ?',
      [req.params.id]);
    if (!provider) return res.status(404).json({ error: 'provider not found' });
    const files = await query('SELECT file_path FROM provider_media WHERE provider_id = ?',
      [req.params.id]);
    await transaction(async (tx) => {
      await tx.query('DELETE FROM providers WHERE provider_id = ?', [req.params.id]);
      await logAction(tx, req.user.user_id, 'delete', 'providers', req.params.id,
        provider.provider_name);
    });
    files.forEach((f) => media.remove(f.file_path));
    if (provider.verification_status === 'verified') ml.reindexQuietly();
    return res.json({ status: 'deleted', provider_id: req.params.id });
  }),
);

/* ---------------------------------------------- supporting evidence, images */
router.post(
  '/providers/:id/media',
  express.raw({ type: media.ACCEPTED, limit: media.MAX_BYTES }),
  [idParam(), q('kind').isIn(['evidence', 'image'])],
  handleValidation,
  asyncRoute(async (req, res) => {
    const provider = await one('SELECT provider_id FROM providers WHERE provider_id = ?',
      [req.params.id]);
    if (!provider) return res.status(404).json({ error: 'provider not found' });
    const type = media.sniff(req.body);
    if (!type) {
      return res.status(415).json({ error: 'upload a PDF, PNG or JPEG file' });
    }
    if (req.query.kind === 'image' && type.ext === 'pdf') {
      return res.status(415).json({ error: 'a profile image must be PNG or JPEG' });
    }
    const name = media.store(req.params.id, req.body, req.query.kind);
    let mediaId;
    try {
      mediaId = await transaction(async (tx) => {
        const r = await tx.query(
          'INSERT INTO provider_media (provider_id, file_path, media_type) VALUES (?, ?, ?)',
          [req.params.id, name, req.query.kind]);
        await logAction(tx, req.user.user_id, `upload:${req.query.kind}`, 'providers',
          req.params.id, String(req.get('X-File-Name') || name).slice(0, 200));
        return r.insertId;
      });
    } catch (err) {
      media.remove(name);
      throw err;
    }
    return res.status(201).json({ media_id: mediaId, media_type: req.query.kind, file_path: name });
  }),
);

router.get(
  '/media/:mediaId',
  [idParam('mediaId')],
  handleValidation,
  asyncRoute(async (req, res) => {
    const row = await one('SELECT file_path FROM provider_media WHERE media_id = ?',
      [req.params.mediaId]);
    const file = row && media.resolve(row.file_path);
    if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'file not found' });
    res.type(media.mimeFor(row.file_path));
    res.set('Cache-Control', 'private, no-store');
    return res.sendFile(file);
  }),
);

router.delete(
  '/media/:mediaId',
  [idParam('mediaId')],
  handleValidation,
  asyncRoute(async (req, res) => {
    const row = await one('SELECT media_id, provider_id, file_path, media_type FROM provider_media WHERE media_id = ?',
      [req.params.mediaId]);
    if (!row) return res.status(404).json({ error: 'file not found' });
    await transaction(async (tx) => {
      await tx.query('DELETE FROM provider_media WHERE media_id = ?', [row.media_id]);
      await logAction(tx, req.user.user_id, `delete:${row.media_type}`, 'providers',
        row.provider_id, row.file_path);
    });
    media.remove(row.file_path);
    return res.json({ status: 'deleted', media_id: row.media_id });
  }),
);

/* ------------------------------------------------------------ categories */
router.get('/categories', asyncRoute(async (_req, res) => {
  const rows = await query(
    `SELECT c.category_id, c.category_name, c.description, c.parent_category_id,
            (SELECT COUNT(*) FROM providers p WHERE p.category_id = c.category_id) AS provider_count,
            (SELECT COUNT(*) FROM providers p WHERE p.category_id = c.category_id
               AND p.verification_status = 'verified') AS verified_count,
            (SELECT COUNT(*) FROM categories k WHERE k.parent_category_id = c.category_id) AS child_count
     FROM categories c
     ORDER BY COALESCE(c.parent_category_id, c.category_id), c.parent_category_id IS NOT NULL,
              c.category_name`,
  );
  res.json({ categories: rows });
}));

const categoryRules = [
  body('category_name').trim().isLength({ min: 2, max: 120 }),
  body('description').optional({ values: 'falsy' }).trim().isLength({ max: 1000 }),
  body('parent_category_id').optional({ values: 'null' }).isInt({ min: 1 }).toInt(),
];

/** The tree is two levels deep: service types, and the categories under them. */
async function checkParent(parentId, selfId = null) {
  if (!parentId) return null;
  if (selfId && parentId === selfId) return 'a category cannot be its own parent';
  const parent = await one('SELECT category_id, parent_category_id FROM categories WHERE category_id = ?',
    [parentId]);
  if (!parent) return 'unknown parent_category_id';
  if (parent.parent_category_id !== null) return 'the parent must be a top-level category';
  if (await one('SELECT provider_id FROM providers WHERE category_id = ? LIMIT 1', [parentId])) {
    return 'that parent already holds providers directly; move them first';
  }
  return null;
}

router.post(
  '/categories', categoryRules, handleValidation,
  asyncRoute(async (req, res) => {
    const { category_name, description = null, parent_category_id = null } = req.body;
    const problem = await checkParent(parent_category_id);
    if (problem) return res.status(422).json({ error: problem });
    if (await one('SELECT category_id FROM categories WHERE LOWER(category_name) = LOWER(?)',
      [category_name])) {
      return res.status(409).json({ error: 'a category with that name already exists' });
    }
    const id = await transaction(async (tx) => {
      const result = await tx.query(
        `INSERT INTO categories (category_name, description, parent_category_id)
         VALUES (?, ?, ?)`, [category_name, description || null, parent_category_id || null],
      );
      await logAction(tx, req.user.user_id, 'create', 'categories', result.insertId);
      return result.insertId;
    });
    return res.status(201).json({ category_id: id });
  }),
);

router.put(
  '/categories/:id', [idParam(), ...categoryRules], handleValidation,
  asyncRoute(async (req, res) => {
    const { category_name, description = null, parent_category_id = null } = req.body;
    const cat = await one('SELECT category_id FROM categories WHERE category_id = ?', [req.params.id]);
    if (!cat) return res.status(404).json({ error: 'category not found' });
    const problem = await checkParent(parent_category_id, req.params.id);
    if (problem) return res.status(422).json({ error: problem });
    if (parent_category_id && await one(
      'SELECT category_id FROM categories WHERE parent_category_id = ? LIMIT 1', [req.params.id])) {
      return res.status(422).json({ error: 'a category with sub-categories must stay top-level' });
    }
    if (await one(
      'SELECT category_id FROM categories WHERE LOWER(category_name) = LOWER(?) AND category_id <> ?',
      [category_name, req.params.id])) {
      return res.status(409).json({ error: 'a category with that name already exists' });
    }
    await transaction(async (tx) => {
      await tx.query(
        'UPDATE categories SET category_name = ?, description = ?, parent_category_id = ? WHERE category_id = ?',
        [category_name, description || null, parent_category_id || null, req.params.id]);
      await logAction(tx, req.user.user_id, 'update', 'categories', req.params.id);
    });
    // The category name is part of every listing's content text.
    ml.reindexQuietly();
    return res.json({ status: 'updated', category_id: req.params.id });
  }),
);

router.delete(
  '/categories/:id', [idParam()], handleValidation,
  asyncRoute(async (req, res) => {
    const cat = await one(
      `SELECT c.category_id, c.category_name,
              (SELECT COUNT(*) FROM providers p WHERE p.category_id = c.category_id) AS providers,
              (SELECT COUNT(*) FROM categories k WHERE k.parent_category_id = c.category_id) AS children
       FROM categories c WHERE c.category_id = ?`, [req.params.id]);
    if (!cat) return res.status(404).json({ error: 'category not found' });
    if (cat.providers || cat.children) {
      return res.status(409).json({
        error: `move its ${cat.providers ? `${cat.providers} provider(s)` : `${cat.children} sub-categories`} first`,
      });
    }
    await transaction(async (tx) => {
      await tx.query('DELETE FROM categories WHERE category_id = ?', [req.params.id]);
      await logAction(tx, req.user.user_id, 'delete', 'categories', req.params.id, cat.category_name);
    });
    return res.json({ status: 'deleted', category_id: req.params.id });
  }),
);

/* ----------------------------------------------------------------- users */
router.get(
  '/users',
  [
    q('q').optional().trim().isLength({ max: 120 }),
    q('role').optional({ values: 'falsy' }).isIn(['user', 'admin']),
    q('page').optional().isInt({ min: 1 }).toInt(),
  ],
  handleValidation,
  asyncRoute(async (req, res) => {
    const page = req.query.page || 1;
    const perPage = 25;
    const where = [];
    const params = [];
    if (req.query.q) {
      where.push('(u.full_name LIKE ? OR u.email LIKE ? OR u.location LIKE ?)');
      params.push(...Array(3).fill(`%${req.query.q}%`));
    }
    if (req.query.role) { where.push('u.role = ?'); params.push(req.query.role); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [{ total }] = await query(`SELECT COUNT(*) AS total FROM users u ${whereSql}`, params);
    const rows = await query(
      `SELECT u.user_id, u.full_name, u.email, u.location, u.role, u.created_at,
              (SELECT COUNT(*) FROM interactions i WHERE i.user_id = u.user_id) AS interactions,
              (SELECT COUNT(*) FROM saved_services s WHERE s.user_id = u.user_id) AS saved,
              (SELECT COUNT(*) FROM search_history h WHERE h.user_id = u.user_id) AS searches
       FROM users u ${whereSql}
       ORDER BY u.role = 'admin' DESC, u.created_at DESC, u.user_id DESC LIMIT ? OFFSET ?`,
      [...params, String(perPage), String((page - 1) * perPage)],
    );
    res.json({ total, page, per_page: perPage, pages: Math.max(1, Math.ceil(total / perPage)), users: rows });
  }),
);

router.put(
  '/users/:id/role',
  [idParam(), body('role').isIn(['user', 'admin'])],
  handleValidation,
  asyncRoute(async (req, res) => {
    if (req.params.id === Number(req.user.user_id)) {
      return res.status(422).json({ error: 'you cannot change your own role' });
    }
    const target = await one('SELECT user_id, role FROM users WHERE user_id = ?', [req.params.id]);
    if (!target) return res.status(404).json({ error: 'user not found' });
    if (target.role === req.body.role) return res.json({ status: 'unchanged', role: target.role });
    await transaction(async (tx) => {
      await tx.query('UPDATE users SET role = ? WHERE user_id = ?', [req.body.role, req.params.id]);
      const [{ admins }] = await tx.query("SELECT COUNT(*) AS admins FROM users WHERE role = 'admin'");
      if (!admins) {
        const err = new Error('the platform must keep at least one administrator');
        err.status = 422;
        throw err;
      }
      await logAction(tx, req.user.user_id, `role:${req.body.role}`, 'users', req.params.id);
    });
    return res.json({ status: 'updated', user_id: req.params.id, role: req.body.role });
  }),
);

/* --------------------------------------------------------------- reports */
const PERIODS = { 7: 7, 30: 30, 90: 90, all: null };

router.get(
  '/reports',
  [q('period').optional().isIn(Object.keys(PERIODS))],
  handleValidation,
  asyncRoute(async (req, res) => {
    const days = PERIODS[req.query.period || 'all'];
    const since = (col) => (days ? `${col} > DATE_SUB(NOW(), INTERVAL ${Number(days)} DAY)` : '1 = 1');

    const [interactionsByType, searchesByCategory, topQueries, topProviders,
      engagementByType, recSummary, quality, duplicates] = await Promise.all([
      query(`SELECT interaction_type, COUNT(*) AS n FROM interactions
             WHERE ${since('created_at')} GROUP BY interaction_type ORDER BY n DESC`),
      query(`SELECT COALESCE(c.category_name, s.category_filter) AS category, COUNT(*) AS n
             FROM search_history s
             LEFT JOIN categories c ON ${CATEGORY_FILTER_JOIN}
             WHERE s.category_filter IS NOT NULL AND s.category_filter <> ''
               AND ${since('s.searched_at')}
             GROUP BY category ORDER BY n DESC LIMIT 12`),
      query(`SELECT LOWER(TRIM(query_text)) AS query_text, COUNT(*) AS n FROM search_history
             WHERE query_text IS NOT NULL AND query_text <> '' AND ${since('searched_at')}
             GROUP BY LOWER(TRIM(query_text)) ORDER BY n DESC LIMIT 12`),
      query(`SELECT p.provider_id, p.provider_name, c.category_name, COUNT(*) AS n,
                    SUM(i.interaction_type = 'save') AS saves,
                    ROUND(AVG(CASE WHEN i.interaction_type = 'rating' THEN i.rating_value END), 1) AS avg_rating
             FROM interactions i JOIN providers p ON p.provider_id = i.provider_id
             JOIN categories c ON c.category_id = p.category_id
             WHERE ${since('i.created_at')}
             GROUP BY p.provider_id ORDER BY n DESC LIMIT 10`),
      query(`SELECT COALESCE(pc.category_name, c.category_name) AS service_type, COUNT(*) AS n
             FROM interactions i JOIN providers p ON p.provider_id = i.provider_id
             JOIN categories c ON c.category_id = p.category_id
             LEFT JOIN categories pc ON pc.category_id = c.parent_category_id
             WHERE ${since('i.created_at')}
             GROUP BY service_type ORDER BY n DESC`),
      query(`SELECT COUNT(*) AS rows_stored, COUNT(DISTINCT user_id) AS users_served,
                    ROUND(AVG(content_score), 3) AS avg_content,
                    ROUND(AVG(collaborative_score), 3) AS avg_collaborative,
                    ROUND(AVG(hybrid_score), 3) AS avg_hybrid,
                    SUM(collaborative_score > 0) AS with_collaborative,
                    MAX(generated_at) AS last_generated
             FROM recommendations WHERE ${since('generated_at')}`),
      query(`SELECT p.provider_id, p.provider_name, p.verification_status, p.created_at,
                    (p.qualifications IS NULL OR TRIM(p.qualifications) = '') AS no_qualifications,
                    (p.contact_email IS NULL OR TRIM(p.contact_email) = '') AS no_contact,
                    (p.service_tags IS NULL OR TRIM(p.service_tags) = '') AS no_tags,
                    (CHAR_LENGTH(COALESCE(p.service_description, '')) < 80) AS short_description,
                    (p.verification_status = 'pending'
                      AND p.created_at < DATE_SUB(NOW(), INTERVAL 14 DAY)) AS stale_pending,
                    (p.verification_status = 'pending' AND NOT EXISTS (
                      SELECT 1 FROM provider_media m WHERE m.provider_id = p.provider_id
                        AND m.media_type = 'evidence')) AS pending_without_evidence
             FROM providers p
             HAVING no_qualifications OR no_contact OR no_tags OR short_description
                    OR stale_pending OR pending_without_evidence
             ORDER BY p.verification_status = 'pending' DESC, p.provider_name LIMIT 100`),
      query(`SELECT LOWER(TRIM(provider_name)) AS name, COUNT(*) AS n,
                    GROUP_CONCAT(provider_id ORDER BY provider_id) AS ids
             FROM providers GROUP BY LOWER(TRIM(provider_name)) HAVING n > 1`),
    ]);

    res.json({
      period: req.query.period || 'all',
      interactions_by_type: interactionsByType,
      searches_by_category: searchesByCategory,
      top_queries: topQueries,
      top_providers: topProviders,
      engagement_by_service_type: engagementByType,
      recommendations: recSummary[0] || {},
      data_quality: { issues: quality, duplicate_names: duplicates },
    });
  }),
);

/* ----------------------------------------------------------------- model */
router.post('/model/reindex', asyncRoute(async (req, res) => {
  const out = await ml.reindex();
  await logAction({ query }, req.user.user_id, 'model:reindex', 'model', null);
  res.json(out);
}));

router.post('/model/retrain', asyncRoute(async (req, res) => {
  const out = await ml.retrain();
  await logAction({ query }, req.user.user_id, 'model:retrain', 'model', null,
    out.alpha !== undefined ? `alpha ${out.alpha} (${out.alpha_source})`.slice(0, 500) : null);
  res.json(out);
}));

module.exports = router;
