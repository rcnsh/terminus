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
import { inkOn, quietMs, send, signedOut, t } from '/account/dom.js';
import { haversineM, loadCampus, profile, reloadProfile, saveNow, withPlace } from '/account/profile.js';
import { MAPLIBRE, PMTILES } from '/app/map-files.js';
import { Row } from '/app/board.js';

/** Live buses refresh this often while a pill is on (the API caches 5 s). */
const BUSES_MS = 5_000;
/** After failed polls the wait doubles from BUSES_MS up to this: a server in trouble isn't helped by more. */
const BUSES_MAX_MS = 60_000;
/**
 * How long until the next poll for the buses, after `fails` failed polls in
 * a row: 5 s, 10 s, 20 s… up to a minute, and never before `quiet` (ms, the
 * server's Retry-After still to run: dom.js quietMs).
 */
export const busesWaitMs = (fails, quiet = 0) => Math.max(quiet, Math.min(BUSES_MAX_MS, BUSES_MS * 2 ** fails));
/** A stop's arrivals refresh this often while its sheet is open (cached 15 s). */
const ARRIVALS_MS = 15_000;
/** How long a bus takes to slide [m] metres along the road: a steady 100 m
 *  a second, so a longer stretch takes longer, from 1 s for a short hop to
 *  4 s, done before the next answer (every 5 s). As the Android app. */
export const slideMs = (m) => Math.max(1_000, Math.min(4_000, (m / 100) * 1_000));
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
/**
 * The open sheet, or null: { stop: code, from }, `from` the bus sheet it was
 * opened from (which back returns to); or { bus: id, stops, all }, `stops`
 * its stops ahead open and `all` of them shown, as when it's come back to.
 */
const sheet = store(null);
/** What had the focus when the sheet opened, for it to go back to when the sheet closes. */
let opener = null;
/**
 * What to centre in what its sheet leaves uncovered, once the sheet is drawn:
 * a stop's code, or { bus: id } (a bus gone back to from one of its stops).
 */
let centreOn = null;

/**
 * A stop's sheet opened from a bus has a step in the browser's history of
 * its own (the same address, marked in its state), so a phone's Back goes
 * back to the bus as Escape does. `onEntry`: that step is the one the
 * browser is on. `skipPop`: the next popstate is the step being taken away
 * (the sheet left another way), not someone going back.
 */
const BACK_MARK = 'mapBack';
let onEntry = false;
let skipPop = false;
/** The browser is on the step now (not on one pushed over it since, as Go there's #now). */
const atEntry = () => Boolean(history.state?.[BACK_MARK]);
/** Takes the step away, the browser going back over it unseen (the address is the same). */
function dropEntry() {
  if (!onEntry) return;
  onEntry = false;
  if (!atEntry()) return;
  skipPop = true;
  history.back();
}
function onPop(e) {
  const was = onEntry;
  onEntry = Boolean(e.state?.[BACK_MARK]);
  if (skipPop) {
    skipPop = false;
    return;
  }
  // Back from the stop: to its bus.
  if (was && !onEntry) {
    if (location.hash === '#map') toBus();
    return;
  }
  // Come back (Back from another tab, Forward) to a step whose sheet has
  // gone since: passed over, so Back is never a step that does nothing.
  if (onEntry && !sheet.get()?.from) dropEntry();
}
// (Not in the tests, which run without a browser.)
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', onPop);
  // Reloaded on the step: the sheet it stood for is gone with the page.
  if (history.state?.[BACK_MARK]) {
    onEntry = true;
    dropEntry();
  }
}

