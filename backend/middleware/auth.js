/**
 * Authentication and role-based access control (Section 4.11).
 *
 * Passwords are hashed with bcrypt; sessions are signed JWTs carrying the user
 * id and role. `requireAdmin` is what stops a signed-in parent from reaching
 * the management endpoints.
 */
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h';
const ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);

const hashPassword = (plain) => bcrypt.hash(plain, ROUNDS);
const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

function issueToken(user) {
  return jwt.sign(
    { sub: user.user_id, role: user.role, name: user.full_name },
    SECRET,
    { expiresIn: EXPIRES_IN }
  );
}

function readToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

/** Populates req.user, or 401. */
function requireAuth(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: 'authentication required' });
  try {
    const claims = jwt.verify(token, SECRET);
    req.user = { user_id: claims.sub, role: claims.role, full_name: claims.name };
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid or expired session' });
  }
}

/** Populates req.user when a token is present, but never rejects. */
function optionalAuth(req, _res, next) {
  const token = readToken(req);
  if (token) {
    try {
      const claims = jwt.verify(token, SECRET);
      req.user = { user_id: claims.sub, role: claims.role, full_name: claims.name };
    } catch { /* anonymous browsing is allowed */ }
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'authentication required' });
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'administrator role required' });
  }
  return next();
}

module.exports = {
  hashPassword, verifyPassword, issueToken,
  requireAuth, optionalAuth, requireAdmin, SECRET,
};
