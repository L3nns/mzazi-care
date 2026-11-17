/* Account area (Figure 4.12): sign in or register, then profile, preferences,
   saved services, search history, password, and your data (deletion). */
const SECTIONS = [
  ['saved', 'Saved services'], ['preferences', 'Preferences'], ['profile', 'My profile'],
  ['history', 'Search history'], ['password', 'Password and sign-in'], ['data', 'Your data'],
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
      if (data.mfa_required) { showCodeStep(data.mfa_token); return; }
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

/** Second step of sign-in: the 6-digit code from the authenticator app. */
function showCodeStep(mfaToken) {
  const root = document.getElementById('account-root');
  root.innerHTML = `
    <div class="panel" style="max-width:420px;margin:2rem auto">
      <h1>Enter your sign-in code</h1>
      <p class="muted">Open your authenticator app and type the 6-digit code shown for Mzazi Care.</p>
      <form id="code-form" novalidate>
        <div class="field"><label for="mfa-code">Code</label>
          <input id="mfa-code" inputmode="numeric" autocomplete="one-time-code" pattern="\\d{6}"
            maxlength="6" required></div>
        <button class="btn" style="width:100%" type="submit">Sign in</button>
        <div class="error-text hidden" id="code-error" role="alert"></div>
      </form>
      <p class="muted" style="margin-top:.8rem"><a href="account.html?tab=login">Start again</a></p>
    </div>`;
  const input = document.getElementById('mfa-code');
  input.focus();
  document.getElementById('code-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('code-error');
    errBox.classList.add('hidden');
    try {
      const data = await API.mfaVerify({ mfa_token: mfaToken, code: input.value.trim() });
      API.setSession(data.token, data.user);
      UI.renderNav();
      showAccount('saved');
    } catch (err) {
      errBox.textContent = formError(err);
      errBox.classList.remove('hidden');
      input.select();
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
  ({ saved, preferences, profile, history: searchHistory, password, data: yourData }[section] || saved)();
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
        <p class="muted">Changing your password signs you out on every other device.</p>
      </form>
    </div>
    <div class="panel" style="max-width:420px;margin-top:1rem" id="mfa-panel">
      <h2>Two-step sign-in</h2><p class="muted">Loading…</p>
    </div>
    <div class="panel" style="max-width:420px;margin-top:1rem">
      <h2>Signed-in devices</h2>
      <p class="muted">Lost a phone or used a shared computer? Sign out everywhere, including here.</p>
      <button class="btn secondary" type="button" id="logout-all">Sign out of all devices</button>
    </div>`;
  mfaPanel();
  document.getElementById('logout-all').addEventListener('click', async () => {
    try {
      await API.logoutAll();
      API.clearSession();
      location.href = 'account.html?tab=login';
    } catch (err) { UI.toast(err.message, true); }
  });
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
      const out = await API.changePassword({
        current_password: document.getElementById('pw-current').value, new_password: next,
      });
      // Older sessions are now revoked; keep this one with the fresh token.
      if (out.token) API.setSession(out.token, out.user);
      e.target.reset();
      UI.toast('Password changed');
    } catch (err) {
      errBox.textContent = formError(err);
      errBox.classList.remove('hidden');
    }
  });
}

/* Your data: what is kept and for how long, and deleting the account. */
function yourData() {
  const { user } = account;
  const isAdmin = user.role === 'admin';
  box().innerHTML = `
    <div class="panel" style="max-width:560px">
      <h1>Your data</h1>
      <p>Searches are kept for a year, your activity (views, saves, ratings) for two years,
        then deleted automatically. The <a href="privacy.html">privacy notice</a> lists
        everything that is kept. You can clear your search history at any time from
        <a href="account.html?tab=history">Search history</a>.</p>
    </div>
    <div class="panel" style="max-width:560px;margin-top:1rem">
      <h2>Delete my account</h2>
      ${isAdmin ? `<p class="notice">Administrator accounts cannot be deleted. Ask another
        administrator to remove your admin role first; your record of administrator actions
        is kept in the audit log.</p>` : `
      <p>This deletes your account and everything recorded about it: your profile, preferences,
        saved services, searches, ratings and activity. It cannot be undone. Ratings you gave
        stop counting towards providers' averages.</p>
      <form id="del-form" novalidate>
        <div class="field"><label for="del-password">Your password</label>
          <input id="del-password" type="password" autocomplete="current-password" required></div>
        ${user.mfa_enabled ? `<div class="field"><label for="del-code">Code from your authenticator app</label>
          <input id="del-code" inputmode="numeric" autocomplete="one-time-code" pattern="\\d{6}" maxlength="6" required></div>` : ''}
        <label class="check"><input type="checkbox" id="del-confirm"> I understand this cannot be undone</label>
        <button class="btn danger" type="submit" style="margin-top:.8rem">Delete my account</button>
        <div class="error-text hidden" id="del-error" role="alert"></div>
      </form>`}
    </div>`;
  const form = document.getElementById('del-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('del-error');
    errBox.classList.add('hidden');
    if (!document.getElementById('del-confirm').checked) {
      errBox.textContent = 'Tick the box to confirm.';
      errBox.classList.remove('hidden');
      return;
    }
    try {
      await API.deleteAccount({
        password: document.getElementById('del-password').value,
        code: document.getElementById('del-code')?.value.trim() || undefined,
      });
      API.clearSession();
      document.getElementById('account-root').innerHTML = `
        <div class="panel" style="max-width:560px" role="status">
          <h1>Your account has been deleted</h1>
          <p>Your profile and everything recorded about you have been removed.</p>
          <p><a class="btn" href="index.html">Back to Mzazi Care</a></p>
        </div>`;
    } catch (err) {
      errBox.textContent = formError(err);
      errBox.classList.remove('hidden');
    }
  });
}

/* Two-step sign-in: off -> setup (show key) -> confirm a code -> on. */
async function mfaPanel() {
  const panel = document.getElementById('mfa-panel');
  if (!panel) return;
  let enabled = false;
  try { enabled = !!(await API.me()).user.mfa_enabled; } catch { /* shown as off */ }
  if (enabled) {
    panel.innerHTML = `
      <h2>Two-step sign-in</h2>
      <p><strong>On.</strong> Signing in needs your password and a code from your authenticator app.</p>
      <form id="mfa-off" novalidate>
        <div class="field"><label for="mfa-off-pw">Password</label>
          <input id="mfa-off-pw" type="password" autocomplete="current-password" required></div>
        <div class="field"><label for="mfa-off-code">Current code</label>
          <input id="mfa-off-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></div>
        <button class="btn secondary" type="submit">Turn off two-step sign-in</button>
        <div class="error-text hidden" id="mfa-off-error" role="alert"></div>
      </form>`;
    panel.querySelector('#mfa-off').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errBox = panel.querySelector('#mfa-off-error');
      try {
        await API.mfaDisable({
          password: panel.querySelector('#mfa-off-pw').value,
          code: panel.querySelector('#mfa-off-code').value.trim(),
        });
        UI.toast('Two-step sign-in is off');
        mfaPanel();
      } catch (err) { errBox.textContent = formError(err); errBox.classList.remove('hidden'); }
    });
    return;
  }
  panel.innerHTML = `
    <h2>Two-step sign-in</h2>
    <p class="muted">Off. Add a code from an authenticator app (such as Google Authenticator,
      Microsoft Authenticator or Aegis) to every sign-in. Recommended for administrators.</p>
    <button class="btn" type="button" id="mfa-start">Set up two-step sign-in</button>`;
  panel.querySelector('#mfa-start').addEventListener('click', async () => {
    let setup;
    try { setup = await API.mfaSetup(); } catch (err) { UI.toast(formError(err), true); return; }
    const key = setup.secret.match(/.{1,4}/g).join(' ');
    panel.innerHTML = `
      <h2>Set up two-step sign-in</h2>
      <ol>
        <li>In your authenticator app, add an account and choose to enter a setup key.</li>
        <li>Enter this key, with account name <strong>Mzazi Care</strong> and type <strong>time-based</strong>:
          <div class="mfa-key" id="mfa-key">${UI.esc(key)}</div>
          <button class="btn secondary small" type="button" id="mfa-copy">Copy key</button></li>
        <li>Type the 6-digit code the app now shows.</li>
      </ol>
      <form id="mfa-confirm" novalidate>
        <div class="field"><label for="mfa-confirm-code">Code from the app</label>
          <input id="mfa-confirm-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></div>
        <button class="btn" type="submit">Turn on</button>
        <div class="error-text hidden" id="mfa-confirm-error" role="alert"></div>
      </form>`;
    panel.querySelector('#mfa-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(setup.secret); UI.toast('Key copied'); }
      catch { window.getSelection().selectAllChildren(panel.querySelector('#mfa-key')); }
    });
    panel.querySelector('#mfa-confirm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errBox = panel.querySelector('#mfa-confirm-error');
      try {
        await API.mfaEnable(panel.querySelector('#mfa-confirm-code').value.trim());
        UI.toast('Two-step sign-in is on');
        mfaPanel();
      } catch (err) { errBox.textContent = formError(err); errBox.classList.remove('hidden'); }
    });
  });
}
