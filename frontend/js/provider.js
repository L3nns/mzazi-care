/* Provider profile (Figure 4.11). Viewing one is itself a signal, so the page
   records a 'view' interaction on load. */
document.addEventListener('DOMContentLoaded', async () => {
  const id = UI.params().id;
  const root = document.getElementById('provider-root');
  if (!id) { root.innerHTML = '<p class="error-text">No provider specified.</p>'; return; }

  try {
    const { provider: p, saved, similar } = await API.provider(id);
    document.title = `${p.provider_name} · Mzazi Care`;
    UI.track(id, 'view');

    root.innerHTML = `
      <div class="layout profile-layout">
        <div>
          <p class="muted"><a href="search.html">Search</a> &rsaquo;
             <a href="search.html?category=${p.category_id}">${UI.esc(p.category_name)}</a>
             &rsaquo; ${UI.esc(p.provider_name)}</p>
          <div class="panel">
            <h1>${UI.esc(p.provider_name)}</h1>
            <p>${UI.statusBadge(p.verification_status)}
               <span class="muted">${UI.esc(p.category_name)} &middot; ${UI.esc(p.location || '')}</span></p>
            <div>${UI.tagChips(p.service_tags, 8)}</div>
            <h3 style="margin-top:1rem">About this service</h3>
            <p>${UI.esc(p.service_description)}</p>
            ${p.qualifications ? `<h3>Qualifications</h3><p>${UI.esc(p.qualifications)}</p>` : ''}
            <h3>Why this appears in recommendations</h3>
            <p class="muted">These tags are the content features the engine matches
               against what you have searched for and saved.</p>
            <div>${UI.tagChips(p.service_tags, 10)}</div>
          </div>
        </div>
        <aside>
          <div class="panel">
            <h2>Contact</h2>
            ${p.contact_email
    ? `<p><a href="mailto:${UI.esc(p.contact_email)}">${UI.esc(p.contact_email)}</a></p>`
    : '<p class="muted">No contact address listed.</p>'}
            <button class="btn" id="save-btn" style="width:100%">
              ${saved ? 'Saved to shortlist' : 'Save to shortlist'}</button>
            <div id="rate-box" style="margin-top:.8rem">
              <label for="rating">Rate this service</label>
              <select id="rating">
                <option value="">Choose…</option>
                ${[5, 4, 3, 2, 1].map((n) => `<option value="${n}">${n} star${n > 1 ? 's' : ''}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="panel rec-panel" style="margin-top:.85rem">
            <h2>Similar services</h2>
            ${similar?.length ? similar.map((s) => `
              <div class="rec-item">
                <a href="provider.html?id=${s.provider_id}">${UI.esc(s.provider_name)}</a>
                <div class="score">Similarity ${Number(s.similarity).toFixed(2)}</div>
              </div>`).join('')
    : '<p class="muted">None found.</p>'}
          </div>
        </aside>
      </div>`;

    const saveBtn = document.getElementById('save-btn');
    let isSaved = saved;
    saveBtn.addEventListener('click', async () => {
      if (!API.getToken()) { location.href = 'account.html?tab=login'; return; }
      try {
        if (isSaved) {
          await API.unsave(id); isSaved = false;
          saveBtn.textContent = 'Save to shortlist'; UI.toast('Removed from your shortlist');
        } else {
          await API.interact({ provider_id: Number(id), interaction_type: 'save' });
          isSaved = true;
          saveBtn.textContent = 'Saved to shortlist'; UI.toast('Saved to your shortlist');
        }
      } catch (err) { UI.toast(err.message, true); }
    });

    document.getElementById('rating').addEventListener('change', async (e) => {
      if (!e.target.value) return;
      if (!API.getToken()) { location.href = 'account.html?tab=login'; return; }
      await UI.track(id, 'rating', e.target.value);
      UI.toast(`Thank you — rated ${e.target.value} stars`);
    });
  } catch (err) {
    root.innerHTML = err.status === 404
      ? '<div class="empty"><h2>Service not found</h2><p class="muted">It may have been removed, or it is not verified yet.</p><p><a href="search.html">Back to search</a></p></div>'
      : `<p class="error-text">Could not load this provider: ${UI.esc(err.message)}</p>`;
  }
});
