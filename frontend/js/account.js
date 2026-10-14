/* Account area (Figure 4.12): sign in or register, then profile, preferences,
   saved services, search history and password. */
const SECTIONS = [
  ['saved', 'Saved services'], ['preferences', 'Preferences'], ['profile', 'My profile'],
  ['history', 'Search history'], ['password', 'Change password'],
];
let account = null;     // { user, preferences, categories, locations }

document.addEventListener('DOMContentLoaded', () => {
  const tab = UI.params().tab;
  if (API.getToken()) showAccount(SECTIONS.some(([k]) => k === tab) ? tab : 'saved');
  else showAuth(tab === 'register' ? 'register' : 'login');
});

const formError = (err) => (err.details?.length
  ? err.details.map((d) => `${d.field.replace(/_/g, ' ')}: ${d.message}`).join(', ')
  : err.message);

function showAuth(mode) {
  const root = document.getElementById('account-root');
  root.innerHTML = `
    <div class="panel" style="max-width:420px;margin:2rem auto">
      <div class="tabs" role="tablist">
        <button class="tab ${mode === 'login' ? 'active' : ''}" type="button" data-mode="login">Log in</button>
        <button class="tab ${mode === 'register' ? 'active' : ''}" type="button" data-mode="register">Create account</button>
      </div>
      <form id="auth-form" novalidate>
        ${mode === 'register' ? `<div class="field">
          <label for="full_name">Full name</label>
          <input id="full_name" autocomplete="name" required>
        </div>` : ''}
        <div class="field">
          <label for="email">Email</label>
          <input id="email" type="email" autocomplete="email" required>
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input id="password" type="password" required
            autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}">
          ${mode === 'register' ? '<div class="muted">At least 8 characters.</div>' : ''}
        </div>
        ${mode === 'register' ? `<div class="field">
          <label for="location">Area you live in</label>
          <input id="location" placeholder="e.g. Westlands" autocomplete="address-level2">
        </div>` : ''}
        <button class="btn" style="width:100%" type="submit">
          ${mode === 'login' ? 'Log in' : 'Create account'}</button>
        <div class="error-text hidden" id="auth-error" role="alert"></div>
      </form>
    </div>`;

  root.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => showAuth(t.dataset.mode));
  });

  document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('auth-error');
    errBox.classList.add('hidden');
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    const payload = {
      email: document.getElementById('email').value.trim(),
      password: document.getElementById('password').value,
    };
    try {
      const data = mode === 'login'
        ? await API.login(payload)
        : await API.register({
          ...payload,
          full_name: document.getElementById('full_name').value.trim(),
          location: document.getElementById('location').value.trim() || undefined,
        });
      API.setSession(data.token, data.user);
      UI.renderNav();
      // A new account starts at preferences: they seed the first recommendations.
      showAccount(mode === 'register' ? 'preferences' : 'saved');
    } catch (err) {
      errBox.textContent = formError(err);
      errBox.classList.remove('hidden');
      btn.disabled = false;
    }
  });
}

async function showAccount(section) {
  const root = document.getElementById('account-root');
  root.innerHTML = '<p class="muted">Loading your account…</p>';
  try {
    const [{ user, preferences }, cats, locs] = await Promise.all([
      API.me(), API.categories(), API.locations().catch(() => ({ locations: [] })),
    ]);
    account = { user, preferences, categories: cats.categories, locations: locs.locations };
  } catch (err) {
    if (err.status === 401) { showAuth('login'); return; }
    root.innerHTML = `<p class="error-text">${UI.esc(err.message)}</p>`;
    return;
  }
  const { user } = account;
  root.innerHTML = `
    <div class="layout with-sidebar">
      <aside>
        <div class="panel">
          <h2>${UI.esc(user.full_name)}</h2>
          <p class="muted">${UI.esc(user.email)}<br>${UI.esc(user.location || 'No area set')}</p>
          <nav class="side-nav" aria-label="Account sections">
            ${SECTIONS.map(([k, label]) => `<a href="account.html?tab=${k}" data-section="${k}">${label}</a>`).join('')}
          </nav>
        </div>
      </aside>
      <div id="account-section"></div>
    </div>`;
  root.querySelectorAll('[data-section]').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); openSection(a.dataset.section); });
  });
  openSection(section);
}

