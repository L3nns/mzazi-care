/* Results page: filters, listings, and a distinct recommendation panel (Figure 4.10). */
let state = { page: 1 };
let allCategories = [];
let runId = 0;

/** The plain-language basis of the list (Section 4.10: "explains the basis of the suggestion"). */
function strategyNote(strategy) {
  const signedIn = Boolean(API.getToken());
  const content = signedIn
    ? (state.q ? 'Matched on your search and what you have viewed, saved and asked for before'
      : 'Matched on what you have viewed, saved and searched for')
    : 'Matched on what you searched for';
  return {
    hybrid: 'Blended from your history and parents with similar needs',
    content_only: content,
    collaborative_only: 'From parents with similar behaviour',
    popularity_fallback: 'Popular and highly rated on Mzazi Care',
    popularity_fallback_sql: 'Popular and highly rated on Mzazi Care',
  }[strategy] || strategy;
}

document.addEventListener('DOMContentLoaded', async () => {
  const p = UI.params();
  state = {
    q: p.q || '', type: p.type || '', category: p.category || '', location: p.location || '',
    sort: p.sort || 'relevance', page: Number(p.page || 1),
  };
  document.getElementById('q').value = state.q;

  const [cats, locs] = await Promise.all([
    API.categories().catch(() => ({ categories: [] })),
    API.locations().catch(() => ({ locations: [] })),
  ]);
  allCategories = cats.categories;
  const { types } = UI.categoryTree(allCategories);
  // A category chosen without a type implies its type.
  const chosen = allCategories.find((c) => String(c.category_id) === state.category);
  if (chosen && chosen.parent_category_id && !state.type) state.type = String(chosen.parent_category_id);

  document.getElementById('f-type').innerHTML = '<option value="">All service types</option>'
    + types.map((t) => `<option value="${t.category_id}"${String(t.category_id) === state.type ? ' selected' : ''}>${UI.esc(t.category_name)}</option>`).join('');
  fillCategories();
  document.getElementById('f-location').innerHTML = '<option value="">Any location</option>'
    + locs.locations.map((l) => `<option value="${UI.esc(l.location)}"${l.location === state.location ? ' selected' : ''}>${UI.esc(l.location)}</option>`).join('');
  document.getElementById('f-sort').value = state.sort;

  document.getElementById('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    state.q = document.getElementById('q').value.trim();
    state.page = 1; run();
  });
  document.getElementById('f-type').addEventListener('change', (e) => {
    state.type = e.target.value; state.category = ''; fillCategories(); state.page = 1; run();
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
    state = { q: '', type: '', category: '', location: '', sort: 'relevance', page: 1 };
    document.getElementById('q').value = '';
    document.getElementById('f-type').value = '';
    fillCategories();
    document.getElementById('f-location').value = '';
    document.getElementById('f-sort').value = 'relevance';
    run();
  });

  // Figure 4.15: on narrow screens the filter panel collapses behind a control.
  const toggle = document.getElementById('filters-toggle');
  const panel = document.getElementById('filters');
  toggle.addEventListener('click', () => {
    const open = panel.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  run();
  loadRecent();
});

function fillCategories() {
  const sel = document.getElementById('f-category');
  const { byParent, leaves } = UI.categoryTree(allCategories);
  const list = state.type ? (byParent[state.type] || []) : leaves;
  sel.innerHTML = '<option value="">All categories</option>'
    + list.map((c) => `<option value="${c.category_id}"${String(c.category_id) === state.category ? ' selected' : ''}>${UI.esc(c.category_name)}</option>`).join('');
  sel.disabled = state.type && !list.length;
}

async function run() {
  const id = ++runId;
  history.replaceState(null, '', `search.html${API.qs(state)}`);
  renderActiveFilters();
  await Promise.all([loadResults(id), loadRecommendations(id)]);
}

function renderActiveFilters() {
  const name = (cid) => allCategories.find((c) => String(c.category_id) === String(cid))?.category_name;
  const chips = [];
  if (state.q) chips.push(['q', `“${state.q}”`]);
  if (state.type) chips.push(['type', name(state.type)]);
  if (state.category) chips.push(['category', name(state.category)]);
  if (state.location) chips.push(['location', state.location]);
  const box = document.getElementById('active-filters');
  box.innerHTML = chips.map(([k, label]) => `<button type="button" class="chip removable" data-clear="${k}"
      aria-label="Remove filter ${UI.esc(label)}">${UI.esc(label)} &times;</button>`).join('');
  box.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.clear;
    state[k] = '';
    if (k === 'q') document.getElementById('q').value = '';
    if (k === 'type') { state.category = ''; document.getElementById('f-type').value = ''; fillCategories(); }
    if (k === 'category') document.getElementById('f-category').value = '';
    if (k === 'location') document.getElementById('f-location').value = '';
    state.page = 1; run();
  }));
}

