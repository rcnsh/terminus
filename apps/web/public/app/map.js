// The Map tab: the campus's streets with the bus routes on them, a pill per
// service along the top, and the stops. A pill shows that service's line and
// its live buses; a stop shows what's coming, the services that call there,
// and ways to go there. Loaded the first time the tab is opened.
//
// Everything comes from our own domain: MapLibre and the PMTiles reader
// (vendor/, scripts/vendor-map.sh), the map file and its style, fonts and
// icons (/map/*), routes and stops (/campus), buses (/buses), arrivals
// (/arrivals). The service worker keeps all but the live ones for offline.

import { $, api, el, t } from '/account/dom.js';

const MAPLIBRE = '/vendor/maplibre-gl@6.11.2/';
const PMTILES = '/vendor/pmtiles@4.5.0/pmtiles.mjs';
/** Live buses refresh this often while a pill is on (the API caches 5 s). */
const BUSES_MS = 5_000;
/** A stop's arrivals refresh this often while its sheet is open (cached 15 s). */
const ARRIVALS_MS = 15_000;
/** How long a bus takes to glide to a new position: about as long as the
 *  feed holds one (it moves a bus every 15–20 s), so a bus keeps driving
 *  instead of jumping and then waiting. */
const GLIDE_MS = 15_000;
/** Further than this along its line in one update (back from a hidden tab),
 *  a bus doesn't glide along it. */
const GLIDE_ALONG_MAX_M = 1_500;
/** Off its line, further than this from where it's drawn, a bus jumps
 *  instead of gliding straight across (through buildings). */
const GLIDE_STRAIGHT_MAX_M = 250;
/** Put back along its line by less than this (GPS error), a bus stays where
 *  it's drawn instead of reversing. */
const HOLD_BACK_M = 60;
/** Further than this from campus, the map opens on campus, not on you. */
const NEAR_CAMPUS_M = 3_000;
/** The map file's extent (MAP_BOUNDS in apps/api/src/map.ts). */
const BOUNDS = [[103.755, 1.28], [103.83, 1.332]];

let ml = null;
let map = null;
let campus = null;
let visible = false;
/** The service whose pill is on, or null. */
let selected = null;
let busTimer = null;
let sheetTimer = null;
let watchId = null;
/** Each bus as it last came from the API, by id (for its card). */
let shown = new Map();
/** Each bus's glide, by id: from where it was drawn to where it is now. */
let glides = new Map();
let glide = null;

const dark = () => window.matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light';
const lang = () => (window.i18n?.lang === 'zh' ? 'zh' : 'en');
const styleUrl = () => `/map/style.json?theme=${dark() ? 'dark' : 'light'}&lang=${lang()}`;
const colorOf = (svc) => campus?.routes[svc]?.color ?? '#8a939c';

const svcVars = (svc) => `--svc:${colorOf(svc)}`;

