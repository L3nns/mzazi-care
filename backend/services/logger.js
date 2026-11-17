/**
 * Structured logging.
 *
 * One JSON object per line when LOG_FORMAT=json (the default in production),
 * a short readable line otherwise. Every line written while a request is being
 * served carries that request's id; the same id is returned to the browser in
 * X-Request-Id and sent on to the ML service, so one request can be followed
 * across both tiers.
 *
 * What is never logged: query strings (search text is the parent's own
 * words), request bodies, tokens and passwords. Request lines carry the path,
 * status, duration and the numeric user id only.
 *
 *   LOG_LEVEL   debug | info | warn | error | silent   (default info; silent in tests)
 *   LOG_FORMAT  json | pretty
 */
const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const context = new AsyncLocalStorage();
let override = {};

const level = () => LEVELS[override.level || process.env.LOG_LEVEL
  || (process.env.NODE_ENV === 'test' ? 'silent' : 'info')] ?? LEVELS.info;
const format = () => override.format || process.env.LOG_FORMAT
  || (process.env.NODE_ENV === 'production' ? 'json' : 'pretty');

function defaultSink(line, lvl) {
  (LEVELS[lvl] >= LEVELS.warn ? process.stderr : process.stdout).write(`${line}\n`);
}

function serialise(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    out[k] = v instanceof Error
      ? { message: v.message, ...(v.status ? { status: v.status } : {}),
        ...(format() === 'json' ? { stack: v.stack } : {}) }
      : v;
  }
  return out;
}

function write(lvl, msg, fields = {}) {
  if (LEVELS[lvl] < level()) return;
  const store = context.getStore();
  const entry = {
    time: new Date().toISOString(), level: lvl, msg,
    ...(store?.requestId ? { request_id: store.requestId } : {}),
    ...serialise(fields),
  };
  let line;
  if (format() === 'json') {
    line = JSON.stringify(entry);
  } else {
    const { time, level: _l, msg: _m, ...rest } = entry;
    const extra = Object.entries(rest)
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
    line = `${time.slice(11, 19)} ${lvl.toUpperCase().padEnd(5)} ${msg}${extra ? ` ${extra}` : ''}`;
  }
  (override.sink || defaultSink)(line, lvl, entry);
}

const log = {
  debug: (msg, fields) => write('debug', msg, fields),
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields),
};

/** The current request's id, for passing to the ML service. */
const requestId = () => context.getStore()?.requestId || null;

// An id the caller sent is reused only if it is short and plain.
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Express middleware: assigns the request id and logs one line per API request. */
function requestLogger(req, res, next) {
  const incoming = req.get('X-Request-Id');
  const id = incoming && SAFE_ID.test(incoming) ? incoming : crypto.randomUUID();
  req.id = id;
  res.set('X-Request-Id', id);
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const path = (req.originalUrl || req.url).split('?')[0];
    const status = res.statusCode;
    const lvl = status >= 500 ? 'error' : path.startsWith('/api/') ? 'info' : 'debug';
    context.run({ requestId: id }, () => write(lvl, 'request', {
      method: req.method, path, status,
      ms: Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100,
      user_id: req.user?.user_id ?? null,
    }));
  });
  context.run({ requestId: id }, next);
}

/** Tests: configure({ level, format, sink }) to capture output; configure() resets. */
function configure(opts = {}) { override = opts; }

module.exports = { log, requestLogger, requestId, configure, LEVELS };
