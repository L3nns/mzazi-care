/**
 * Client for the Python recommendation service.
 *
 * The browser never talks to the ML service; Express is the only caller, and it
 * authenticates with a shared service token. If the service is unreachable the
 * caller degrades gracefully rather than failing the page.
 */
const BASE = process.env.ML_SERVICE_URL || 'http://localhost:8000';
const TOKEN = process.env.ML_SERVICE_TOKEN || '';
const TIMEOUT = Number(process.env.ML_TIMEOUT_MS || 8000);

async function call(path, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(TOKEN ? { 'X-Service-Token': TOKEN } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const err = new Error(data.detail || `ML service returned ${res.status}`);
      err.status = res.status === 503 ? 503 : 502;
      throw err;
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error('recommendation service timed out');
      e.status = 504;
      throw e;
    }
    if (!err.status) err.status = 502;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const health = () => call('/health');
const modelCard = () => call('/model');
const recommend = (payload) => call('/recommend', { method: 'POST', body: payload });
const similar = (providerId, topN = 5) =>
  call(`/similar/${providerId}?top_n=${topN}`);
const reindex = () => call('/reindex', { method: 'POST' });
const retrain = () => call('/retrain', { method: 'POST' });

/** Fire-and-forget: a verification must not fail because re-indexing did. */
function reindexQuietly() {
  reindex().catch((err) => console.warn('[ml] reindex failed:', err.message));
}

module.exports = {
  health, modelCard, recommend, similar, reindex, retrain, reindexQuietly,
};
