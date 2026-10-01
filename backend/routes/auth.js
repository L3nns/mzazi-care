/** Registration, login, profile and declared preferences (FR-01, FR-02). */
const express = require('express');
const { body } = require('express-validator');
const { query, one } = require('../config/db');
const { handleValidation } = require('../middleware/validate');
const { asyncRoute } = require('../middleware/errors');
const {
  hashPassword, verifyPassword, issueToken, requireAuth,
} = require('../middleware/auth');

const router = express.Router();

router.post(
  '/register',
  [
    body('full_name').trim().isLength({ min: 2, max: 150 }),
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }).withMessage('at least 8 characters'),
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
      [full_name, email, hash, phone_number, location],
    );
    const user = {
      user_id: result.insertId, full_name, email, location, role: 'user',
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
      return res.status(401).json({ error: 'invalid email or password' });
    }
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
      [...fields.map((f) => req.body[f]), req.user.user_id],
    );
    return res.json({ status: 'updated', fields });
  }),
);

/** Declared category preferences - the cold-start signal (FR-02). */
router.put(
  '/me/preferences',
  requireAuth,
  [
    body('category_ids').isArray({ min: 0, max: 20 }),
    body('category_ids.*').isInt({ min: 1 }),
    body('preferred_location').optional().trim().isLength({ max: 120 }),
  ],
  handleValidation,
  asyncRoute(async (req, res) => {
    const { category_ids, preferred_location = null } = req.body;
    await query('DELETE FROM user_preferences WHERE user_id = ?', [req.user.user_id]);
    for (const cid of category_ids) {
      await query(
        `INSERT INTO user_preferences (user_id, category_id, preferred_location, preference_weight)
         VALUES (?, ?, ?, 1.00)`,
        [req.user.user_id, cid, preferred_location],
      );
    }
    return res.json({ status: 'updated', count: category_ids.length });
  }),
);

module.exports = router;
