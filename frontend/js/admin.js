/* Administrator console (Figures 4.13 and 4.14): dashboard, verification
   queue, listings, the listing form with supporting evidence, categories,
   registered users, reports, model controls and the audit log. */
let categories = [];
let me = null;
const view = () => document.getElementById('admin-view');
const loading = () => { view().innerHTML = '<p class="muted">Loading…</p>'; };
const failed = (err) => { view().innerHTML = `<p class="error-text">${UI.esc(err.message)}</p>`; };
const errText = (err) => (err.details?.length
  ? err.details.map((d) => `${d.field.replace(/_/g, ' ')}: ${d.message}`).join(', ') : err.message);

document.addEventListener('DOMContentLoaded', async () => {
  me = API.getUser();
  if (!me || me.role !== 'admin') {
    document.getElementById('admin-root').innerHTML =
      '<div class="empty"><h2>Administrator access required</h2><p class="muted">Sign in with an administrator account.</p><p><a href="account.html?tab=login">Log in</a></p></div>';
    return;
  }
  await loadCategories();
  document.querySelectorAll('#admin-tabs .tab').forEach((t) => {
    t.addEventListener('click', () => show(t.dataset.view));
  });
  const start = UI.params().view;
  show(VIEWS[start] ? start : 'dashboard');
});

// Verification document types; the server's list replaces this on load.
let DOC_LABELS = {
  identity: 'Identity document', qualification: 'Qualification certificate',
  professional_registration: 'Professional registration', business_registration: 'Business registration',
  facility_licence: 'Facility licence', other: 'Other supporting document',
};

async function loadCategories() {
  try {
    const out = await API.adminCategories();
    categories = out.categories;
    if (out.document_types) DOC_LABELS = out.document_types;
  } catch { categories = []; }
}

const VIEWS = {
  dashboard: () => dashboard(),
  pending: () => listings({ status: 'queue' }),
  listings: () => listings({}),
  form: () => providerForm(null),
  categories: () => categoryAdmin(),
  areas: () => areaAdmin(),
  users: () => users({}),
  reports: () => reports('all'),
  logs: () => logs(1),
};

function show(name, ...args) {
  document.querySelectorAll('#admin-tabs .tab').forEach((x) => {
    x.classList.toggle('active', x.dataset.view === name);
    x.setAttribute('aria-selected', String(x.dataset.view === name));
  });
  history.replaceState(null, '', `admin.html?view=${name}`);
  (args.length && name === 'form' ? () => providerForm(...args) : VIEWS[name])();
  refreshPendingCount();
}

async function refreshPendingCount() {
  try {
    const { total } = await API.adminProviders({ status: 'queue', per_page: 1 });
    const el = document.getElementById('pending-count');
    el.textContent = total;
    el.classList.toggle('hidden', !total);
  } catch { /* badge simply stays as it was */ }
}

/* What each workflow move is called on a button, what it needs and what it says afterwards. */
const MOVES = {
  pending: { button: 'Submit for review', done: 'Submitted for review' },
  under_review: { button: 'Start review', done: 'Review started' },
  verified: {
    button: 'Approve',
    done: 'Approved — the listing is now searchable and the catalogue is being re-indexed',
  },
  needs_more_information: {
    button: 'Ask for more information', reason: 'Ask for more information',
    help: 'Say exactly which document or detail the provider must supply.',
    done: 'Marked as needing more information; the request is in its history',
  },
  rejected: {
    button: 'Reject', reason: 'Reject', danger: true,
    help: 'Say why the listing cannot be accepted. The provider may resubmit.',
    done: 'Listing rejected; the reason is in its history',
  },
  suspended: {
    button: 'Suspend', reason: 'Suspend', danger: true,
    help: 'Say why the listing is suspended. It leaves search and recommendations at once.',
    done: 'Listing suspended and removed from search',
  },
  expired: { button: 'Mark expired', done: 'Listing marked expired and removed from search' },
};

/** Moves a listing; asks for a reason first where the workflow requires one. */
async function setStatus(id, status, name = 'this listing') {
  const move = MOVES[status] || {};
  let note = null;
  if (move.reason) {
    note = await askReason(name, move);
    if (!note) return false;
  }
  try {
    await API.adminVerify(id, status, note);
    UI.toast(move.done || 'Status updated');
    refreshPendingCount();
    return true;
  } catch (err) { UI.toast(errText(err), true); return false; }
}

function askReason(name, move = MOVES.rejected) {
  const dialog = document.getElementById('reason-dialog');
  const text = document.getElementById('reason-text');
  document.getElementById('reason-title').textContent = `${move.reason}: ${name}`;
  document.getElementById('reason-help').textContent = move.help;
  document.getElementById('reason-ok').textContent = move.reason;
  text.value = '';
  return new Promise((resolve) => {
    const done = () => {
      dialog.removeEventListener('close', done);
      resolve(dialog.returnValue === 'ok' && text.value.trim().length >= 5 ? text.value.trim() : null);
    };
    dialog.addEventListener('close', done);
    dialog.returnValue = '';
    dialog.showModal();
    text.focus();
  });
}

