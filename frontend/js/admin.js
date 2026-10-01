/* Administrator console (Figures 4.13 and 4.14): dashboard, verification queue,
   listing form, model controls and the audit log. */
let categoriesCache = [];

document.addEventListener('DOMContentLoaded', async () => {
  const user = API.getUser();
  if (!user || user.role !== 'admin') {
    document.getElementById('admin-root').innerHTML =
      '<div class="empty"><h2>Administrator access required</h2><p class="muted">Sign in with an administrator account.</p><p><a href="account.html?tab=login">Log in</a></p></div>';
    return;
  }
  try { categoriesCache = (await API.categories()).categories.filter((c) => c.parent_category_id !== null); }
  catch { categoriesCache = []; }

  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      show(t.dataset.view);
    });
  });
  show('dashboard');
});

function show(view) {
  ({ dashboard, pending: pendingQueue, listings, form: providerForm, logs }[view] || dashboard)();
}

async function dashboard() {
  const root = document.getElementById('admin-view');
  root.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const s = await API.adminStats();
    const model = s.model?.config || {};
    const metrics = s.model?.metrics || {};
    root.innerHTML = `
      <div class="stat-row">
        ${[['Total listings', s.total_providers], ['Verified', s.verified],
    ['Pending', s.pending], ['Searches this week', s.searches_this_week]]
    .map(([l, v]) => `<div class="stat"><div class="label">${l}</div><div class="value">${v}</div></div>`).join('')}
      </div>
      <div class="layout profile-layout" style="margin-top:1rem">
        <div class="panel">
          <h2>Catalogue</h2>
          <table>
            <tbody>
              <tr><td>Registered parents</td><td><strong>${s.users}</strong></td></tr>
              <tr><td>Recorded interactions</td><td><strong>${s.interactions}</strong></td></tr>
              <tr><td>Rejected listings</td><td><strong>${s.rejected}</strong></td></tr>
            </tbody>
          </table>
        </div>
        <div class="panel rec-panel">
          <h2>Recommendation model</h2>
          ${s.model ? `<table><tbody>
            <tr><td>Encoder</td><td><strong>${UI.esc(model.encoder_name || '—')}</strong></td></tr>
            <tr><td>Neighbourhood k</td><td><strong>${model.k ?? '—'}</strong></td></tr>
            <tr><td>Weight &alpha;</td><td><strong>${model.alpha ?? '—'}</strong></td></tr>
            <tr><td>Matrix density</td><td><strong>${model.density_pct ?? '—'}%</strong></td></tr>
            <tr><td>Indexed providers</td><td><strong>${model.n_providers ?? '—'}</strong></td></tr>
            <tr><td>Recall@10</td><td><strong>${metrics.recall ?? '—'}</strong></td></tr>
            <tr><td>Last trained</td><td><strong>${UI.esc(model.trained_at || '—')}</strong></td></tr>
          </tbody></table>
          <div style="margin-top:.7rem;display:flex;gap:.5rem;flex-wrap:wrap">
            <button class="btn small" id="reindex">Re-index catalogue</button>
            <button class="btn secondary small" id="retrain">Retrain model</button>
          </div>`
    : '<p class="error-text">The recommendation service is unreachable.</p>'}
        </div>
      </div>`;

    const bind = (id, fn, label) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('click', async () => {
        el.disabled = true; el.textContent = 'Working…';
        try { const out = await fn(); UI.toast(`${label} finished in ${out.seconds ?? '?'}s`); dashboard(); }
        catch (err) { UI.toast(err.message, true); el.disabled = false; el.textContent = label; }
      });
    };
    bind('reindex', API.adminReindex, 'Re-index catalogue');
    bind('retrain', API.adminRetrain, 'Retrain model');
  } catch (err) {
    root.innerHTML = `<p class="error-text">${UI.esc(err.message)}</p>`;
  }
}

async function pendingQueue() { await listings('pending'); }

async function listings(status = '') {
  const root = document.getElementById('admin-view');
  root.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const data = await API.adminProviders({ status: status || undefined });
    root.innerHTML = `
      <div class="panel">
        <h2>${status ? 'Pending verification' : 'All listings'} (${data.total})</h2>
        ${data.providers.length ? `<table>
          <thead><tr><th>Provider</th><th>Category</th><th>Area</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>${data.providers.map((p) => `
            <tr>
              <td>${UI.esc(p.provider_name)}</td>
              <td>${UI.esc(p.category_name)}</td>
              <td>${UI.esc(p.location || '')}</td>
              <td>${UI.statusBadge(p.verification_status)}</td>
              <td style="white-space:nowrap">
                ${p.verification_status !== 'verified'
    ? `<button class="btn small" data-verify="${p.provider_id}">Approve</button>` : ''}
                ${p.verification_status !== 'rejected'
    ? `<button class="btn secondary small" data-reject="${p.provider_id}">Reject</button>` : ''}
                <button class="btn secondary small" data-edit="${p.provider_id}">Edit</button>
              </td>
            </tr>`).join('')}</tbody></table>`
    : '<div class="empty"><p>Nothing here.</p></div>'}
      </div>`;

    const act = async (id, statusValue) => {
      try {
        await API.adminVerify(id, statusValue);
        UI.toast(statusValue === 'verified'
          ? 'Approved — the catalogue is being re-indexed'
          : 'Listing rejected');
        listings(status);
      } catch (err) { UI.toast(err.message, true); }
    };
    root.querySelectorAll('[data-verify]').forEach((b) =>
      b.addEventListener('click', () => act(b.dataset.verify, 'verified')));
    root.querySelectorAll('[data-reject]').forEach((b) =>
      b.addEventListener('click', () => act(b.dataset.reject, 'rejected')));
    root.querySelectorAll('[data-edit]').forEach((b) =>
      b.addEventListener('click', () => providerForm(b.dataset.edit)));
  } catch (err) {
    root.innerHTML = `<p class="error-text">${UI.esc(err.message)}</p>`;
  }
}

