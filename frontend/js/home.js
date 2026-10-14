/* Landing page: search entry point plus category browsing (Figure 4.9). */
document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('search-form');
  const catSelect = document.getElementById('category');
  const locSelect = document.getElementById('location');
  const groups = document.getElementById('category-groups');
  const recBox = document.getElementById('home-recs');

  try {
    const { categories } = await API.categories();
    const { types, byParent } = UI.categoryTree(categories);
    catSelect.innerHTML = UI.categoryOptions(categories);
    // Grouped by service type, so browsing mirrors the catalogue's structure.
    groups.innerHTML = types.map((t) => {
      const kids = byParent[t.category_id] || [];
      const total = kids.reduce((n, c) => n + Number(c.provider_count || 0), Number(t.provider_count || 0));
      return `<div class="category-group">
        <h3><a href="search.html?type=${t.category_id}">${UI.esc(t.category_name)}</a>
          <span class="muted">${total} verified</span></h3>
        <div class="card-grid">${(kids.length ? kids : [t]).map((c) => `
          <a class="card" href="search.html?category=${c.category_id}">
            <h4>${UI.esc(c.category_name)}</h4>
            <div class="muted">${c.provider_count} verified provider${Number(c.provider_count) === 1 ? '' : 's'}</div>
          </a>`).join('')}</div>
      </div>`;
    }).join('');
  } catch (err) {
    groups.innerHTML = `<p class="error-text">Could not load categories: ${UI.esc(err.message)}</p>`;
  }

  try {
    const { locations } = await API.locations();
    locSelect.innerHTML = '<option value="">Any location</option>'
      + locations.map((l) => `<option value="${UI.esc(l.location)}">${UI.esc(l.location)}</option>`).join('');
  } catch { locSelect.innerHTML = '<option value="">Any location</option>'; }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    location.href = `search.html${API.qs({
      q: document.getElementById('q').value.trim(),
      category: catSelect.value,
      location: locSelect.value,
    })}`;
  });

  const list = recBox.querySelector('.rec-list');
  if (!API.getToken()) {
    // Section 4.10: invite the visitor to sign in so recommendations can be
    // generated from their searches and saved providers.
    list.innerHTML = `<p class="muted">Log in to see services recommended from your
      searches and saved providers.</p>
      <a class="btn small" href="account.html?tab=login">See recommendations</a>`;
    return;
  }
  try {
    const data = await API.recommendations({ top_n: 4 });
    list.innerHTML = data.results?.length
      ? `<div class="rec-grid">${data.results.map((r) => `
          <div class="rec-item">
            <a href="provider.html?id=${r.provider_id}" data-track="${r.provider_id}">${UI.esc(r.provider_name)}</a>
            <div class="muted">${UI.esc(r.category_name || '')} ${UI.stars(r.avg_rating, r.rating_count)}</div>
          </div>`).join('')}</div>
        <p style="margin-top:.5rem"><a href="search.html">See more recommendations</a></p>`
      : '<p class="muted">Search or save a provider and suggestions will appear here.</p>';
    UI.trackClicks(list);
  } catch {
    recBox.classList.add('hidden');     // signed in but the service is down
  }
});