async function getJSON(path) {
  const res = await fetch(path, { credentials: 'same-origin', headers: { 'accept-language': window.i18n?.header ?? 'en' } });
  if (res.status === 401) {
    location.replace('/account/?next=/app/');
    throw new Error('signed out');
  }
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

function metres(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180;
  const x = (bLon - aLon) * r * Math.cos(((aLat + bLat) / 2) * r);
  return Math.hypot(x, (bLat - aLat) * r) * 6_371_000;
}

/** Where the phone is, only when location is already allowed. Never asks. */
async function allowed() {
  if (!navigator.geolocation) return false;
  const state = await navigator.permissions?.query({ name: 'geolocation' }).then((p) => p.state).catch(() => null);
  return state === 'granted';
}

/* ---------- opening ---------- */

/** Shows the map, building it the first time. */
export async function showMap() {
  visible = true;
  if (map) {
    map.resize();
    resume();
    return;
  }
  try {
    await build();
  } catch (err) {
    if (err.message === 'signed out') return;
    $('#map').replaceChildren(el('p', { class: 'map-empty hint', textContent: t('The map needs a connection the first time.') }));
  }
}

/** Stops everything that runs while the map is on screen. */
export function hideMap() {
  visible = false;
  clearTimeout(busTimer);
  clearTimeout(sheetTimer);
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

function resume() {
  if (selected) pollBuses();
  followMe();
  if (sheetRefresh) sheetRefresh();
}

async function build() {
  const css = el('link', { rel: 'stylesheet', href: `${MAPLIBRE}maplibre-gl.css` });
  document.head.append(css);
  const [maplibre, { Protocol }, data] = await Promise.all([import(`${MAPLIBRE}maplibre-gl.mjs`), import(PMTILES), getJSON('/campus')]);
  ml = maplibre;
  campus = data;
  ml.addProtocol('pmtiles', new Protocol({ metadata: true }).tile);

  const core = campus.stops.filter((s) => s.core);
  const fit = boundsOf(core.map((s) => [s.lon, s.lat]));
  map = new ml.Map({
    container: 'map',
    style: styleUrl(),
    bounds: fit,
    fitBoundsOptions: { padding: { top: 70, bottom: 30, left: 30, right: 30 } },
    maxBounds: [[BOUNDS[0][0] - 0.02, BOUNDS[0][1] - 0.02], [BOUNDS[1][0] + 0.02, BOUNDS[1][1] + 0.02]],
    // Not past the campus area: the map file covers only that.
    minZoom: 13,
    maxZoom: 19,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    attributionControl: { compact: true },
    // Chinese place names in the phone's own fonts: no CJK font files to fetch.
    localIdeographFontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', sans-serif",
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new ml.NavigationControl({ showCompass: false }), 'bottom-right');
  // Lost after a pinch or a drag: one tap back to the whole campus.
  map.addControl(
    {
      onAdd() {
        this.box = el(
          'div',
          { class: 'maplibregl-ctrl maplibregl-ctrl-group' },
          el('button', {
            type: 'button',
            class: 'map-recentre',
            title: t('Back to campus'),
            'aria-label': t('Back to campus'),
            innerHTML: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/></svg>',
            onclick: () => map.fitBounds(fit, { padding: { top: 70, bottom: 30, left: 30, right: 30 }, duration: 600 }),
          }),
        );
        return this.box;
      },
      onRemove() {
        this.box.remove();
      },
    },
    'bottom-right',
  );
  // Our layers again after every style load: the first, and each light/dark switch.
  map.on('style.load', addLayers);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => map.setStyle(styleUrl()));
  map.on('click', onClick);
  for (const layer of ['stops', 'stop-names', 'buses']) {
    map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
  }
  renderPills();
  startOnMe();
  followMe();
}

function boundsOf(points) {
  const lons = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  return [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]];
}

/** On your nearest stop when location is allowed and you're on campus. */
async function startOnMe() {
  if (!(await allowed())) return;
  navigator.geolocation.getCurrentPosition(
    (p) => {
      const { latitude: lat, longitude: lon } = p.coords;
      let best = null;
      for (const s of campus.stops) {
        const d = metres(lat, lon, s.lat, s.lon);
        if (!best || d < best.d) best = { s, d };
      }
      if (best && best.d < NEAR_CAMPUS_M) map.jumpTo({ center: [best.s.lon, best.s.lat], zoom: 17 });
    },
    () => {},
    { maximumAge: 60_000, timeout: 8_000 },
  );
}

/** Your dot, kept up to date while the map is open; only with location already allowed. */
async function followMe() {
  if (watchId !== null || !(await allowed()) || !visible) return;
  watchId = navigator.geolocation.watchPosition(
    (p) => map.getSource('me')?.setData({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [p.coords.longitude, p.coords.latitude] } }),
    () => {},
    { maximumAge: 15_000, enableHighAccuracy: true },
  );
}

/* ---------- layers ---------- */

const empty = { type: 'FeatureCollection', features: [] };

