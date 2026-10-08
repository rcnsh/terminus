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

import { Icon, focusSoon, html, reducedMotion, store, useEffect, useLayoutEffect, useMemo, useRef, useState, useStore } from '/assets/ui.js';
import { inkOn, send, t } from '/account/dom.js';
import { haversineM, loadCampus, profile, reloadProfile, saveNow, withPlace } from '/account/profile.js';
import { MAPLIBRE, PMTILES } from '/app/map-files.js';
import { Row } from '/app/board.js';

/** Live buses refresh this often while a pill is on (the API caches 5 s). */
const BUSES_MS = 5_000;
/** A stop's arrivals refresh this often while its sheet is open (cached 15 s). */
const ARRIVALS_MS = 15_000;
/** How long a bus takes to slide [m] metres along the road: a steady 100 m
 *  a second, so a longer stretch takes longer, from 1 s for a short hop to
 *  4 s, done before the next answer (every 5 s). As the Android app. */
const slideMs = (m) => Math.max(1_000, Math.min(4_000, (m / 100) * 1_000));
/** Further than this along its line in one answer (back from a hidden tab),
 *  a bus jumps instead of sliding. */
const SLIDE_MAX_M = 1_500;
/** No answer for longer than this (the screen was off, the tab hidden, the
 *  connection lost): every bus jumps to where it is now. */
const STALE_MS = 15_000;
/** A poll for the buses gives up after this long, so the next one can go. */
const BUSES_TIMEOUT_MS = 10_000;
/** A bus at a stop is drawn this far beside the dot, to its left (the kerb:
 *  buses drive on the left), and each one behind it this much further back
 *  along the road: pixels at full size (zoom 17), smaller zoomed out. */
const AT_STOP_SIDE_PX = 22;
const AT_STOP_STEP_PX = 26;
/** Further than this from campus, the map opens on campus, not on you. */
const NEAR_CAMPUS_M = 3_000;
/** The map file's extent (MAP_BOUNDS in apps/api/src/map.ts). */
const BOUNDS = [[103.755, 1.28], [103.83, 1.332]];
/** Room round the whole campus, clear of the pills along the top. */
const CAMPUS_PADDING = { top: 70, bottom: 30, left: 30, right: 30 };

/* ---------- what's on screen ---------- */

/** /campus, once loaded. */
const campusData = store(null);
/** The service whose pill is on, or null. */
const selected = store(null);
/** The line under the pills ("2 buses on A1"), or null. */
const status = store(null);
/** The open sheet: { stop: code } or { bus: id }, or null. */
const sheet = store(null);
/** What had the focus when the sheet opened, for it to go back to when the sheet closes. */
let opener = null;
/** A stop to centre in what its sheet leaves uncovered, once the sheet is drawn. */
let centreOn = null;

/** Opens `what` ({ stop } or { bus }) in the sheet, or closes it (null). */
function openSheet(what) {
  const was = sheet.get();
  if (what && !was) {
    const f = document.activeElement;
    opener = f && f !== document.body && !f.closest('.map-sheet') ? f : null;
  }
  sheet.set(what);
  // Closed: focus back where it was (a stop in the list, the map), else the map.
  if (!what && was) {
    const back = opener;
    opener = null;
    focusSoon(() => (back?.isConnected ? back : (document.getElementById('map-stops') ?? map?.getCanvas())));
  }
}

/** A stop opened from elsewhere (Nearby, the list of stops): its sheet, the map centred on it above the sheet. */
function showStop(code) {
  centreOn = code;
  openSheet({ stop: code });
}
/** Each bus as it last came from the API, by id (for its sheet). */
const shown = store(new Map());

let ml = null;
let map = null;
let visible = false;
let busTimer = null;
let watchId = null;
/** Each bus's slide, by id: from where it was drawn to where it is now. */
let glides = new Map();
/** When the last answer came (Date.now(), which counts a device's sleep,
 *  unlike performance.now() in some browsers), to tell a stale map. */
let lastAnswer = -Infinity;
/** The last answer's buses are last-known places (the feed didn't answer): drawn faded. */
let dimmed = false;
let glide = null;
/** The whole-campus view, for the button back to it. */
let fit = null;