/* ------------------------------------------------------------- dashboard */
async function dashboard() {
  loading();
  try {
    const [s, pending, recent, expiring] = await Promise.all([
      API.adminStats(),
      API.adminProviders({ status: 'queue', per_page: 5 }),
      API.adminLogs({ limit: 6 }),
      API.adminExpiringDocuments(),
    ]);
    const model = s.model?.config || {};
    const metrics = s.model?.metrics || {};
    view().innerHTML = `
      ${s.mfa_enabled ? '' : `<div class="notice" role="status">
        <strong>Turn on two-step sign-in.</strong> Your account can approve listings and change roles;
        a password alone is not enough protection.
        <a href="account.html?tab=password">Set it up</a></div>`}
      <div class="stat-row">
        ${[['Verified listings', s.verified], ['Waiting for review', s.queue],
    ['Needs more information', s.needs_more_information], ['Documents expiring (30 days)', s.documents_expiring]]
    .map(([l, v]) => `<div class="stat"><div class="label">${l}</div><div class="value">${Number(v).toLocaleString()}</div></div>`).join('')}
      </div>
      <p class="muted">Also: ${Number(s.suspended)} suspended · ${Number(s.expired)} expired ·
        ${Number(s.rejected)} rejected · ${Number(s.searches_this_week).toLocaleString()} searches this week</p>
      <div class="layout dash-layout">
        <div class="panel">
          <div class="panel-head"><h2>Verification queue</h2>
            <button class="btn secondary small" type="button" id="all-pending">View the whole queue</button></div>
          ${pending.providers.length ? `<div class="table-wrap"><table>
            <thead><tr><th>Provider</th><th>Category</th><th>Status</th><th>Submitted</th><th>Documents</th><th>Action</th></tr></thead>
            <tbody>${pending.providers.map((p) => `<tr>
              <td><a href="#" data-review="${p.provider_id}">${UI.esc(p.provider_name)}</a></td>
              <td>${UI.esc(p.category_name)}</td>
              <td>${UI.statusBadge(p.verification_status)}</td>
              <td>${UI.fmtDate(p.created_at)}</td>
              <td>${p.evidence_count ? `${p.evidence_count} file${p.evidence_count > 1 ? 's' : ''}` : '<span class="muted">none</span>'}</td>
              <td class="actions">
                <button class="btn small" type="button" data-review="${p.provider_id}">Review</button>
              </td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty"><p>The queue is empty.</p></div>'}
          <h3 style="margin-top:1rem">Documents expiring soon</h3>
          ${expiring.documents.length ? `<div class="table-wrap"><table>
            <thead><tr><th>Provider</th><th>Document</th><th>Expires</th></tr></thead>
            <tbody>${expiring.documents.map((d) => `<tr>
              <td><a href="#" data-review="${d.provider_id}">${UI.esc(d.provider_name)}</a></td>
              <td>${UI.esc(DOC_LABELS[d.document_type] || d.document_type)} (v${Number(d.version)})</td>
              <td>${UI.fmtDate(d.expires_on)} · ${Number(d.days_left) < 0 ? '<strong>expired</strong>'
    : `${Number(d.days_left)} day${Number(d.days_left) === 1 ? '' : 's'} left`}</td>
            </tr>`).join('')}</tbody></table></div>`
    : `<p class="muted">No accepted document expires in the next ${Number(expiring.days)} days.</p>`}
        </div>
        <div class="panel rec-panel">
          <h2>Model status</h2>
          ${s.model ? `<table><tbody>
            <tr><td>Encoder</td><td><strong>${UI.esc(model.encoder_name || '—')}</strong></td></tr>
            <tr><td>Weight &alpha;</td><td><strong>${model.alpha ?? '—'}</strong>
              <div class="muted">${UI.esc(model.alpha_source || '')}</div></td></tr>
            <tr><td>Neighbourhood k</td><td><strong>${model.k ?? '—'}</strong></td></tr>
            <tr><td>Matrix density</td><td><strong>${model.density_pct ?? '—'}%</strong></td></tr>
            <tr><td>Indexed services</td><td><strong>${model.n_providers ?? '—'}</strong></td></tr>
            <tr><td>Recall@10</td><td><strong>${metrics.recall ?? '—'}</strong>
              ${metrics.users ? `<div class="muted">${metrics.users} held-out users · ${UI.esc(metrics.protocol || '')}</div>` : ''}</td></tr>
            <tr><td>Last re-index</td><td>${UI.esc(s.model.last_reindexed || '—')}</td></tr>
            <tr><td>Last retrain</td><td>${UI.esc(s.model.last_retrained || '—')}</td></tr>
          </tbody></table>
          <div class="button-row">
            <button class="btn small" type="button" id="reindex">Re-index catalogue</button>
            <button class="btn secondary small" type="button" id="retrain">Retrain model</button>
          </div>
          <p class="muted" style="margin-top:.5rem">Re-index refits the serving version on the current catalogue.
            Retrain builds a new candidate version, choosing &alpha; and the location and quality weights
            on validation data; it serves only if it scores no worse than the current version.</p>`
    : '<p class="error-text">The recommendation service is unreachable. Search still works; recommendations fall back to popular services.</p>'}
        </div>
      </div>
      <div class="panel" style="margin-top:1rem" id="model-versions"></div>
      <div class="panel" style="margin-top:1rem">
        <div class="panel-head"><h2>Recent administrative activity</h2>
          <button class="btn secondary small" type="button" id="all-logs">Full activity log</button></div>
        ${logTable(recent.logs)}
      </div>`;

    const v = view();
    v.querySelector('#all-pending').addEventListener('click', () => show('pending'));
    v.querySelector('#all-logs').addEventListener('click', () => show('logs'));
    v.querySelectorAll('[data-review]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault(); show('form', Number(a.dataset.review));
    }));
    modelVersions(v.querySelector('#model-versions'));
    bindModelButton('reindex', API.adminReindex, 'Re-index catalogue');
    bindModelButton('retrain', API.adminRetrain, 'Retrain model');
  } catch (err) { failed(err); }
}

function bindModelButton(id, fn, label) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('click', async () => {
    el.disabled = true; el.textContent = 'Working…';
    try {
      const out = await fn();
      UI.toast(out.candidate
        ? `Candidate ${out.candidate.id} ${out.promoted ? 'is now serving' : 'was kept as a candidate'}: ${out.reason}`
        : `${label} finished in ${out.seconds ?? '?'}s`);
      dashboard();
    } catch (err) { UI.toast(err.message, true); el.disabled = false; el.textContent = label; }
  });
}