function addLayers() {
  const ink = dark() ? '#f2efeb' : '#1c1917';
  const paper = dark() ? '#1a1816' : '#ffffff';
  map.addSource('routes', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: Object.entries(campus.routes).map(([svc, r]) => ({ type: 'Feature', properties: { svc, color: r.color }, geometry: { type: 'LineString', coordinates: r.line } })),
    },
  });
  map.addSource('stops', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: campus.stops.map((s) => ({ type: 'Feature', properties: { code: s.code, name: s.name, services: ` ${s.services.join(' ')} ` }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } })),
    },
  });
  map.addSource('buses', { type: 'geojson', data: empty });
  map.addSource('me', { type: 'geojson', data: empty });

  const width = ['interpolate', ['linear'], ['zoom'], 13, 1.5, 16, 4, 18, 7];
  map.addLayer({ id: 'route-casing', type: 'line', source: 'routes', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': paper, 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 3, 16, 7, 18, 11], 'line-opacity': 0.9 } });
  map.addLayer({ id: 'routes', type: 'line', source: 'routes', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': width } });
  // The chosen service, drawn again on top of the others.
  map.addLayer({ id: 'route-on', type: 'line', source: 'routes', filter: ['==', ['get', 'svc'], ''], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 3, 16, 6, 18, 9] } });
  map.addLayer({
    id: 'stops',
    type: 'circle',
    source: 'stops',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2.5, 16, 5.5, 18, 8],
      'circle-color': paper,
      'circle-stroke-color': ink,
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 13, 1, 16, 2],
    },
  });
  map.addLayer({
    id: 'stop-names',
    type: 'symbol',
    source: 'stops',
    minzoom: 15,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Medium'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 15, 11, 18, 14],
      'text-offset': [0, 0.9],
      'text-anchor': 'top',
      'text-optional': true,
      'text-max-width': 8,
    },
    paint: { 'text-color': ink, 'text-halo-color': paper, 'text-halo-width': 1.5 },
  });
  map.addLayer({ id: 'me-halo', type: 'circle', source: 'me', paint: { 'circle-radius': 14, 'circle-color': '#2b7bf3', 'circle-opacity': 0.18 } });
  map.addLayer({ id: 'me', type: 'circle', source: 'me', paint: { 'circle-radius': 6.5, 'circle-color': '#2b7bf3', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } });
  if (!map.hasImage('heading')) map.addImage('heading', arrow('#ffffff'), { pixelRatio: 2 });
  map.addLayer({ id: 'buses', type: 'circle', source: 'buses', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 7, 17, 11], 'circle-color': ['get', 'color'], 'circle-stroke-color': paper, 'circle-stroke-width': 2.5 } });
  map.addLayer({
    id: 'bus-heading',
    type: 'symbol',
    source: 'buses',
    filter: ['==', ['get', 'moving'], true],
    layout: { 'icon-image': 'heading', 'icon-rotate': ['get', 'heading'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.7, 17, 1] },
  });
  highlight();
  drawBuses(frameAt(performance.now()));
}

/** A small white arrow pointing up (north) before rotation. */
function arrow(fill) {
  const size = 32;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = fill;
  g.beginPath();
  g.moveTo(16, 6);
  g.lineTo(24, 20);
  g.lineTo(16, 16.5);
  g.lineTo(8, 20);
  g.closePath();
  g.fill();
  return g.getImageData(0, 0, size, size);
}

/** The chosen service stands out; the rest step back. */
function highlight() {
  if (!map?.getLayer('routes')) return;
  map.setFilter('route-on', ['==', ['get', 'svc'], selected ?? '']);
  map.setPaintProperty('routes', 'line-opacity', selected ? 0.18 : 0.9);
  map.setPaintProperty('route-casing', 'line-opacity', selected ? 0.3 : 0.9);
  // services is " A1 D2 ": spaces round each, so K never matches inside another code.
  const on = selected ? ['in', ` ${selected} `, ['get', 'services']] : true;
  map.setPaintProperty('stops', 'circle-opacity', selected ? ['case', on, 1, 0.35] : 1);
  map.setPaintProperty('stops', 'circle-stroke-opacity', selected ? ['case', on, 1, 0.35] : 1);
  map.setPaintProperty('stop-names', 'text-opacity', selected ? ['case', on, 1, 0.4] : 1);
}