function openSection(section) {
  history.replaceState(null, '', `account.html?tab=${section}`);
  document.querySelectorAll('[data-section]').forEach((a) => {
    a.classList.toggle('active', a.dataset.section === section);
    if (a.dataset.section === section) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  ({ saved, preferences, profile, history: searchHistory, password }[section] || saved)();
}

const box = () => document.getElementById('account-section');

async function saved() {
  box().innerHTML = '<p class="muted">Loading…</p>';
  try {
    const data = await API.saved();
    box().innerHTML = `
      <h1>Saved services (${data.count})</h1>
      ${data.saved.length ? data.saved.map((s) => `
        <article class="result">
          <div class="thumb" aria-hidden="true">${UI.esc(UI.initials(s.provider_name))}</div>
          <div class="body">
            <h3><a href="provider.html?id=${s.provider_id}">${UI.esc(s.provider_name)}</a></h3>
            <div class="muted">${UI.esc(s.category_name)} &middot; ${UI.esc(s.location || '')} &middot; saved ${UI.fmtDate(s.saved_at)}</div>
            ${s.verification_status === 'verified' ? '<span class="badge-verified">Verified</span>'
    : '<span class="muted">No longer listed</span>'}
          </div>
          <div class="row-actions">
            <a class="btn secondary small" href="provider.html?id=${s.provider_id}">View</a>
            <button class="btn secondary small" type="button" data-remove="${s.provider_id}">Remove</button>
          </div>
        </article>`).join('')
    : '<div class="empty"><p>You have not shortlisted any services yet.</p><p><a href="search.html">Browse the catalogue</a></p></div>'}`;
    box().querySelectorAll('[data-remove]').forEach((b) => {
      b.addEventListener('click', async () => {
        try { await API.unsave(b.dataset.remove); UI.toast('Removed from your shortlist'); saved(); }
        catch (err) { UI.toast(err.message, true); }
      });
    });
  } catch (err) {
    box().innerHTML = `<p class="error-text">${UI.esc(err.message)}</p>`;
  }
}

function preferences() {
  const { categories, preferences: prefs, locations, user } = account;
  const chosen = new Set(prefs.map((p) => p.category_id));
  const preferredLocation = prefs[0]?.preferred_location || user.location || '';
  const { types, byParent } = UI.categoryTree(categories);
  box().innerHTML = `
    <div class="panel">
      <h1>My preferences</h1>
      <p class="muted">These seed your recommendations before you have a history, and keep
        shaping them afterwards alongside what you search for and save.</p>
      <form id="pref-form">
        ${types.map((t) => {
    const kids = byParent[t.category_id] || [];
    return `<fieldset class="pref-group"><legend>${UI.esc(t.category_name)}</legend>
            ${(kids.length ? kids : [t]).map((c) => `
              <label class="check"><input type="checkbox" value="${c.category_id}"
                ${chosen.has(c.category_id) ? 'checked' : ''}> ${UI.esc(c.category_name)}</label>`).join('')}
          </fieldset>`;
  }).join('')}
        <div class="field" style="max-width:320px">
          <label for="pref-location">Preferred location</label>
          <input id="pref-location" list="loc-list" value="${UI.esc(preferredLocation)}" placeholder="e.g. Westlands">
          <datalist id="loc-list">${locations.map((l) => `<option value="${UI.esc(l.location)}">`).join('')}</datalist>
        </div>
        <button class="btn" type="submit">Update preferences</button>
      </form>
    </div>`;
  document.getElementById('pref-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ids = [...e.target.querySelectorAll('input[type=checkbox]:checked')].map((i) => Number(i.value));
    const loc = document.getElementById('pref-location').value.trim();
    try {
      await API.setPreferences({ category_ids: ids, preferred_location: loc || null });
      account.preferences = ids.map((cid) => ({ category_id: cid, preferred_location: loc || null }));
      UI.toast(ids.length ? 'Preferences updated' : 'Preferences cleared');
    } catch (err) { UI.toast(formError(err), true); }
  });
}

function profile() {
  const { user } = account;
  box().innerHTML = `
    <div class="panel" style="max-width:560px">
      <h1>My profile</h1>
      <form id="profile-form">
        <div class="field"><label for="p-name">Full name</label>
          <input id="p-name" value="${UI.esc(user.full_name)}" autocomplete="name" required></div>
        <div class="field"><label for="p-email">Email</label>
          <input id="p-email" value="${UI.esc(user.email)}" disabled></div>
        <div class="form-row">
          <div class="field"><label for="p-phone">Phone number</label>
            <input id="p-phone" value="${UI.esc(user.phone_number || '')}" autocomplete="tel" placeholder="+2547…"></div>
          <div class="field"><label for="p-location">Area you live in</label>
            <input id="p-location" value="${UI.esc(user.location || '')}" autocomplete="address-level2"></div>
        </div>
        <button class="btn" type="submit">Save profile</button>
        <div class="error-text hidden" id="profile-error" role="alert"></div>
      </form>
      <p class="muted" style="margin-top:.75rem">Member since ${UI.fmtDate(user.created_at)}.</p>
    </div>`;
  document.getElementById('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('profile-error');
    errBox.classList.add('hidden');
    try {
      const out = await API.updateMe({
        full_name: document.getElementById('p-name').value.trim(),
        phone_number: document.getElementById('p-phone').value.trim(),
        location: document.getElementById('p-location').value.trim(),
      });
      API.setSession(out.token, out.user);
      account.user = { ...account.user, ...out.user };
      UI.renderNav();
      UI.toast('Profile saved');
    } catch (err) {
      errBox.textContent = formError(err);
      errBox.classList.remove('hidden');
    }
  });
}