/* -------------------------------------------------------------- listings */
async function listings(filters) {
  const f = { status: '', q: '', category: '', page: 1, ...filters };
  loading();
  try {
    const data = await API.adminProviders({ ...f, per_page: 20 });
    const title = f.status === 'queue' ? 'Verification queue' : 'Provider listings';
    view().innerHTML = `
      <div class="panel">
        <div class="panel-head"><h2>${title} (${data.total})</h2>
          <button class="btn small" type="button" id="new-listing">Add listing</button></div>
        <form class="toolbar" id="list-filters">
          <input id="lf-q" placeholder="Search name, area or email" value="${UI.esc(f.q)}" aria-label="Search listings">
          <select id="lf-status" aria-label="Status">
            ${[['', 'Any status'], ['queue', 'Waiting for review'], ...Object.entries(UI.STATUS_LABELS)]
    .map(([s, label]) => `<option value="${s}"${s === f.status ? ' selected' : ''}>${UI.esc(label)}</option>`).join('')}
          </select>
          <select id="lf-category" aria-label="Category">${UI.categoryOptions(categories, f.category)}</select>
          <button class="btn secondary small" type="submit">Apply</button>
        </form>
        ${data.providers.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Provider</th><th>Category</th><th>Area</th><th>Status</th><th>Evidence</th><th>Added</th><th>Action</th></tr></thead>
          <tbody>${data.providers.map((p) => `
            <tr>
              <td><a href="#" data-edit="${p.provider_id}">${UI.esc(p.provider_name)}</a></td>
              <td>${UI.esc(p.category_name)}</td>
              <td>${UI.esc(p.location || '')}</td>
              <td>${UI.statusBadge(p.verification_status)}</td>
              <td>${p.evidence_count || '<span class="muted">0</span>'}</td>
              <td>${UI.fmtDate(p.created_at)}</td>
              <td class="actions">
                <button class="btn secondary small" type="button" data-edit="${p.provider_id}">Review / edit</button>
                <button class="btn danger small" type="button" data-delete="${p.provider_id}" data-name="${UI.esc(p.provider_name)}">Delete</button>
              </td>
            </tr>`).join('')}</tbody></table></div>`
    : '<div class="empty"><p>No listings match.</p></div>'}
        <div class="pagination" id="list-pager"></div>
      </div>`;

    const v = view();
    const again = (extra = {}) => listings({ ...f, ...extra });
    v.querySelector('#new-listing').addEventListener('click', () => show('form'));
    v.querySelector('#list-filters').addEventListener('submit', (e) => {
      e.preventDefault();
      again({
        q: v.querySelector('#lf-q').value.trim(),
        status: v.querySelector('#lf-status').value,
        category: v.querySelector('#lf-category').value,
        page: 1,
      });
    });
    UI.pager(v.querySelector('#list-pager'), data, (n) => again({ page: n }));
    v.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', (e) => {
      e.preventDefault(); show('form', Number(b.dataset.edit));
    }));
    v.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', async () => {
      if (!window.confirm(`Delete "${b.dataset.name}" permanently? Its interactions, saves and files go with it. This cannot be undone.`)) return;
      try {
        await API.adminDeleteProvider(b.dataset.delete);
        UI.toast('Listing deleted');
        again();
      } catch (err) { UI.toast(err.message, true); }
    }));
  } catch (err) { failed(err); }
}

/* ------------------------------------------------------- listing form */
async function providerForm(id = null) {
  let p = {
    provider_name: '', category_id: '', service_description: '', service_tags: '',
    location: '', qualifications: '', contact_email: '', verification_status: 'pending',
  };
  let files = [];
  let events = [];
  let requirements = [];
  let nextStates = [];
  let areaList = [];
  try { areaList = (await API.adminAreas()).areas.filter((a) => a.is_active); } catch { /* form still works */ }
  if (id) {
    loading();
    try {
      ({
        provider: p, media: files, events, requirements, next_states: nextStates,
      } = await API.adminProvider(id));
    } catch (err) { failed(err); return; }
  }
  const evidence = files.filter((m) => m.media_type === 'evidence');
  const images = files.filter((m) => m.media_type === 'image');
  const queued = { evidence: [], image: [] };
  const docOptions = (sel = '') => Object.entries(DOC_LABELS)
    .map(([k, label]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${UI.esc(label)}</option>`).join('');

  view().innerHTML = `
    <form id="provider-form" class="layout form-layout" novalidate>
      <div class="panel">
        <h2>${id ? `Edit listing: ${UI.esc(p.provider_name)}` : 'Add a new listing'}</h2>
        <div class="form-row">
          <div class="field"><label for="provider_name">Provider name</label>
            <input id="provider_name" value="${UI.esc(p.provider_name)}" required maxlength="150"></div>
          <div class="field"><label for="category_id">Service category</label>
            <select id="category_id" required>${UI.categoryOptions(categories, p.category_id, { placeholder: 'Select…' })}</select></div>
        </div>
        <div class="field"><label for="service_description">Service description</label>
          <textarea id="service_description" required minlength="20" maxlength="4000">${UI.esc(p.service_description)}</textarea>
          <div class="muted">At least 20 characters. This text is what the recommender reads.</div></div>
        <div class="form-row">
          <div class="field"><label for="service_tags">Service tags (comma separated)</label>
            <input id="service_tags" value="${UI.esc(p.service_tags || '')}" placeholder="lactation, home visit" maxlength="255"></div>
          <div class="field"><label for="location">Primary area</label>
            <input id="location" value="${UI.esc(p.location || '')}" placeholder="Area / estate / town"
              required maxlength="120" list="area-options">
            <datalist id="area-options">${areaList.map((a) => `<option value="${UI.esc(a.area_name)}">`).join('')}</datalist></div>
        </div>
        ${areaList.length ? `<fieldset class="field area-set"><legend>Also serves</legend>
          <div class="area-grid">${areaList.map((a) => `<label class="check">
            <input type="checkbox" name="area" value="${Number(a.area_id)}"${(p.area_ids || []).includes(Number(a.area_id)) ? ' checked' : ''}>
            ${UI.esc(a.area_name)}</label>`).join('')}</div>
          <div class="muted">Areas the provider visits or takes clients from. The primary area is always included.
            Never enter a home address.</div></fieldset>` : ''}
        <div class="field"><label for="qualifications">Qualifications</label>
          <textarea id="qualifications" maxlength="2000">${UI.esc(p.qualifications || '')}</textarea></div>
        <div class="field"><label for="contact_email">Contact email</label>
          <input id="contact_email" type="email" value="${UI.esc(p.contact_email || '')}" placeholder="info@provider.co.ke"></div>
        <div class="button-row">
          <button class="btn" type="submit">Save listing</button>
          <button class="btn secondary" type="button" id="cancel">Cancel</button>
        </div>
        <div class="error-text hidden" id="form-error" role="alert"></div>
      </div>
      <div class="side-stack">
        <div class="panel">
          <h2>Verification</h2>
          ${id ? `<p>Status: ${UI.statusBadge(p.verification_status)}</p>
            ${requirements.length ? `<h3>Required documents</h3>
              <ul class="checklist">${requirements.map((r) => `<li class="${r.satisfied ? 'ok' : 'todo'}">
                <span aria-hidden="true">${r.satisfied ? '✓' : '○'}</span>
                ${UI.esc(r.label)} <span class="muted">${r.satisfied ? 'accepted and current' : 'still needed'}</span></li>`).join('')}</ul>` : ''}
            ${nextStates.length ? `<div class="button-row">${nextStates.map((s) => `
              <button class="btn ${MOVES[s]?.danger ? 'danger' : s === 'verified' ? '' : 'secondary'} small"
                type="button" data-move="${s}">${UI.esc(MOVES[s]?.button || UI.STATUS_LABELS[s])}</button>`).join('')}</div>` : ''}`
    : '<p>New listings start as <strong>pending</strong>. Save first, then attach and review documents.</p>'}
          <p class="muted">Only verified listings appear in search and recommendations.
            Approval needs an accepted, current copy of every required document.</p>
          ${events.length ? `<h3>History</h3><ul class="history">${events.map((h) => `
            <li><strong>${UI.esc(h.from_status ? `${UI.STATUS_LABELS[h.from_status] || h.from_status} → ` : '')}${UI.esc(UI.STATUS_LABELS[h.to_status] || h.to_status)}</strong>
              · ${UI.fmtDate(h.created_at, true)} · ${UI.esc(h.actor_name || 'automatic')}
              ${h.reason ? `<div class="muted">${UI.esc(h.reason)}</div>` : ''}</li>`).join('')}</ul>` : ''}
        </div>
        <div class="panel">
          <h2>Verification documents</h2>
          <p class="muted">PDF, JPG or PNG, up to 5 MB each. Only administrators can open these, and every opening is logged.</p>
          <ul class="file-list doc-list" id="evidence-list">${evidence.map(docRow).join('')}</ul>
          <label class="drop" for="evidence-input">Choose documents to attach
            <input id="evidence-input" type="file" accept="application/pdf,image/png,image/jpeg" multiple></label>
        </div>
        <div class="panel">
          <h2>Profile image</h2>
          <p class="muted">Shown on the public profile once the listing is verified. JPG or PNG.</p>
          <ul class="file-list" id="image-list">${images.map(fileRow).join('')}</ul>
          <label class="drop" for="image-input">Choose an image
            <input id="image-input" type="file" accept="image/png,image/jpeg"></label>
        </div>
      </div>
    </form>`;

  const v = view();
  const bindFileRows = (listEl) => {
    listEl.querySelectorAll('[data-download]').forEach((b) => b.addEventListener('click', () =>
      API.adminDownloadMedia(b.dataset.download, b.dataset.file).catch((err) => UI.toast(err.message, true))));
    listEl.querySelectorAll('[data-remove-file]').forEach((b) => b.addEventListener('click', async () => {
      if (!window.confirm('Remove this file?')) return;
      try { await API.adminDeleteMedia(b.dataset.removeFile); b.closest('li').remove(); UI.toast('File removed'); }
      catch (err) { UI.toast(err.message, true); }
    }));
    listEl.querySelectorAll('[data-accept-doc]').forEach((b) => b.addEventListener('click', async () => {
      try { await API.adminReviewDocument(b.dataset.acceptDoc, 'accepted'); UI.toast('Document accepted'); show('form', id); }
      catch (err) { UI.toast(errText(err), true); }
    }));
    listEl.querySelectorAll('[data-reject-doc]').forEach((b) => b.addEventListener('click', async () => {
      const note = await askReason('this document', {
        reason: 'Reject document', help: 'Say what is wrong with it, e.g. unreadable, expired or the wrong person.',
      });
      if (!note) return;
      try { await API.adminReviewDocument(b.dataset.rejectDoc, 'rejected', note); UI.toast('Document rejected'); show('form', id); }
      catch (err) { UI.toast(errText(err), true); }
    }));
    listEl.querySelectorAll('[data-unqueue]').forEach((b) => b.addEventListener('click', () => {
      const [kind, idx] = b.dataset.unqueue.split(':');
      queued[kind][Number(idx)] = null;
      b.closest('li').remove();
    }));
  };
  bindFileRows(v.querySelector('#evidence-list'));
  bindFileRows(v.querySelector('#image-list'));

  // Evidence rows ask what the document is and when it expires before upload.
  const queue = (kind, input, listEl) => {
    [...input.files].forEach((file) => {
      if (file.size > 5 * 1024 * 1024) { UI.toast(`${file.name} is over 5 MB`, true); return; }
      const idx = queued[kind].push({ file }) - 1;
      const meta = kind === 'evidence' ? `
        <label class="sr-only" for="qt-${idx}">Document type</label>
        <select id="qt-${idx}" data-qtype="${idx}" required><option value="">Document type…</option>${docOptions()}</select>
        <label class="inline-label" for="qe-${idx}">Expires</label>
        <input id="qe-${idx}" type="date" data-qexp="${idx}">` : '';
      listEl.insertAdjacentHTML('beforeend', `<li class="queued"><span>${UI.esc(file.name)}</span>${meta}
        <span class="muted">uploads on save</span>
        <button class="btn secondary small" type="button" data-unqueue="${kind}:${idx}">Remove</button></li>`);
    });
    input.value = '';
    bindFileRows(listEl);
  };
  v.querySelector('#evidence-input').addEventListener('change', (e) => queue('evidence', e.target, v.querySelector('#evidence-list')));
  v.querySelector('#image-input').addEventListener('change', (e) => queue('image', e.target, v.querySelector('#image-list')));

  v.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    if (await setStatus(id, b.dataset.move, `"${p.provider_name}"`)) show('form', id);
    else b.disabled = false;
  }));

  const read = () => ({
    provider_name: v.querySelector('#provider_name').value.trim(),
    category_id: Number(v.querySelector('#category_id').value) || undefined,
    service_description: v.querySelector('#service_description').value.trim(),
    service_tags: v.querySelector('#service_tags').value.trim() || undefined,
    location: v.querySelector('#location').value.trim(),
    qualifications: v.querySelector('#qualifications').value.trim() || undefined,
    contact_email: v.querySelector('#contact_email').value.trim() || undefined,
    area_ids: [...v.querySelectorAll('input[name="area"]:checked')].map((x) => Number(x.value)),
  });

  const form = v.querySelector('#provider-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = v.querySelector('#form-error');
    errBox.classList.add('hidden');
    // Every queued document needs a type before anything is saved.
    for (const [i, q] of queued.evidence.entries()) {
      if (!q) continue;
      q.document_type = v.querySelector(`[data-qtype="${i}"]`).value;
      q.expires_on = v.querySelector(`[data-qexp="${i}"]`).value || undefined;
      if (!q.document_type) {
        errBox.textContent = `Choose a document type for ${q.file.name}.`;
        errBox.classList.remove('hidden');
        v.querySelector(`[data-qtype="${i}"]`).focus();
        return;
      }
    }
    const buttons = [...form.querySelectorAll('button')];
    buttons.forEach((b) => { b.disabled = true; });
    try {
      const body = read();
      const saved = id ? await API.adminUpdateProvider(id, body) : await API.adminCreateProvider(body);
      const pid = id || saved.provider_id;
      let uploadErrors = 0;
      for (const kind of ['evidence', 'image']) {
        for (const q of queued[kind].filter(Boolean)) {
          try { await API.adminUpload(pid, kind, q.file, q); } catch (err) {
            uploadErrors += 1; UI.toast(`${q.file.name}: ${errText(err)}`, true);
          }
        }
      }
      UI.toast(uploadErrors ? 'Listing saved; some files did not upload' : 'Listing saved');
      show('form', pid);
    } catch (err) {
      errBox.textContent = errText(err);
      errBox.classList.remove('hidden');
      buttons.forEach((b) => { b.disabled = false; });
    }
  });
  v.querySelector('#cancel').addEventListener('click', () => show('listings'));
}