/** Opens `what` ({ stop } or { bus }) in the sheet, or closes it (null). */
function openSheet(what) {
  const was = sheet.get();
  // Left the stop opened from a bus some other way (Close, another sheet,
  // the Map tab again): its step goes too. Opened from a bus: a step of its own.
  if (!what?.from) dropEntry();
  else if (!atEntry()) {
    history.pushState({ ...history.state, [BACK_MARK]: true }, '');
    onEntry = true;
  }
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

/**
 * A stop opened from elsewhere (Nearby, the list of stops, a bus's sheet):
 * its sheet, the map centred on it above the sheet. `from`: the bus sheet
 * it came from ({ bus, stops, all }), which back returns to.
 */
function showStop(code, from = null) {
  centreOn = code;
  openSheet(from ? { stop: code, from } : { stop: code });
}

/**
 * Back (Escape): from a stop opened from a bus, to that bus as it was if it's
 * still on the map, the map moved to it; else closed. With its step on top
 * of the history, through the history, as the phone's Back goes.
 */
function back() {
  if (atEntry() && sheet.get()?.from) history.back();
  else toBus();
}
function toBus() {
  const from = sheet.get()?.from;
  const to = from && shown.get().has(from.bus) ? from : null;
  if (to) centreOn = { bus: to.bus };
  openSheet(to);
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
  if (res.status === 401) await signedOut();
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
    // The screen stays on the map file, which covers only the campus area:
    // MapLibre keeps the whole view inside, and zooms out no further than
    // the screen full of it. (The apps work this out themselves: PanLimit.)
    maxBounds: BOUNDS,
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
        b.onclick = toCampus;
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

/**
 * The whole campus in view: "Back to campus", and the Map tab tapped again.
 * The room a stop's sheet left at the bottom (showStop's easeTo) goes too, or
 * the campus would sit above the middle.
 */
function toCampus() {
  const to = map?.cameraForBounds(fit, { padding: CAMPUS_PADDING });
  if (to) map.flyTo({ ...to, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 600 });
}

/**
 * The Map tab tapped while on it: back to how it opened, the whole campus
 * with no sheet open and no service chosen.
 */
export function home() {
  centreOn = null;
  openSheet(null);
  if (selected.get()) choose(null);
  toCampus();
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

/** Polls for the buses in a row that failed: each one doubles the wait before the next. */
let busFails = 0;
/** A poll on its way: only one at a time. */
let busPolling = false;

async function pollBuses() {
  clearTimeout(busTimer);
  const svc = selected.get();
  // The tab or page shown again while a poll is on its way would start a
  // second loop beside the first: that poll arms the next one itself.
  if (!svc || !visible || busPolling) return;
  busPolling = true;
  let got;
  try {
    got = await pollOnce(svc);
  } finally {
    busPolling = false;
  }
  if (got === 'signed out') return;
  // Another service chosen while this one was on its way: its turn now.
  if (svc !== selected.get()) return void pollBuses();
  busFails = got === 'ok' ? 0 : busFails + 1;
  // Not again once the map's tab is hidden while this one was on its way.
  if (visible && document.visibilityState === 'visible') busTimer = setTimeout(pollBuses, busesWaitMs(busFails, quietMs('/buses')));
}

/** One poll for `svc`'s buses: 'ok', 'failed', 'signed out', or 'moved on' (another service chosen meanwhile). */
async function pollOnce(svc) {
  try {
    // The next poll waits for this one: a call that hangs would stop the map, so it's given up on.
    const data = await getJSON(`/buses?svc=${encodeURIComponent(svc)}`, BUSES_TIMEOUT_MS);
    if (svc !== selected.get()) return 'moved on';
    // `stale`: the feed didn't answer, and these are where the buses last were.
    const old = data.available && data.stale === true;
    if (!data.available) status.set(t('Live buses aren’t available right now.'));
    else if (old) status.set(t('Bus positions may be out of date'));
    else if (!data.buses.length) status.set(t('No {0} buses running right now.', svc));
    else status.set(data.buses.length === 1 ? t('1 bus on {0}', svc) : t('{0} buses on {1}', data.buses.length, svc));
    dim(old);
    moveTo(data.buses.map((b) => ({ ...b, svc, color: colorOf(svc) })));
    return 'ok';
  } catch (err) {
    if (err.message === 'signed out') return 'signed out';
    if (svc !== selected.get()) return 'moved on';
    status.set(navigator.onLine ? t('Live buses aren’t available right now.') : t('Live buses need a connection.'));
    // The buses drawn are from the last answer: faded once that's old, so they don't pass for live.
    if (Date.now() - lastAnswer > STALE_MS) dim(true);
    return 'failed';
  }
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
  const route = campusData.get()?.routes[selected.get()];
  const path = pathOf(route?.line, route?.loop);
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
export function positionAt(g, now) {
  if (!g.from) return g.to;
  const k = Math.max(0, Math.min(1, (now - g.start) / g.ms));
  if (k === 1) return g.to;
  const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
  const { from, to, path, d } = g;
  const at = pointAt(path, from.along + d * e);
  const [a, b] = [pointAt(path, from.along), pointAt(path, to.along)];
  return {
    ...to,
    along: path.loop ? (((from.along + d * e) % path.total) + path.total) % path.total : from.along + d * e,
    lat: at.lat + (from.lat - a.lat) * (1 - e) + (to.lat - b.lat) * e,
    lon: at.lon + (from.lon - a.lon) * (1 - e) + (to.lon - b.lon) * e,
    heading: at.bearing,
    offset: [from.offset[0] + (to.offset[0] - from.offset[0]) * e, from.offset[1] + (to.offset[1] - from.offset[1]) * e],
  };
}

/* A route line measured as the API measures it (haversine, metres from its
   start at each point), so a bus's `along` is a place on it. Whether it's a
   loop comes from /campus, as the API places buses: a loop's line needn't end
   exactly where it starts (A1's ends are some 40 m apart at KRB). */

const paths = new WeakMap();

export function pathOf(line, loop) {
  if (!line || line.length < 2) return null;
  let p = paths.get(line);
  if (!p) {
    const cum = [0];
    for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + haversineM(line[i - 1][1], line[i - 1][0], line[i][1], line[i][0]));
    p = { line, cum, total: cum[cum.length - 1], loop: Boolean(loop) };
    paths.set(line, p);
  }
  return p;
}

/** Metres on along [path] from bus [f] to bus [b], round a loop past its
 *  start; null when it isn't on ahead (the same place, behind, a long way,
 *  or a line kept from before the route changed). */
export function aheadBy(path, f, b) {
  if (f.along == null || b.along == null || path.total <= 0 || f.along > path.total + 1 || b.along > path.total + 1) return null;
  let d = b.along - f.along;
  if (path.loop && d < -path.total / 2) d += path.total;
  return d > 0 && d <= SLIDE_MAX_M ? d : null;
}

/** The point [m] metres along [path], and the road's direction there. */
export function pointAt(path, m) {
  const { line, cum, total } = path;
  m = path.loop ? ((m % total) + total) % total : Math.max(0, Math.min(total, m));
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
  const route = campusData.get()?.routes[b?.svc];
  const path = b?.stretch && pathOf(route?.line, route?.loop);
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
 * A sheet's drag, in CSS pixels (and pixels a millisecond): past `start` it's
 * a drag, not a tap; `open` up opens what the handle holds; down past
 * `close`, or flicked past `open`, it closes.
 */
const DRAG = { start: 12, open: 24, close: 96, flick: 0.8 };

/**
 * The frame a stop's sheet and a bus's share, so the two read alike: a grab
 * handle; a `lead` tile beside the title, the line under it and Close; a line
 * of `facts`; then the body (a SectionBand and its rows); then the `footer`'s
 * buttons, kept in view under the rest, which scrolls however long it is.
 * The handle does what it promises: dragged down from it or the header, the
 * sheet follows the finger and closes as Close does, or springs back if let
 * go short. `onHandle`, when set, comes first: dragged up it's called with
 * true, down with false, the handle tapped with null, and it returns whether
 * it changed anything (a bus's stops closed before the sheet). Opened, the
 * focus is on its title (`id` changes with what it's about); Escape goes
 * back (see back()), and Close shuts it whatever it came from.
 */
function Frame({ id, title, sub, lead, facts, onHandle, footer, children, box }) {
  const head = useRef(null);
  const drag = useRef(null);
  const dragged = useRef(false);
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
  // The handle; the section band does the same for a screen reader.
  // Tapped, on its click (after the tap, so the sheet growing under the
  // finger doesn't put the click on a row); not the click a drag ends in.
  const handle = onHandle
    ? html`
        <div
          class="sheet-grab live"
          aria-hidden="true"
          onClick=${() => {
            if (dragged.current) dragged.current = false;
            else onHandle(null);
          }}
        ></div>
      `
    : html`<div class="sheet-grab" aria-hidden="true"></div>`;
  // A drag on the handle or the header (not the rows, which scroll): down,
  // the sheet follows the finger; let go, onHandle, then the sheet, decide.
  const follow = (dy) => {
    const el = box.current;
    if (!el) return;
    el.classList.toggle('dragging', dy != null);
    el.style.transform = dy ? `translateY(${dy}px)` : '';
  };
  const grab = {
    onPointerDown: (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      dragged.current = false;
      drag.current = { id: e.pointerId, y: e.clientY, moved: false, trail: [{ y: e.clientY, t: e.timeStamp }] };
    },
    onPointerMove: (e) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      // A mouse let go outside before it became a drag: over.
      if (e.pointerType === 'mouse' && !(e.buttons & 1)) {
        drag.current = null;
        return;
      }
      const dy = e.clientY - d.y;
      if (!d.moved) {
        if (Math.abs(dy) < DRAG.start) return;
        // A drag now, not a tap: the pointer is the header's until let go (no click on Close).
        d.moved = true;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // The pointer's already gone: its up still ends the drag.
        }
      }
      d.trail.push({ y: e.clientY, t: e.timeStamp });
      while (d.trail.length > 2 && e.timeStamp - d.trail[0].t > 100) d.trail.shift();
      follow(Math.max(0, dy));
    },
    onPointerUp: (e) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      drag.current = null;
      if (!d.moved) return;
      dragged.current = true;
      const dy = e.clientY - d.y;
      const first = d.trail[0];
      const speed = e.timeStamp > first.t ? (e.clientY - first.y) / (e.timeStamp - first.t) : 0;
      const down = dy > DRAG.close || (dy > DRAG.open && speed > DRAG.flick);
      // Closing: as Close does (its history step too), from where the finger left it.
      if (down && !onHandle?.(false)) return openSheet(null);
      follow(null);
      if (dy < -DRAG.open) onHandle?.(true);
    },
    onPointerCancel: () => {
      drag.current = null;
      follow(null);
    },
  };
  return html`
    <section
      class="map-sheet"
      aria-labelledby="sheet-title"
      ref=${box}
      onKeyDown=${(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        back();
      }}
    >
      <div class="sheet-scroll">
        <div class="sheet-top" ...${grab}>
          ${handle}
          <div class="sheet-head">
            ${lead}
            <div class="sheet-titles"><h2 id="sheet-title" tabindex="-1" ref=${head}>${title}</h2>${sub && html`<p class="hint">${sub}</p>`}</div>
            <button type="button" class="sheet-close" aria-label=${t('Close')} onClick=${() => openSheet(null)}>×</button>
          </div>
          ${facts && html`<div class="sheet-facts">${facts}</div>`}
        </div>
        <div class="sheet-body">${children}</div>
      </div>
      ${footer && html`<div class="sheet-foot sheet-actions">${footer}</div>`}
    </section>
  `;
}

/**
 * A grey band naming what's under it, the same on a stop's sheet ("Buses
 * here") as on a bus's ("Stops ahead"). With `onToggle`, it opens and closes
 * what's under it (`controls`), and a chevron says so.
 */
function SectionBand({ text, open = true, onToggle, controls }) {
  if (!onToggle) return html`<h3 class="sheet-band">${text}</h3>`;
  return html`
    <button type="button" class="sheet-band" aria-expanded=${String(open)} aria-controls=${open ? controls : undefined} onClick=${onToggle}>
      ${text}<${Icon} paths=${CHEVRON_DOWN} class="chev" />
    </button>
  `;
}

/** How full a bus is, as three rising bars (as many filled as it's full) and a word. */
function CrowdMeter({ crowd }) {
  const word = { low: t('Seats free'), medium: t('Busy'), high: t('Packed') }[crowd];
  if (!word) return null;
  return html`<span class=${`bus-crowd ${crowd}`}><span class="bars" aria-hidden="true"><i></i><i></i><i></i></span>${word}</span>`;
}

/** Stops after the next one shown in the bus's list before "+N more". */
const AHEAD_SHOWN = 4;
const CHEVRON_DOWN = '<path d="m6 9 6 6 6-6" />';
const CHEVRON_END = '<path d="m9 6 6 6-6 6" />';

/**
 * The bus's line from the stop it passed (or the one it's at) on through the
 * stops ahead, as the server lists them (`upcoming`): the client never walks
 * the route itself. An older server without `upcoming` gives its next stop
 * only. The first few after the next, unless `all` (or only one more is
 * left); with more beyond them, the line fades out under the last. Passed,
 * here and next are drawn on the line (grey, the bus, bold), not written
 * beside it; a screen reader still hears the word. Each stop's row is a
 * button that opens that stop (`onStop(code, name)`), a chevron at its end
 * saying so; the bus's own row ("On its way") isn't.
 */
function StopStrip({ b, all, onStop }) {
  const ahead = stopsAhead(b);
  const rows = [];
  if (b.at) rows.push({ key: `at-${b.at.code}`, code: b.at.code, name: b.at.name, kind: 'here', said: t('here') });
  else if (b.stretch) {
    rows.push({ key: `last-${b.stretch.last.code}`, code: b.stretch.last.code, name: b.stretch.last.name, kind: 'passed', said: t('passed') });
    rows.push({ key: 'bus', name: t('On its way'), kind: 'bus' });
  }
  const shownAhead = all || hiddenAhead(b) <= 1 ? ahead : ahead.slice(0, AHEAD_SHOWN + 1);
  shownAhead.forEach((s, i) => rows.push({ key: `${i}-${s.code}`, code: s.code, name: s.name, kind: i === 0 ? 'next' : 'stop', said: i === 0 ? t('next') : null }));
  const fades = shownAhead.length < ahead.length;
  // The rail's colour above and below each row's dot: grey up to the bus, the route's colour after it.
  const grey = 'var(--line-strong)';
  const svc = 'var(--svc)';
  return html`
    <ol class="bus-strip" id="bus-strip" style=${svcVars(b.svc)}>
      ${rows.map((r, i) => {
        const top = i === 0 ? 'transparent' : rows[i - 1].kind === 'passed' ? grey : svc;
        const bottom = i === rows.length - 1 && !fades ? 'transparent' : r.kind === 'passed' ? grey : svc;
        const rail = html`<span class="rail" aria-hidden="true">${r.kind === 'bus' || r.kind === 'here' ? html`<span class="marker"><${Icon} paths=${CHEVRON_DOWN} /></span>` : html`<span class="dot"></span>`}</span>`;
        const name = html`<span class="name">${r.name}${r.said && html`<span class="sr-only">, ${r.said}</span>`}</span>`;
        return html`
          <li key=${r.key} class=${`bus-stop ${r.kind}`} style=${`--top:${top};--bottom:${bottom}`}>
            ${r.kind === 'bus'
              ? html`<div class="bus-row">${rail}${name}</div>`
              : html`
                  <button type="button" class="bus-row" onClick=${() => onStop(r.code, r.name)}>
                    ${rail}${name}<span class="sr-only">. ${t('Show this stop')}</span><${Icon} paths=${CHEVRON_END} class="go" />
                  </button>
                `}
          </li>
        `;
      })}
      ${fades && html`<li key="fade" class="bus-stop fade" aria-hidden="true"><span class="rail"></span></li>`}
    </ol>
  `;
}

/** The stops ahead of bus [b], after the one it's at. */
function stopsAhead(b) {
  const ahead = b.upcoming ?? (b.nextStop ? [b.nextStop] : []);
  return b.at && ahead[0]?.code === b.at.code ? ahead.slice(1) : ahead;
}

/** How many of bus [b]'s stops ahead the strip leaves out until asked: one alone is just shown. */
const hiddenAhead = (b) => Math.max(0, stopsAhead(b).length - (AHEAD_SHOWN + 1));

/**
 * A bus: its service, where its line ends and where it is or is going next,
 * its plate, whether it's moving and how full it is; opened up (a tap, or the
 * handle dragged up), the stops still ahead. Its button opens the sheet of
 * the stop it's at or coming to. Follows its updates while open.
 */
function BusSheet({ id, box, stops = false, all: allAtFirst = false }) {
  const buses = useStore(shown);
  const campus = useStore(campusData);
  const b = buses.get(id);
  const [open, setOpen] = useState(stops);
  const [all, setAll] = useState(allAtFirst);
  useEffect(() => {
    if (!b) openSheet(null);
  }, [b]);
  useEffect(() => {
    markOpen(b ?? null);
  }, [b?.id, b?.stretch?.from, b?.stretch?.to, b?.svc]);
  useEffect(() => () => markOpen(null), []);
  if (!b) return null;
  const more = hiddenAhead(b);
  const tile = html`<span class="sheet-tile bus-svc" style=${svcVars(b.svc)} aria-hidden="true">${b.svc}</span>`;
  const where = b.at ? t('At {0}', b.at.name) : b.nextStop ? t('Next: {0}', b.nextStop.name) : null;
  // Where its line ends leads, as a stop's name does; where it is comes under.
  const head = b.towards ? t('Towards {0}', b.towards.name) : where;
  // The tile is the service to the eye; a screen reader hears it in the title.
  const title = head ? html`<span class="sr-only">${t('{0} bus', b.svc)} </span>${head}` : t('{0} bus', b.svc);
  const sub = b.towards ? where : null;
  const stop = stopOfBus(campus, b);
  // A stop opened from here: its sheet, the map on it, and back returns to this bus as it is.
  const go = (code) => showStop(code, { bus: id, stops: open, all });
  // A stop on its line by its code; from an older API, by name, the one nearest the bus.
  const onStop = (code, name) => {
    const s = (code && campus?.stops.find((x) => x.code === code)) || stopOfBus(campus, b, name);
    if (s) go(s.code);
  };
  const facts = html`
    <div class="bus-info">
      ${b.plate && html`<span class="plate">${b.plate}</span>`}
      ${b.moving != null && html`<span class="bus-moving"><span class="dot" aria-hidden="true"></span>${b.moving ? t('Moving') : t('Stopped')}</span>`}
      <${CrowdMeter} crowd=${b.crowd} />
    </div>
  `;
  const footer = stop && html`<button type="button" class="btn small ghost" onClick=${() => go(stop.code)}>${t('Show {0}', stop.name)}</button>`;
  return html`
    <${Frame} id=${`bus-${id}`} title=${title} sub=${sub} lead=${tile} facts=${facts} onHandle=${(up) => {
        const next = up ?? !open;
        if (next !== open) setOpen(next);
        return next !== open;
      }} footer=${footer} box=${box}>
      <${SectionBand} text=${t('Stops ahead')} open=${open} onToggle=${() => setOpen(!open)} controls="bus-strip" />
      ${open && html`<${StopStrip} b=${b} all=${all} onStop=${onStop} />`}
      ${open && more > 1 && html`<button type="button" class="sheet-more" aria-expanded=${String(all)} aria-controls="bus-strip" onClick=${() => setAll(!all)}>${all ? t('Show fewer') : t('Show {0} more stops', more)}</button>`}
    <//>
  `;
}

/**
 * The stop bus [b] is at or coming to (or the one called `name` on its line):
 * of the stops with that name on its service, the one nearest the bus (one
 * name can be either side of a road).
 */
export function stopOfBus(campus, b, name = (b.at ?? b.nextStop)?.name) {
  if (!name || !campus || b.lat == null || b.lon == null) return null;
  let best = null;
  let bestM = Infinity;
  for (const s of campus.stops) {
    if (s.name !== name || !s.services?.includes(b.svc)) continue;
    const m = haversineM(b.lat, b.lon, s.lat, s.lon);
    if (m < bestM) [best, bestM] = [s, m];
  }
  return best;
}

/** The rows a stop's sheet shows before "Show more", so the map stays in view. */
const PEEK_ROWS = 3;
const WALKER = '<circle cx="13" cy="4" r="2" fill="currentColor"/><path d="M12 8l-2 6-3 7M10 14l3 3v4M7 12l2-4h3l2 3 3 1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
const PIN = '<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/>';
const STAR = '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>';

/**
 * A stop: its board as the Buses tab has it (refreshed while open), the first
 * few rows until asked for the rest, and ways to go there. A row tapped picks
 * its service on the map, and tapped again unpicks it, as its pill does.
 */
function StopSheet({ code, box, onGoTo, onSaved, active }) {
  const campus = useStore(campusData);
  // The service picked on the map: its row is washed in its colour, as its pill is pressed.
  const picked = useStore(selected);
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
  // A stop's tile, where a bus's has its service: the two headers line up.
  const tile = html`<span class="sheet-tile stop-tile" aria-hidden="true"><${Icon} paths=${PIN} /></span>`;
  const footer = html`
    <button type="button" class="btn small accent" onClick=${() => onGoTo({ code: stop.code, name: stop.name, place: same?.key ?? null })}>${t('Go there')}</button>
    <a class="btn small ghost icon" href=${directions(stop)} target="_blank" rel="noopener" aria-label=${t('Walking directions')} title=${t('Walking directions')}><${Icon} paths=${WALKER} /></a>
    <button type="button" class=${`btn small ghost icon${same ? ' on' : ''}`} disabled=${Boolean(same) || saving} onClick=${save} aria-label=${same ? t('In your favourites') : t('Add to favourites')} title=${same ? t('In your favourites') : t('Add to favourites')}><${Icon} paths=${STAR} /></button>
    ${saveMsg && html`<p class="hint" role="alert">${saveMsg}</p>`}
  `;
  return html`
    <${Frame} id=${`stop-${code}`} title=${stop.name} sub=${sub} lead=${tile} footer=${footer} box=${box}>
      <${SectionBand} text=${t('Buses here')} />
      ${(!board || board.text) &&
      html`
        <div class="sheet-note">
          <div class="hint">${board?.text ?? t('Checking…')}</div>
          ${board?.text && html`<div class="svc-tags">${stop.services.map((svc) => html`<${SvcTag} svc=${svc} key=${svc} onClick=${() => choose(svc)} />`)}</div>`}
        </div>
      `}
      ${rows.length > 0 &&
      html`
        <div class="sheet-board" id="sheet-board">
          ${(all || more <= 1 ? rows : rows.slice(0, PEEK_ROWS)).map((r) => html`<${Row} key=${r.svc} r=${r} picked=${r.svc === picked} onPick=${(svc) => choose(svc === selected.get() ? null : svc)} />`)}
        </div>
        ${more > 1 && html`<button type="button" class="sheet-more" aria-expanded=${String(all)} aria-controls="sheet-board" onClick=${() => setAll(!all)}>${all ? t('Show fewer') : t('Show {0} more', more)}</button>`}
      `}
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
    const bus = code?.bus;
    // A bus: where it's drawn (or sliding to), else where it last came from the API.
    const at = bus ? open?.bus === bus && (glides.get(bus)?.to ?? shown.get().get(bus)) : open?.stop === code && campusData.get()?.stops.find((s) => s.code === code);
    if (!at || at.lat == null || !map) return;
    centreOn = null;
    const go = () => map.easeTo({ center: [at.lon, at.lat], zoom: Math.max(map.getZoom(), 17), padding: { top: 70, bottom: (sheetBox.current?.offsetHeight ?? 0) + 20 }, duration: 600 });
    // Not loaded: the map is still being built (from Nearby), or a source is
    // taking new data (a bus's sheet closing clears its ring), after which
    // 'load' never comes again; 'idle' comes in either case.
    if (map.loaded()) go();
    else map.once('idle', go);
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
    ${open?.bus && html`<${BusSheet} key=${open.bus} id=${open.bus} stops=${open.stops} all=${open.all} box=${sheetBox} />`}
  `;
}