async function loadResults(id) {
  const box = document.getElementById('results');
  const sugBox = document.getElementById('suggestions');
  box.innerHTML = '<p class="muted">Searching…</p>';
  sugBox.innerHTML = '';
  try {
    const data = await API.search({ ...state, per_page: 10 });
    if (id !== runId) return;              // a newer search has started
    document.getElementById('result-count').textContent =
      `${data.total} service${data.total === 1 ? '' : 's'} found`;
    box.innerHTML = data.results.length
      ? data.results.map(UI.resultCard).join('')
      : `<div class="empty"><p>No services match ${state.q ? `“${UI.esc(state.q)}”` : 'those filters'}.</p>
         <p class="muted">Try removing a filter, or browse a broader category.</p></div>`;
    UI.pager(document.getElementById('pagination'), data, (n) => {
      state.page = n; run(); window.scrollTo(0, 0);
    });
    if (data.suggestions?.length) {
      // Figure 4.5: never leave the parent at an empty page.
      sugBox.innerHTML = `<h2 class="suggest-heading">${data.suggestion_basis === 'closest'
        ? 'Closest services to what you asked for' : 'Popular and highly rated instead'}</h2>
        ${data.suggestions.map(UI.resultCard).join('')}`;
    }
    UI.trackClicks(box);
    UI.trackClicks(sugBox);
  } catch (err) {
    if (id !== runId) return;
    document.getElementById('result-count').textContent = 'Search unavailable';
    box.innerHTML = `<p class="error-text">Could not load results: ${UI.esc(err.message)}</p>`;
  }
}

async function loadRecommendations(id) {
  const panel = document.getElementById('rec-panel');
  const list = panel.querySelector('.rec-list');
  const note = panel.querySelector('.strategy-note');
  list.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const data = await API.recommendations({
      query: state.q || null, top_n: 5,
      category: state.category || null, type: state.type || null,
      location: state.location || null,
    });
    if (id !== runId) return;
    note.textContent = strategyNote(data.strategy);
    list.innerHTML = data.results.length ? data.results.map((r) => `
      <div class="rec-item">
        <a href="provider.html?id=${r.provider_id}" data-track="${r.provider_id}">${UI.esc(r.provider_name)}</a>
        <div class="muted">${UI.esc(r.category_name || '')} &middot; ${UI.esc(r.location || '')}</div>
        ${r.basis === 'related_highly_rated'
    ? '<div class="basis-note">Highly rated in a related category</div>' : ''}
        <div class="rec-meta">
          ${r.hybrid_score !== undefined && r.basis === 'match'
    ? `<span class="score" title="Combined match score (0 to 1)">Match ${Number(r.hybrid_score).toFixed(2)}</span>` : ''}
          ${UI.stars(r.avg_rating, r.rating_count)}
        </div>
      </div>`).join('')
      : '<p class="muted">No suggestions yet — search or save a provider and they will appear.</p>';
    UI.trackClicks(list);
  } catch {
    if (id !== runId) return;
    note.textContent = '';
    list.innerHTML = '<p class="muted">Recommendations unavailable right now.</p>';
  }
}

async function loadRecent() {
  if (!API.getToken()) return;
  try {
    const { interactions } = await API.myInteractions();
    const seen = new Map();
    interactions.filter((i) => i.interaction_type === 'view').forEach((i) => {
      if (!seen.has(i.provider_id) && seen.size < 5) seen.set(i.provider_id, i);
    });
    if (!seen.size) return;
    const panel = document.getElementById('recent-panel');
    panel.querySelector('.recent-list').innerHTML = [...seen.values()].map((i) => `
      <div class="rec-item"><a href="provider.html?id=${i.provider_id}">${UI.esc(i.provider_name)}</a>
        <div class="muted">${UI.fmtDate(i.created_at)}</div></div>`).join('');
    panel.classList.remove('hidden');
  } catch { /* the panel simply stays hidden */ }
}