function fileRow(m) {
  const kind = m.file_path.split('.').pop().toUpperCase();
  return `<li><span>${UI.esc(kind)} file #${m.media_id}</span>
    <button class="btn secondary small" type="button" data-download="${m.media_id}" data-file="${UI.esc(m.file_path)}">Download</button>
    <button class="btn secondary small" type="button" data-remove-file="${m.media_id}">Remove</button></li>`;
}

/** One verification document: what it is, its version, expiry and review. */
function docRow(m) {
  const d = new Date();  // local calendar day, as the server judges expiry
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const exp = m.expires_on ? String(m.expires_on).slice(0, 10) : null;
  const expired = exp && exp < today;
  const review = { accepted: 'Accepted', rejected: 'Rejected', pending: 'Awaiting review' }[m.review_status] || 'Awaiting review';
  return `<li class="doc">
    <span><strong>${UI.esc(DOC_LABELS[m.document_type] || 'Document')}</strong> · v${Number(m.version || 1)}
      <span class="muted">${exp ? `${expired ? 'expired' : 'expires'} ${UI.fmtDate(exp)}` : 'no expiry date'}</span>
      <span class="doc-status ${expired ? 'bad' : m.review_status || 'pending'}">${expired ? 'Expired' : review}</span>
      ${m.review_note ? `<span class="muted">“${UI.esc(m.review_note)}”${m.reviewer_name ? ` — ${UI.esc(m.reviewer_name)}` : ''}</span>` : ''}</span>
    <button class="btn secondary small" type="button" data-download="${m.media_id}" data-file="${UI.esc(m.file_path)}">Open</button>
    ${m.review_status !== 'accepted' ? `<button class="btn small" type="button" data-accept-doc="${m.media_id}">Accept</button>` : ''}
    ${m.review_status !== 'rejected' ? `<button class="btn secondary small" type="button" data-reject-doc="${m.media_id}">Reject</button>` : ''}
    <button class="btn secondary small" type="button" data-remove-file="${m.media_id}">Remove</button></li>`;
}

