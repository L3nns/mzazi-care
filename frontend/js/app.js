/* Shared helpers: navigation state, toasts, escaping, small renderers. */
const UI = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toast(message, isError = false) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const el = document.createElement('div');
    el.className = `toast${isError ? ' error' : ''}`;
    el.setAttribute('role', isError ? 'alert' : 'status');
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3600);
  }

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2)
      .map((w) => w.charAt(0)).join('').toUpperCase();
  }

  function renderNav() {
    const user = API.getUser();
    const actions = document.getElementById('nav-actions');
    if (!actions) return;
    const here = location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.nav-links a').forEach((a) => {
      if (a.getAttribute('href') === here) a.classList.add('active');
    });
    if (user) {
      const adminLink = user.role === 'admin'
        ? '<a class="btn secondary small" href="admin.html">Admin</a>' : '';
      actions.innerHTML = `${adminLink}
        <a class="btn secondary small" href="account.html">My account</a>
        <button class="btn small" id="logout" type="button">Log out</button>`;
      document.getElementById('logout').addEventListener('click', () => {
        API.clearSession(); location.href = 'index.html';
      });
    } else {
      actions.innerHTML = `
        <a class="btn secondary small" href="account.html?tab=login">Log in</a>
        <a class="btn small" href="account.html?tab=register">Sign up</a>`;
    }
  }

  // Verification states. The label carries the meaning; colour only repeats it.
  const STATUS_LABELS = {
    draft: 'Draft', pending: 'Pending', under_review: 'Under review',
    needs_more_information: 'Needs more information', verified: 'Verified',
    rejected: 'Rejected', suspended: 'Suspended', expired: 'Expired',
  };
  const statusBadge = (s) => {
    const cls = s === 'verified' ? 'badge-verified'
      : ['rejected', 'suspended', 'expired'].includes(s) ? 'badge-verified badge-rejected'
        : 'badge-verified badge-pending';
    return `<span class="${cls}">${esc(STATUS_LABELS[s] || s)}</span>`;
  };

  const tagChips = (tags, limit = 4) => String(tags || '').split(',')
    .filter((t) => t.trim()).slice(0, limit)
    .map((t) => `<span class="chip tag">${esc(t.replace(/-/g, ' ').trim())}</span>`)
    .join('');

  /** "★ 4.3 (12)" - or nothing when a service has no ratings yet. */
  function stars(avg, count) {
    if (avg === null || avg === undefined || !Number(count)) return '';
    const n = Number(avg);
    return `<span class="stars" title="Average rating ${n.toFixed(1)} from ${count} rating${Number(count) === 1 ? '' : 's'}">
      <span aria-hidden="true">★</span> ${n.toFixed(1)} <span class="muted">(${Number(count)})</span></span>`;
  }

  /** "Serves Kilimani" or "About 3 km from Kilimani" - distances are between area centres. */
  function areaNote(p) {
    if (!p.area_origin) return '';
    if (p.serves_origin) return `<div class="area-note">Serves ${esc(p.area_origin)}</div>`;
    if (p.distance_km !== null && p.distance_km !== undefined) {
      return `<div class="area-note">About ${Math.max(1, Math.round(p.distance_km))} km from ${esc(p.area_origin)}
        <span class="muted">(between area centres)</span></div>`;
    }
    return '';
  }

  function resultCard(p) {
    return `<article class="result">
      <div class="thumb" aria-hidden="true">${esc(initials(p.provider_name))}</div>
      <div class="body">
        <h3><a href="provider.html?id=${Number(p.provider_id)}" data-track="${Number(p.provider_id)}">${esc(p.provider_name)}</a></h3>
        <div class="muted">${esc(p.category_name || '')}${p.location ? ` &middot; ${esc(p.location)}` : ''}
          ${stars(p.avg_rating, p.rating_count)}</div>
        ${areaNote(p)}
        <div style="margin:.4rem 0">${tagChips(p.service_tags)}</div>
        ${p.verification_status === 'verified' ? '<span class="badge-verified">Verified</span>' : ''}
      </div>
    </article>`;
  }

  const FEEDBACK_OPTIONS = [
    ['not_relevant', 'Not relevant to me'], ['too_far', 'Too far away'],
    ['wrong_category', 'Wrong kind of service'], ['already_contacted', 'Already contacted them'],
  ];

  /**
   * One recommended provider, with "Why am I seeing this?" (the engine's
   * reasons, from real score components) and, when signed in, feedback.
   */
  function recItem(r) {
    const reasons = (r.reasons || []).map((x) => `<li>${esc(x.text)}</li>`).join('');
    const id = Number(r.provider_id);
    const signedIn = Boolean(API.getToken());
    return `<div class="rec-item" data-rec="${id}">
      <a href="provider.html?id=${id}" data-track="${id}">${esc(r.provider_name)}</a>
      <div class="muted">${esc(r.category_name || '')}${r.location ? ` &middot; ${esc(r.location)}` : ''}
        ${stars(r.avg_rating, r.rating_count)}</div>
      ${reasons ? `<details class="why"><summary>Why am I seeing this?</summary><ul>${reasons}</ul></details>` : ''}
      ${signedIn ? `<details class="fb"><summary>Not for me</summary>
        <div class="fb-options">${FEEDBACK_OPTIONS.map(([k, label]) =>
    `<button type="button" class="btn secondary small" data-fb="${k}">${esc(label)}</button>`).join('')}</div>
      </details>` : ''}
    </div>`;
  }

  /** Wires the feedback buttons in a list built from recItem(). */
  function bindFeedback(container) {
    container.querySelectorAll('[data-fb]').forEach((b) => b.addEventListener('click', async () => {
      const item = b.closest('[data-rec]');
      try {
        await API.recFeedback(Number(item.dataset.rec), b.dataset.fb);
        item.innerHTML = '<p class="muted" role="status">Thanks — we will not suggest this provider to you again.</p>';
      } catch (err) { toast(err.message, true); }
    }));
  }

  /** Splits /api/categories into service types (top level) and their categories. */
  function categoryTree(categories) {
    const types = categories.filter((c) => c.parent_category_id === null);
    const leaves = categories.filter((c) => c.parent_category_id !== null);
    const byParent = Object.fromEntries(types.map((t) => [t.category_id,
      leaves.filter((l) => l.parent_category_id === t.category_id)]));
    // Top-level categories with no children are themselves assignable.
    const assignable = categories.filter((c) => !categories.some((k) => k.parent_category_id === c.category_id));
    return { types, leaves, byParent, assignable };
  }

  /** <option>s grouped by service type. Only categories without children are
      selectable; a service type with children is an <optgroup> label. */
  function categoryOptions(categories, selected = '', { placeholder = 'All categories' } = {}) {
    const { types, byParent } = categoryTree(categories);
    const sel = String(selected ?? '');
    const opt = (c) => `<option value="${c.category_id}"${String(c.category_id) === sel ? ' selected' : ''}>${esc(c.category_name)}</option>`;
    const groups = types.map((t) => {
      const kids = byParent[t.category_id] || [];
      if (!kids.length) return opt(t);
      return `<optgroup label="${esc(t.category_name)}">${kids.map(opt).join('')}</optgroup>`;
    }).join('');
    return `<option value="">${esc(placeholder)}</option>${groups}`;
  }

  /** Numbered pager; calls onPage(n). Shows a window around the current page. */
  function pager(el, { page, pages }, onPage) {
    if (!el) return;
    if (!pages || pages <= 1) { el.innerHTML = ''; return; }
    const btn = (label, n, { disabled = false, active = false, aria = '' } = {}) =>
      `<button type="button" class="btn ${active ? '' : 'secondary'} small" data-page="${n}"
        ${disabled ? 'disabled' : ''} ${active ? 'aria-current="page"' : ''} ${aria ? `aria-label="${aria}"` : ''}>${label}</button>`;
    const from = Math.max(1, Math.min(page - 3, pages - 6));
    const to = Math.min(pages, from + 6);
    let html = btn('&laquo;', page - 1, { disabled: page === 1, aria: 'Previous page' });
    for (let i = from; i <= to; i += 1) html += btn(i, i, { active: i === page });
    html += btn('&raquo;', page + 1, { disabled: page === pages, aria: 'Next page' });
    el.innerHTML = html;
    el.querySelectorAll('button[data-page]').forEach((b) => {
      b.addEventListener('click', () => onPage(Number(b.dataset.page)));
    });
  }

  const fmtDate = (v, withTime = false) => {
    if (!v) return '';
    const s = String(v).replace('T', ' ').replace(/\.\d+Z?$/, '').replace(/Z$/, '');
    return withTime ? s.slice(0, 16) : s.slice(0, 10);
  };

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

  /** Records a 'click' for every provider link carrying data-track inside root. */
  function trackClicks(root) {
    root.querySelectorAll('a[data-track]').forEach((a) => {
      a.addEventListener('click', () => track(a.dataset.track, 'click'));
    });
  }

  const params = () => Object.fromEntries(new URLSearchParams(location.search));

  document.addEventListener('DOMContentLoaded', renderNav);
  return {
    esc, toast, renderNav, statusBadge, STATUS_LABELS, tagChips, stars, resultCard, recItem, bindFeedback, categoryTree,
    categoryOptions, pager, fmtDate, track, trackClicks, params, initials,
  };
})();
