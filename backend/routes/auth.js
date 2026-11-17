/** Registration, login, profile and declared preferences (FR-01, FR-02). */
const express = require('express');
const { body } = require('express-validator');
const { query, one, transaction } = require('../config/db');
const { CATEGORY_FILTER_JOIN } = require('../services/catalog');
const { handleValidation } = require('../middleware/validate');
const { asyncRoute } = require('../middleware/errors');
const {
  hashPassword, verifyPassword, issueToken, requireAuth,
  issueMfaChallenge, readMfaChallenge, MFA_KEY,
} = require('../middleware/auth');
const totp = require('../services/totp');
const ml = require('../services/mlClient');
const { log } = require('../services/logger');

const router = express.Router();

/** Sign-ins to administrator accounts go to the audit trail (Figure 4.6). */
const logAdminAuth = (adminId, action) => query(
  `INSERT INTO admin_logs (admin_id, action_type, entity_affected, entity_id)
   VALUES (?, ?, 'users', ?)`, [adminId, action, adminId],
).catch((err) => log.warn('could not record admin sign-in', { err }));

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
      `SELECT user_id, full_name, email, password_hash, location, role, token_version, mfa_enabled
       FROM users WHERE email = ?`, [email],
    );
    // Same response whether the email is unknown or the password is wrong, so
    // the endpoint cannot be used to enumerate registered addresses.
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      if (user && user.role === 'admin') await logAdminAuth(user.user_id, 'auth:login_failed');
      return res.status(401).json({ error: 'invalid email or password' });
    }
    // Password was right, but the account also wants a code from its app.
    if (user.mfa_enabled) {
      return res.json({ mfa_required: true, mfa_token: issueMfaChallenge(user) });
    }
    if (user.role === 'admin') await logAdminAuth(user.user_id, 'auth:login');
    return res.json({ token: issueToken(user), user: publicUser(user) });
  }),
);

const publicUser = (u) => ({
  user_id: u.user_id, full_name: u.full_name, email: u.email, location: u.location, role: u.role,
});

/* ----------------------------------------------- two-step sign-in (TOTP) */
const codeRule = body('code').trim().matches(/^\d{6}$/).withMessage('enter the 6-digit code');

/**
 * Accepts a code for the user's stored secret, refusing a step already used
 * (a code seen over someone's shoulder cannot be replayed). Returns true/false.
 */
async function consumeCode(userId, code, { requireEnabled = true } = {}) {
  const row = await one(
    'SELECT mfa_secret, mfa_enabled, mfa_last_step FROM users WHERE user_id = ?', [userId]);
  if (!row || !row.mfa_secret || (requireEnabled && !row.mfa_enabled)) return false;
  let secret;
  try { secret = totp.decrypt(row.mfa_secret, MFA_KEY); } catch { return false; }
  const step = totp.verify(secret, code);
  if (step === null || (row.mfa_last_step !== null && step <= Number(row.mfa_last_step))) return false;
  await query('UPDATE users SET mfa_last_step = ? WHERE user_id = ?', [step, userId]);
  return true;
}

router.post(
  '/mfa/verify',
  [body('mfa_token').isString().notEmpty(), codeRule],
  handleValidation,
  asyncRoute(async (req, res) => {
    const claims = readMfaChallenge(req.body.mfa_token);
    if (!claims) return res.status(401).json({ error: 'the sign-in took too long; start again' });
    const user = await one(
      `SELECT user_id, full_name, email, location, role, token_version, mfa_enabled
       FROM users WHERE user_id = ?`, [claims.sub]);
    if (!user || Number(user.token_version) !== Number(claims.tv || 0)) {
      return res.status(401).json({ error: 'the sign-in took too long; start again' });
    }
    if (!(await consumeCode(user.user_id, req.body.code))) {
      if (user.role === 'admin') await logAdminAuth(user.user_id, 'auth:mfa_failed');
      return res.status(401).json({ error: 'that code is not correct; check your app and try again' });
    }
    if (user.role === 'admin') await logAdminAuth(user.user_id, 'auth:login');
    return res.json({ token: issueToken(user), user: publicUser(user) });
  }),
);

