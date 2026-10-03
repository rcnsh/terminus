// The Map tab: the campus's streets with the bus routes on them, a pill per
// service along the top, and the stops. A pill shows that service's line and
// its live buses; a stop shows what's coming, the services that call there,
// and ways to go there. Loaded the first time the tab is opened.
//
// MapLibre draws the map itself, so it's driven from here as it always was:
// the map, its layers and the buses' glides are plain functions below. What
// sits on top of it (the pills, the status line, the sheet for a stop or a
// bus) is drawn by Preact from the stores they share.
//
// Everything comes from our own domain: MapLibre and the PMTiles reader
// (vendor/, scripts/vendor-map.sh), the map file and its style, fonts and
// icons (/map/*), routes and stops (/campus), buses (/buses), arrivals
// (/arrivals). The service worker keeps all but the live ones for offline.

import { html, store, useEffect, useLayoutEffect, useRef, useState, useStore } from '/assets/ui.js';
import { inkOn, t } from '/account/dom.js';
import { loadCampus, profile, reloadProfile, saveNow, withPlace } from '/account/profile.js';

// "@" spelled %40: Cloudflare's static assets redirect the "@" form to it,
// which cost a round trip per file.
const MAPLIBRE = '/vendor/maplibre-gl%406.11.2/';
const PMTILES = '/vendor/pmtiles%404.5.0/pmtiles.mjs';
/** Live buses refresh this often while a pill is on (the API caches 5 s). */
const BUSES_MS = 5_000;
/** A stop's arrivals refresh this often while its sheet is open (cached 15 s). */
const ARRIVALS_MS = 15_000;
/** How long a bus takes to catch up with a new answer, which says where it
 *  is now and how fast it's going (speed, until): about one answer. */
const CATCH_MS = 5_000;
/** From an answer without a speed (an older API), how long a bus takes to
 *  glide to its new position: about as long as the feed holds one. */
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

/* ---------- what's on screen ---------- */

/** /campus, once loaded. */
const campusData = store(null);
/** The service whose pill is on, or null. */
const selected = store(null);
/** The line under the pills ("2 buses on A1"), or null. */
const status = store(null);
/** The open sheet: { stop: code } or { bus: id }, or null. */
const sheet = store(null);
/** Each bus as it last came from the API, by id (for its sheet). */
const shown = store(new Map());

let ml = null;
let map = null;
let visible = false;
let busTimer = null;
let watchId = null;
/** Each bus's glide, by id: from where it was drawn to where it is now. */
let glides = new Map();
let glide = null;
/** The whole-campus view, for the button back to it. */
let fit = null;

/** Dark as the page is: the theme chosen in Settings, or the device's (assets/theme.js). */
const dark = () => window.theme?.dark() ?? window.matchMedia('(prefers-color-scheme: dark)').matches;
const lang = () => (window.i18n?.lang === 'zh' ? 'zh' : 'en');
const styleUrl = () => `/map/style.json?theme=${dark() ? 'dark' : 'light'}&lang=${lang()}`;
const colorOf = (svc) => campusData.get()?.routes[svc]?.color ?? '#8a939c';
const svcVars = (svc) => `--svc:${colorOf(svc)};--svc-ink:${inkOn(colorOf(svc))}`;

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

/* ---------- the map ---------- */

