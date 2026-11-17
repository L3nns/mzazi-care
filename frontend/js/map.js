/* Map view of the search page: the current search's results grouped by the
   area each provider serves, and a place search ("Yaya Centre", "Kilimani").
   Services sit at their area's approximate centre, never at an address.
   Leaflet is loaded only when the map is first opened. */
const MapView = (() => {
  const NAIROBI = [-1.286, 36.817];
  const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const PAGE = 50;                     // the search API's largest page
  const MAX_ON_MAP = 200;
  let map = null;
  let areaLayer = null;
  let placeLayer = null;
  const centres = new Map();           // area name -> [lat, lng]
  let onArea = () => {};               // search.js: (areaName, withinKm) => void
  let current = 0;                     // drops stale renders

  const colour = (name, fallback) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/leaflet-1.9.4/leaflet.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('the map could not be loaded'));
      document.head.appendChild(s);
    });
  }

  async function ensure() {
    if (map) return;
    await loadLeaflet();
    const { locations } = await API.locations();
    locations.filter((l) => l.latitude !== null && l.longitude !== null)
      .forEach((l) => centres.set(l.location, [l.latitude, l.longitude]));
    map = L.map('map', { scrollWheelZoom: false }).setView(NAIROBI, 12);
    L.tileLayer(TILES, {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    areaLayer = L.layerGroup().addTo(map);
    placeLayer = L.layerGroup().addTo(map);
    // Buttons inside popups ("Show only Kilimani", "Show services near here").
    map.on('popupopen', (e) => {
      const el = e.popup.getElement();
      el.querySelectorAll('[data-area]').forEach((b) => b.addEventListener('click', () => {
        map.closePopup();
        onArea(b.dataset.area, b.dataset.within || '');
      }));
    });
  }

  function popupHtml(area, list, nearby) {
    const items = list.slice(0, 5).map((p) => `<li><a href="provider.html?id=${Number(p.provider_id)}">${UI.esc(p.provider_name)}</a>
      <span class="muted">${UI.esc(p.category_name || '')}</span></li>`).join('');
    const more = list.length > 5 ? `<li class="muted">and ${list.length - 5} more</li>` : '';
    return `<strong>${UI.esc(area)}</strong>
      <div class="muted">${list.length} service${list.length === 1 ? '' : 's'}${nearby ? ' (nearby suggestion)' : ''}</div>
      <ul class="map-list">${items}${more}</ul>
      <button type="button" class="btn small" data-area="${UI.esc(area)}">Show only ${UI.esc(area)}</button>`;
  }

  /** Draws the search `state` on the map. */
  async function render(state) {
    const id = ++current;
    const status = document.getElementById('map-status');
    const areaList = document.getElementById('map-areas');
    status.textContent = 'Loading the map…';
    try {
      await ensure();
      map.invalidateSize();
      // Every result (up to MAX_ON_MAP), so the counts per area are complete.
      const data = await API.searchForMap({ ...state, page: 1, per_page: PAGE });
      const results = data.results.slice();
      for (let p = 2; p <= Math.min(data.pages, MAX_ON_MAP / PAGE); p += 1) {
        const more = await API.searchForMap({ ...state, page: p, per_page: PAGE });
        if (id !== current) return;
        results.push(...more.results);
      }
      if (id !== current) return;
      const nearby = !results.length && (data.suggestions || []).length > 0;
      const list = results.length ? results : (data.suggestions || []);
      const groups = new Map();
      list.forEach((p) => {
        if (!groups.has(p.location)) groups.set(p.location, []);
        groups.get(p.location).push(p);
      });
      areaLayer.clearLayers();
      const points = [];
      const rows = [];
      const blue = colour('--blue', '#1f5fbf');
      for (const [area, providers] of groups) {
        const c = centres.get(area);
        if (!c) continue;                      // an area without a known centre
        points.push(c);
        rows.push([area, providers.length]);
        L.circleMarker(c, {
          radius: 8 + Math.min(providers.length, 8) * 2, weight: 2, color: blue,
          fillColor: blue, fillOpacity: nearby ? 0.15 : 0.35, dashArray: nearby ? '4 4' : null,
        }).bindTooltip(`${area}: ${providers.length}`).bindPopup(popupHtml(area, providers, nearby))
          .addTo(areaLayer);
      }
      if (points.length) map.fitBounds(points, { padding: [40, 40], maxZoom: 14 });
      status.textContent = !list.length ? 'Nothing to show on the map for this search.'
        : nearby ? 'Nothing matches here, so nearby or related services are shown (dashed).'
          : data.total > results.length ? `Showing the first ${results.length} of ${data.total} services.`
            : `${data.total} service${data.total === 1 ? '' : 's'} in ${rows.length} area${rows.length === 1 ? '' : 's'}.`;
      // The same areas as a list: usable without a pointer or a screen.
      areaList.innerHTML = rows.sort((a, b) => b[1] - a[1]).map(([area, n]) => `<li>
          <button type="button" class="link-button" data-area="${UI.esc(area)}">${UI.esc(area)}</button>
          <span class="muted">${n} service${n === 1 ? '' : 's'}</span></li>`).join('');
      areaList.querySelectorAll('[data-area]').forEach((b) =>
        b.addEventListener('click', () => onArea(b.dataset.area, '')));
    } catch (err) {
      if (id !== current) return;
      status.textContent = `The map is unavailable: ${err.message}`;
    }
  }

  /** How widely to search around a place: just covering its nearest area centre. */
  const withinFor = (km) => (km <= 2 ? '3' : km <= 4 ? '5' : '10');

  function choose(place) {
    placeLayer.clearLayers();
    const near = place.nearest || [];
    const first = near[0];
    const within = place.area_name ? '' : (first ? withinFor(first.distance_km) : '');
    const target = place.area_name || first?.area_name;
    const orange = colour('--accent', '#c2410c');
    L.circleMarker([place.lat, place.lng], { radius: 7, weight: 2, color: orange, fillColor: orange, fillOpacity: 0.9 })
      .bindPopup(`<strong>${UI.esc(place.name)}</strong>
        ${near.length ? `<div class="muted">Nearest service areas (between centres):</div>
          <ul class="map-list">${near.map((n) => `<li>${UI.esc(n.area_name)} · about ${n.distance_km} km</li>`).join('')}</ul>` : ''}
        ${target ? `<button type="button" class="btn small" data-area="${UI.esc(target)}" data-within="${within}">
          Show services near here</button>` : ''}`)
      .addTo(placeLayer).openPopup();
    map.setView([place.lat, place.lng], place.area_name ? 14 : 15);
  }

  async function findPlace(text) {
    const box = document.getElementById('place-results');
    box.innerHTML = '<p class="muted">Finding the place…</p>';
    try {
      await ensure();
      const { results, source } = await API.geoSearch(text);
      if (!results.length) {
        box.innerHTML = '<p class="muted">No place by that name in or around Nairobi.</p>';
        return;
      }
      box.innerHTML = (results.length > 1 ? `<p class="muted">Did you mean:</p>${results.map((r, i) =>
        `<button type="button" class="chip" data-i="${i}">${UI.esc(r.name)}</button>`).join(' ')}` : '')
        + (source === 'openstreetmap' ? '<p class="muted map-credit">Places from OpenStreetMap.</p>' : '');
      box.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => choose(results[Number(b.dataset.i)])));
      choose(results[0]);
    } catch (err) {
      box.innerHTML = `<p class="error-text">${UI.esc(err.message)}</p>`;
    }
  }

  return {
    render,
    findPlace,
    onAreaChosen: (fn) => { onArea = fn; },
  };
})();