/* ------------------------------------------------------------ categories */
async function categoryAdmin(editing = null) {
  loading();
  await loadCategories();
  const top = categories.filter((c) => c.parent_category_id === null);
  const cur = editing ? categories.find((c) => c.category_id === editing) : null;
  view().innerHTML = `
    <div class="layout dash-layout">
      <div class="panel">
        <h2>Categories (${categories.length})</h2>
        <p class="muted">Top-level categories are the service types parents filter by.
          Providers attach to the categories under them.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Category</th><th>Verified / all providers</th><th>Action</th></tr></thead>
          <tbody>${categories.map((c) => `<tr class="${c.parent_category_id ? 'child-row' : 'type-row'}">
            <td>${c.parent_category_id ? '<span class="indent" aria-hidden="true">└</span>' : ''}<strong>${UI.esc(c.category_name)}</strong>
              ${c.description ? `<div class="muted">${UI.esc(c.description)}</div>` : ''}</td>
            <td>${c.child_count ? `<span class="muted">${c.child_count} sub-categories</span>` : `${c.verified_count} / ${c.provider_count}`}
              ${c.required_documents ? `<div class="muted">Needs: ${c.required_documents.split(',').map((d) => UI.esc(DOC_LABELS[d] || d)).join(', ')}</div>` : ''}</td>
            <td class="actions">
              <button class="btn secondary small" type="button" data-edit-cat="${c.category_id}">Edit</button>
              <button class="btn danger small" type="button" data-del-cat="${c.category_id}"
                ${c.provider_count || c.child_count ? 'disabled title="Move its providers or sub-categories first"' : ''}>Delete</button>
            </td></tr>`).join('')}</tbody></table></div>
      </div>
      <div class="panel">
        <h2>${cur ? `Edit ${UI.esc(cur.category_name)}` : 'Add a category'}</h2>
        <form id="cat-form">
          <div class="field"><label for="cat-name">Name</label>
            <input id="cat-name" value="${UI.esc(cur?.category_name || '')}" required maxlength="120"></div>
          <div class="field"><label for="cat-parent">Service type</label>
            <select id="cat-parent">
              <option value="">None — this is a service type</option>
              ${top.filter((t) => t.category_id !== cur?.category_id).map((t) => `<option value="${t.category_id}"${t.category_id === cur?.parent_category_id ? ' selected' : ''}>${UI.esc(t.category_name)}</option>`).join('')}
            </select></div>
          <div class="field"><label for="cat-desc">Description</label>
            <textarea id="cat-desc" maxlength="1000">${UI.esc(cur?.description || '')}</textarea></div>
          <fieldset class="field doc-reqs"><legend>Documents required before a listing is verified</legend>
            ${Object.entries(DOC_LABELS).filter(([k]) => k !== 'other').map(([k, label]) => `<label class="check">
              <input type="checkbox" name="req-doc" value="${k}"${String(cur?.required_documents || '').split(',').includes(k) ? ' checked' : ''}>
              ${UI.esc(label)}</label>`).join('')}
            <div class="muted">Leave all unticked to use the service type's list (or identity only for a service type).</div>
          </fieldset>
          <div class="button-row">
            <button class="btn" type="submit">${cur ? 'Save changes' : 'Add category'}</button>
            ${cur ? '<button class="btn secondary" type="button" id="cat-cancel">Cancel</button>' : ''}
          </div>
          <div class="error-text hidden" id="cat-error" role="alert"></div>
        </form>
      </div>
    </div>`;
  const v = view();
  v.querySelectorAll('[data-edit-cat]').forEach((b) => b.addEventListener('click', () => categoryAdmin(Number(b.dataset.editCat))));
  v.querySelectorAll('[data-del-cat]').forEach((b) => b.addEventListener('click', async () => {
    const c = categories.find((x) => x.category_id === Number(b.dataset.delCat));
    if (!window.confirm(`Delete the category "${c.category_name}"?`)) return;
    try { await API.adminDeleteCategory(c.category_id); UI.toast('Category deleted'); categoryAdmin(); }
    catch (err) { UI.toast(err.message, true); }
  }));
  v.querySelector('#cat-cancel')?.addEventListener('click', () => categoryAdmin());
  v.querySelector('#cat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = v.querySelector('#cat-error');
    errBox.classList.add('hidden');
    const body = {
      category_name: v.querySelector('#cat-name').value.trim(),
      parent_category_id: Number(v.querySelector('#cat-parent').value) || null,
      description: v.querySelector('#cat-desc').value.trim() || undefined,
      required_documents: [...v.querySelectorAll('input[name="req-doc"]:checked')].map((x) => x.value),
    };
    try {
      if (cur) await API.adminUpdateCategory(cur.category_id, body);
      else await API.adminCreateCategory(body);
      UI.toast(cur ? 'Category updated' : 'Category added');
      categoryAdmin();
    } catch (err) { errBox.textContent = errText(err); errBox.classList.remove('hidden'); }
  });
}