/* ---------- pills and live buses ---------- */

function renderPills() {
  const order = Object.keys(campus.routes).sort();
  $('#map-pills').replaceChildren(
    ...order.map((svc) =>
      el(
        'button',
        { type: 'button', style: svcVars(svc), 'aria-pressed': String(svc === selected), 'aria-label': t('{0}: show its line and live buses', svc), onclick: () => choose(svc === selected ? null : svc) },
        el('span', { class: 'dot' }),
        svc,
      ),
    ),
  );
}

/** One service at a time: its line and buses, or none. */
function choose(svc) {
  selected = svc;
  clearTimeout(busTimer);
  cancelAnimationFrame(glide);
  shown = new Map();
  glides = new Map();
  drawBuses([]);
  renderPills();
  highlight();
  status(null);
  if (!svc) return;
  map.fitBounds(boundsOf(campus.routes[svc].line), { padding: { top: 80, bottom: 40, left: 40, right: 40 }, maxZoom: 16.5, duration: 600 });
  status(t('Finding {0} buses…', svc));
  pollBuses();
}

function status(text) {
  $('#map-status').hidden = !text;
  $('#map-status').textContent = text ?? '';
}

async function pollBuses() {
  clearTimeout(busTimer);
  const svc = selected;
  if (!svc || !visible) return;
  try {
    const data = await getJSON(`/buses?svc=${encodeURIComponent(svc)}`);
    if (svc !== selected) return;
    if (!data.available) status(t('Live buses aren’t available right now.'));
    else if (!data.buses.length) status(t('No {0} buses running right now.', svc));
    else status(data.buses.length === 1 ? t('1 bus on {0}', svc) : t('{0} buses on {1}', data.buses.length, svc));
    moveTo(data.buses.map((b) => ({ ...b, svc, color: colorOf(svc) })));
  } catch (err) {
    if (err.message === 'signed out' || svc !== selected) return;
    status(navigator.onLine ? t('Live buses aren’t available right now.') : t('Live buses need a connection.'));
  }
  if (document.visibilityState === 'visible') busTimer = setTimeout(pollBuses, BUSES_MS);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && visible && selected) pollBuses();
});

/**
 * Starts a glide for each bus whose position changed, from where it's drawn
 * to where it is: along its route line when both ends are on it, so it
 * follows the road round corners; straight across a short way otherwise. A
 * bus whose position hasn't changed keeps gliding: the API answers every
 * few seconds, the feed moves a bus every 15–20.
 */
function moveTo(buses) {
  const now = performance.now();
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const path = pathOf(campus?.routes[selected]?.line);
  shown = new Map(buses.map((b) => [b.id, b]));
  const next = new Map();
  for (const b of buses) {
    const g = glides.get(b.id);
    if (g && g.to.lat === b.lat && g.to.lon === b.lon) next.set(b.id, { ...g, to: b });
    else next.set(b.id, g && !reduce ? glideFrom(positionAt(g, now), b, path, now) : { from: null, to: b });
  }
  glides = next;
  cancelAnimationFrame(glide);
  const step = (t) => {
    drawBuses(frameAt(t));
    if ([...glides.values()].some((g) => g.from && t - g.start < GLIDE_MS)) glide = requestAnimationFrame(step);
  };
  glide = requestAnimationFrame(step);
}

function frameAt(now) {
  return [...glides.values()].map((g) => positionAt(g, now));
}