async function searchHistory() {
  box().innerHTML = '<p class="muted">Loading…</p>';
  try {
    const { searches } = await API.mySearches();
    box().innerHTML = `
      <div class="panel">
        <div class="panel-head"><h1>Search history</h1>
          ${searches.length ? '<button class="btn secondary small" type="button" id="clear-history">Clear history</button>' : ''}</div>
        <p class="muted">Your recent searches shape your recommendations.</p>
        ${searches.length ? `<div class="table-wrap"><table>
          <thead><tr><th>When</th><th>Search</th><th>Category</th><th>Location</th><th></th></tr></thead>
          <tbody>${searches.map((s) => {
    const catId = /^\d+$/.test(String(s.category_filter || '')) ? s.category_filter : '';
    return `<tr>
            <td>${UI.fmtDate(s.searched_at, true)}</td>
            <td>${UI.esc(s.query_text || '—')}</td>
            <td>${UI.esc(s.category_name || s.category_filter || '—')}</td>
            <td>${UI.esc(s.location_filter || '—')}</td>
            <td><a href="search.html${API.qs({ q: s.query_text, category: catId, location: s.location_filter })}">Search again</a></td>
          </tr>`;
  }).join('')}</tbody></table></div>`
    : '<div class="empty"><p>No searches yet.</p></div>'}
      </div>`;
    document.getElementById('clear-history')?.addEventListener('click', async () => {
      if (!window.confirm('Clear your whole search history? Recommendations will rely on what you save and view instead.')) return;
      try { await API.clearSearches(); UI.toast('Search history cleared'); searchHistory(); }
      catch (err) { UI.toast(err.message, true); }
    });
  } catch (err) {
    box().innerHTML = `<p class="error-text">${UI.esc(err.message)}</p>`;
  }
}

function password() {
  box().innerHTML = `
    <div class="panel" style="max-width:420px">
      <h1>Change password</h1>
      <form id="pw-form">
        <div class="field"><label for="pw-current">Current password</label>
          <input id="pw-current" type="password" autocomplete="current-password" required></div>
        <div class="field"><label for="pw-new">New password</label>
          <input id="pw-new" type="password" autocomplete="new-password" minlength="8" required>
          <div class="muted">At least 8 characters.</div></div>
        <div class="field"><label for="pw-confirm">Confirm new password</label>
          <input id="pw-confirm" type="password" autocomplete="new-password" required></div>
        <button class="btn" type="submit">Change password</button>
        <div class="error-text hidden" id="pw-error" role="alert"></div>
      </form>
    </div>`;
  document.getElementById('pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('pw-error');
    errBox.classList.add('hidden');
    const next = document.getElementById('pw-new').value;
    if (next !== document.getElementById('pw-confirm').value) {
      errBox.textContent = 'The new passwords do not match.';
      errBox.classList.remove('hidden');
      return;
    }
    try {
      await API.changePassword({
        current_password: document.getElementById('pw-current').value, new_password: next,
      });
      e.target.reset();
      UI.toast('Password changed');
    } catch (err) {
      errBox.textContent = formError(err);
      errBox.classList.remove('hidden');
    }
  });
}