/* ----------------------------------------------------------------- users */
async function users(filters) {
  const f = { q: '', role: '', page: 1, ...filters };
  loading();
  try {
    const data = await API.adminUsers(f);
    view().innerHTML = `
      <div class="panel">
        <h2>Registered users (${data.total})</h2>
        <form class="toolbar" id="user-filters">
          <input id="uf-q" placeholder="Search name, email or area" value="${UI.esc(f.q)}" aria-label="Search users">
          <select id="uf-role" aria-label="Role">
            <option value="">Any role</option>
            <option value="user"${f.role === 'user' ? ' selected' : ''}>Parents and guardians</option>
            <option value="admin"${f.role === 'admin' ? ' selected' : ''}>Administrators</option>
          </select>
          <button class="btn secondary small" type="submit">Apply</button>
        </form>
        <div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Email</th><th>Area</th><th>Role</th><th>Joined</th><th>Activity</th><th>Action</th></tr></thead>
          <tbody>${data.users.map((u) => `<tr>
            <td>${UI.esc(u.full_name)}</td>
            <td>${UI.esc(u.email)}</td>
            <td>${UI.esc(u.location || '')}</td>
            <td>${u.role === 'admin' ? '<span class="badge-verified">admin</span>' : 'parent'}</td>
            <td>${UI.fmtDate(u.created_at)}</td>
            <td class="muted">${u.interactions} interactions · ${u.saved} saved · ${u.searches} searches</td>
            <td>${Number(u.user_id) === Number(me.user_id) ? '<span class="muted">you</span>'
    : `<button class="btn secondary small" type="button" data-role="${u.user_id}" data-to="${u.role === 'admin' ? 'user' : 'admin'}"
                  data-name="${UI.esc(u.full_name)}">${u.role === 'admin' ? 'Remove admin' : 'Make admin'}</button>
       ${u.role === 'admin' ? '' : `<button class="btn danger small" type="button" data-delete="${u.user_id}"
                  data-name="${UI.esc(u.full_name)}">Delete account</button>`}`}</td>
          </tr>`).join('')}</tbody></table></div>
        <div class="pagination" id="user-pager"></div>
      </div>`;
    const v = view();
    v.querySelector('#user-filters').addEventListener('submit', (e) => {
      e.preventDefault();
      users({ q: v.querySelector('#uf-q').value.trim(), role: v.querySelector('#uf-role').value, page: 1 });
    });
    UI.pager(v.querySelector('#user-pager'), data, (n) => users({ ...f, page: n }));
    v.querySelectorAll('[data-role]').forEach((b) => b.addEventListener('click', async () => {
      const to = b.dataset.to;
      if (!window.confirm(to === 'admin'
        ? `Give ${b.dataset.name} administrator access? They will be able to verify and delete listings.`
        : `Remove administrator access from ${b.dataset.name}?`)) return;
      try { await API.adminSetRole(b.dataset.role, to); UI.toast('Role updated'); users(f); }
      catch (err) { UI.toast(err.message, true); }
    }));
    v.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', async () => {
      if (!window.confirm(`Delete ${b.dataset.name}'s account and everything recorded about them? This cannot be undone.`)) return;
      const reason = window.prompt('Reason, for the audit log (optional):', 'deleted at the parent\'s request');
      if (reason === null) return;
      try { await API.adminDeleteUser(b.dataset.delete, reason.trim()); UI.toast('Account deleted'); users(f); }
      catch (err) { UI.toast(err.message, true); }
    }));
  } catch (err) { failed(err); }
}

