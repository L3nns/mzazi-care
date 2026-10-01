/**
 * Mzazi Care Discovery & Catalog System - application layer.
 *
 * The Express tier of the four-layer architecture in Figure 4.1: it owns
 * business logic, authentication and the REST API, sits between the browser and
 * both the MySQL data layer and the Python recommendation layer, and serves the
 * static front end.
 */
require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { notFound, errorHandler } = require('./middleware/errors');
const ml = require('./services/mlClient');

const app = express();
const PORT = Number(process.env.PORT || 4000);

/* ------------------------------------------------------------- security */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
    },
  },
}));
app.use(cors({ origin: process.env.CORS_ORIGIN || true, credentials: true }));
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));
if (process.env.NODE_ENV !== 'test') app.use(morgan('tiny'));

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

/* --------------------------------------------------------------- routes */
app.get('/api/health', async (_req, res) => {
  let mlHealth = { status: 'unreachable' };
  try { mlHealth = await ml.health(); } catch (err) { mlHealth.error = err.message; }
  res.json({ status: 'ok', service: 'mzazi-care-api', ml: mlHealth });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/services', require('./routes/services'));
app.use('/api/interactions', require('./routes/interactions'));
app.use('/api/saved', require('./routes/saved'));
app.use('/api/recommendations', require('./routes/recommendations'));
app.use('/api/admin', require('./routes/admin'));

/* ---------------------------------------------------------- front end */
const FRONTEND = process.env.FRONTEND_DIR
  || path.resolve(__dirname, '..', 'frontend');
app.use(express.static(FRONTEND, { extensions: ['html'] }));

app.use('/api', notFound);
app.get('*', (_req, res) => res.sendFile(path.join(FRONTEND, 'index.html')));
app.use(errorHandler);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Mzazi Care API listening on http://localhost:${PORT}`);
    console.log(`  recommendation service: ${process.env.ML_SERVICE_URL || 'http://localhost:8000'}`);
    console.log(`  front end: ${FRONTEND}`);
  });
}

module.exports = app;
