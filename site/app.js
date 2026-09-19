/* EV pricer SPA: loads data.json (built hourly by GitHub Actions), caches it in
   localStorage for 15 minutes, renders a sortable/filterable Tabulator table and
   mirrors filter + sort state into the URL query string so views can be bookmarked. */
(() => {
  'use strict';

  const DATA_URL = 'data.json';
  const CACHE_KEY = 'ev-pricer:data:v2'; // bump when data.json shape changes so stale caches are dropped
  const CACHE_TTL_MS = 15 * 60 * 1000;

  const $ = id => document.getElementById(id);
  const els = {
    status: $('status-text'), refresh: $('refresh'), count: $('count'), reset: $('reset'),
    city: $('f-city'), network: $('f-network'), type: $('f-type'), current: $('f-current'),
    kw: $('f-kw'), price: $('f-price'), q: $('f-q'), source: $('source-link'),
    filters: $('filters'), filtersToggle: $('filters-toggle'),
    nearMe: $('near-me'), radius: $('f-radius'), geoStatus: $('geo-status'), geoClear: $('geo-clear'),
    table: $('table'), map: $('map'), viewList: $('view-list'), viewMap: $('view-map'),
  };

  const fmtPrice = new Intl.NumberFormat('en', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
  const fmtInt = new Intl.NumberFormat('en');
  const collator = new Intl.Collator('lt', { sensitivity: 'base', numeric: true });
  const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  // ------------------------------------------------------------------ cache
  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const c = JSON.parse(raw);
      return c && c.payload && c.savedAt ? c : null;
    } catch { return null; }
  }
  function writeCache(payload) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), payload })); }
    catch (e) { console.warn('Cache write failed', e); }
  }

  // ------------------------------------------------------------ preferences
  // Personal defaults, kept in this browser's localStorage (a static site has no server to read cookies).
  const PREFS_KEY = 'ev-pricer:prefs:v1';
  const PREFS_DEFAULTS = { radiusKm: 10, kw: '', price: '', types: [], current: [], view: 'list', autoLocate: false };
  function loadPrefs() {
    try { return { ...PREFS_DEFAULTS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')) }; }
    catch { return { ...PREFS_DEFAULTS }; }
  }
  function savePrefs(p) {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) { console.warn('Could not save preferences', e); }
  }
  let prefs = loadPrefs();

  async function fetchData(force) {
    const res = await fetch(DATA_URL + (force ? `?t=${Date.now()}` : ''), { cache: force ? 'reload' : 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    if (!Array.isArray(payload.stations)) throw new Error('Malformed data');
    writeCache(payload);
    return { payload, savedAt: Date.now() };
  }

  async function loadData(force = false) {
    const cached = readCache();
    if (!force && cached && Date.now() - cached.savedAt < CACHE_TTL_MS) return { ...cached, fromCache: true };
    try { return await fetchData(force); }
    catch (e) {
      if (cached) return { ...cached, fromCache: true, error: e };
      throw e;
    }
  }

  // ----------------------------------------------------------------- status
  const relTime = ms => {
    const s = Math.round(ms / 1000);
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} h ago`;
    return `${Math.round(h / 24)} d ago`;
  };
  let statusState = null;
  function renderStatus() {
    if (!statusState) return;
    const { payload, savedAt, fromCache, error } = statusState;
    const gen = payload.generatedAt ? new Date(payload.generatedAt) : null;
    const age = Date.now() - savedAt;
    const stale = age > CACHE_TTL_MS;
    const parts = [];
    if (gen) parts.push(`<span title="${gen.toLocaleString()}">Report built ${relTime(Date.now() - gen)}</span>`);
    parts.push(`<span class="${stale ? 'stale' : ''}" title="${new Date(savedAt).toLocaleString()}">${fromCache ? 'cached' : 'loaded'} ${relTime(age)}</span>`);
    if (error) parts.push(`<span class="error" title="${error.message}">refresh failed, showing cached data</span>`);
    els.status.innerHTML = parts.join(' · ');
    if (payload.source) els.source.href = payload.source;
  }
  setInterval(renderStatus, 30_000);

  // -------------------------------------------------------------- URL state
  const state = { city: [], network: [], type: [], current: [], kw: '', price: '', q: '', sort: [], station: '', view: 'list' };
  const LIST_KEYS = ['city', 'network', 'type', 'current'];

  const FILTER_PARAMS = [...LIST_KEYS, 'kw', 'price', 'q'];
  function readUrl() {
    const p = new URLSearchParams(location.search);
    const hasFilters = FILTER_PARAMS.some(k => p.has(k));
    for (const k of LIST_KEYS) state[k] = p.getAll(k).filter(Boolean);
    state.kw = p.get('kw') ?? '';
    state.price = p.get('price') ?? '';
    state.q = p.get('q') ?? '';
    state.station = p.get('station') ?? '';
    state.view = p.has('view') ? (p.get('view') === 'map' ? 'map' : 'list') : prefs.view;
    if (!hasFilters) applyDefaultFilters();
    state.sort = (p.get('sort') ?? '').split(',').filter(Boolean).map(s => {
      const [column, dir = 'asc'] = s.split(':');
      return { column, dir: dir === 'desc' ? 'desc' : 'asc' };
    });
  }
  function applyDefaultFilters() {
    state.city = []; state.network = []; state.q = '';
    state.type = [...prefs.types];
    state.current = [...prefs.current];
    state.kw = prefs.kw ? String(prefs.kw) : '';
    state.price = prefs.price ? String(prefs.price) : '';
  }
  function writeUrl() {
    const p = new URLSearchParams();
    for (const k of LIST_KEYS) for (const v of state[k]) p.append(k, v);
    if (state.kw) p.set('kw', state.kw);
    if (state.price) p.set('price', state.price);
    if (state.q) p.set('q', state.q);
    const shareableSort = state.sort.filter(s => s.column !== 'distance');
    if (shareableSort.length) p.set('sort', shareableSort.map(s => `${s.column}:${s.dir}`).join(','));
    if (typeof openStationId === 'string' && openStationId) p.set('station', openStationId);
    if (state.view === 'map') p.set('view', 'map');
    const qs = p.toString();
    const url = location.pathname + (qs ? '?' + qs : '') + location.hash;
    if (url !== location.pathname + location.search + location.hash) history.replaceState(null, '', url);
  }

  // ---------------------------------------------------------------- filters
  const selects = {};
  function buildSelect(el, key, items, labelFn = v => v) {
    const opts = items.map(([value, count]) => ({ value, text: labelFn(value), count }));
    if (selects[key]) selects[key].destroy();
    selects[key] = new TomSelect(el, {
      options: opts,
      items: [...state[key]],
      maxItems: null,
      plugins: ['remove_button', 'clear_button'],
      hideSelected: true,
      closeAfterSelect: false,
      render: {
        option: (d, esc) => `<div>${esc(d.text)}<span class="cnt">${fmtInt.format(d.count)}</span></div>`,
        item: (d, esc) => `<div>${esc(d.text)}</div>`,
      },
      sortField: [{ field: 'count', direction: 'desc' }, { field: 'text' }],
      onChange: values => { state[key] = Array.isArray(values) ? [...values] : (values ? [values] : []); applyFilters(); },
      // Tom Select keeps the typed search text after a pick; clear it so the next pick starts clean.
      onItemAdd() { this.setTextboxValue(''); this.refreshOptions(false); },
    });
  }

  function countBy(stations, pick) {
    const m = new Map();
    for (const s of stations) for (const v of pick(s)) if (v) m.set(v, (m.get(v) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0]));
  }

  function rowMatches(s) {
    if (state.city.length && !state.city.includes(s.city)) return false;
    if (state.network.length && !state.network.includes(s.network)) return false;
    if (state.type.length && !state.type.some(t => s.types.includes(t))) return false;
    if (state.current.length && !state.current.some(c => s.current.includes(c))) return false;
    const kw = parseFloat(state.kw);
    if (Number.isFinite(kw) && kw > 0 && s.maxPower < kw) return false;
    const price = parseFloat(state.price);
    if (Number.isFinite(price) && (s.priceMin === null || s.priceMin > price)) return false;
    if (state.q) {
      const q = norm(state.q).trim();
      if (q && !s._search.includes(q)) return false;
    }
    if (geo.position && geo.radiusKm && (s.distance === null || s.distance > geo.radiusKm)) return false;
    return true;
  }

  let table = null;
  // Tabulator builds asynchronously; calling layout methods before 'tableBuilt' throws on some devices.
  const readyQueue = [];
  function whenReady(fn) {
    if (!table) return;
    if (table.initialized) fn(); else readyQueue.push(fn);
  }
  function activeFilterCount() {
    return LIST_KEYS.reduce((n, k) => n + (state[k].length ? 1 : 0), 0) + (state.kw ? 1 : 0) + (state.price ? 1 : 0) + (state.q.trim() ? 1 : 0);
  }
  function updateFilterToggle() {
    const n = activeFilterCount();
    els.filtersToggle.textContent = n ? `Filters (${n})` : 'Filters';
    els.filtersToggle.classList.toggle('active', n > 0);
  }
  function applyFilters() {
    writeUrl();
    updateFilterToggle();
    whenReady(() => table.setFilter(rowMatches));
    if (state.view === 'map') mapView.update('auto');
  }

  function syncInputsFromState() {
    for (const k of LIST_KEYS) selects[k]?.setValue(state[k], true);
    els.kw.value = state.kw;
    els.price.value = state.price;
    els.q.value = state.q;
  }

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  els.kw.addEventListener('input', debounce(() => { state.kw = els.kw.value.trim(); applyFilters(); }, 150));
  els.price.addEventListener('input', debounce(() => { state.price = els.price.value.trim(); applyFilters(); }, 150));
  els.q.addEventListener('input', debounce(() => { state.q = els.q.value; applyFilters(); }, 150));
  els.reset.addEventListener('click', () => {
    applyDefaultFilters();
    state.sort = [];
    syncInputsFromState();
    whenReady(() => table.setSort(geo.position ? [{ column: 'distance', dir: 'asc' }] : sortersFor([])));
    applyFilters();
  });
  els.filtersToggle.addEventListener('click', () => {
    const open = els.filters.classList.toggle('open');
    els.filtersToggle.setAttribute('aria-expanded', String(open));
  });
  window.addEventListener('popstate', () => {
    readUrl();
    setView(state.view, false);
    syncInputsFromState();
    whenReady(() => table.setSort(sortersFor(state.sort)));
    applyFilters();
  });

  // -------------------------------------------------------------------- map
  // Leaflet + OpenStreetMap tiles, loaded on demand the first time the map is opened.
  const LEAFLET = {
    css: ['https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css',
      'https://cdn.jsdelivr.net/npm/leaflet.markercluster@1.5.3/dist/MarkerCluster.css',
      'https://cdn.jsdelivr.net/npm/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css'],
    js: ['https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js',
      'https://cdn.jsdelivr.net/npm/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js'],
  };
  const LT_BOUNDS = [[53.85, 20.9], [56.5, 26.9]];
  const tierColor = v => v === null ? '#6b7280' : v <= 0.30 ? '#15803d' : v <= 0.45 ? '#d97706' : '#b91c1c';
  const priceColor = s => tierColor(s.priceMin);
  // short label for the map pill: "Free", "0.29", "0.30+" (several prices), "n/a"
  const pillLabel = s => s.free && s.priceMax === 0 ? 'Free' : s.priceMin === null ? 'n/a' : fmtPrice.format(s.priceMin) + (s.priceMax > s.priceMin ? '+' : '');
  const median = arr => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  const priceLabel = s => s.free && s.priceMax === 0 ? 'Free*' : s.priceMin === null ? 'price n/a' : (s.priceMin === s.priceMax ? fmtPrice.format(s.priceMin) : `${fmtPrice.format(s.priceMin)}–${fmtPrice.format(s.priceMax)}`) + ' €/kWh';

  const mapView = (() => {
    let loading = null, map = null, cluster = null, userMarker = null, fitted = false, pendingCenter = false;
    const loadAsset = (url, kind) => new Promise((resolve, reject) => {
      const el = kind === 'css' ? Object.assign(document.createElement('link'), { rel: 'stylesheet', href: url }) : Object.assign(document.createElement('script'), { src: url });
      el.onload = resolve; el.onerror = () => reject(new Error(`Failed to load ${url}`));
      document.head.appendChild(el);
    });
    async function load() {
      if (window.L?.markerClusterGroup) return;
      loading ??= (async () => {
        await Promise.all(LEAFLET.css.map(u => loadAsset(u, 'css')));
        for (const u of LEAFLET.js) await loadAsset(u, 'js'); // markercluster needs L first
      })();
      await loading;
    }
    function popupHtml(s) {
      const dist = geo.position && s.distance !== null ? ` · ${s.distance < 1 ? `${Math.round(s.distance * 1000)} m` : `${fmtKm.format(s.distance)} km`}` : '';
      return `<div class="map-popup">
        <div class="t">${esc(s.address)}</div>
        <div class="s">${esc([s.network, s.city].filter(Boolean).join(' · '))}${dist}</div>
        <div class="row">${chips(s.types)}${chips(s.current)}</div>
        <div class="row"><b>${fmtInt.format(s.maxPower)} kW</b> · ${s.stalls} stall${s.stalls === 1 ? '' : 's'} · <b style="color:${priceColor(s)}">${esc(priceLabel(s))}</b></div>
        <div class="actions"><button type="button" data-detail="${esc(s.id)}">Details</button><a href="${directionsUrl(s)}" target="_blank" rel="noopener">Directions</a></div>
      </div>`;
    }
    function ensureMap() {
      if (map) return;
      els.map.innerHTML = '';
      map = L.map(els.map, { zoomControl: true, attributionControl: true });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' }).addTo(map);
      cluster = L.markerClusterGroup({
        chunkedLoading: true, spiderfyOnMaxZoom: true, showCoverageOnHover: false, zoomToBoundsOnClick: true,
        // wide grouping when zoomed out; at street level only stations on (almost) the same spot group, and a click fans them out
        maxClusterRadius: zoom => (zoom >= 15 ? 22 : 60),
        iconCreateFunction: c => {
          const prices = c.getAllChildMarkers().map(m => m.station?.priceMin).filter(v => v !== null && v !== undefined);
          const med = median(prices);
          return L.divIcon({ className: '', iconSize: [46, 46], html: `<div class="pc" style="background:${tierColor(med)}"><b>${c.getChildCount()}</b><small>${med === null ? 'n/a' : '~' + fmtPrice.format(med)}</small></div>` });
        },
      });
      map.addLayer(cluster);
      const legend = L.control({ position: 'bottomleft' });
      legend.onAdd = () => {
        const d = L.DomUtil.create('div', 'map-legend');
        d.innerHTML = '<b>€/kWh on each marker</b><br><i style="background:#15803d"></i>≤ 0.30 or free<br><i style="background:#d97706"></i>0.31 – 0.45<br><i style="background:#b91c1c"></i>&gt; 0.45<br><i style="background:#6b7280"></i>not reported<br><span class="lg-note">Groups show count and median price</span>';
        return d;
      };
      legend.addTo(map);
      map.fitBounds(LT_BOUNDS);
      els.map.addEventListener('click', e => {
        const b = e.target.closest('[data-detail]');
        if (!b) return;
        const st = allStations.find(x => x.id === b.dataset.detail);
        if (st) openDetail(st);
      });
    }
    // refit: true = always re-center; 'auto' = only when none of the results are in the current view
    function update(refit = false) {
      if (!map) return;
      const visible = allStations.filter(s => s.lat !== null && s.lon !== null && rowMatches(s));
      cluster.clearLayers();
      const markers = visible.map(s => {
        const m = L.marker([s.lat, s.lon], {
          icon: L.divIcon({ className: '', iconSize: [0, 0], iconAnchor: [0, 0], popupAnchor: [0, -14], html: `<div class="pm" style="background:${priceColor(s)}">${esc(pillLabel(s))}</div>` }),
          title: `${s.address} · ${priceLabel(s)}`,
        }).bindPopup(() => popupHtml(s), { maxWidth: 320 });
        m.station = s;
        return m;
      });
      cluster.addLayers(markers);
      let doFit = refit === true || !fitted;
      if (refit === 'auto' && fitted && visible.length) {
        // Re-center when results left the current view, or when they occupy only a small corner of it
        // (e.g. picking a city from the country-wide view). Otherwise leave the user's pan/zoom alone.
        const b = map.getBounds();
        const rb = cluster.getBounds();
        const outside = !visible.some(s => b.contains([s.lat, s.lon]));
        const spanLat = (rb.getNorth() - rb.getSouth()) / (b.getNorth() - b.getSouth());
        const spanLng = (rb.getEast() - rb.getWest()) / (b.getEast() - b.getWest());
        const tiny = spanLat < 0.25 && spanLng < 0.25 && map.getZoom() < 15;
        doFit = outside || tiny;
      }
      if (doFit) {
        if (geo.position && (refit === true || !fitted)) map.setView([geo.position.lat, geo.position.lon], geo.radiusKm ? (geo.radiusKm <= 5 ? 13 : geo.radiusKm <= 10 ? 12 : geo.radiusKm <= 25 ? 11 : 10) : 13);
        else if (visible.length) map.fitBounds(cluster.getBounds().pad(0.05), { maxZoom: 15 });
        else if (!geo.position) map.fitBounds(LT_BOUNDS);
        fitted = true;
      }
    }
    function onPosition() {
      if (!map) return;
      if (userMarker) { map.removeLayer(userMarker); userMarker = null; }
      if (geo.position) {
        userMarker = L.marker([geo.position.lat, geo.position.lon], { icon: L.divIcon({ className: '', html: '<div class="user-dot" title="You are here"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
      }
      // Center on the user now if the map is showing; otherwise remember to do it when the map is next opened.
      if (state.view === 'map') update(true);
      else pendingCenter = !!geo.position;
    }
    async function show() {
      els.map.classList.remove('hidden');
      els.table.classList.add('hidden');
      if (!map) {
        els.map.innerHTML = '<div class="map-loading">Loading map…</div>';
        try { await load(); }
        catch (e) { els.map.innerHTML = `<div class="map-loading">Map could not be loaded (${esc(e.message)}).</div>`; return; }
        ensureMap();
        onPosition();
      }
      map.invalidateSize();
      update(pendingCenter ? true : false);
      pendingCenter = false;
    }
    function hide() {
      const wasHidden = els.table.classList.contains('hidden');
      els.map.classList.add('hidden');
      els.table.classList.remove('hidden');
      // Only redraw when the table was actually hidden (coming back from the map). Redrawing during the
      // initial build throws inside Tabulator's responsive layout on narrow screens.
      if (wasHidden) whenReady(() => table.redraw(true));
    }
    return { show, hide, update, onPosition };
  })();

  function setView(view, fromUser = true) {
    state.view = view === 'map' ? 'map' : 'list';
    els.viewList.classList.toggle('on', state.view === 'list');
    els.viewMap.classList.toggle('on', state.view === 'map');
    els.viewList.setAttribute('aria-selected', String(state.view === 'list'));
    els.viewMap.setAttribute('aria-selected', String(state.view === 'map'));
    if (fromUser) writeUrl();
    if (state.view === 'map') mapView.show(); else mapView.hide();
  }
  els.viewList.addEventListener('click', () => setView('list'));
  els.viewMap.addEventListener('click', () => setView('map'));

  // -------------------------------------------------------- preferences UI
  const prefsDlg = $('prefs'), prefsForm = $('prefs-form');
  function fillPrefsForm() {
    const f = prefsForm.elements;
    f.radiusKm.value = String(+prefs.radiusKm || 0);
    f.kw.value = prefs.kw || '';
    f.price.value = prefs.price || '';
    for (const el of prefsForm.querySelectorAll('input[name=types]')) el.checked = prefs.types.includes(el.value);
    for (const el of prefsForm.querySelectorAll('input[name=current]')) el.checked = prefs.current.includes(el.value);
    for (const el of prefsForm.querySelectorAll('input[name=view]')) el.checked = el.value === prefs.view;
    f.autoLocate.checked = !!prefs.autoLocate;
  }
  function readPrefsForm() {
    const f = prefsForm.elements;
    return {
      radiusKm: +f.radiusKm.value || 0,
      kw: f.kw.value.trim(),
      price: f.price.value.trim(),
      types: [...prefsForm.querySelectorAll('input[name=types]:checked')].map(e => e.value),
      current: [...prefsForm.querySelectorAll('input[name=current]:checked')].map(e => e.value),
      view: prefsForm.querySelector('input[name=view]:checked')?.value === 'map' ? 'map' : 'list',
      autoLocate: f.autoLocate.checked,
    };
  }
  $('prefs-open').addEventListener('click', () => { fillPrefsForm(); prefsDlg.showModal(); });
  $('prefs-close').addEventListener('click', () => prefsDlg.close());
  prefsDlg.addEventListener('click', e => { if (e.target === prefsDlg) prefsDlg.close(); });
  prefsForm.addEventListener('submit', e => {
    e.preventDefault();
    prefs = readPrefsForm();
    savePrefs(prefs);
    // apply right away: filters back to the new defaults, radius if a position is active
    applyDefaultFilters();
    syncInputsFromState();
    if (geo.position) { geo.radiusKm = +prefs.radiusKm || 0; els.radius.value = geo.radiusKm ? String(geo.radiusKm) : ''; }
    applyFilters();
    prefsDlg.close();
  });
  $('prefs-clear').addEventListener('click', () => {
    localStorage.removeItem(PREFS_KEY);
    prefs = { ...PREFS_DEFAULTS };
    fillPrefsForm();
  });
  $('prefs-reset-reload').addEventListener('click', () => {
    // Clear filters and the URL, drop the cached report so it is re-downloaded, keep preferences.
    try { localStorage.removeItem(CACHE_KEY); } catch {}
    location.replace(location.pathname);
  });

  // ------------------------------------------------------------------ table
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function priceFormatter(cell) {
    const s = cell.getRow().getData();
    const title = esc(s.prices.join(' | ') || 'No price reported');
    if (s.free && s.priceMax === 0) return `<span class="price free" title="Operator reports: ${title}. Often limited to the venue's customers, check on site.">Free*</span>`;
    if (s.priceMin === null) return `<span class="price na" title="${title}">n/a</span>`;
    const range = s.priceMin === s.priceMax ? fmtPrice.format(s.priceMin) : `${fmtPrice.format(s.priceMin)}–${fmtPrice.format(s.priceMax)}`;
    const hasExtra = s.prices.some(p => /\bir\b|\+/.test(p));
    return `<span class="price" title="${title}">${range}${hasExtra ? '<span class="extra" title="Additional fee applies, hover for details">+fee</span>' : ''}</span>`;
  }
  function addressFormatter(cell) {
    const s = cell.getRow().getData();
    const map = s.lat && s.lon ? `<a class="map" href="${mapsUrl(s)}" target="_blank" rel="noopener" title="Open in Google Maps">📍 Map</a>` : '';
    const tip = [s.id, s.owner && `Owner: ${s.owner}`, s.hours && `Hours: ${s.hours}`].filter(Boolean).join('\n');
    const mobileInfo = `<span class="m-only">${esc([s.network, s.city].filter(Boolean).join(' · '))} · </span>`;
    return `<div class="addr" title="${esc(tip)}">${esc(s.address)}${map}<div class="id">${mobileInfo}${esc(s.id)}${s.hours && s.hours !== '24/7' ? ' · limited hours' : ''}</div></div>`;
  }
  const mapsUrl = s => `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lon}`;
  const directionsUrl = s => `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}`;

  // ---------------------------------------------------------- station detail
  const dlg = $('detail');
  let openStationId = null;
  const chips = (list, cls = '') => list.map(t => `<span class="chip ${cls || (t === 'DC' ? 'dc' : t === 'AC' ? 'ac' : '')}">${esc(t)}</span>`).join('') || '<span class="price na">n/a</span>';
  function openDetail(s) {
    openStationId = s.id;
    $('detail-title').textContent = s.address || s.id;
    $('detail-sub').textContent = [s.city, s.network, s.id].filter(Boolean).join(' · ');
    const rows = (s.points || []).map(p => `<tr>
        <td>${esc(p.id)}</td><td>${chips(p.types)}</td><td>${chips(p.current)}</td>
        <td class="num">${fmtInt.format(p.power)}</td><td>${p.cable ? 'yes' : 'no'}</td><td>${esc(p.price || 'n/a')}</td></tr>`).join('');
    const badges = [
      s.hours === '24/7' ? '<span class="badge ok">Open 24/7</span>' : s.hours ? '<span class="badge warn">Limited hours</span>' : '',
      s.free ? '<span class="badge ok">Free (operator-reported)</span>' : '',
      s.accessible ? '<span class="badge">♿ Accessible</span>' : '',
      s.heavy ? '<span class="badge">Heavy vehicles</span>' : '',
      s.current.includes('DC') ? '<span class="badge">DC fast charging</span>' : '',
    ].join('');
    const kv = [
      ['Network', s.network], ['Owner', s.owner], ['City', s.city],
      ['Opening hours', s.hours], ['Max power', `${fmtInt.format(s.maxPower)} kW`],
      ['Charge points', `${s.stalls} (${s.connectors} connector${s.connectors === 1 ? '' : 's'})`],
      ['Price', s.prices.length ? s.prices.join(' | ') : 'not reported'],
      ['Payment', s.payment.join(', ')], ['Installed', s.installed],
      ['Coordinates', s.lat && s.lon ? `${s.lat}, ${s.lon}` : ''],
      ['Distance from you', geo.position && s.distance !== null ? (s.distance < 1 ? `${Math.round(s.distance * 1000)} m` : `${fmtKm.format(s.distance)} km`) + ' (straight line)' : ''],
    ].filter(([, v]) => v).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    $('detail-body').innerHTML = `
      <div class="detail-actions">
        ${s.lat && s.lon ? `<a href="${mapsUrl(s)}" target="_blank" rel="noopener">📍 Open in Google Maps</a>
        <a class="secondary" href="${directionsUrl(s)}" target="_blank" rel="noopener">🧭 Directions</a>` : ''}
        <a class="secondary" href="https://ev.vialietuva.lt/" target="_blank" rel="noopener">Source portal</a>
      </div>
      <div>${badges}</div>
      <dl class="kv">${kv}</dl>
      <div class="points-wrap"><table class="points"><thead><tr><th>Charge point</th><th>Connector</th><th>Current</th><th>kW</th><th>Cable</th><th>Price</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    if (!dlg.open) dlg.showModal();
    writeUrl();
  }
  function closeDetail() { openStationId = null; if (dlg.open) dlg.close(); writeUrl(); }
  $('detail-close').addEventListener('click', closeDetail);
  dlg.addEventListener('close', () => { if (openStationId) { openStationId = null; writeUrl(); } });
  dlg.addEventListener('click', e => { if (e.target === dlg) closeDetail(); });

  const fmtKm = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
  function distanceFormatter(cell) {
    const d = cell.getValue();
    if (d === null || d === undefined) return '';
    const txt = d < 1 ? `${Math.round(d * 1000)} m` : `${fmtKm.format(d)} km`;
    return `<span class="dist">${txt}${geo.approximate ? '<span class="approx" title="Your browser reported a rough position (accuracy worse than 2 km)"> ≈</span>' : ''}</span>`;
  }

  // ------------------------------------------------------------- geolocation
  // Position lives only in memory for this page view: it is never stored, never put in the URL.
  const geo = { position: null, approximate: false, radiusKm: 0, prevSort: null };
  let allStations = [];
  const toRad = x => x * Math.PI / 180;
  function haversineKm(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371.0088 * Math.asin(Math.sqrt(a));
  }
  function setGeoStatus(text, isError = false) {
    els.geoStatus.textContent = text;
    els.geoStatus.classList.toggle('error', isError);
  }
  function applyPosition(pos) {
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    const first = !geo.position;
    geo.position = { lat, lon };
    if (first) { geo.radiusKm = +prefs.radiusKm || 0; els.radius.value = geo.radiusKm ? String(geo.radiusKm) : ''; } // start with the preferred radius; user can change it
    geo.approximate = Number.isFinite(accuracy) && accuracy > 2000;
    for (const s of allStations) s.distance = s.lat !== null && s.lon !== null ? haversineKm(lat, lon, s.lat, s.lon) : null;
    els.nearMe.classList.add('active');
    els.nearMe.textContent = '📍 Near me ✓';
    els.radius.classList.remove('hidden');
    els.geoClear.classList.remove('hidden');
    setGeoStatus(`${lat.toFixed(3)}, ${lon.toFixed(3)}${geo.approximate ? ' · approximate' : ''}`);
    whenReady(() => {
      if (first) geo.prevSort = table.getSorters().map(x => ({ column: x.field, dir: x.dir }));
      table.showColumn('distance');
      table.redraw(true); // re-run responsive column hiding for the new column set
      table.setSort([{ column: 'distance', dir: 'asc' }]);
      table.setFilter(rowMatches);
    });
    mapView.onPosition();
  }
  function clearPosition() {
    geo.position = null; geo.approximate = false; geo.radiusKm = 0;
    for (const s of allStations) s.distance = null;
    els.nearMe.classList.remove('active');
    els.nearMe.textContent = '📍 Near me';
    els.radius.value = '';
    els.radius.classList.add('hidden');
    els.geoClear.classList.add('hidden');
    setGeoStatus('');
    const prev = geo.prevSort;
    whenReady(() => {
      table.hideColumn('distance');
      table.redraw(true);
      table.setSort(sortersFor(prev || []));
      table.setFilter(rowMatches);
    });
    geo.prevSort = null;
    mapView.onPosition();
  }
  function requestPosition() {
    if (!('geolocation' in navigator)) { setGeoStatus('Your browser does not support location.', true); return; }
    els.nearMe.disabled = true; els.nearMe.classList.add('busy'); els.nearMe.textContent = '📍 Locating…';
    setGeoStatus('');
    const done = () => { els.nearMe.disabled = false; els.nearMe.classList.remove('busy'); if (!geo.position) els.nearMe.textContent = '📍 Near me'; };
    navigator.geolocation.getCurrentPosition(
      pos => { done(); applyPosition(pos); },
      err => {
        done();
        if (err.code === 1) setGeoStatus("Location blocked. Allow it for this site in your browser's settings.", true);
        else if (err.code === 3) setGeoStatus('Could not get your location in time, try again.', true);
        else setGeoStatus('Could not get your location, try again.', true);
      },
      { enableHighAccuracy: false, timeout: 12_000, maximumAge: 5 * 60_000 },
    );
  }
  els.nearMe.addEventListener('click', requestPosition); // re-clicking refreshes the position
  els.geoClear.addEventListener('click', clearPosition);
  els.radius.addEventListener('change', () => { geo.radiusKm = parseFloat(els.radius.value) || 0; whenReady(() => table.setFilter(rowMatches)); if (state.view === 'map') mapView.update(true); });

  const chipFormatter = cell => cell.getValue().map(t => `<span class="chip ${t === 'DC' ? 'dc' : t === 'AC' ? 'ac' : ''}">${esc(t)}</span>`).join('');

  const nullsLast = { alignEmptyValues: 'bottom' };
  // Locale-aware text sorter that always keeps empty values at the bottom (custom sorters ignore alignEmptyValues).
  const textSorter = (a, b, _ra, _rb, _col, dir) => {
    if (!a && !b) return 0;
    if (!a) return dir === 'asc' ? 1 : -1;
    if (!b) return dir === 'asc' ? -1 : 1;
    return collator.compare(a, b);
  };
  const DEFAULT_SORT = { column: 'city', dir: 'asc' };
  // Tabulator mutates sorter objects it is given (column name -> Column object), so always hand it copies.
  const sortersFor = list => (list.length ? list : [DEFAULT_SORT]).map(s => ({ ...s }));
  const columns = [
    { title: 'City', field: 'city', width: 150, sorter: textSorter, cssClass: 'wrap', responsive: 3 },
    { title: 'Network', field: 'network', width: 150, sorter: textSorter, responsive: 4 },
    { title: 'Address', field: 'address', minWidth: 150, widthGrow: 3, formatter: addressFormatter, sorter: textSorter, responsive: 0 },
    { title: 'Connectors', field: 'types', width: 190, headerSort: false, formatter: chipFormatter, cssClass: 'chips', variableHeight: true, responsive: 6 },
    { title: 'AC/DC', field: 'current', width: 90, headerSort: false, formatter: chipFormatter, cssClass: 'chips', responsive: 5 },
    { title: 'kW', field: 'maxPower', width: 80, headerTooltip: 'Maximum power of the station (kW)', hozAlign: 'right', sorter: 'number', cssClass: 'num-cell', formatter: c => fmtInt.format(c.getValue()), responsive: 1 },
    { title: 'Stalls', field: 'stalls', width: 90, hozAlign: 'right', sorter: 'number', cssClass: 'num-cell', responsive: 2 },
    { title: 'km', field: 'distance', width: 74, hozAlign: 'right', sorter: 'number', sorterParams: nullsLast, formatter: distanceFormatter, cssClass: 'num-cell', responsive: 0, visible: false, headerTooltip: 'Straight-line distance from your location' },
    { title: '€/kWh', field: 'priceMin', width: 100, cssClass: 'wrap', hozAlign: 'right', sorter: 'number', sorterParams: nullsLast, formatter: priceFormatter, responsive: 0 },
  ];

  function updateCount(shownRows) {
    if (!table) return;
    const shown = Array.isArray(shownRows) ? shownRows.length : table.getDataCount('active'), total = table.getDataCount();
    els.count.textContent = shown === total ? `${fmtInt.format(total)} stations` : `${fmtInt.format(shown)} of ${fmtInt.format(total)} stations`;
  }

  function buildTable(stations) {
    allStations = stations;
    for (const s of stations) { s._search = norm([s.address, s.id, s.owner, s.network, s.city].join(' ')); s.distance = null; }
    if (geo.position) for (const s of stations) s.distance = s.lat !== null && s.lon !== null ? haversineKm(geo.position.lat, geo.position.lon, s.lat, s.lon) : null;
    if (table) { table.replaceData(stations); return; }
    table = new Tabulator('#table', {
      data: stations,
      columns,
      layout: 'fitColumns',
      responsiveLayout: 'hide',
      height: '100%',
      index: 'id',
      headerSortClickElement: 'header',
      columnHeaderSortMulti: true,
      headerSortTristate: true,
      initialSort: sortersFor(state.sort),
      placeholder: 'No stations match these filters',
    });
    table.on('dataFiltered', (_filters, rows) => updateCount(rows));
    table.on('dataLoaded', () => updateCount());
    table.on('dataSorted', sorters => {
      // Tabulator lists sorters with the primary sort last; we store them in that same order.
      const next = sorters.map(s => ({ column: s.field, dir: s.dir }));
      const isDefault = next.length === 1 && next[0].column === DEFAULT_SORT.column && next[0].dir === DEFAULT_SORT.dir;
      state.sort = isDefault ? [] : next;
      writeUrl();
    });
    table.on('rowClick', (e, row) => { if (!e.target.closest('a')) openDetail(row.getData()); });
    table.on('tableBuilt', () => { table.setFilter(rowMatches); while (readyQueue.length) readyQueue.shift()(); });
  }

  // ------------------------------------------------------------------- boot
  function render(result) {
    statusState = result;
    renderStatus();
    const stations = result.payload.stations;
    buildSelect(els.city, 'city', countBy(stations, s => [s.city]));
    buildSelect(els.network, 'network', countBy(stations, s => [s.network]));
    buildSelect(els.type, 'type', countBy(stations, s => s.types));
    buildSelect(els.current, 'current', countBy(stations, s => s.current));
    syncInputsFromState();
    updateFilterToggle();
    buildTable(stations);
    if (state.station && !openStationId) {
      const s = stations.find(x => x.id === state.station);
      if (s) openDetail(s);
    }
    state.station = '';
    setView(state.view, false);
    if (prefs.autoLocate && !geo.position && !autoLocated) { autoLocated = true; requestPosition(); }
  }
  let autoLocated = false;

  async function refresh(force) {
    els.refresh.disabled = true;
    els.status.textContent = 'Loading…';
    let result = null;
    try { result = await loadData(force); }
    catch (e) {
      console.error('Data load failed', e);
      els.status.innerHTML = `<span class="error">Failed to load data (${esc(e.message)}). Check your connection and press Refresh.</span>`;
      els.refresh.disabled = false;
      return;
    }
    try { render(result); }
    catch (e) {
      console.error('Render failed', e);
      statusState = null; // keep the error visible instead of letting the status ticker overwrite it
      els.status.innerHTML = `<span class="error" title="${esc(e.stack || '')}">Display error (${esc(e.message)}). Reload the page; if it persists, please report it.</span>`;
    } finally { els.refresh.disabled = false; }
  }
  els.refresh.addEventListener('click', () => refresh(true));

  readUrl();
  refresh(false);
})();
