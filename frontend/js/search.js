/* Results page: filters, listings or a map, and a distinct recommendation panel (Figure 4.10). */
let state = { page: 1 };
let allCategories = [];
let runId = 0;
let view = 'list';                     // 'list' | 'map'; kept in the URL as ?view=map

/** The page address for the current search (and view). */
const pageUrl = () => `search.html${API.qs({ ...state, view: view === 'map' ? 'map' : '' })}`;

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
    within_km: p.within_km || '', sort: p.sort || 'relevance', page: Number(p.page || 1),
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
  document.getElementById('f-within').value = state.within_km;

  // List or map. The map shows the same search, grouped by area.
  document.getElementById('view-list').addEventListener('click', () => setView('list'));
  document.getElementById('view-map').addEventListener('click', () => setView('map'));
  document.getElementById('place-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = document.getElementById('place-q').value.trim();
    if (text.length >= 2) MapView.findPlace(text);
  });
  MapView.onAreaChosen(applyArea);
  setView(p.view === 'map' ? 'map' : 'list', false);

  document.getElementById('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    state.q = document.getElementById('q').value.trim();
    state.page = 1; run();
  });
  document.getElementById('f-type').addEventListener('change', (e) => {
    state.type = e.target.value; state.category = ''; fillCategories(); state.page = 1; run();
  });
  ['f-category', 'f-location', 'f-within', 'f-sort'].forEach((id) => {
    document.getElementById(id).addEventListener('change', () => {
      state.category = document.getElementById('f-category').value;
      state.location = document.getElementById('f-location').value;
      state.within_km = document.getElementById('f-within').value;
      state.sort = document.getElementById('f-sort').value;
      state.page = 1; run();
    });
  });
  document.getElementById('clear-filters').addEventListener('click', () => {
    state = { q: '', type: '', category: '', location: '', within_km: '', sort: 'relevance', page: 1 };
    document.getElementById('f-within').value = '';
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
  history.replaceState(null, '', pageUrl());
  renderActiveFilters();
  await Promise.all([loadResults(id), loadRecommendations(id),
    view === 'map' ? MapView.render(state) : null]);
}

function setView(next, render = true) {
  view = next;
  document.getElementById('list-view').classList.toggle('hidden', view !== 'list');
  document.getElementById('map-view').classList.toggle('hidden', view !== 'map');
  document.getElementById('view-list').setAttribute('aria-pressed', String(view === 'list'));
  document.getElementById('view-map').setAttribute('aria-pressed', String(view === 'map'));
  history.replaceState(null, '', pageUrl());
  if (render && view === 'map') MapView.render(state);
}

/** From the map: search one area (and, for a place between areas, its neighbours). */
function applyArea(area, withinKm) {
  state.location = area;
  state.within_km = withinKm || '';
  const loc = document.getElementById('f-location');
  if ([...loc.options].some((o) => o.value === area)) loc.value = area;
  document.getElementById('f-within').value = state.within_km;
  state.page = 1;
  run();
}

function renderActiveFilters() {
  const name = (cid) => allCategories.find((c) => String(c.category_id) === String(cid))?.category_name;
  const chips = [];
  if (state.q) chips.push(['q', `“${state.q}”`]);
  if (state.type) chips.push(['type', name(state.type)]);
  if (state.category) chips.push(['category', name(state.category)]);
  if (state.location) chips.push(['location', state.within_km ? `${state.location} + ${state.within_km} km` : state.location]);
  const box = document.getElementById('active-filters');
  box.innerHTML = chips.map(([k, label]) => `<button type="button" class="chip removable" data-clear="${k}"
      aria-label="Remove filter ${UI.esc(label)}">${UI.esc(label)} &times;</button>`).join('');
  box.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.clear;
    state[k] = '';
    if (k === 'q') document.getElementById('q').value = '';
    if (k === 'type') { state.category = ''; document.getElementById('f-type').value = ''; fillCategories(); }
    if (k === 'category') document.getElementById('f-category').value = '';
    if (k === 'location') {
      document.getElementById('f-location').value = '';
      state.within_km = ''; document.getElementById('f-within').value = '';
    }
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
    // "a midwife near Kilimani": the server read the area out of the query.
    // Adopt it as a visible, removable filter so nothing happens silently.
    if (data.understood?.from_query) {
      state.location = data.understood.location;
      state.q = data.understood.query || '';
      document.getElementById('q').value = state.q;
      const sel = document.getElementById('f-location');
      if ([...sel.options].some((o) => o.value === state.location)) sel.value = state.location;
      history.replaceState(null, '', pageUrl());
      renderActiveFilters();
      UI.toast(`Showing services in ${data.understood.location}, from your search`);
    }
    document.getElementById('result-count').textContent =
      `${data.total} service${data.total === 1 ? '' : 's'} found`;
    const origin = data.area?.name;
    // Nothing clearly matched: show the closest services, and say so.
    const weak = data.match_quality === 'weak'
      ? `<p class="notice" role="note">None of these clearly matches “${UI.esc(state.q)}”. They are the
         closest services listed here; check that one fits before contacting them.</p>` : '';
    box.innerHTML = data.results.length
      ? weak + data.results.map((r) => UI.resultCard({ ...r, area_origin: origin })).join('')
      : `<div class="empty"><p>No services match ${state.q ? `“${UI.esc(state.q)}”` : 'those filters'}.</p>
         <p class="muted">Try removing a filter, or browse a broader category.</p></div>`;
    UI.pager(document.getElementById('pagination'), data, (n) => {
      state.page = n; run(); window.scrollTo(0, 0);
    });
    if (data.suggestions?.length) {
      // Figure 4.5: never leave the parent at an empty page.
      const heading = {
        nearby: `None in ${UI.esc(data.suggestion_origin)} — these are in nearby areas`,
        closest: 'Closest services to what you asked for',
      }[data.suggestion_basis] || 'Popular and highly rated instead';
      sugBox.innerHTML = `<h2 class="suggest-heading">${heading}</h2>
        ${data.suggestions.map((r) => UI.resultCard({ ...r, area_origin: data.suggestion_origin })).join('')}`;
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
    list.innerHTML = data.results.length ? data.results.map(UI.recItem).join('')
      : '<p class="muted">No suggestions yet — search or save a provider and they will appear.</p>';
    UI.trackClicks(list);
    UI.bindFeedback(list);
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