/** Dark as the page is: the theme chosen in Settings, or the device's (assets/theme.js). */
const dark = () => window.theme?.dark() ?? window.matchMedia('(prefers-color-scheme: dark)').matches;
const lang = () => (window.i18n?.lang === 'zh' ? 'zh' : 'en');
const styleUrl = () => `/map/style.json?theme=${dark() ? 'dark' : 'light'}&lang=${lang()}`;
/** The page's ink and paper, for what's drawn over the street map. */
const pageInk = () => (dark() ? '#f2efeb' : '#1c1917');
const pagePaper = () => (dark() ? '#1a1816' : '#ffffff');
/**
 * The edge round a route line and a bus: on the light street map a dark
 * one, so a pale line (A2's yellow, K's blue) still stands out from the
 * streets at 3:1; on the dark map the page's own colour does that.
 */
const edgeOf = () => (dark() ? pagePaper() : '#57534e');
const colorOf = (svc) => campusData.get()?.routes[svc]?.color ?? '#8a939c';
const svcVars = (svc) => `--svc:${colorOf(svc)};--svc-ink:${inkOn(colorOf(svc))}`;

async function getJSON(path, timeoutMs) {
  const res = await send(path, { credentials: 'same-origin', headers: { 'accept-language': window.i18n?.header ?? 'en' }, timeoutMs });
  if (res.status === 401) {
    location.replace('/account/?next=/app/');
    throw new Error('signed out');
  }
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
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
    fitBoundsOptions: { padding: CAMPUS_PADDING },
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
        b.onclick = () => map.fitBounds(fit, { padding: CAMPUS_PADDING, duration: 600 });
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
        const d = haversineM(lat, lon, s.lat, s.lon);
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
  const ink = pageInk();
  const paper = pagePaper();
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
  map.addSource('stretch', { type: 'geojson', data: empty });

  const width = ['interpolate', ['linear'], ['zoom'], 13, 1.5, 16, 4, 18, 7];
  map.addLayer({ id: 'route-casing', type: 'line', source: 'routes', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': edgeOf(), 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 3, 16, 7, 18, 11], 'line-opacity': 0.9 } });
  map.addLayer({ id: 'routes', type: 'line', source: 'routes', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': width } });
  // The chosen service, drawn again on top of the others.
  map.addLayer({ id: 'route-on', type: 'line', source: 'routes', filter: ['==', ['get', 'svc'], ''], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 3, 16, 6, 18, 9] } });
  // A tapped bus's stretch between two stops, the part of the route it's somewhere on.
  map.addLayer({ id: 'stretch-casing', type: 'line', source: 'stretch', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': paper, 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 7, 16, 13, 18, 18] } });
  map.addLayer({ id: 'stretch', type: 'line', source: 'stretch', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 5, 16, 9, 18, 13] } });
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
      // Below the dot, or another side of it when a bus is there.
      'text-variable-anchor': ['top', 'bottom', 'right', 'left'],
      'text-radial-offset': 0.9,
      'text-optional': true,
      'text-max-width': 8,
    },
    paint: { 'text-color': ink, 'text-halo-color': paper, 'text-halo-width': 1.5 },
  });
  map.addLayer({ id: 'me-halo', type: 'circle', source: 'me', paint: { 'circle-radius': 14, 'circle-color': '#2b7bf3', 'circle-opacity': 0.18 } });
  map.addLayer({ id: 'me', type: 'circle', source: 'me', paint: { 'circle-radius': 6.5, 'circle-color': '#2b7bf3', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } });
  if (!map.hasImage('heading')) map.addImage('heading', arrow('#ffffff'), { pixelRatio: 2 });
  paintBus();
  // Icons, not circles, so a bus at a stop can sit beside the dot: a
  // symbol's offset is per bus, in pixels, and turns with the road.
  const bus = (id, image) => ({
    id,
    type: 'symbol',
    source: 'buses',
    layout: {
      'icon-image': image,
      'icon-size': BUS_SIZE,
      'icon-rotate': ['get', 'heading'],
      'icon-rotation-alignment': 'map',
      'icon-offset': ['get', 'offset'],
      'icon-allow-overlap': true,
      // Stop names keep clear of buses (they move to another side of their dot).
      'icon-ignore-placement': image !== 'bus',
    },
  });
  map.addLayer({ ...bus('bus-on', 'bus-on'), filter: ['==', ['get', 'id'], ''] });
  map.addLayer(bus('buses', 'bus'));
  map.addLayer(bus('bus-heading', 'heading'));
  highlight();
  dim(dimmed);
  markOpen(openBus);
  drawBuses(frameAt(performance.now()));
}

