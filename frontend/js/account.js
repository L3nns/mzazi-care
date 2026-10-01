/* Account area: login, registration, shortlist and preferences (Figure 4.12). */
document.addEventListener('DOMContentLoaded', () => {
  const tab = UI.params().tab;
  if (API.getToken()) showAccount(); else showAuth(tab === 'register' ? 'register' : 'login');
});

function showAuth(mode) {
  const root = document.getElementById('account-root');
  root.innerHTML = `
    <div class="panel" style="max-width:420px;margin:2rem auto">
      <div class="tabs">
        <button class="tab ${mode === 'login' ? 'active' : ''}" data-mode="login">Log in</button>
        <button class="tab ${mode === 'register' ? 'active' : ''}" data-mode="register">Create account</button>
      </div>
      <form id="auth-form">
        <div class="field ${mode === 'login' ? 'hidden' : ''}">
          <label for="full_name">Full name</label>
          <input id="full_name" autocomplete="name">
        </div>
        <div class="field">
          <label for="email">Email</label>
          <input id="email" type="email" autocomplete="email" required>
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input id="password" type="password" autocomplete="current-password" required>
          ${mode === 'register' ? '<div class="muted">At least 8 characters.</div>' : ''}
        </div>
        <div class="field ${mode === 'login' ? 'hidden' : ''}">
          <label for="location">Area you live in</label>
          <input id="location" placeholder="e.g. Westlands">
        </div>
        <button class="btn" style="width:100%" type="submit">
          ${mode === 'login' ? 'Log in' : 'Create account'}</button>
        <div class="error-text hidden" id="auth-error"></div>
      </form>
    </div>`;

  root.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => showAuth(t.dataset.mode));
  });

  document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('auth-error');
    errBox.classList.add('hidden');
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
      showAccount();
    } catch (err) {
      errBox.textContent = err.details?.length
        ? err.details.map((d) => `${d.field}: ${d.message}`).join(', ')
        : err.message;
      errBox.classList.remove('hidden');
    }
  });
}

async function showAccount() {
  const root = document.getElementById('account-root');
  root.innerHTML = '<p class="muted">Loading your account…</p>';
  try {
    const [{ user, preferences }, savedData, cats] = await Promise.all([
      API.me(), API.saved(), API.categories(),
    ]);
    const leaves = cats.categories.filter((c) => c.parent_category_id !== null);
    const chosen = new Set(preferences.map((p) => p.category_id));

    root.innerHTML = `
      <div class="layout with-sidebar">
        <aside>
          <div class="panel">
            <h2>${UI.esc(user.full_name)}</h2>
            <p class="muted">${UI.esc(user.email)}<br>${UI.esc(user.location || 'No area set')}</p>
          </div>
          <div class="panel" style="margin-top:.85rem">
            <h3>My preferences</h3>
            <p class="muted">These seed your recommendations before you have a history.</p>
            <div id="pref-list" style="max-height:220px;overflow:auto;margin:.5rem 0">
              ${leaves.map((c) => `
                <label style="display:flex;gap:.45rem;align-items:center;color:var(--ink);font-size:.9rem">
                  <input type="checkbox" value="${c.category_id}" style="width:auto"
                    ${chosen.has(c.category_id) ? 'checked' : ''}>
                  ${UI.esc(c.category_name)}
                </label>`).join('')}
            </div>
            <button class="btn secondary small" id="save-prefs">Update preferences</button>
          </div>
        </aside>
        <div>
          <h1>Saved services (${savedData.count})</h1>
          <div id="saved-list">
            ${savedData.saved.length ? savedData.saved.map((s) => `
              <article class="result">
                <div class="thumb">${UI.esc(String(s.provider_name).trim()[0])}</div>
                <div class="body">
                  <h3><a href="provider.html?id=${s.provider_id}">${UI.esc(s.provider_name)}</a></h3>
                  <div class="muted">${UI.esc(s.category_name)} &middot; ${UI.esc(s.location || '')}</div>
                  ${s.verification_status === 'verified' ? '<span class="badge-verified">Verified</span>' : ''}
                </div>
                <button class="btn secondary small" data-remove="${s.provider_id}">Remove</button>
              </article>`).join('')
    : '<div class="empty"><p>You have not shortlisted any services yet.</p><p><a href="search.html">Browse the catalogue</a></p></div>'}
          </div>
        </div>
      </div>`;

    document.getElementById('save-prefs').addEventListener('click', async () => {
      const ids = [...document.querySelectorAll('#pref-list input:checked')]
        .map((i) => Number(i.value));
      try {
        await API.setPreferences({ category_ids: ids, preferred_location: user.location });
        UI.toast('Preferences updated');
      } catch (err) { UI.toast(err.message, true); }
    });

    root.querySelectorAll('[data-remove]').forEach((b) => {
      b.addEventListener('click', async () => {
        try { await API.unsave(b.dataset.remove); showAccount(); UI.toast('Removed'); }
        catch (err) { UI.toast(err.message, true); }
      });
    });
  } catch (err) {
    if (err.status === 401) { showAuth('login'); return; }
    root.innerHTML = `<p class="error-text">${UI.esc(err.message)}</p>`;
  }
}
