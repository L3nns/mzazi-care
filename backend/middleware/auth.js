/**
 * Authentication and role-based access control (Section 4.11).
 *
 * Passwords are hashed with bcrypt; sessions are signed JWTs carrying the user
 * id and role. `requireAdmin` is what stops a signed-in parent from reaching
 * the management endpoints.
 */
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { one } = require('../config/db');

// Anyone who knows the signing secret can mint an administrator token, so a
// production server refuses to start with a missing or placeholder secret.
const DEV_SECRET = 'change-me-in-production';
const PLACEHOLDER = /^(change-me|replace-with|dev-jwt-secret)/i;
function resolveSecret(raw, env) {
  const weak = !raw || PLACEHOLDER.test(raw) || raw.length < 32;
  if (!weak) return raw;
  if (env === 'production') {
    throw new Error('JWT_SECRET is missing or a placeholder; set a random '
      + 'value of at least 32 characters (openssl rand -hex 32)');
  }
  if (env !== 'test') require('../services/logger').log.warn('weak JWT_SECRET - development use only');
  return raw || DEV_SECRET;
}
const SECRET = resolveSecret(process.env.JWT_SECRET, process.env.NODE_ENV);
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h';
const ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);

const hashPassword = (plain) => bcrypt.hash(plain, ROUNDS);
const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

/**
 * Every token carries the user's token_version. Changing the password, changing
 * the role or signing out everywhere increments it, which revokes every token
 * issued before - a stateless JWT cannot otherwise be withdrawn.
 */
function issueToken(user) {
  return jwt.sign(
    { sub: user.user_id, role: user.role, name: user.full_name, tv: user.token_version || 0 },
    SECRET,
    { expiresIn: EXPIRES_IN }
  );
}

/**
 * After a correct password on an account with two-step sign-in, the client
 * gets this short-lived challenge instead of a session. It only unlocks the
 * code check, and it dies with the session version like any other token.
 */
function issueMfaChallenge(user) {
  return jwt.sign({ sub: user.user_id, purpose: 'mfa', tv: user.token_version || 0 },
    SECRET, { expiresIn: '5m' });
}

function readMfaChallenge(token) {
  try {
    const claims = jwt.verify(String(token || ''), SECRET);
    return claims.purpose === 'mfa' ? claims : null;
  } catch { return null; }
}

/** Key material for encrypting TOTP secrets; a separate key survives JWT rotation. */
const MFA_KEY = process.env.MFA_ENCRYPTION_KEY || SECRET;

function readToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

/**
 * Verifies the signature, then checks the account still exists and the token
 * has not been revoked. The role comes from the database, not the token.
 * Returns the user, or null with a reason.
 */
async function resolveSession(token) {
  let claims;
  try { claims = jwt.verify(token, SECRET); } catch { return { reason: 'invalid or expired session' }; }
  // A half-finished two-step sign-in token is not a session.
  if (claims.purpose) return { reason: 'invalid or expired session' };
  const row = await one('SELECT role, token_version FROM users WHERE user_id = ?', [claims.sub]);
  if (!row || Number(row.token_version || 0) !== Number(claims.tv || 0)) {
    return { reason: 'this session has been signed out' };
  }
  return {
    user: { user_id: claims.sub, role: row.role, full_name: claims.name, roleFromDb: true },
  };
}

/** Populates req.user, or 401. */
async function requireAuth(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: 'authentication required' });
  try {
    const { user, reason } = await resolveSession(token);
    if (!user) return res.status(401).json({ error: reason });
    req.user = user;
    return next();
  } catch (err) {
    return next(err);
  }
}

/** Populates req.user when a valid token is present, but never rejects. */
async function optionalAuth(req, _res, next) {
  const token = readToken(req);
  if (token) {
    try {
      const { user } = await resolveSession(token);
      if (user) req.user = user;
    } catch { /* anonymous browsing is allowed */ }
  }
  return next();
}

/**
 * The role is re-read from the database rather than trusted from the token,
 * so an administrator who is demoted loses access at once, not when their
 * session expires. requireAuth has already read it in this request.
 */
async function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'authentication required' });
  try {
    const row = req.user.roleFromDb ? { role: req.user.role }
      : await one('SELECT role FROM users WHERE user_id = ?', [req.user.user_id]);
    if (!row || row.role !== 'admin') {
      return res.status(403).json({ error: 'administrator role required' });
    }
    req.user.role = 'admin';
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  hashPassword, verifyPassword, issueToken,
  requireAuth, optionalAuth, requireAdmin, SECRET, resolveSecret,
  issueMfaChallenge, readMfaChallenge, MFA_KEY,
};
