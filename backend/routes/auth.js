/** Registration, login, profile and declared preferences (FR-01, FR-02). */
const express = require('express');
const { body } = require('express-validator');
const { query, one, transaction } = require('../config/db');
const { CATEGORY_FILTER_JOIN } = require('../services/catalog');
const { handleValidation } = require('../middleware/validate');
const { asyncRoute } = require('../middleware/errors');
const {
  hashPassword, verifyPassword, issueToken, requireAuth,
} = require('../middleware/auth');

const router = express.Router();

/** Sign-ins to administrator accounts go to the audit trail (Figure 4.6). */
const logAdminAuth = (adminId, action) => query(
  `INSERT INTO admin_logs (admin_id, action_type, entity_affected, entity_id)
   VALUES (?, ?, 'users', ?)`, [adminId, action, adminId],
).catch((err) => console.warn('[auth] could not log sign-in:', err.message));

router.post(
  '/register',
  [
    body('full_name').trim().isLength({ min: 2, max: 150 }),
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8, max: 200 }).withMessage('at least 8 characters'),
    body('location').optional().trim().isLength({ max: 120 }),
    body('phone_number').optional().trim().isLength({ max: 20 }),
  ],
  handleValidation,
  asyncRoute(async (req, res) => {
    const { full_name, email, password, location = null, phone_number = null } = req.body;
    if (await one('SELECT user_id FROM users WHERE email = ?', [email])) {
      return res.status(409).json({ error: 'that email is already registered' });
    }
    const hash = await hashPassword(password);
    const result = await query(
      `INSERT INTO users (full_name, email, password_hash, phone_number, location, role)
       VALUES (?, ?, ?, ?, ?, 'user')`,
      [full_name, email, hash, phone_number, location || null],
    );
    const user = {
      user_id: result.insertId, full_name, email, location: location || null, role: 'user',
    };
    return res.status(201).json({ token: issueToken(user), user });
  }),
);

router.post(
  '/login',
  [body('email').isEmail().normalizeEmail(), body('password').notEmpty()],
  handleValidation,
  asyncRoute(async (req, res) => {
    const { email, password } = req.body;
    const user = await one(
      `SELECT user_id, full_name, email, password_hash, location, role
       FROM users WHERE email = ?`, [email],
    );
    // Same response whether the email is unknown or the password is wrong, so
    // the endpoint cannot be used to enumerate registered addresses.
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      if (user && user.role === 'admin') await logAdminAuth(user.user_id, 'auth:login_failed');
      return res.status(401).json({ error: 'invalid email or password' });
    }
    if (user.role === 'admin') await logAdminAuth(user.user_id, 'auth:login');
    delete user.password_hash;
    return res.json({ token: issueToken(user), user });
  }),
);

router.get('/me', requireAuth, asyncRoute(async (req, res) => {
  const user = await one(
    `SELECT user_id, full_name, email, phone_number, location, role, created_at
     FROM users WHERE user_id = ?`, [req.user.user_id],
  );
  if (!user) return res.status(404).json({ error: 'not found' });
  const preferences = await query(
    `SELECT p.preference_id, p.category_id, c.category_name,
            p.preferred_location, p.preference_weight
     FROM user_preferences p JOIN categories c ON c.category_id = p.category_id
     WHERE p.user_id = ?`, [req.user.user_id],
  );
  return res.json({ user, preferences });
}));

router.put(
  '/me',
  requireAuth,
  [
    body('full_name').optional().trim().isLength({ min: 2, max: 150 }),
    body('location').optional().trim().isLength({ max: 120 }),
    body('phone_number').optional().trim().isLength({ max: 20 }),
  ],
  handleValidation,
  asyncRoute(async (req, res) => {
    const fields = ['full_name', 'location', 'phone_number']
      .filter((f) => req.body[f] !== undefined);
    if (!fields.length) return res.status(422).json({ error: 'nothing to update' });
    await query(
      `UPDATE users SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE user_id = ?`,
      [...fields.map((f) => req.body[f] || null), req.user.user_id],
    );
    const user = await one(
      `SELECT user_id, full_name, email, phone_number, location, role
       FROM users WHERE user_id = ?`, [req.user.user_id],
    );
    // The name travels in the token, so hand back a fresh one.
    return res.json({ status: 'updated', fields, user, token: issueToken(user) });
  }),
);

router.put(
  '/me/password',
  requireAuth,
  [
    body('current_password').notEmpty(),
    body('new_password').isLength({ min: 8, max: 200 }).withMessage('at least 8 characters'),
  ],
  handleValidation,
  asyncRoute(async (req, res) => {
    const row = await one('SELECT password_hash FROM users WHERE user_id = ?',
      [req.user.user_id]);
    if (!row || !(await verifyPassword(req.body.current_password, row.password_hash))) {
      return res.status(403).json({ error: 'the current password is not correct' });
    }
    if (req.body.current_password === req.body.new_password) {
      return res.status(422).json({ error: 'choose a password you have not used here' });
    }
    await query('UPDATE users SET password_hash = ? WHERE user_id = ?',
      [await hashPassword(req.body.new_password), req.user.user_id]);
    return res.json({ status: 'updated' });
  }),
);

/** Declared category preferences - the cold-start signal (FR-02). */
router.put(
  '/me/preferences',
  requireAuth,
  [
    body('category_ids').isArray({ min: 0, max: 30 }),
    body('category_ids.*').isInt({ min: 1 }).toInt(),
    body('preferred_location').optional({ nullable: true }).trim().isLength({ max: 120 }),
  ],
  handleValidation,
  asyncRoute(async (req, res) => {
    const ids = [...new Set(req.body.category_ids)];
    const location = req.body.preferred_location || null;
    if (ids.length) {
      const known = await query(
        `SELECT category_id FROM categories WHERE category_id IN (${ids.map(() => '?').join(',')})`,
        ids,
      );
      if (known.length !== ids.length) {
        return res.status(422).json({ error: 'unknown category in category_ids' });
      }
    }
    // Replace the whole set atomically, so a failure cannot leave it half-written.
    await transaction(async (tx) => {
      await tx.query('DELETE FROM user_preferences WHERE user_id = ?', [req.user.user_id]);
      for (const cid of ids) {
        await tx.query(
          `INSERT INTO user_preferences (user_id, category_id, preferred_location, preference_weight)
           VALUES (?, ?, ?, 1.00)`,
          [req.user.user_id, cid, location],
        );
      }
    });
    return res.json({ status: 'updated', count: ids.length, preferred_location: location });
  }),
);

/** The user's own search history (Figure 4.12). */
router.get('/me/searches', requireAuth, asyncRoute(async (req, res) => {
  const rows = await query(
    `SELECT s.search_id, s.query_text, s.category_filter, c.category_name,
            s.location_filter, s.searched_at
     FROM search_history s
     LEFT JOIN categories c ON ${CATEGORY_FILTER_JOIN}
     WHERE s.user_id = ? ORDER BY s.searched_at DESC, s.search_id DESC LIMIT 50`,
    [req.user.user_id],
  );
  res.json({ searches: rows });
}));

router.delete('/me/searches', requireAuth, asyncRoute(async (req, res) => {
  const result = await query('DELETE FROM search_history WHERE user_id = ?', [req.user.user_id]);
  res.json({ status: 'cleared', removed: result.affectedRows || 0 });
}));

module.exports = router;
