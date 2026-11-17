const { log } = require('../services/logger');

function notFound(_req, res) {
  res.status(404).json({ error: 'not found' });
}

/* eslint-disable no-unused-vars */
function errorHandler(err, _req, res, _next) {
  const status = err.status || 500;
  if (status >= 500) log.error('unhandled error', { err });
  res.status(status).json({
    error: status >= 500 ? 'internal server error' : err.message,
    ...(process.env.NODE_ENV !== 'production' && status >= 500
      ? { detail: err.message }
      : {}),
  });
}

/** Wraps an async route so rejections reach the error handler. */
const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { notFound, errorHandler, asyncRoute };