async function providerForm(id = null) {
  const root = document.getElementById('admin-view');
  let p = {
    provider_name: '', category_id: '', service_description: '', service_tags: '',
    location: '', qualifications: '', contact_email: '', verification_status: 'pending',
  };
  if (id) {
    try { ({ provider: p } = await API.adminProvider(id)); }
    catch (err) { UI.toast(err.message, true); return; }
  }

  root.innerHTML = `
    <div class="panel" style="max-width:720px">
      <h2>${id ? 'Edit listing' : 'Add a new listing'}</h2>
      ${id ? `<p>${UI.statusBadge(p.verification_status)}</p>` : ''}
      <form id="provider-form">
        <div class="form-row">
          <div class="field"><label for="provider_name">Provider name</label>
            <input id="provider_name" value="${UI.esc(p.provider_name)}" required></div>
          <div class="field"><label for="category_id">Service category</label>
            <select id="category_id" required>
              <option value="">Select…</option>
              ${categoriesCache.map((c) => `<option value="${c.category_id}"${c.category_id === p.category_id ? ' selected' : ''}>${UI.esc(c.category_name)}</option>`).join('')}
            </select></div>
        </div>
        <div class="field"><label for="service_description">Service description</label>
          <textarea id="service_description" required>${UI.esc(p.service_description)}</textarea>
          <div class="muted">At least 20 characters. This text is what the recommender reads.</div></div>
        <div class="form-row">
          <div class="field"><label for="service_tags">Tags (comma separated)</label>
            <input id="service_tags" value="${UI.esc(p.service_tags)}" placeholder="lactation, home-visit"></div>
          <div class="field"><label for="location">Location</label>
            <input id="location" value="${UI.esc(p.location)}" required></div>
        </div>
        <div class="field"><label for="qualifications">Qualifications and evidence</label>
          <textarea id="qualifications">${UI.esc(p.qualifications || '')}</textarea></div>
        <div class="field"><label for="contact_email">Contact email</label>
          <input id="contact_email" type="email" value="${UI.esc(p.contact_email || '')}"></div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap">
          <button class="btn" type="submit">${id ? 'Save changes' : 'Create listing'}</button>
          ${id && p.verification_status !== 'verified'
    ? '<button class="btn secondary" type="button" id="save-verify">Save and approve</button>' : ''}
          <button class="btn secondary" type="button" id="cancel">Cancel</button>
        </div>
        <div class="error-text hidden" id="form-error"></div>
      </form>
    </div>`;

  const read = () => ({
    provider_name: document.getElementById('provider_name').value.trim(),
    category_id: Number(document.getElementById('category_id').value),
    service_description: document.getElementById('service_description').value.trim(),
    service_tags: document.getElementById('service_tags').value.trim() || undefined,
    location: document.getElementById('location').value.trim(),
    qualifications: document.getElementById('qualifications').value.trim() || undefined,
    contact_email: document.getElementById('contact_email').value.trim() || undefined,
  });

  const submit = async (thenVerify = false) => {
    const errBox = document.getElementById('form-error');
    errBox.classList.add('hidden');
    try {
      const body = read();
      const saved = id
        ? await API.adminUpdateProvider(id, body)
        : await API.adminCreateProvider(body);
      const pid = id || saved.provider_id;
      if (thenVerify) await API.adminVerify(pid, 'verified');
      UI.toast(thenVerify ? 'Saved and approved' : 'Listing saved');
      listings();
    } catch (err) {
      errBox.textContent = err.details?.length
        ? err.details.map((d) => `${d.field}: ${d.message}`).join(', ')
        : err.message;
      errBox.classList.remove('hidden');
    }
  };

  document.getElementById('provider-form').addEventListener('submit', (e) => {
    e.preventDefault(); submit(false);
  });
  document.getElementById('save-verify')?.addEventListener('click', () => submit(true));
  document.getElementById('cancel').addEventListener('click', () => listings());
}

async function logs() {
  const root = document.getElementById('admin-view');
  root.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const { logs: rows } = await API.adminLogs();
    root.innerHTML = `<div class="panel"><h2>Activity log</h2>
      ${rows.length ? `<table>
        <thead><tr><th>When</th><th>Administrator</th><th>Action</th><th>Entity</th></tr></thead>
        <tbody>${rows.map((l) => `<tr>
          <td>${UI.esc(String(l.performed_at).replace('T', ' ').slice(0, 19))}</td>
          <td>${UI.esc(l.admin_name || l.admin_id)}</td>
          <td>${UI.esc(l.action_type)}</td>
          <td>${UI.esc(l.entity_affected || '')} ${l.entity_id ?? ''}</td>
        </tr>`).join('')}</tbody></table>` : '<div class="empty"><p>No activity yet.</p></div>'}
    </div>`;
  } catch (err) {
    root.innerHTML = `<p class="error-text">${UI.esc(err.message)}</p>`;
  }
}
