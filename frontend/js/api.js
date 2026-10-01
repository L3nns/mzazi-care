/* Thin API client. Keeps the token in localStorage and attaches it to calls. */
const API = (() => {
  const TOKEN = 'mzazi_token';
  const USER = 'mzazi_user';

  const getToken = () => localStorage.getItem(TOKEN);
  const getUser = () => {
    try { return JSON.parse(localStorage.getItem(USER) || 'null'); } catch { return null; }
  };
  const setSession = (token, user) => {
    localStorage.setItem(TOKEN, token);
    localStorage.setItem(USER, JSON.stringify(user));
  };
  const clearSession = () => { localStorage.removeItem(TOKEN); localStorage.removeItem(USER); };

  async function call(path, { method = 'GET', body, auth = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (auth && token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`/api${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      if (res.status === 401 && getToken()) { clearSession(); }
      const err = new Error(data.error || `request failed (${res.status})`);
      err.status = res.status;
      err.details = data.details;
      throw err;
    }
    return data;
  }

  const qs = (obj) => {
    const p = new URLSearchParams();
    Object.entries(obj).forEach(([k, v]) => {
      if (v !== null && v !== undefined && v !== '') p.set(k, v);
    });
    const s = p.toString();
    return s ? `?${s}` : '';
  };

  return {
    getToken, getUser, setSession, clearSession, qs,
    register: (b) => call('/auth/register', { method: 'POST', body: b, auth: false }),
    login: (b) => call('/auth/login', { method: 'POST', body: b, auth: false }),
    me: () => call('/auth/me'),
    updateMe: (b) => call('/auth/me', { method: 'PUT', body: b }),
    setPreferences: (b) => call('/auth/me/preferences', { method: 'PUT', body: b }),

    categories: () => call('/categories', { auth: false }),
    locations: () => call('/services/locations', { auth: false }),
    search: (params) => call(`/services${qs(params)}`),
    provider: (id) => call(`/services/${id}`),

    recommendations: (params) => call(`/recommendations${qs(params)}`),
    interact: (b) => call('/interactions', { method: 'POST', body: b }),
    myInteractions: () => call('/interactions/me'),

    saved: () => call('/saved'),
    unsave: (id) => call(`/saved/${id}`, { method: 'DELETE' }),

    adminStats: () => call('/admin/stats'),
    adminLogs: () => call('/admin/logs'),
    adminProviders: (params) => call(`/admin/providers${qs(params)}`),
    adminProvider: (id) => call(`/admin/providers/${id}`),
    adminCreateProvider: (b) => call('/admin/providers', { method: 'POST', body: b }),
    adminUpdateProvider: (id, b) => call(`/admin/providers/${id}`, { method: 'PUT', body: b }),
    adminVerify: (id, status) => call(`/admin/providers/${id}/verify`,
      { method: 'PUT', body: { verification_status: status } }),
    adminDeleteProvider: (id) => call(`/admin/providers/${id}`, { method: 'DELETE' }),
    adminReindex: () => call('/admin/model/reindex', { method: 'POST' }),
    adminRetrain: () => call('/admin/model/retrain', { method: 'POST' }),
  };
})();
