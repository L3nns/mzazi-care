/* Thin API client. Keeps the token in localStorage and attaches it to calls. */
const API = (() => {
  const TOKEN = 'mzazi_token';
  const USER = 'mzazi_user';

  const safeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const safeSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
  const safeDel = (k) => { try { localStorage.removeItem(k); } catch { /* private mode */ } };

  const getToken = () => safeGet(TOKEN);
  const getUser = () => {
    try { return JSON.parse(safeGet(USER) || 'null'); } catch { return null; }
  };
  const setSession = (token, user) => {
    safeSet(TOKEN, token);
    safeSet(USER, JSON.stringify(user));
  };
  const clearSession = () => { safeDel(TOKEN); safeDel(USER); };

  async function call(path, {
    method = 'GET', body, auth = true, keepalive = false, raw = null, contentType = null,
  } = {}) {
    const headers = {};
    if (raw) headers['Content-Type'] = contentType || 'application/octet-stream';
    else if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = getToken();
    if (auth && token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`/api${path}`, {
      method, headers, keepalive,
      body: raw || (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
    if (!res.ok) {
      if (res.status === 401 && token && auth) clearSession();
      const err = new Error(data.error || `request failed (${res.status})`);
      err.status = res.status;
      err.details = data.details;
      throw err;
    }
    return data;
  }

  /** Authenticated binary download, handed to the browser as a file. */
  async function download(path, fileName) {
    const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: fileName });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
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
    getToken, getUser, setSession, clearSession, qs, download,
    register: (b) => call('/auth/register', { method: 'POST', body: b, auth: false }),
    login: (b) => call('/auth/login', { method: 'POST', body: b, auth: false }),
    me: () => call('/auth/me'),
    updateMe: (b) => call('/auth/me', { method: 'PUT', body: b }),
    changePassword: (b) => call('/auth/me/password', { method: 'PUT', body: b }),
    setPreferences: (b) => call('/auth/me/preferences', { method: 'PUT', body: b }),
    mySearches: () => call('/auth/me/searches'),
    clearSearches: () => call('/auth/me/searches', { method: 'DELETE' }),

    categories: () => call('/categories', { auth: false }),
    locations: () => call('/services/locations', { auth: false }),
    search: (params) => call(`/services${qs(params)}`),
    provider: (id) => call(`/services/${id}`),

    recommendations: (params) => call(`/recommendations${qs(params)}`),
    // keepalive: a click that navigates away must still be recorded.
    interact: (b) => call('/interactions', { method: 'POST', body: b, keepalive: true }),
    myInteractions: () => call('/interactions/me'),

    saved: () => call('/saved'),
    unsave: (id) => call(`/saved/${id}`, { method: 'DELETE' }),

    adminStats: () => call('/admin/stats'),
    adminLogs: (params = {}) => call(`/admin/logs${qs(params)}`),
    adminProviders: (params) => call(`/admin/providers${qs(params)}`),
    adminProvider: (id) => call(`/admin/providers/${id}`),
    adminCreateProvider: (b) => call('/admin/providers', { method: 'POST', body: b }),
    adminUpdateProvider: (id, b) => call(`/admin/providers/${id}`, { method: 'PUT', body: b }),
    adminVerify: (id, status, note) => call(`/admin/providers/${id}/verify`,
      { method: 'PUT', body: { verification_status: status, ...(note ? { note } : {}) } }),
    adminDeleteProvider: (id) => call(`/admin/providers/${id}`, { method: 'DELETE' }),
    adminUpload: (id, kind, file) => call(`/admin/providers/${id}/media${qs({ kind })}`,
      { method: 'POST', raw: file, contentType: file.type }),
    adminDeleteMedia: (mediaId) => call(`/admin/media/${mediaId}`, { method: 'DELETE' }),
    adminDownloadMedia: (mediaId, name) => download(`/admin/media/${mediaId}`, name),
    adminCategories: () => call('/admin/categories'),
    adminCreateCategory: (b) => call('/admin/categories', { method: 'POST', body: b }),
    adminUpdateCategory: (id, b) => call(`/admin/categories/${id}`, { method: 'PUT', body: b }),
    adminDeleteCategory: (id) => call(`/admin/categories/${id}`, { method: 'DELETE' }),
    adminUsers: (params) => call(`/admin/users${qs(params)}`),
    adminSetRole: (id, role) => call(`/admin/users/${id}/role`, { method: 'PUT', body: { role } }),
    adminReports: (params) => call(`/admin/reports${qs(params)}`),
    adminReindex: () => call('/admin/model/reindex', { method: 'POST' }),
    adminRetrain: () => call('/admin/model/retrain', { method: 'POST' }),
  };
})();
