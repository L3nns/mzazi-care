/* Landing page: search entry point plus category browsing (Figure 4.9). */
document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('search-form');
  const catSelect = document.getElementById('category');
  const locSelect = document.getElementById('location');
  const grid = document.getElementById('category-grid');
  const recBox = document.getElementById('home-recs');

  try {
    const { categories } = await API.categories();
    const leaves = categories.filter((c) => c.parent_category_id !== null);
    catSelect.innerHTML = '<option value="">All categories</option>'
      + leaves.map((c) => `<option value="${c.category_id}">${UI.esc(c.category_name)}</option>`).join('');
    grid.innerHTML = leaves.slice(0, 9).map((c) => `
      <a class="card" href="search.html?category=${c.category_id}">
        <h3>${UI.esc(c.category_name)}</h3>
        <div class="muted">${c.provider_count} verified provider${c.provider_count === 1 ? '' : 's'}</div>
      </a>`).join('');
  } catch (err) {
    grid.innerHTML = `<p class="error-text">Could not load categories: ${UI.esc(err.message)}</p>`;
  }

  try {
    const { locations } = await API.locations();
    locSelect.innerHTML = '<option value="">Any location</option>'
      + locations.map((l) => `<option value="${UI.esc(l.location)}">${UI.esc(l.location)}</option>`).join('');
  } catch { /* the filter simply stays empty */ }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const params = API.qs({
      q: document.getElementById('q').value.trim(),
      category: catSelect.value,
      location: locSelect.value,
    });
    location.href = `search.html${params}`;
  });

  if (API.getToken()) {
    try {
      const data = await API.recommendations({ top_n: 3 });
      if (data.results?.length) {
        recBox.classList.remove('hidden');
        recBox.querySelector('.rec-list').innerHTML = data.results.map((r) => `
          <div class="rec-item">
            <a href="provider.html?id=${r.provider_id}">${UI.esc(r.provider_name)}</a>
            <div class="muted">${UI.esc(r.category_name || '')}</div>
          </div>`).join('');
      }
    } catch { /* signed in but the service is down: just hide the panel */ }
  }
});