/* --------------------------------------------------------------- reports */
async function reports(period) {
  loading();
  try {
    const r = await API.adminReports({ period });
    const table = (rows, cols, empty = 'No data for this period.') => (rows.length
      ? `<div class="table-wrap"><table><thead><tr>${cols.map(([, h]) => `<th>${h}</th>`).join('')}</tr></thead>
         <tbody>${rows.map((row) => `<tr>${cols.map(([k]) => `<td>${UI.esc(row[k] ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
      : `<p class="muted">${empty}</p>`);
    const rec = r.recommendations || {};
    const issues = r.data_quality.issues;
    const flag = (row) => [
      row.no_qualifications && 'no qualifications', row.no_contact && 'no contact email',
      row.no_tags && 'no tags', row.short_description && 'short description',
      row.stale_pending && 'pending over 14 days', row.pending_without_evidence && 'pending without evidence',
    ].filter(Boolean).join(', ');
    view().innerHTML = `
      <div class="panel-head"><h2>Summary reports</h2>
        <label class="inline">Period
          <select id="period">${[['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['all', 'All time']]
    .map(([k, l]) => `<option value="${k}"${k === period ? ' selected' : ''}>${l}</option>`).join('')}</select></label></div>
      <div class="report-grid">
        <div class="panel"><h3>Interactions by type</h3>
          ${table(r.interactions_by_type, [['interaction_type', 'Type'], ['n', 'Count']])}</div>
        <div class="panel"><h3>Engagement by service type</h3>
          ${table(r.engagement_by_service_type, [['service_type', 'Service type'], ['n', 'Interactions']])}</div>
        <div class="panel"><h3>Most searched categories</h3>
          ${table(r.searches_by_category, [['category', 'Category'], ['n', 'Searches']])}</div>
        <div class="panel"><h3>Top search terms</h3>
          ${table(r.top_queries, [['query_text', 'Search'], ['n', 'Times']])}</div>
        <div class="panel wide"><h3>Most engaged providers</h3>
          ${table(r.top_providers, [['provider_name', 'Provider'], ['category_name', 'Category'], ['n', 'Interactions'], ['saves', 'Saves'], ['avg_rating', 'Avg rating']])}</div>
        <div class="panel"><h3>Recommendation output</h3>
          <table><tbody>
            <tr><td>Stored recommendation rows</td><td><strong>${rec.rows_stored ?? 0}</strong></td></tr>
            <tr><td>Users served</td><td><strong>${rec.users_served ?? 0}</strong></td></tr>
            <tr><td>Mean content score</td><td><strong>${rec.avg_content ?? '—'}</strong></td></tr>
            <tr><td>Mean collaborative score</td><td><strong>${rec.avg_collaborative ?? '—'}</strong></td></tr>
            <tr><td>Mean combined score</td><td><strong>${rec.avg_hybrid ?? '—'}</strong></td></tr>
            <tr><td>Rows with a collaborative contribution</td><td><strong>${rec.with_collaborative ?? 0}</strong></td></tr>
          </tbody></table>
          <p class="muted">The three scores are stored separately so each component's contribution can be compared (Section 3.2.5).</p></div>
        <div class="panel wide"><h3>Catalogue data quality (${issues.length})</h3>
          ${issues.length ? `<div class="table-wrap"><table><thead><tr><th>Provider</th><th>Status</th><th>Issues</th><th></th></tr></thead>
            <tbody>${issues.map((row) => `<tr><td>${UI.esc(row.provider_name)}</td><td>${UI.statusBadge(row.verification_status)}</td>
              <td>${UI.esc(flag(row))}</td><td><a href="#" data-fix="${row.provider_id}">Fix</a></td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">No issues found.</p>'}
          ${r.data_quality.duplicate_names.length ? `<h3>Possible duplicates</h3>
            ${table(r.data_quality.duplicate_names, [['name', 'Name'], ['n', 'Listings'], ['ids', 'Provider ids']])}` : ''}
        </div>
      </div>`;
    const v = view();
    v.querySelector('#period').addEventListener('change', (e) => reports(e.target.value));
    v.querySelectorAll('[data-fix]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault(); show('form', Number(a.dataset.fix));
    }));
  } catch (err) { failed(err); }
}

/* -------------------------------------------------------------- activity */
function logTable(rows) {
  return rows.length ? `<div class="table-wrap"><table>
    <thead><tr><th>When</th><th>Administrator</th><th>Action</th><th>Affected</th><th>Notes</th></tr></thead>
    <tbody>${rows.map((l) => `<tr>
      <td>${UI.fmtDate(l.performed_at, true)}</td>
      <td>${UI.esc(l.admin_name || l.admin_id)}</td>
      <td><code>${UI.esc(l.action_type)}</code></td>
      <td>${UI.esc(l.entity_name || `${l.entity_affected || ''} ${l.entity_id ?? ''}`)}</td>
      <td class="muted">${UI.esc(l.notes || '')}</td>
    </tr>`).join('')}</tbody></table></div>` : '<div class="empty"><p>No activity yet.</p></div>';
}

async function logs(page) {
  loading();
  try {
    const data = await API.adminLogs({ limit: 50, page });
    view().innerHTML = `<div class="panel"><h2>Activity log (${data.total})</h2>
      ${logTable(data.logs)}<div class="pagination" id="log-pager"></div></div>`;
    UI.pager(view().querySelector('#log-pager'),
      { page: data.page, pages: Math.ceil(data.total / data.per_page) }, (n) => logs(n));
  } catch (err) { failed(err); }
}

/* --------------------------------------------------------- model versions */
async function modelVersions(box) {
  if (!box) return;
  let data;
  try { data = await API.adminModelVersions(); } catch {
    box.innerHTML = '<h2>Model versions</h2><p class="muted">The recommendation service is unreachable.</p>';
    return;
  }
  const fmt = (x) => (x === undefined || x === null ? '—' : Number(x).toFixed(3));
  box.innerHTML = `
    <div class="panel-head"><h2>Model versions</h2>
      ${data.history.length ? '<button class="btn secondary small" type="button" id="model-rollback">Roll back to previous</button>' : ''}</div>
    <p class="muted">Offline metrics on held-out interactions (${UI.esc(data.versions[0]?.metrics?.protocol || 'no evaluation yet')}).
      They measure ranking on past behaviour, not how satisfied parents are.</p>
    ${data.versions.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Version</th><th>Status</th><th>Recall@10</th><th>nDCG@10</th><th>Settings</th><th>Decision</th><th><span class="sr-only">Action</span></th></tr></thead>
      <tbody>${data.versions.slice(0, 8).map((m) => `<tr>
        <td>${UI.esc(m.id)}<div class="muted">${UI.esc(m.created_at)}</div></td>
        <td>${m.id === data.production ? '<strong>Serving</strong>' : UI.esc(String(m.status).replace('_', ' '))}</td>
        <td>${fmt(m.metrics?.recall)}${m.comparison ? `<div class="muted">serving then: ${fmt(m.comparison.production?.recall)}</div>` : ''}</td>
        <td>${fmt(m.metrics?.ndcg)}</td>
        <td class="muted">α ${fmt(m.params?.alpha)} · location ${fmt(m.params?.location_weight)} · quality ${fmt(m.params?.quality_weight)}</td>
        <td class="muted">${UI.esc(m.decision?.reason || '')}</td>
        <td>${m.id !== data.production ? `<button class="btn secondary small" type="button" data-promote="${UI.esc(m.id)}">Promote</button>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>` : '<p class="muted">No versions yet.</p>'}`;
  box.querySelectorAll('[data-promote]').forEach((b) => b.addEventListener('click', async () => {
    if (!window.confirm(`Serve version ${b.dataset.promote} to everyone now?`)) return;
    b.disabled = true;
    try { await API.adminPromoteModel(b.dataset.promote); UI.toast(`Version ${b.dataset.promote} is now serving`); dashboard(); }
    catch (err) { UI.toast(errText(err), true); b.disabled = false; }
  }));
  box.querySelector('#model-rollback')?.addEventListener('click', async (e) => {
    if (!window.confirm('Return to the previous serving version?')) return;
    e.target.disabled = true;
    try { const out = await API.adminRollbackModel(); UI.toast(`Rolled back to ${out.production?.id || 'the previous version'}`); dashboard(); }
    catch (err) { UI.toast(errText(err), true); e.target.disabled = false; }
  });
}

/* ---------------------------------------------------------- service areas */
async function areaAdmin(editing = null) {
  loading();
  let list = [];
  try { list = (await API.adminAreas()).areas; } catch (err) { failed(err); return; }
  const cur = editing ? list.find((a) => a.area_id === editing) : null;
  const num = (x) => (x === null || x === undefined ? '' : Number(x));
  view().innerHTML = `
    <div class="layout dash-layout">
      <div class="panel">
        <h2>Service areas (${list.length})</h2>
        <p class="muted">Parents filter by these areas, and distances in search are measured between their centres.
          Centres are approximate neighbourhood points, never addresses.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Area</th><th>Centre</th><th>Providers</th><th>Status</th><th><span class="sr-only">Action</span></th></tr></thead>
          <tbody>${list.map((a) => `<tr>
            <td><strong>${UI.esc(a.area_name)}</strong></td>
            <td class="muted">${a.latitude === null ? 'not set' : `${Number(a.latitude).toFixed(4)}, ${Number(a.longitude).toFixed(4)}`}</td>
            <td>${Number(a.provider_count)}</td>
            <td>${a.is_active ? 'Active' : 'Hidden'}</td>
            <td><button class="btn secondary small" type="button" data-edit-area="${Number(a.area_id)}">Edit</button></td>
          </tr>`).join('')}</tbody></table></div>
      </div>
      <div class="panel">
        <h2>${cur ? `Edit ${UI.esc(cur.area_name)}` : 'Add an area'}</h2>
        <form id="area-form" novalidate>
          <div class="field"><label for="area-name">Name</label>
            <input id="area-name" value="${UI.esc(cur?.area_name || '')}" required maxlength="120"></div>
          <div class="form-row">
            <div class="field"><label for="area-lat">Centre latitude</label>
              <input id="area-lat" inputmode="decimal" value="${num(cur?.latitude)}" placeholder="-1.2921"></div>
            <div class="field"><label for="area-lng">Centre longitude</label>
              <input id="area-lng" inputmode="decimal" value="${num(cur?.longitude)}" placeholder="36.7856"></div>
          </div>
          <label class="check"><input type="checkbox" id="area-active"${!cur || cur.is_active ? ' checked' : ''}>
            Show this area to parents</label>
          <div class="button-row">
            <button class="btn" type="submit">${cur ? 'Save changes' : 'Add area'}</button>
            ${cur ? '<button class="btn secondary" type="button" id="area-cancel">Cancel</button>' : ''}
          </div>
          <div class="error-text hidden" id="area-error" role="alert"></div>
        </form>
      </div>
    </div>`;
  const v = view();
  v.querySelectorAll('[data-edit-area]').forEach((b) => b.addEventListener('click', () => areaAdmin(Number(b.dataset.editArea))));
  v.querySelector('#area-cancel')?.addEventListener('click', () => areaAdmin());
  v.querySelector('#area-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = v.querySelector('#area-error');
    errBox.classList.add('hidden');
    const val = (sel) => { const t = v.querySelector(sel).value.trim(); return t === '' ? null : Number(t); };
    const body = {
      area_name: v.querySelector('#area-name').value.trim(),
      latitude: val('#area-lat'), longitude: val('#area-lng'),
      is_active: v.querySelector('#area-active').checked,
    };
    try {
      if (cur) await API.adminUpdateArea(cur.area_id, body); else await API.adminCreateArea(body);
      UI.toast(cur ? 'Area updated' : 'Area added');
      areaAdmin();
    } catch (err) { errBox.textContent = errText(err); errBox.classList.remove('hidden'); }
  });
}