/** A glide for bus [b] from [from] (where it's drawn), or none: it jumps. */
function glideFrom(from, b, path, now) {
  const d = path && alongBy(path, from, b);
  if (d != null) {
    if (d < -HOLD_BACK_M) return { from: null, to: b };
    return { from, to: b, start: now, path, d: Math.max(0, d) };
  }
  if (haversine(from.lat, from.lon, b.lat, b.lon) > GLIDE_STRAIGHT_MAX_M) return { from: null, to: b };
  return { from, to: b, start: now, path: null, d: null };
}

/** Where glide [g]'s bus is drawn at [now], at a steady pace. */
function positionAt(g, now) {
  if (!g.from) return g.to;
  const k = Math.max(0, Math.min(1, (now - g.start) / GLIDE_MS));
  // Mid-glide straight, it's off the line: the next glide is straight too.
  if (g.d == null) return k === 1 ? g.to : { ...g.to, along: null, lat: g.from.lat + (g.to.lat - g.from.lat) * k, lon: g.from.lon + (g.to.lon - g.from.lon) * k };
  const along = g.from.along + g.d * k;
  const at = pointAt(g.path, along);
  const total = g.path.total;
  return { ...g.to, along: g.path.closed ? ((along % total) + total) % total : along, lat: at.lat, lon: at.lon, heading: g.d > 0 ? at.bearing : g.to.heading };
}

/* A route line measured as the API measures it (haversine, metres from its
   start at each point), so a bus's `along` is a place on it. */

const paths = new WeakMap();

function pathOf(line) {
  if (!line || line.length < 2) return null;
  let p = paths.get(line);
  if (!p) {
    const cum = [0];
    for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + haversine(line[i - 1][1], line[i - 1][0], line[i][1], line[i][0]));
    const total = cum[cum.length - 1];
    const [a, z] = [line[0], line[line.length - 1]];
    p = { line, cum, total, closed: haversine(a[1], a[0], z[1], z[0]) < 5 };
    paths.set(line, p);
  }
  return p;
}

/** Metres to glide along [path] from bus [f] to bus [b]; null when not
 *  along it (off the line, a line that isn't the API's, or a long way). */
function alongBy(path, f, b) {
  if (f.along == null || b.along == null || path.total <= 0) return null;
  // A line kept from before the route changed: `along` isn't a place on it.
  for (const x of [f, b]) {
    const at = pointAt(path, x.along);
    if (haversine(at.lat, at.lon, x.lat, x.lon) > 10) return null;
  }
  let d = b.along - f.along;
  // Round a loop the short way, past its start.
  if (path.closed) {
    if (d < -path.total / 2) d += path.total;
    else if (d > path.total / 2) d -= path.total;
  }
  return Math.abs(d) > GLIDE_ALONG_MAX_M ? null : d;
}

/** The point [m] metres along [path], and the road's direction there. */
function pointAt(path, m) {
  const { line, cum, total } = path;
  m = path.closed ? ((m % total) + total) % total : Math.max(0, Math.min(total, m));
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= m) lo = mid; else hi = mid;
  }
  const [aLon, aLat] = line[lo];
  const [bLon, bLat] = line[hi];
  const seg = cum[hi] - cum[lo];
  const t = seg > 0 ? (m - cum[lo]) / seg : 0;
  return { lat: aLat + (bLat - aLat) * t, lon: aLon + (bLon - aLon) * t, bearing: bearing(aLat, aLon, bLat, bLon) };
}

/** As apps/api/src/geo.ts, so distances along a line match the API's. */
function haversine(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180;
  const s = Math.sin(((bLat - aLat) * r) / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(((bLon - aLon) * r) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(s)));
}

function bearing(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180;
  const y = Math.sin((bLon - aLon) * r) * Math.cos(bLat * r);
  const x = Math.cos(aLat * r) * Math.sin(bLat * r) - Math.sin(aLat * r) * Math.cos(bLat * r) * Math.cos((bLon - aLon) * r);
  return ((Math.atan2(y, x) / r) % 360 + 360) % 360;
}