/** How big a bus is drawn: full size from zoom 17, smaller zoomed out. */
const BUS_SIZE = ['interpolate', ['linear'], ['zoom'], 13, 0.64, 17, 1];
const busSize = (zoom) => Math.max(0.64, Math.min(1, 0.64 + ((zoom - 13) * 0.36) / 4));

/** The bus icon in the chosen service's colour, ringed in the page's: one
 *  service's buses are shown at a time. */
function paintBus() {
  const paper = pagePaper();
  const color = colorOf(selected.get());
  // At 2 pixels a point: 11 across the disc, with a 2.5 ring, and on the
  // light map a thin dark edge round that, so the white ring shows on pale streets.
  const size = 60;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  for (const [r, fill] of [...(dark() ? [] : [[29.5, edgeOf()]]), [27, paper], [22, color]]) {
    g.fillStyle = fill;
    g.beginPath();
    g.arc(size / 2, size / 2, r, 0, Math.PI * 2);
    g.fill();
  }
  const image = g.getImageData(0, 0, size, size);
  if (map.hasImage('bus')) map.updateImage('bus', image);
  else map.addImage('bus', image, { pixelRatio: 2 });
  // The tapped bus: a ring in the page's ink round it, a little way out.
  const ringSize = 80;
  const rc = document.createElement('canvas');
  rc.width = rc.height = ringSize;
  const rg = rc.getContext('2d');
  rg.strokeStyle = pageInk();
  rg.lineWidth = 5;
  rg.beginPath();
  rg.arc(ringSize / 2, ringSize / 2, 33, 0, Math.PI * 2);
  rg.stroke();
  const ring = rg.getImageData(0, 0, ringSize, ringSize);
  if (map.hasImage('bus-on')) map.updateImage('bus-on', ring);
  else map.addImage('bus-on', ring, { pixelRatio: 2 });
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

/** Buses at their last-known places, faded so they don't pass for live; or back to full. */
function dim(on) {
  dimmed = on;
  if (!map?.getLayer('buses')) return;
  for (const id of ['buses', 'bus-heading', 'bus-on']) map.setPaintProperty(id, 'icon-opacity', on ? 0.4 : 1);
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
  dim(false);
  highlight();
  if (map) paintBus();
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
    // The next poll waits for this one: a call that hangs would stop the map, so it's given up on.
    const data = await getJSON(`/buses?svc=${encodeURIComponent(svc)}`, BUSES_TIMEOUT_MS);
    if (svc !== selected.get()) return;
    // `stale`: the feed didn't answer, and these are where the buses last were.
    const old = data.available && data.stale === true;
    if (!data.available) status.set(t('Live buses aren’t available right now.'));
    else if (old) status.set(t('Bus positions may be out of date'));
    else if (!data.buses.length) status.set(t('No {0} buses running right now.', svc));
    else status.set(data.buses.length === 1 ? t('1 bus on {0}', svc) : t('{0} buses on {1}', data.buses.length, svc));
    dim(old);
    moveTo(data.buses.map((b) => ({ ...b, svc, color: colorOf(svc) })));
  } catch (err) {
    if (err.message === 'signed out' || svc !== selected.get()) return;
    status.set(navigator.onLine ? t('Live buses aren’t available right now.') : t('Live buses need a connection.'));
    // The buses drawn are from the last answer: faded once that's old, so they don't pass for live.
    if (Date.now() - lastAnswer > STALE_MS) dim(true);
  }
  // Not again once the map's tab is hidden while this one was on its way.
  if (visible && document.visibilityState === 'visible') busTimer = setTimeout(pollBuses, BUSES_MS);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && visible && selected.get()) pollBuses();
});

/**
 * Slides each bus whose place changed from where it's drawn to its new
 * place, along its route line, so it follows the road round corners. One
 * that can't get there along the line (behind it, or a long way on) jumps,
 * and so does every bus with reduced motion or after a while without an
 * answer.
 */
