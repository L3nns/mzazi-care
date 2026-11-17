/**
 * Mzazi Care Discovery & Catalog System - application layer.
 *
 * The Express tier of the four-layer architecture in Figure 4.1: it owns
 * business logic, authentication and the REST API, sits between the browser and
 * both the MySQL data layer and the Python recommendation layer, and serves the
 * static front end.
 */
const path = require('path');

// backend/.env wins; the project-root .env (shared with docker compose and
// the ML service) fills in anything it does not set.
require('dotenv').config();
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const { notFound, errorHandler } = require('./middleware/errors');
const ml = require('./services/mlClient');
const { log, requestLogger } = require('./services/logger');

const app = express();
const PORT = Number(process.env.PORT || 4000);

// Behind a reverse proxy (TLS termination), the client address is in
// X-Forwarded-For. Without this every visitor shares the proxy's address and
// the per-client rate limits below become one limit for everyone. Set it to
// the number of proxies in front (usually 1); leave unset when exposed directly.
if (process.env.TRUST_PROXY) {
  const hops = Number(process.env.TRUST_PROXY);
  app.set('trust proxy', Number.isInteger(hops) ? hops : process.env.TRUST_PROXY);
}

// First, so every later line - including errors - carries the request id.
app.use(requestLogger);

/* ------------------------------------------------------------- security */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      // Map images for the search page's map (OpenStreetMap; attribution shown).
      imgSrc: ["'self'", 'data:', 'blob:', 'https://tile.openstreetmap.org'],
      connectSrc: ["'self'"],
    },
  },
}));
// The front end is served from this same origin, so cross-origin calls are
// only allowed for the origins CORS_ORIGIN lists (comma-separated).
const corsOrigins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: corsOrigins.length ? corsOrigins : false, credentials: true }));
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));

app.use('/api', rateLimit({
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT || 300),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many requests, please slow down' },
}));
// Brute-force protection on the credential endpoints specifically.
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60_000, max: 20 }));
app.use('/api/auth/register', rateLimit({ windowMs: 60 * 60_000, max: 10 }));
// Six-digit codes are guessable without a tight limit on attempts.
app.use('/api/auth/mfa', rateLimit({ windowMs: 15 * 60_000, max: 20 }));
// Place search can reach a third-party geocoder that allows one request a second.
app.use('/api/geo', rateLimit({ windowMs: 60_000, max: 30 }));

/* --------------------------------------------------------------- routes */
app.get('/api/health', async (_req, res) => {
  let mlHealth = { status: 'unreachable' };
  try { mlHealth = await ml.health(); } catch (err) { mlHealth.error = err.message; }
  res.json({ status: 'ok', service: 'mzazi-care-api', ml: mlHealth });
});

// The API description; backend/tests/openapi.test.js keeps it in step with the routes.
const OPENAPI = process.env.OPENAPI_FILE
  || path.resolve(__dirname, '..', 'docs', 'api', 'openapi.yaml');
app.get('/api/openapi.yaml', (_req, res) => res.type('application/yaml').sendFile(OPENAPI));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/services', require('./routes/services'));
app.use('/api/interactions', require('./routes/interactions'));
app.use('/api/saved', require('./routes/saved'));
app.use('/api/recommendations', require('./routes/recommendations'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/geo', require('./routes/geo'));

/* ---------------------------------------------------------- front end */
const FRONTEND = process.env.FRONTEND_DIR
  || path.resolve(__dirname, '..', 'frontend');
app.use(express.static(FRONTEND, { extensions: ['html'] }));

app.use('/api', notFound);
app.get('*', (_req, res) => res.sendFile(path.join(FRONTEND, 'index.html')));
app.use(errorHandler);

if (require.main === module) {
  // Bring an older database up to date before serving; failure is reported,
  // not fatal, so a read-only database user can still run the site.
  require('./config/migrate').migrate()
    .catch((err) => log.warn('migrations skipped', { err }))
    .finally(() => {
      // Daily check that verified listings still hold current documents.
      require('./services/expiry').schedule();
      // Daily deletion of personal data past its retention period.
      require('./services/retention').schedule();
      app.listen(PORT, () => log.info('listening', {
        url: `http://localhost:${PORT}`,
        ml_service: process.env.ML_SERVICE_URL || 'http://localhost:8000',
        frontend: FRONTEND,
      }));
    });
}

module.exports = app;