/** Starts enrolment: a new secret, stored encrypted and not yet active. */
router.post('/mfa/setup', requireAuth, asyncRoute(async (req, res) => {
  const user = await one('SELECT email, mfa_enabled FROM users WHERE user_id = ?', [req.user.user_id]);
  if (user.mfa_enabled) return res.status(409).json({ error: 'two-step sign-in is already on' });
  const secret = totp.generateSecret();
  await query('UPDATE users SET mfa_secret = ?, mfa_last_step = NULL WHERE user_id = ?',
    [totp.encrypt(secret, MFA_KEY), req.user.user_id]);
  return res.json({ secret, otpauth_uri: totp.otpauthUri(secret, user.email) });
}));

/** Finishes enrolment once the app produces a matching code. */
router.post('/mfa/enable', requireAuth, [codeRule], handleValidation, asyncRoute(async (req, res) => {
  if (!(await consumeCode(req.user.user_id, req.body.code, { requireEnabled: false }))) {
    return res.status(422).json({ error: 'that code does not match; start the setup again if it keeps failing' });
  }
  await query('UPDATE users SET mfa_enabled = 1 WHERE user_id = ?', [req.user.user_id]);
  if (req.user.role === 'admin') await logAdminAuth(req.user.user_id, 'auth:mfa_enabled');
  return res.json({ status: 'two-step sign-in is on' });
}));

/** Turning it off needs both the password and a current code. */
router.post(
  '/mfa/disable',
  requireAuth,
  [body('password').notEmpty(), codeRule],
  handleValidation,
  asyncRoute(async (req, res) => {
    const row = await one('SELECT password_hash FROM users WHERE user_id = ?', [req.user.user_id]);
    if (!row || !(await verifyPassword(req.body.password, row.password_hash))
      || !(await consumeCode(req.user.user_id, req.body.code))) {
      return res.status(403).json({ error: 'the password or code is not correct' });
    }
    await query(
      'UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_last_step = NULL WHERE user_id = ?',
      [req.user.user_id]);
    if (req.user.role === 'admin') await logAdminAuth(req.user.user_id, 'auth:mfa_disabled');
    return res.json({ status: 'two-step sign-in is off' });
  }),
);

router.get('/me', requireAuth, asyncRoute(async (req, res) => {
  const user = await one(
    `SELECT user_id, full_name, email, phone_number, location, role, created_at, mfa_enabled
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
    // Revokes every other session; this one continues with a fresh token.
    await query(
      `UPDATE users SET password_hash = ?, token_version = token_version + 1
       WHERE user_id = ?`,
      [await hashPassword(req.body.new_password), req.user.user_id],
    );
    const user = await one(
      'SELECT user_id, full_name, email, location, role, token_version FROM users WHERE user_id = ?',
      [req.user.user_id],
    );
    const { token_version: _tv, ...publicUser } = user;
    return res.json({ status: 'updated', token: issueToken(user), user: publicUser });
  }),
);

/** Signs this account out on every device by revoking all issued tokens. */
router.post('/logout-all', requireAuth, asyncRoute(async (req, res) => {
  await query('UPDATE users SET token_version = token_version + 1 WHERE user_id = ?',
    [req.user.user_id]);
  return res.json({ status: 'signed out everywhere' });
}));

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

/**
 * Deletes the signed-in account and everything recorded about it: profile,
 * preferences, searches, views, clicks, saves, ratings, feedback and the
 * recommendations shown (all ON DELETE CASCADE). Needs the password, and the
 * current code when two-step sign-in is on. An administrator must first have
 * the role removed by another administrator, so the audit trail stays whole.
 */
router.delete(
  '/me',
  requireAuth,
  [body('password').notEmpty(), body('code').optional({ values: 'falsy' }).trim().matches(/^\d{6}$/)],
  handleValidation,
  asyncRoute(async (req, res) => {
    const userId = req.user.user_id;
    const row = await one('SELECT password_hash, role, mfa_enabled FROM users WHERE user_id = ?', [userId]);
    if (!row || !(await verifyPassword(req.body.password, row.password_hash))) {
      return res.status(401).json({ error: 'that password is not correct' });
    }
    if (row.role === 'admin') {
      return res.status(409).json({
        error: 'an administrator account cannot be deleted; ask another administrator to remove your admin role first',
      });
    }
    if (row.mfa_enabled && !(req.body.code && await consumeCode(userId, req.body.code))) {
      return res.status(401).json({ error: 'enter the current code from your authenticator app' });
    }
    await query('DELETE FROM users WHERE user_id = ?', [userId]);
    // The serving model still holds this parent's activity until it is refitted.
    ml.reindexQuietly();
    log.info('account deleted by its owner', { user_id: userId });
    return res.json({ status: 'deleted' });
  }),
);

module.exports = router;