function drawBuses(buses) {
  map?.getSource('buses')?.setData({
    type: 'FeatureCollection',
    features: buses.map((b) => ({
      type: 'Feature',
      properties: { id: b.id, svc: b.svc, color: b.color, heading: b.heading ?? 0, moving: Boolean(b.moving && b.heading !== null) },
      geometry: { type: 'Point', coordinates: [b.lon, b.lat] },
    })),
  });
}

/* ---------- the sheet: a stop or a bus ---------- */

/** Re-renders the open sheet's live part; null when no sheet is open. */
let sheetRefresh = null;

/** How far from a stop or bus a tap still picks it, in pixels: about a
 *  fingertip on a touch screen, less with a mouse. */
const tapSlop = () => (window.matchMedia('(pointer: coarse)').matches ? 24 : 10);

/** The stop or bus nearest the tap, within [tapSlop]; else a stop's name
 *  under the finger. */
function onClick(e) {
  const r = tapSlop();
  const around = (n) => [[e.point.x - n, e.point.y - n], [e.point.x + n, e.point.y + n]];
  let best = null;
  for (const f of map.queryRenderedFeatures(around(r), { layers: ['buses', 'stops'] })) {
    const p = map.project(f.geometry.coordinates);
    // A bus wins over a stop under it.
    const d = Math.hypot(p.x - e.point.x, p.y - e.point.y) - (f.layer.id === 'buses' ? 12 : 0);
    if (d <= r && (!best || d < best.d)) best = { f, d };
  }
  // A stop's name, tapped on (not just near), is the stop, after any dot.
  if (!best) {
    const [name] = map.queryRenderedFeatures(around(4), { layers: ['stop-names'] });
    if (name) best = { f: name };
  }
  if (!best) return closeSheet();
  if (best.f.layer.id === 'buses') openBus(best.f.properties.id);
  else openStop(best.f.properties.code);
}

function closeSheet() {
  clearTimeout(sheetTimer);
  sheetRefresh = null;
  $('#map-sheet').hidden = true;
}

function sheet(title, sub, ...body) {
  const box = $('#map-sheet');
  box.replaceChildren(
    el('div', { class: 'sheet-head' }, el('div', {}, el('h2', { textContent: title }), sub ? el('p', { class: 'hint', textContent: sub }) : ''), el('button', { type: 'button', class: 'sheet-close', textContent: '×', 'aria-label': t('Close'), onclick: closeSheet })),
    ...body,
  );
  box.hidden = false;
}

const crowdWord = (c) => ({ low: t('Quiet'), medium: t('Filling'), high: t('Packed') })[c] ?? null;
const svcTag = (svc, onclick) => el(onclick ? 'button' : 'span', { class: 'svc-tag', style: svcVars(svc), textContent: svc, ...(onclick ? { type: 'button', onclick, 'aria-label': t('Show {0} on the map', svc) } : {}) });

function openBus(id) {
  clearTimeout(sheetTimer);
  const render = () => {
    const b = shown.get(id);
    if (!b) return closeSheet();
    sheet(
      t('{0} bus', b.svc),
      b.moving ? null : t('Stopped'),
      el(
        'div',
        { class: 'sheet-rows' },
        el('div', { class: 'sheet-row' }, el('span', { textContent: t('Next stop') }), el('span', { class: 'when', textContent: b.nextStop?.name ?? t('Not on its route right now') })),
        b.crowd ? el('div', { class: 'sheet-row' }, el('span', { textContent: t('How full') }), el('span', { class: 'when', textContent: crowdWord(b.crowd) })) : '',
      ),
    );
  };
  render();
  // Follows the bus's own updates (pollBuses) while open.
  sheetRefresh = () => {
    render();
    sheetTimer = setTimeout(sheetRefresh, BUSES_MS);
  };
  sheetTimer = setTimeout(sheetRefresh, BUSES_MS);
}