function moveTo(buses) {
  // Animation frames are timed by performance.now(); how long since the last
  // answer by the wall clock, which keeps counting while the device sleeps.
  const now = performance.now();
  const wall = Date.now();
  const stale = wall - lastAnswer > STALE_MS;
  lastAnswer = wall;
  const reduce = reducedMotion();
  const path = pathOf(campusData.get()?.routes[selected.get()]?.line);
  shown.set(new Map(buses.map((b) => [b.id, b])));
  const next = new Map();
  for (const raw of buses) {
    const b = { ...raw, offset: raw.at ? [-AT_STOP_SIDE_PX, AT_STOP_STEP_PX * raw.slot] : [0, 0] };
    const g = glides.get(b.id);
    const from = g ? positionAt(g, now) : null;
    const d = !reduce && !stale && from && path ? aheadBy(path, from, b) : null;
    next.set(b.id, d ? { from, to: b, start: now, path, d, ms: slideMs(d) } : { from: null, to: b, start: now });
  }
  glides = next;
  cancelAnimationFrame(glide);
  const step = (ms) => {
    drawBuses(frameAt(ms));
    if ([...glides.values()].some((g) => g.from && ms - g.start < g.ms)) glide = requestAnimationFrame(step);
  };
  glide = requestAnimationFrame(step);
}

function frameAt(now) {
  return [...glides.values()].map((g) => positionAt(g, now));
}

/**
 * Where slide [g]'s bus is drawn at [now]: along the line from its old place
 * to its new one, easing in and out. Its old and new places may be beside the
 * line (a stop's dot, and beside it), so it moves from one to the other as
 * it goes.
 */
function positionAt(g, now) {
  if (!g.from) return g.to;
  const k = Math.max(0, Math.min(1, (now - g.start) / g.ms));
  if (k === 1) return g.to;
  const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
  const { from, to, path, d } = g;
  const at = pointAt(path, from.along + d * e);
  const [a, b] = [pointAt(path, from.along), pointAt(path, to.along)];
  return {
    ...to,
    along: path.closed ? (((from.along + d * e) % path.total) + path.total) % path.total : from.along + d * e,
    lat: at.lat + (from.lat - a.lat) * (1 - e) + (to.lat - b.lat) * e,
    lon: at.lon + (from.lon - a.lon) * (1 - e) + (to.lon - b.lon) * e,
    heading: at.bearing,
    offset: [from.offset[0] + (to.offset[0] - from.offset[0]) * e, from.offset[1] + (to.offset[1] - from.offset[1]) * e],
  };
}

/* A route line measured as the API measures it (haversine, metres from its
   start at each point), so a bus's `along` is a place on it. */

const paths = new WeakMap();

function pathOf(line) {
  if (!line || line.length < 2) return null;
  let p = paths.get(line);
  if (!p) {
    const cum = [0];
    for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + haversineM(line[i - 1][1], line[i - 1][0], line[i][1], line[i][0]));
    const total = cum[cum.length - 1];
    const [a, z] = [line[0], line[line.length - 1]];
    p = { line, cum, total, closed: haversineM(a[1], a[0], z[1], z[0]) < 5 };
    paths.set(line, p);
  }
  return p;
}

/** Metres on along [path] from bus [f] to bus [b], round a loop past its
 *  start; null when it isn't on ahead (the same place, behind, a long way,
 *  or a line kept from before the route changed). */