async function build(container) {
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = `${MAPLIBRE}maplibre-gl.css`;
  document.head.append(css);
  const [maplibre, { Protocol }, data] = await Promise.all([import(`${MAPLIBRE}maplibre-gl.mjs`), import(PMTILES), loadCampus()]);
  ml = maplibre;
  campusData.set(data);
  ml.addProtocol('pmtiles', new Protocol({ metadata: true }).tile);

  const core = data.stops.filter((s) => s.core);
  fit = boundsOf(core.map((s) => [s.lon, s.lat]));
  map = new ml.Map({
    container,
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
        this.box = document.createElement('div');
        this.box.className = 'maplibregl-ctrl maplibregl-ctrl-group';
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'map-recentre';
        b.title = t('Back to campus');
        b.setAttribute('aria-label', t('Back to campus'));
        // A constant, never data.
        b.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/></svg>';
        b.onclick = () => map.fitBounds(fit, { padding: { top: 70, bottom: 30, left: 30, right: 30 }, duration: 600 });
        this.box.append(b);
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
  document.addEventListener('themechange', () => map.setStyle(styleUrl()));
  map.on('click', onClick);
  for (const layer of ['stops', 'stop-names', 'buses']) {
    map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
  }
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
      for (const s of campusData.get().stops) {
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

/** Stops everything that runs while the map is on screen. */
function hide() {
  visible = false;
  clearTimeout(busTimer);
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

function resume() {
  visible = true;
  map.resize();
  if (selected.get()) pollBuses();
  followMe();
}

/* ---------- layers ---------- */

const empty = { type: 'FeatureCollection', features: [] };

function addLayers() {
  const campus = campusData.get();
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
  const svc = selected.get();
  map.setFilter('route-on', ['==', ['get', 'svc'], svc ?? '']);
  map.setPaintProperty('routes', 'line-opacity', svc ? 0.18 : 0.9);
  map.setPaintProperty('route-casing', 'line-opacity', svc ? 0.3 : 0.9);
  // services is " A1 D2 ": spaces round each, so K never matches inside another code.
  const on = svc ? ['in', ` ${svc} `, ['get', 'services']] : true;
  map.setPaintProperty('stops', 'circle-opacity', svc ? ['case', on, 1, 0.35] : 1);
  map.setPaintProperty('stops', 'circle-stroke-opacity', svc ? ['case', on, 1, 0.35] : 1);
  map.setPaintProperty('stop-names', 'text-opacity', svc ? ['case', on, 1, 0.4] : 1);
}

/* ---------- live buses ---------- */

/** One service at a time: its line and buses, or none. */
function choose(svc) {
  selected.set(svc);
  clearTimeout(busTimer);
  cancelAnimationFrame(glide);
  shown.set(new Map());
  glides = new Map();
  drawBuses([]);
  highlight();
  status.set(null);
  if (!svc) return;
  map.fitBounds(boundsOf(campusData.get().routes[svc].line), { padding: { top: 80, bottom: 40, left: 40, right: 40 }, maxZoom: 16.5, duration: 600 });
  status.set(t('Finding {0} buses…', svc));
  pollBuses();
}

async function pollBuses() {
  clearTimeout(busTimer);
  const svc = selected.get();
  if (!svc || !visible) return;
  try {
    const data = await getJSON(`/buses?svc=${encodeURIComponent(svc)}`);
    if (svc !== selected.get()) return;
    if (!data.available) status.set(t('Live buses aren’t available right now.'));
    else if (!data.buses.length) status.set(t('No {0} buses running right now.', svc));
    else status.set(data.buses.length === 1 ? t('1 bus on {0}', svc) : t('{0} buses on {1}', data.buses.length, svc));
    moveTo(data.buses.map((b) => ({ ...b, svc, color: colorOf(svc) })));
  } catch (err) {
    if (err.message === 'signed out' || svc !== selected.get()) return;
    status.set(navigator.onLine ? t('Live buses aren’t available right now.') : t('Live buses need a connection.'));
  }
  // Not again once the map's tab is hidden while this one was on its way.
  if (visible && document.visibilityState === 'visible') busTimer = setTimeout(pollBuses, BUSES_MS);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && visible && selected.get()) pollBuses();
});

/**
 * Starts a glide for each bus whose position changed, from where it's drawn
 * to where it is: along its route line when both ends are on it, so it
 * follows the road round corners; straight only onto or off its line. The
 * API says where each bus is estimated to be now and how fast it's going,
 * so a bus keeps moving between answers, up to the place the answer says
 * it doesn't pass. A bus whose position hasn't changed keeps going.
 */
function moveTo(buses) {
  const now = performance.now();
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const path = pathOf(campusData.get()?.routes[selected.get()]?.line);
  shown.set(new Map(buses.map((b) => [b.id, b])));
  const next = new Map();
  for (const b of buses) {
    const g = glides.get(b.id);
    if (g && g.to.lat === b.lat && g.to.lon === b.lon) next.set(b.id, { ...g, to: b });
    else if (reduce) next.set(b.id, { from: null, to: b, start: now, path: null });
    else next.set(b.id, glideFrom(g ? positionAt(g, now) : null, b, path, now));
  }
  glides = next;
  cancelAnimationFrame(glide);
  const step = (ms) => {
    drawBuses(frameAt(ms));
    if ([...glides.values()].some((g) => moving(g, ms))) glide = requestAnimationFrame(step);
  };
  glide = requestAnimationFrame(step);
}

/** Whether glide [g]'s bus is still on its way at [now]. */
function moving(g, now) {
  if (g.from && now - g.start < (g.to.speed == null ? GLIDE_MS : CATCH_MS)) return true;
  return Boolean(g.path && g.to.speed > 0 && (g.to.speed * (now - g.start)) / 1000 < onFor(g.to));
}

/** Metres an answer's bus may go on along its line before the next answer. */
const onFor = (b) => (b.speed > 0 && b.until != null && b.along != null ? Math.max(0, b.until - b.along) : 0);

function frameAt(now) {
  return [...glides.values()].map((g) => positionAt(g, now));
}

/**
 * A glide for bus [b] from [from] (where it's drawn; null for a new bus),
 * or none: it jumps there. On its line at both ends, it only ever moves
 * along the line: a bus that can't glide along it (the other side of the
 * road, a long way) jumps rather than cut across. Straight only onto or off
 * its line, a short way.
 */
function glideFrom(from, b, path, now) {
  const jump = { from: null, to: b, start: now, path: b.along != null ? path : null };
  if (!from) return jump;
  const d = path && alongBy(path, from, b);
  if (d != null) return d < -HOLD_BACK_M ? jump : { from, to: b, start: now, path, d };
  if (from.along != null && b.along != null) return jump;
  if (haversine(from.lat, from.lon, b.lat, b.lon) > GLIDE_STRAIGHT_MAX_M) return jump;
  return { from, to: b, start: now, path: null, d: null };
}

/**
 * Where glide [g]'s bus is drawn at [now]. Its answer goes on at its speed
 * up to its until; the bus catches up with that over CATCH_MS, or, a little
 * ahead of it (the bus went slower than shown), waits for it.
 */
function positionAt(g, now) {
  // Metres the answer's bus has gone on since.
  const on = Math.min(onFor(g.to), ((g.to.speed ?? 0) * Math.max(0, now - g.start)) / 1000);
  if (!g.from) return g.path && on > 0 ? alongAt(g.path, g.to, g.to.along + on, true) : g.to;
  const k = Math.max(0, Math.min(1, (now - g.start) / (g.to.speed == null ? GLIDE_MS : CATCH_MS)));
  // Mid-glide straight, it's off the line: the next glide is straight too.
  if (g.d == null) return k === 1 ? g.to : { ...g.to, along: null, lat: g.from.lat + (g.to.lat - g.from.lat) * k, lon: g.from.lon + (g.to.lon - g.from.lon) * k };
  const target = g.d + on;
  const m = g.d >= 0 ? target * k : Math.max(0, target);
  return alongAt(g.path, g.to, g.from.along + m, m > 0);
}

/** Bus [b] drawn [m] metres along [path]; pointing along the road when it's going [forward]. */
function alongAt(path, b, m, forward) {
  const at = pointAt(path, m);
  const total = path.total;
  return { ...b, along: path.closed ? ((m % total) + total) % total : m, lat: at.lat, lon: at.lon, heading: forward ? at.bearing : b.heading };
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
  let lo = 0,
    hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= m) lo = mid;
    else hi = mid;
  }
  const [aLon, aLat] = line[lo];
  const [bLon, bLat] = line[hi];
  const seg = cum[hi] - cum[lo];
  const k = seg > 0 ? (m - cum[lo]) / seg : 0;
  return { lat: aLat + (bLat - aLat) * k, lon: aLon + (bLon - aLon) * k, bearing: bearing(aLat, aLon, bLat, bLon) };
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
  return (((Math.atan2(y, x) / r) % 360) + 360) % 360;
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

/* ---------- taps ---------- */

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
  if (!best) return sheet.set(null);
  sheet.set(best.f.layer.id === 'buses' ? { bus: best.f.properties.id } : { stop: best.f.properties.code });
}

/** Walking directions in the phone's maps app: Apple Maps on Apple devices, Google Maps elsewhere. */
function directions(s) {
  const apple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
  return apple ? `https://maps.apple.com/?daddr=${s.lat},${s.lon}&dirflg=w` : `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}&travelmode=walking`;
}

/* ---------- drawing ---------- */

const crowdWord = (c) => ({ low: t('Quiet'), medium: t('Filling'), high: t('Packed') })[c] ?? null;
const mins = (s) => Math.round(s / 60);
const when = (b) => (b.etaS < 60 ? t('Arriving') : b.quality === 'scheduled' ? t('~{0}', t('{0} min', mins(b.etaS))) : t('{0} min', mins(b.etaS)));

function SvcTag({ svc, onClick }) {
  return onClick
    ? html`<button type="button" class="svc-tag" style=${svcVars(svc)} aria-label=${t('Show {0} on the map', svc)} onClick=${onClick}>${svc}</button>`
    : html`<span class="svc-tag" style=${svcVars(svc)}>${svc}</span>`;
}

function Pills() {
  const campus = useStore(campusData);
  const svc = useStore(selected);
  if (!campus) return null;
  return html`
    <nav class="app-chips map-pills" aria-label=${t('Show a service and its buses')}>
      ${Object.keys(campus.routes)
        .sort()
        .map(
          (s) => html`
            <button type="button" key=${s} style=${svcVars(s)} aria-pressed=${String(s === svc)} aria-label=${t('{0}: show its line and live buses', s)} onClick=${() => choose(s === svc ? null : s)}>
              <span class="dot"></span>${s}
            </button>
          `,
        )}
    </nav>
  `;
}

function Status() {
  const text = useStore(status);
  return html`<div class="map-status" role="status" hidden=${!text}>${text ?? ''}</div>`;
}

/** The sheet's frame: the title, a line under it, and Close. */
function Frame({ title, sub, children, box }) {
  return html`
    <section class="map-sheet" aria-live="polite" ref=${box}>
      <div class="sheet-head">
        <div><h2>${title}</h2>${sub && html`<p class="hint">${sub}</p>`}</div>
        <button type="button" class="sheet-close" aria-label=${t('Close')} onClick=${() => sheet.set(null)}>×</button>
      </div>
      ${children}
    </section>
  `;
}

/** A bus: where it's going next and how full it is, following its updates while open. */
function BusSheet({ id, box }) {
  const buses = useStore(shown);
  const b = buses.get(id);
  useEffect(() => {
    if (!b) sheet.set(null);
  }, [b]);
  if (!b) return null;
  return html`
    <${Frame} title=${t('{0} bus', b.svc)} sub=${b.moving ? null : t('Stopped')} box=${box}>
      <div class="sheet-rows">
        <div class="sheet-row"><span>${t('Next stop')}</span><span class="when">${b.nextStop?.name ?? t('Not on its route right now')}</span></div>
        ${b.crowd && html`<div class="sheet-row"><span>${t('How full')}</span><span class="when">${crowdWord(b.crowd)}</span></div>`}
      </div>
    <//>
  `;
}

/** A stop: what's coming (refreshed while open), its services, and ways to go there. */
function StopSheet({ code, box, onGoTo, onSaved, active }) {
  const campus = useStore(campusData);
  const p = useStore(profile);
  const stop = campus?.stops.find((s) => s.code === code);
  const [board, setBoard] = useState(null);
  const [saveMsg, setSaveMsg] = useState(null);
  const [saving, setSaving] = useState(false);

  // Fresh each time: a favourite may have been added or removed elsewhere since.
  useEffect(() => {
    setSaveMsg(null);
    reloadProfile().catch(() => {});
  }, [code]);

  useEffect(() => {
    setBoard(null);
    if (!active) return;
    let timer = null;
    let gone = false;
    const load = async () => {
      try {
        const data = await getJSON(`/arrivals?stop=${encodeURIComponent(code)}`);
        if (gone) return;
        const list = data.available ? data.board.filter((b) => b.etaS !== null) : [];
        setBoard(list.length ? { list } : { text: data.available ? t('No buses due') : t('No times right now') });
      } catch (err) {
        if (gone || err.message === 'signed out') return;
        setBoard({ text: navigator.onLine ? t('No times right now') : t('Live times need a connection.') });
      }
      if (!gone) timer = setTimeout(load, ARRIVALS_MS);
    };
    load();
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [code, active]);

  if (!stop) return null;
  const same = p?.places.find((x) => x.to === stop.code);
  // Adds the stop to the places (chips and widget), named as it's called.
  const save = async () => {
    setSaving(true);
    try {
      if (!profile.get()) await reloadProfile();
      await saveNow((x) => withPlace(x, stop.code, stop.name));
      onSaved?.();
    } catch (err) {
      setSaveMsg(err.status === 400 ? t("You've reached the limit of saved places. Remove one in Settings to add another.") : t('Not saved. {0}', err.message));
    } finally {
      setSaving(false);
    }
  };
  return html`
    <${Frame} title=${stop.name} box=${box}>
      <div class="sheet-rows">
        ${!board && html`<div class="hint">${t('Checking…')}</div>`}
        ${board?.text && html`<div class="hint">${board.text}</div>`}
        ${board?.list?.map(
          (b) => html`
            <div class="sheet-row" key=${`${b.svc}-${b.etaS}`}>
              <${SvcTag} svc=${b.svc} />
              <span class="when">${when(b)}${b.crowd && html`<span class="crowd">${crowdWord(b.crowd)}</span>`}</span>
            </div>
          `,
        )}
      </div>
      <p class="sheet-label">${t('Services here')}</p>
      <div class="svc-tags">${stop.services.map((svc) => html`<${SvcTag} svc=${svc} key=${svc} onClick=${() => choose(svc)} />`)}</div>
      <div class="sheet-actions">
        <button type="button" class="btn small accent" onClick=${() => onGoTo({ code: stop.code, name: stop.name, place: same?.key ?? null })}>${t('Go there')}</button>
        <a class="btn small ghost" href=${directions(stop)} target="_blank" rel="noopener">${t('Walking directions')}</a>
        <button type="button" class="btn small ghost" disabled=${Boolean(same) || saving} onClick=${save}>${same ? t('Saved as {0}', same.label) : (saveMsg ?? t('Save as place'))}</button>
      </div>
    <//>
  `;
}

/**
 * The Map tab. `visible`: its tab is on screen (the map pauses otherwise).
 * `focus`: a stop to open, centred above its sheet (from Nearby); `onFocused`
 * says it's done. `onGoTo` takes Go there to Now; `onSaved` follows a stop
 * saved as a place.
 */
export function MapTab({ visible: on, focus, onFocused, onGoTo, onSaved }) {
  const container = useRef(null);
  const sheetBox = useRef(null);
  const open = useStore(sheet);
  const [state, setState] = useState(map ? 'ready' : 'idle');

  // Built the first time it's on screen, paused while another tab is.
  useEffect(() => {
    if (!on) return hide();
    if (map) return resume();
    visible = true;
    setState('loading');
    build(container.current)
      .then(() => setState('ready'))
      .catch((err) => setState(err.message === 'signed out' ? 'idle' : 'failed'));
  }, [on]);

  // A stop opened from elsewhere: its sheet, then the map centred in what the sheet leaves uncovered.
  useEffect(() => {
    if (!focus || state !== 'ready') return;
    sheet.set({ stop: focus });
    onFocused?.();
  }, [focus, state]);
  const centring = useRef(null);
  if (focus && state === 'ready') centring.current = focus;
  useLayoutEffect(() => {
    const code = centring.current;
    const stop = code && campusData.get()?.stops.find((s) => s.code === code);
    if (!stop || open?.stop !== code) return;
    centring.current = null;
    const go = () => map.easeTo({ center: [stop.lon, stop.lat], zoom: Math.max(map.getZoom(), 17), padding: { top: 70, bottom: (sheetBox.current?.offsetHeight ?? 0) + 20 }, duration: 600 });
    if (map.loaded()) go();
    else map.once('load', go);
  }, [open]);

  return html`
    <div id="map" class="map" role="region" aria-label=${t('Campus map')} ref=${container}>
      ${state === 'failed' && html`<p class="map-empty hint">${t('The map needs a connection the first time.')}</p>`}
    </div>
    <div class="map-top">
      <${Pills} />
      <${Status} />
    </div>
    ${open?.stop && html`<${StopSheet} code=${open.stop} box=${sheetBox} onGoTo=${onGoTo} onSaved=${onSaved} active=${on} />`}
    ${open?.bus && html`<${BusSheet} id=${open.bus} box=${sheetBox} />`}
  `;
}