function openStop(code) {
  clearTimeout(sheetTimer);
  const stop = campus.stops.find((s) => s.code === code);
  if (!stop) return;
  const rows = el('div', { class: 'sheet-rows' }, el('div', { class: 'hint', textContent: t('Checking…') }));
  const save = el('button', { type: 'button', class: 'btn small ghost', textContent: t('Save as place'), onclick: () => saveAsPlace(stop, save) });
  sheet(
    stop.name,
    null,
    rows,
    el('p', { class: 'sheet-label', textContent: t('Services here') }),
    el('div', { class: 'svc-tags' }, ...stop.services.map((svc) => svcTag(svc, () => choose(svc)))),
    el(
      'div',
      { class: 'sheet-actions' },
      el('button', { type: 'button', class: 'btn small accent', textContent: t('Go there'), onclick: () => document.dispatchEvent(new CustomEvent('go-to-stop', { detail: { code: stop.code, name: stop.name, place: profile?.places.find((p) => p.to === stop.code)?.key ?? null } })) }),
      el('a', { class: 'btn small ghost', href: directions(stop), target: '_blank', rel: 'noopener', textContent: t('Walking directions') }),
      save,
    ),
  );
  markSaved(stop, save);
  sheetRefresh = async () => {
    clearTimeout(sheetTimer);
    try {
      const data = await getJSON(`/arrivals?stop=${encodeURIComponent(code)}`);
      if (sheetRefresh === null) return;
      const board = data.available ? data.board.filter((b) => b.etaS !== null) : [];
      rows.replaceChildren(
        ...(board.length
          ? board.map((b) =>
              el(
                'div',
                { class: 'sheet-row' },
                svcTag(b.svc),
                el('span', { class: 'when' }, b.etaS < 60 ? t('Arriving') : b.quality === 'scheduled' ? t('~{0}', t('{0} min', Math.round(b.etaS / 60))) : t('{0} min', Math.round(b.etaS / 60)), b.crowd ? el('span', { class: 'crowd', textContent: crowdWord(b.crowd) }) : ''),
              ),
            )
          : [el('div', { class: 'hint', textContent: data.available ? t('No buses due') : t('No times right now') })]),
      );
    } catch (err) {
      if (err.message === 'signed out') return;
      rows.replaceChildren(el('div', { class: 'hint', textContent: navigator.onLine ? t('No times right now') : t('Live times need a connection.') }));
    }
    if (sheetRefresh && visible) sheetTimer = setTimeout(sheetRefresh, ARRIVALS_MS);
  };
  sheetRefresh();
}

/** Walking directions in the phone's maps app: Apple Maps on Apple devices, Google Maps elsewhere. */
function directions(s) {
  const apple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
  return apple
    ? `https://maps.apple.com/?daddr=${s.lat},${s.lon}&dirflg=w`
    : `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}&travelmode=walking`;
}

/* ---------- saving a stop as a place ---------- */

let profile = null;

async function markSaved(stop, button) {
  try {
    profile ??= await api('/me/profile');
  } catch {
    return;
  }
  const same = profile.places.find((p) => p.to === stop.code);
  if (same) {
    button.textContent = t('Saved as {0}', same.label);
    button.disabled = true;
  }
}

/** Adds the stop to the places (chips and widget), named as it's called. */
async function saveAsPlace(stop, button) {
  button.disabled = true;
  try {
    profile = await api('/me/profile');
    if (!profile.places.some((p) => p.to === stop.code)) {
      const label = stop.name.slice(0, 24);
      let key = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'place';
      while (profile.places.some((p) => p.key === key)) key = `${key.slice(0, 21)}-${Math.floor(Math.random() * 90 + 10)}`;
      profile.places.push({ key, label, to: stop.code });
      profile = await api('/me/profile', { method: 'PUT', body: profile });
      document.dispatchEvent(new CustomEvent('places-changed'));
    }
    markSaved(stop, button);
  } catch (err) {
    button.disabled = false;
    button.textContent = err.status === 400 ? t('Places are full: remove one in Settings') : t('Not saved. {0}', err.message);
  }
}