function aheadBy(path, f, b) {
  if (f.along == null || b.along == null || path.total <= 0 || f.along > path.total + 1 || b.along > path.total + 1) return null;
  let d = b.along - f.along;
  if (path.closed && d < -path.total / 2) d += path.total;
  return d > 0 && d <= SLIDE_MAX_M ? d : null;
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

function bearing(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180;
  const y = Math.sin((bLon - aLon) * r) * Math.cos(bLat * r);
  const x = Math.cos(aLat * r) * Math.sin(bLat * r) - Math.sin(aLat * r) * Math.cos(bLat * r) * Math.cos((bLon - aLon) * r);
  return (((Math.atan2(y, x) / r) % 360) + 360) % 360;
}

/** The bus whose card is open, or null. */
let openBus = null;

/**
 * Bus [b], whose card is open, ringed; between stops, its stretch drawn over
 * its route, with the rest of the route stepping well back. Its midpoint can
 * be a long way from the bus, so the whole stretch is where it is. Null
 * clears both.
 */
function markOpen(b) {
  openBus = b;
  if (!map?.getSource('stretch')) return;
  map.setFilter('bus-on', ['==', ['get', 'id'], b?.id ?? '']);
  const path = b?.stretch && pathOf(campusData.get()?.routes[b.svc]?.line);
  const line = path ? sliceOf(path, b.stretch.from, b.stretch.to) : null;
  map.getSource('stretch').setData(line ? { type: 'Feature', properties: { color: b.color }, geometry: { type: 'LineString', coordinates: line } } : empty);
  map.setPaintProperty('route-on', 'line-opacity', line ? 0.2 : 1);
}

/** The part of [path] from [a] to [b] metres along it, as [lon, lat] points. */
function sliceOf(path, a, b) {
  if (!(b > a) || a < 0 || b > path.total + 1) return null;
  const end = (m) => {
    const p = pointAt(path, Math.min(m, path.total));
    return [p.lon, p.lat];
  };
  const inner = path.line.filter((_, i) => path.cum[i] > a && path.cum[i] < b);
  return [end(a), ...inner, end(b)];
}

function drawBuses(buses) {
  map?.getSource('buses')?.setData({
    type: 'FeatureCollection',
    features: buses.map((b) => ({
      type: 'Feature',
      properties: { id: b.id, svc: b.svc, color: b.color, heading: b.heading ?? 0, offset: b.offset ?? [0, 0] },
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
    const p = f.layer.id === 'buses' ? drawnAt(f) : map.project(f.geometry.coordinates);
    // A bus wins over a stop under it.
    const d = Math.hypot(p.x - e.point.x, p.y - e.point.y) - (f.layer.id === 'buses' ? 12 : 0);
    if (d <= r && (!best || d < best.d)) best = { f, d };
  }
  // A stop's name, tapped on (not just near), is the stop, after any dot.
  if (!best) {
    const [name] = map.queryRenderedFeatures(around(4), { layers: ['stop-names'] });
    if (name) best = { f: name };
  }
  if (!best) return openSheet(null);
  openSheet(best.f.layer.id === 'buses' ? { bus: best.f.properties.id } : { stop: best.f.properties.code });
}

/** Where bus feature [f] is drawn on screen: its point, moved by its offset
 *  (turned with the road, and sized with the bus). */
function drawnAt(f) {
  const p = map.project(f.geometry.coordinates);
  // Arrays come back from the map as JSON text.
  const o = f.properties.offset;
  const [ox, oy] = typeof o === 'string' ? JSON.parse(o) : (o ?? [0, 0]);
  const k = busSize(map.getZoom());
  const r = ((f.properties.heading - map.getBearing()) * Math.PI) / 180;
  return { x: p.x + k * (ox * Math.cos(r) - oy * Math.sin(r)), y: p.y + k * (ox * Math.sin(r) + oy * Math.cos(r)) };
}

/** Walking directions in the phone's maps app: Apple Maps on Apple devices, Google Maps elsewhere. */
function directions(s) {
  const apple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
  return apple ? `https://maps.apple.com/?daddr=${s.lat},${s.lon}&dirflg=w` : `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}&travelmode=walking`;
}

/* ---------- drawing ---------- */

/** How crowded a bus is, as the feed says: low, medium or high. */
const crowdWord = (c) => ({ low: t('Low'), medium: t('Medium'), high: t('High') })[c] ?? null;

/** A service here, when there are no times to list it by: tapped, its line on the map. */
const SvcTag = ({ svc, onClick }) => html`<button type="button" class="svc-tag" style=${svcVars(svc)} aria-label=${t('Show {0} on the map', svc)} onClick=${onClick}>${svc}</button>`;

function Pills() {
  const campus = useStore(campusData);
  const svc = useStore(selected);
  if (!campus) return null;
  return html`
    <div class="app-chips map-pills" role="group" aria-label=${t('Show a service and its buses')}>
      ${Object.keys(campus.routes)
        .sort()
        .map(
          (s) => html`
            <button type="button" key=${s} style=${svcVars(s)} aria-pressed=${String(s === svc)} aria-label=${t('{0}: show its line and live buses', s)} onClick=${() => choose(s === svc ? null : s)}>
              <span class="dot"></span>${s}
            </button>
          `,
        )}
    </div>
  `;
}

/**
 * The map's stops as a list, for a keyboard or a screen reader: a stop picked
 * and then Open (or Enter) opens its sheet, as tapping it on the map does.
 * Not on picking alone: on Windows and Linux the arrow keys pick as they
 * move through the list. Seen only while it has the focus; the Buses tab has
 * every stop and bus in words too.
 */
function StopList() {
  const campus = useStore(campusData);
  const [code, setCode] = useState('');
  const stops = useMemo(() => [...(campus?.stops ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [campus]);
  if (!campus) return null;
  const open = () => code && showStop(code);
  return html`
    <form
      class="map-stops"
      onSubmit=${(e) => {
        e.preventDefault();
        open();
      }}
    >
      <label class="sr-only" for="map-stops">${t('Stops on this map')}</label>
      <select
        id="map-stops"
        value=${code}
        onChange=${(e) => setCode(e.currentTarget.value)}
        onKeyDown=${(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          open();
        }}
      >
        <option value="">${t('Open a stop…')}</option>
        ${stops.map((x) => html`<option value=${x.code} key=${x.code}>${x.name}</option>`)}
      </select>
      <button type="submit" class="btn">${t('Open')}</button>
    </form>
    <p class="sr-only">${t('The Buses tab lists every stop and its buses in words.')}</p>
  `;
}

function Status() {
  const text = useStore(status);
  return html`<div class="map-status" role="status" hidden=${!text}>${text ?? ''}</div>`;
}

/**
 * The sheet's frame: the title, a line under it, and Close. Opened, the focus
 * is on its title (`id` changes with what it's about); Escape closes it.
 */
function Frame({ id, title, sub, children, box }) {
  const head = useRef(null);
  useEffect(() => {
    head.current?.focus({ preventScroll: true });
  }, [id]);
  // How tall it is, for the map's buttons to sit above it on a phone (app.css).
  useLayoutEffect(() => {
    const el = box.current;
    const tab = el?.closest('.map-tab');
    if (!tab) return;
    const sized = new ResizeObserver(() => tab.style.setProperty('--sheet-h', `${el.offsetHeight}px`));
    sized.observe(el);
    return () => {
      sized.disconnect();
      tab.style.removeProperty('--sheet-h');
    };
  }, []);
  return html`
    <section
      class="map-sheet"
      aria-labelledby="sheet-title"
      ref=${box}
      onKeyDown=${(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        openSheet(null);
      }}
    >
      <div class="sheet-head">
        <div><h2 id="sheet-title" tabindex="-1" ref=${head}>${title}</h2>${sub && html`<p class="hint">${sub}</p>`}</div>
        <button type="button" class="sheet-close" aria-label=${t('Close')} onClick=${() => openSheet(null)}>×</button>
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
    if (!b) openSheet(null);
  }, [b]);
  useEffect(() => {
    markOpen(b ?? null);
  }, [b?.id, b?.stretch?.from, b?.stretch?.to, b?.svc]);
  useEffect(() => () => markOpen(null), []);
  if (!b) return null;
  return html`
    <${Frame} id=${`bus-${id}`} title=${html`${t('{0} bus', b.svc)}${b.plate && html` <span class="plate">${b.plate}</span>`}`} sub=${b.at ? t('At {0}', b.at.name) : b.stretch && b.nextStop ? t('Between {0} and {1}', b.stretch.last.name, b.nextStop.name) : null} box=${box}>
      <div class="sheet-rows">
        ${b.nextStop && html`<div class="sheet-row"><span>${t('Next stop')}</span><span class="when">${b.nextStop.name}</span></div>`}
        ${b.crowd && html`<div class="sheet-row"><span>${t('Crowding')}</span><span class="when">${crowdWord(b.crowd)}</span></div>`}
      </div>
    <//>
  `;
}

/** The rows a stop's sheet shows before "Show more", so the map stays in view. */
const PEEK_ROWS = 3;
const WALKER = '<circle cx="13" cy="4" r="2" fill="currentColor"/><path d="M12 8l-2 6-3 7M10 14l3 3v4M7 12l2-4h3l2 3 3 1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
const STAR = '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>';

/**
 * A stop: its board as the Buses tab has it (refreshed while open), the first
 * few rows until asked for the rest, and ways to go there. A row tapped shows
 * its service on the map.
 */
function StopSheet({ code, box, onGoTo, onSaved, active }) {
  const campus = useStore(campusData);
  const p = useStore(profile);
  const stop = campus?.stops.find((s) => s.code === code);
  const [board, setBoard] = useState(null);
  const [all, setAll] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [saving, setSaving] = useState(false);
  // The profile has been asked for (it may still fail): until then, which buses to ask for isn't known.
  const [asked, setAsked] = useState(false);

  // Fresh each time: a favourite may have been added or removed elsewhere since.
  useEffect(() => {
    setSaveMsg(null);
    setAll(false);
    reloadProfile()
      .catch(() => {})
      .finally(() => setAsked(true));
  }, [code]);

  // The public buses there too when the account has them on, as the Buses tab.
  const pub = p?.publicBuses === true;
  const known = Boolean(p) || asked;
  useEffect(() => {
    setBoard(null);
    if (!active || !known) return;
    let timer = null;
    let gone = false;
    // Paused while the page is hidden, as the buses are; fetched again when it's back.
    const again = () => {
      clearTimeout(timer);
      if (!gone && !document.hidden) timer = setTimeout(load, ARRIVALS_MS);
    };
    const back = () => {
      clearTimeout(timer);
      if (!gone && !document.hidden) load();
    };
    const load = async () => {
      try {
        // stopped=1: the services not running now too, greyed, so every service here has its row.
        const data = await getJSON(`/arrivals?stop=${encodeURIComponent(code)}${pub ? '&public=1' : ''}&stopped=1`);
        if (gone) return;
        const list = data.available ? data.board : [];
        setBoard(list.length ? { list } : { text: data.available ? t('No buses due') : t('No times right now') });
      } catch (err) {
        if (gone || err.message === 'signed out') return;
        setBoard({ text: navigator.onLine ? t('No times right now') : t('Live times need a connection.') });
      }
      again();
    };
    load();
    document.addEventListener('visibilitychange', back);
    return () => {
      gone = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', back);
    };
  }, [code, active, pub, known]);

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
      // The server's own words when it answered; the browser's ("Failed to fetch") aren't for people.
      setSaveMsg(
        err.status === 400
          ? t("You can't add more favourites. Remove one in Settings first.")
          : err.status
            ? t('Not saved. {0}', err.message)
            : t('Not saved. Check your connection.'),
      );
    } finally {
      setSaving(false);
    }
  };
  const rows = board?.list ?? [];
  const more = rows.length - PEEK_ROWS;
  const sub = stop.longName && stop.longName !== stop.name ? stop.longName : null;
  return html`
    <${Frame} id=${`stop-${code}`} title=${stop.name} sub=${sub} box=${box}>
      ${!board && html`<div class="hint">${t('Checking…')}</div>`}
      ${board?.text && html`<div class="hint">${board.text}</div>`}
      ${rows.length > 0 &&
      html`
        <div class="sheet-board" id="sheet-board">
          ${(all || more <= 1 ? rows : rows.slice(0, PEEK_ROWS)).map((r) => html`<${Row} key=${r.svc} r=${r} onPick=${choose} />`)}
        </div>
        ${more > 1 && html`<button type="button" class="sheet-more" aria-expanded=${String(all)} aria-controls="sheet-board" onClick=${() => setAll(!all)}>${all ? t('Show fewer') : t('Show {0} more', more)}</button>`}
      `}
      ${board?.text && html`<div class="svc-tags">${stop.services.map((svc) => html`<${SvcTag} svc=${svc} key=${svc} onClick=${() => choose(svc)} />`)}</div>`}
      <div class="sheet-actions">
        <button type="button" class="btn small accent" onClick=${() => onGoTo({ code: stop.code, name: stop.name, place: same?.key ?? null })}>${t('Go there')}</button>
        <a class="btn small ghost icon" href=${directions(stop)} target="_blank" rel="noopener" aria-label=${t('Walking directions')} title=${t('Walking directions')}><${Icon} paths=${WALKER} /></a>
        <button type="button" class=${`btn small ghost icon${same ? ' on' : ''}`} disabled=${Boolean(same) || saving} onClick=${save} aria-label=${same ? t('In your favourites') : t('Add to favourites')} title=${same ? t('In your favourites') : t('Add to favourites')}><${Icon} paths=${STAR} /></button>
      </div>
      ${saveMsg && html`<p class="hint" role="alert">${saveMsg}</p>`}
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
    showStop(focus);
    onFocused?.();
  }, [focus, state]);
  useLayoutEffect(() => {
    const code = centreOn;
    const stop = code && campusData.get()?.stops.find((s) => s.code === code);
    if (!stop || open?.stop !== code || !map) return;
    centreOn = null;
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
      <${StopList} />
      <${Status} />
    </div>
    ${open?.stop && html`<${StopSheet} code=${open.stop} box=${sheetBox} onGoTo=${onGoTo} onSaved=${onSaved} active=${on} />`}
    ${open?.bus && html`<${BusSheet} id=${open.bus} box=${sheetBox} />`}
  `;
}
