/* Shared helpers: navigation state, toasts, escaping, small renderers. */
const UI = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toast(message, isError = false) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const el = document.createElement('div');
    el.className = `toast${isError ? ' error' : ''}`;
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2)
      .map((w) => w.charAt(0)).join('').toUpperCase();
  }

  function renderNav() {
    const user = API.getUser();
    const actions = document.getElementById('nav-actions');
    if (!actions) return;
    const here = location.pathname.replace(/\/$/, '') || '/index.html';
    document.querySelectorAll('.nav-links a').forEach((a) => {
      if (a.getAttribute('href') === here.split('/').pop()) a.classList.add('active');
    });
    if (user) {
      const adminLink = user.role === 'admin'
        ? '<a class="btn secondary small" href="admin.html">Admin</a>' : '';
      actions.innerHTML = `${adminLink}
        <a class="btn secondary small" href="account.html">My account</a>
        <button class="btn small" id="logout">Log out</button>`;
      document.getElementById('logout').addEventListener('click', () => {
        API.clearSession(); location.href = 'index.html';
      });
    } else {
      actions.innerHTML = `
        <a class="btn secondary small" href="account.html?tab=login">Log in</a>
        <a class="btn small" href="account.html?tab=register">Sign up</a>`;
    }
  }

  const statusBadge = (s) => {
    const cls = s === 'verified' ? 'badge-verified'
      : s === 'pending' ? 'badge-verified badge-pending' : 'badge-verified badge-rejected';
    return `<span class="${cls}">${esc(s)}</span>`;
  };

  const tagChips = (tags, limit = 4) => String(tags || '').split(',')
    .filter(Boolean).slice(0, limit)
    .map((t) => `<span class="chip tag">${esc(t.replace(/-/g, ' ').trim())}</span>`)
    .join('');

  function resultCard(p) {
    return `<article class="result">
      <div class="thumb">${esc(String(p.provider_name || '?').trim()[0] || '?')}</div>
      <div class="body">
        <h3><a href="provider.html?id=${p.provider_id}">${esc(p.provider_name)}</a></h3>
        <div class="muted">${esc(p.category_name || '')} &middot; ${esc(p.location || '')}</div>
        <div style="margin:.4rem 0">${tagChips(p.service_tags)}</div>
        ${p.verification_status === 'verified' ? '<span class="badge-verified">Verified</span>' : ''}
      </div>
    </article>`;
  }

  /* Interactions drive the recommender, so record them wherever they happen. */
  async function track(providerId, type, ratingValue = null) {
    if (!API.getToken()) return;
    try {
      await API.interact({
        provider_id: Number(providerId),
        interaction_type: type,
        ...(ratingValue ? { rating_value: Number(ratingValue) } : {}),
      });
    } catch (err) { console.warn('could not record interaction:', err.message); }
  }

  const params = () => Object.fromEntries(new URLSearchParams(location.search));

  document.addEventListener('DOMContentLoaded', renderNav);
  return { esc, toast, renderNav, statusBadge, tagChips, resultCard, track, params, initials };
})();
