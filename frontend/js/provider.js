/* Provider profile (Figure 4.11). Viewing one is itself a signal, so the page
   records a 'view' interaction on load. */
document.addEventListener('DOMContentLoaded', async () => {
  const id = Number(UI.params().id);
  const root = document.getElementById('provider-root');
  if (!id) { root.innerHTML = '<p class="error-text">No provider specified.</p>'; return; }

  try {
    const { provider: p, media, saved, my_rating: myRating, similar } = await API.provider(id);
    document.title = `${p.provider_name} · Mzazi Care`;
    UI.track(id, 'view');

    const tags = String(p.service_tags || '').split(',').map((t) => t.trim()).filter(Boolean);
    const image = media?.[0];
    const tabs = {
      overview: `<p>${UI.esc(p.service_description)}</p>`,
      qualifications: p.qualifications
        ? `<p>${UI.esc(p.qualifications)}</p>
           <p class="muted">Reviewed by a Mzazi Care administrator before this listing was published.</p>`
        : '<p class="muted">No qualifications listed.</p>',
      services: tags.length
        ? `<ul class="service-list">${tags.map((t) => `<li>${UI.esc(t.replace(/-/g, ' '))}</li>`).join('')}</ul>`
        : '<p class="muted">No services listed.</p>',
      location: `<p><strong>${UI.esc(p.location || 'Not stated')}</strong>, Nairobi</p>
        ${(p.service_areas || []).length > 1 ? `<p>Also serves: ${p.service_areas.filter((a) => a !== p.location).map(UI.esc).join(', ')}</p>` : ''}
        ${p.location ? `<p><a href="search.html?location=${encodeURIComponent(p.location)}">Other verified services in ${UI.esc(p.location)}</a></p>` : ''}`,
    };

    root.innerHTML = `
      <p class="muted crumbs"><a href="search.html">Search</a> &rsaquo;
        ${p.parent_category_id ? `<a href="search.html?type=${p.parent_category_id}">${UI.esc(p.parent_category_name)}</a> &rsaquo;` : ''}
        <a href="search.html?category=${p.category_id}">${UI.esc(p.category_name)}</a>
        &rsaquo; ${UI.esc(p.provider_name)}</p>
      <div class="layout profile-layout">
        <div>
          <div class="panel profile-head">
            ${image
    ? `<img class="profile-image" src="${UI.esc(image.url)}" alt="${UI.esc(p.provider_name)}">`
    : `<div class="profile-image placeholder" aria-hidden="true">${UI.esc(UI.initials(p.provider_name))}</div>`}
            <div>
              <h1>${UI.esc(p.provider_name)}</h1>
              <p>${UI.statusBadge(p.verification_status)}
                 <span class="muted">${UI.esc(p.category_name)} &middot; ${UI.esc(p.location || '')}</span></p>
              <p>${UI.stars(p.avg_rating, p.rating_count) || '<span class="muted">No ratings yet</span>'}</p>
              <div>${UI.tagChips(p.service_tags, 6)}</div>
            </div>
          </div>
          <div class="panel" style="margin-top:.85rem">
            <div class="tabs" role="tablist">
              ${[['overview', 'Overview'], ['qualifications', 'Qualifications'],
    ['services', 'Services offered'], ['location', 'Location']].map(([k, label], i) => `
                <button class="tab${i === 0 ? ' active' : ''}" role="tab" type="button" id="tab-${k}"
                  aria-selected="${i === 0}" aria-controls="tabpanel" data-tab="${k}">${label}</button>`).join('')}
            </div>
            <div id="tabpanel" role="tabpanel" aria-labelledby="tab-overview">${tabs.overview}</div>
            <h3 style="margin-top:1rem">Service tags used for recommendation matching</h3>
            <p class="muted">The engine matches these, with the description, against what
               you search for and save.</p>
            <div>${UI.tagChips(p.service_tags, 12)}</div>
          </div>
        </div>
        <aside>
          <div class="panel">
            <h2>Contact this provider</h2>
            ${p.contact_email
    ? `<p><a href="mailto:${UI.esc(p.contact_email)}">${UI.esc(p.contact_email)}</a></p>`
    : '<p class="muted">No contact address listed.</p>'}
            <button class="btn" id="save-btn" type="button" style="width:100%"
              aria-pressed="${saved}">${saved ? 'Saved to shortlist' : 'Save to shortlist'}</button>
            <button class="btn secondary" id="share-btn" type="button" style="width:100%;margin-top:.5rem">Share provider</button>
            <div style="margin-top:.85rem">
              <label for="rating">${myRating ? `Your rating: ${myRating} star${myRating > 1 ? 's' : ''}. Change it` : 'Rate this service you have used'}</label>
              <select id="rating">
                <option value="">Choose…</option>
                ${[5, 4, 3, 2, 1].map((n) => `<option value="${n}"${n === myRating ? ' selected' : ''}>${n} star${n > 1 ? 's' : ''}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="panel rec-panel" style="margin-top:.85rem">
            <h2>Similar services</h2>
            ${similar?.length ? similar.map((s) => `
              <div class="rec-item">
                <a href="provider.html?id=${s.provider_id}" data-track="${s.provider_id}">${UI.esc(s.provider_name)}</a>
                <div class="muted">${UI.esc(s.category_name || '')}${s.location ? ` &middot; ${UI.esc(s.location)}` : ''}</div>
                <span class="score" title="Content similarity (0 to 1)">Similarity ${Number(s.similarity).toFixed(2)}</span>
              </div>`).join('')
    : '<p class="muted">None found.</p>'}
          </div>
        </aside>
      </div>`;

    const panel = document.getElementById('tabpanel');
    root.querySelectorAll('[data-tab]').forEach((t) => {
      t.addEventListener('click', () => {
        root.querySelectorAll('[data-tab]').forEach((x) => {
          x.classList.toggle('active', x === t);
          x.setAttribute('aria-selected', String(x === t));
        });
        panel.innerHTML = tabs[t.dataset.tab];
        panel.setAttribute('aria-labelledby', t.id);
      });
    });
    UI.trackClicks(root);

    const saveBtn = document.getElementById('save-btn');
    let isSaved = saved;
    saveBtn.addEventListener('click', async () => {
      if (!API.getToken()) { location.href = 'account.html?tab=login'; return; }
      saveBtn.disabled = true;
      try {
        if (isSaved) {
          await API.unsave(id); isSaved = false;
          UI.toast('Removed from your shortlist');
        } else {
          await API.interact({ provider_id: id, interaction_type: 'save' });
          isSaved = true;
          UI.toast('Saved to your shortlist');
        }
        saveBtn.textContent = isSaved ? 'Saved to shortlist' : 'Save to shortlist';
        saveBtn.setAttribute('aria-pressed', String(isSaved));
      } catch (err) { UI.toast(err.message, true); }
      saveBtn.disabled = false;
    });

    document.getElementById('share-btn').addEventListener('click', async () => {
      const url = location.href;
      try {
        if (navigator.share) await navigator.share({ title: p.provider_name, url });
        else { await navigator.clipboard.writeText(url); UI.toast('Link copied'); }
      } catch (err) {
        if (err.name !== 'AbortError') UI.toast('Copy this page address to share it', true);
      }
    });

    document.getElementById('rating').addEventListener('change', async (e) => {
      if (!e.target.value) return;
      if (!API.getToken()) { location.href = 'account.html?tab=login'; return; }
      try {
        const out = await API.interact({ provider_id: id, interaction_type: 'rating', rating_value: Number(e.target.value) });
        const stars = `${e.target.value} star${e.target.value === '1' ? '' : 's'}`;
        UI.toast(out.updated ? `Your rating is now ${stars}` : `Thank you — rated ${stars}`);
      } catch (err) { UI.toast(err.message, true); }
    });
  } catch (err) {
    root.innerHTML = err.status === 404
      ? '<div class="empty"><h2>Service not found</h2><p class="muted">It may have been removed, or it is not verified yet.</p><p><a href="search.html">Back to search</a></p></div>'
      : `<p class="error-text">Could not load this provider: ${UI.esc(err.message)}</p>`;
  }
});
