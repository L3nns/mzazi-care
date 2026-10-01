/* Results page: filters, listings, and a distinct recommendation panel (Figure 4.10). */
let state = { page: 1 };

document.addEventListener('DOMContentLoaded', async () => {
  const p = UI.params();
  state = { q: p.q || '', category: p.category || '', location: p.location || '',
    sort: p.sort || 'relevance', page: Number(p.page || 1) };

  document.getElementById('q').value = state.q;

  const [cats, locs] = await Promise.all([
    API.categories().catch(() => ({ categories: [] })),
    API.locations().catch(() => ({ locations: [] })),
  ]);
  const leaves = cats.categories.filter((c) => c.parent_category_id !== null);
  document.getElementById('f-category').innerHTML =
    '<option value="">All categories</option>'
    + leaves.map((c) => `<option value="${c.category_id}"${String(c.category_id) === state.category ? ' selected' : ''}>${UI.esc(c.category_name)}</option>`).join('');
  document.getElementById('f-location').innerHTML =
    '<option value="">Any location</option>'
    + locs.locations.map((l) => `<option value="${UI.esc(l.location)}"${l.location === state.location ? ' selected' : ''}>${UI.esc(l.location)}</option>`).join('');
  document.getElementById('f-sort').value = state.sort;

  document.getElementById('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    state.q = document.getElementById('q').value.trim();
    state.page = 1; run();
  });
  ['f-category', 'f-location', 'f-sort'].forEach((id) => {
    document.getElementById(id).addEventListener('change', () => {
      state.category = document.getElementById('f-category').value;
      state.location = document.getElementById('f-location').value;
      state.sort = document.getElementById('f-sort').value;
      state.page = 1; run();
    });
  });
  document.getElementById('clear-filters').addEventListener('click', () => {
    state = { q: '', category: '', location: '', sort: 'relevance', page: 1 };
    document.getElementById('q').value = '';
    document.getElementById('f-category').value = '';
    document.getElementById('f-location').value = '';
    run();
  });

  run();
});

async function run() {
  const url = `search.html${API.qs(state)}`;
  history.replaceState(null, '', url);
  await Promise.all([loadResults(), loadRecommendations()]);
}

async function loadResults() {
  const box = document.getElementById('results');
  box.innerHTML = '<p class="muted">Searching…</p>';
  try {
    const data = await API.search({ ...state, per_page: 10 });
    document.getElementById('result-count').textContent =
      `${data.total} service${data.total === 1 ? '' : 's'} found`;
    box.innerHTML = data.results.length
      ? data.results.map(UI.resultCard).join('')
      : `<div class="empty"><p>No services match those filters.</p>
         <p class="muted">Try removing a filter, or browse a broader category.</p></div>`;
    renderPagination(data);
    box.querySelectorAll('a[href^="provider.html"]').forEach((a) => {
      a.addEventListener('click', () => {
        const id = new URL(a.href, location.origin).searchParams.get('id');
        UI.track(id, 'click');
      });
    });
  } catch (err) {
    box.innerHTML = `<p class="error-text">Could not load results: ${UI.esc(err.message)}</p>`;
  }
}

function renderPagination(data) {
  const el = document.getElementById('pagination');
  if (data.pages <= 1) { el.innerHTML = ''; return; }
  const btn = (label, page, disabled = false, active = false) =>
    `<button class="btn ${active ? '' : 'secondary'} small" data-page="${page}" ${disabled ? 'disabled' : ''}>${label}</button>`;
  let html = btn('&laquo;', data.page - 1, data.page === 1);
  for (let i = 1; i <= Math.min(data.pages, 7); i += 1) {
    html += btn(i, i, false, i === data.page);
  }
  html += btn('&raquo;', data.page + 1, data.page === data.pages);
  el.innerHTML = html;
  el.querySelectorAll('button[data-page]').forEach((b) => {
    b.addEventListener('click', () => {
      state.page = Number(b.dataset.page); run(); window.scrollTo(0, 0);
    });
  });
}

async function loadRecommendations() {
  const panel = document.getElementById('rec-panel');
  const list = panel.querySelector('.rec-list');
  const note = panel.querySelector('.strategy-note');
  list.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const data = await API.recommendations({
      query: state.q || null, top_n: 5,
      category: state.category || null, location: state.location || null,
    });
    const strategies = {
      hybrid: 'Blended from your history and similar parents',
      content_only: 'Matched on what you searched for',
      collaborative_only: 'From parents with similar behaviour',
      popularity_fallback: 'Popular on Mzazi Care right now',
      popularity_fallback_sql: 'Popular on Mzazi Care right now',
    };
    note.textContent = strategies[data.strategy] || data.strategy;
    list.innerHTML = data.results.length ? data.results.map((r) => `
      <div class="rec-item">
        <a href="provider.html?id=${r.provider_id}">${UI.esc(r.provider_name)}</a>
        <div class="muted">${UI.esc(r.category_name || '')} &middot; ${UI.esc(r.location || '')}</div>
        ${r.hybrid_score !== undefined
    ? `<div class="score">Match ${Number(r.hybrid_score).toFixed(2)}</div>` : ''}
      </div>`).join('')
      : '<p class="muted">No suggestions yet — search or save a provider and they will appear.</p>';
  } catch (err) {
    list.innerHTML = `<p class="muted">Recommendations unavailable right now.</p>`;
  }
}
