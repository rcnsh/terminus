import {
  Icon,
  Skeleton,
  focusSoon,
  html,
  reducedMotion,
  store,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useStore,
} from '/assets/ui.js';
import { inkOn, quietMs, send, signedOut, t } from '/account/dom.js';
import {
  campus as campusStore,
  haversineM,
  loadCampus,
  profile,
  reloadProfile,
  restorePlace,
  saveNow,
  toast,
  withPlace,
  withoutPlace,
} from '/account/profile.js';
import { MAPLIBRE, PMTILES } from '/app/map-files.js';
import { Row, WaitingRows } from '/app/board.js';

const BUSES_MS = 5_000;
const BUSES_MAX_MS = 60_000;
export const busesWaitMs = (fails, quiet = 0) => Math.max(quiet, Math.min(BUSES_MAX_MS, BUSES_MS * 2 ** fails));
const ARRIVALS_MS = 15_000;
export const slideMs = (m) => Math.max(1_000, Math.min(4_000, (m / 100) * 1_000));
const SLIDE_MAX_M = 1_500;
const STALE_MS = 15_000;
const BUSES_TIMEOUT_MS = 10_000;
const AT_STOP_SIDE_PX = 22;
const AT_STOP_STEP_PX = 26;
const NEAR_CAMPUS_M = 3_000;
const BOUNDS = [
  [103.755, 1.28],
  [103.83, 1.332],
];
const CAMPUS_PADDING = { top: 70, bottom: 30, left: 30, right: 30 };

const campusData = store(null);
const selected = store(null);
const status = store(null);
const sheet = store(null);
let opener = null;
let centreOn = null;

const BACK_MARK = 'mapBack';
let onEntry = false;
let skipPop = false;
const atEntry = () => Boolean(history.state?.[BACK_MARK]);
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
  if (was && !onEntry) {
    if (location.hash === '#map') toBus();
    return;
  }
  if (onEntry && !sheet.get()?.from) dropEntry();
}
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', onPop);
  if (history.state?.[BACK_MARK]) {
    onEntry = true;
    dropEntry();
  }
}

function openSheet(what) {
  const was = sheet.get();
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
  if (!what) map?.setMaxBounds(BOUNDS);
  if (!what && was) {
    const back = opener;
    opener = null;
    focusSoon(() => (back?.isConnected ? back : (document.getElementById('map-stops') ?? map?.getCanvas())));
  }
}

function showStop(code, from = null) {
  centreOn = code;
  openSheet(from ? { stop: code, from } : { stop: code });
}

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
const shown = store(new Map());

let ml = null;
let map = null;
let visible = false;
let busTimer = null;
let watchId = null;
let glides = new Map();
let lastAnswer = -Infinity;
let dimmed = false;
let glide = null;
let building = null;
let libFails = 0;
let styled = null;
let protocolAdded = false;
let fit = null;

const dark = () => window.theme?.dark() ?? window.matchMedia('(prefers-color-scheme: dark)').matches;
const lang = () => (window.i18n?.lang === 'zh' ? 'zh' : 'en');
const styleUrl = () => `/map/style.json?theme=${dark() ? 'dark' : 'light'}&lang=${lang()}`;
const pageInk = () => (dark() ? '#f2efeb' : '#1c1917');
const pagePaper = () => (dark() ? '#1a1816' : '#ffffff');
const edgeOf = () => (dark() ? pagePaper() : '#57534e');
const colorOf = (svc) => campusData.get()?.routes[svc]?.color ?? '#8a939c';
const svcVars = (svc) => `--svc:${colorOf(svc)};--svc-ink:${inkOn(colorOf(svc))}`;

async function getJSON(path, timeoutMs) {
  const res = await send(path, { credentials: 'same-origin', headers: { 'accept-language': window.i18n?.header ?? 'en' }, timeoutMs });
  if (res.status === 401) await signedOut();
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

async function allowed() {
  if (!navigator.geolocation) return false;
  const state = await navigator.permissions
    ?.query({ name: 'geolocation' })
    .then((p) => p.state)
    .catch(() => null);
  return state === 'granted';
}

function ensureMap(container) {
  building ??= build(container).catch((err) => {
    building = null;
    throw err;
  });
  return building;
}

async function build(container) {
  const href = `${MAPLIBRE}maplibre-gl.css`;
  if (![...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => l.getAttribute('href') === href)) {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = href;
    document.head.append(css);
  }
  const again = libFails ? `?retry=${libFails}` : '';
  const libs = Promise.all([import(`${MAPLIBRE}maplibre-gl.mjs${again}`), import(`${PMTILES}${again}`)]).catch((err) => {
    libFails += 1;
    throw err;
  });
  const [[maplibre, { Protocol }], data] = await Promise.all([libs, loadCampus()]);
  ml = maplibre;
  campusData.set(data);
  if (!protocolAdded) ml.addProtocol('pmtiles', new Protocol({ metadata: true }).tile);
  protocolAdded = true;

  fit = campusBounds(data);
  map = new ml.Map({
    container,
    style: (styled = styleUrl()),
    bounds: fit,
    fitBoundsOptions: { padding: CAMPUS_PADDING },
    maxBounds: BOUNDS,
    minZoom: 13,
    maxZoom: 19,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    attributionControl: { compact: true },
    localIdeographFontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', sans-serif",
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new ml.NavigationControl({ showCompass: false }), 'bottom-right');
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
        b.innerHTML =
          '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M3,9.5L12,4l9,5.5zM6,12.5v5M10,12.5v5M14,12.5v5M18,12.5v5M3,20.5h18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
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
  map.on('style.load', addLayers);
  const restyle = () => {
    if (styleUrl() === styled) return;
    styled = styleUrl();
    map.setStyle(styled);
  };
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', restyle);
  document.addEventListener('themechange', restyle);
  map.on('click', onClick);
  map.on('movestart', (e) => {
    if (e.originalEvent) lineFitted = null;
  });
  map.on('resize', () => {
    if (lineFitted && lineFitted === selected.get()) fitLine(0);
  });
  for (const layer of ['stops', 'stop-names', 'buses']) {
    map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
  }
  startOnMe();
  followMe();
}

function toCampus() {
  const to = map?.cameraForBounds(fit, { padding: CAMPUS_PADDING });
  if (to) map.flyTo({ ...to, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 600 });
}

export function home() {
  centreOn = null;
  openSheet(null);
  if (selected.get()) choose(null);
  toCampus();
}

export function campusBounds(data) {
  const core = new Set(data.stops.filter((s) => s.core).map((s) => s.code));
  if (!core.size) return boundsOf(data.stops.map((s) => [s.lon, s.lat]));
  const lines = Object.values(data.routes ?? {}).filter((r) => r.seq?.length && r.seq.every((code) => core.has(code)));
  return boundsOf([...data.stops.filter((s) => core.has(s.code)).map((s) => [s.lon, s.lat]), ...lines.flatMap((r) => r.line)]);
}

function boundsOf(points) {
  const lons = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  return [
    [Math.min(...lons), Math.min(...lats)],
    [Math.max(...lons), Math.max(...lats)],
  ];
}

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

async function followMe() {
  if (watchId !== null || !(await allowed()) || !visible) return;
  if (watchId !== null) return;
  watchId = navigator.geolocation.watchPosition(
    (p) =>
      map
        .getSource('me')
        ?.setData({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [p.coords.longitude, p.coords.latitude] } }),
    () => {},
    { maximumAge: 15_000, enableHighAccuracy: true },
  );
}

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

const empty = { type: 'FeatureCollection', features: [] };

const routesOf = (campus) => ({
  type: 'FeatureCollection',
  features: Object.entries(campus.routes).map(([svc, r]) => ({
    type: 'Feature',
    properties: { svc, color: r.color },
    geometry: { type: 'LineString', coordinates: r.line },
  })),
});

const stopsOf = (campus) => ({
  type: 'FeatureCollection',
  features: campus.stops.map((s) => ({
    type: 'Feature',
    properties: { code: s.code, name: s.name, services: ` ${s.services.join(' ')} ` },
    geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
  })),
});

campusStore.subscribe((c) => {
  if (!c || !campusData.get() || c === campusData.get()) return;
  campusData.set(c);
  map?.getSource('routes')?.setData(routesOf(c));
  map?.getSource('stops')?.setData(stopsOf(c));
});

function addLayers() {
  const campus = campusData.get();
  const ink = pageInk();
  const paper = pagePaper();
  map.addSource('routes', { type: 'geojson', data: routesOf(campus) });
  map.addSource('stops', { type: 'geojson', data: stopsOf(campus) });
  map.addSource('buses', { type: 'geojson', data: empty });
  map.addSource('me', { type: 'geojson', data: empty });
  map.addSource('stretch', { type: 'geojson', data: empty });

  const width = ['interpolate', ['linear'], ['zoom'], 13, 1.5, 16, 4, 18, 7];
  map.addLayer({
    id: 'route-casing',
    type: 'line',
    source: 'routes',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': edgeOf(), 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 3, 16, 7, 18, 11], 'line-opacity': 0.9 },
  });
  map.addLayer({
    id: 'routes',
    type: 'line',
    source: 'routes',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': width },
  });
  map.addLayer({
    id: 'route-on',
    type: 'line',
    source: 'routes',
    filter: ['==', ['get', 'svc'], ''],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 3, 16, 6, 18, 9] },
  });
  map.addLayer({
    id: 'stretch-casing',
    type: 'line',
    source: 'stretch',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': paper, 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 7, 16, 13, 18, 18] },
  });
  map.addLayer({
    id: 'stretch',
    type: 'line',
    source: 'stretch',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 5, 16, 9, 18, 13] },
  });
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
      'text-variable-anchor': ['top', 'bottom', 'right', 'left'],
      'text-radial-offset': 0.9,
      'text-optional': true,
      'text-max-width': 8,
    },
    paint: { 'text-color': ink, 'text-halo-color': paper, 'text-halo-width': 2.5 },
  });
  if (!map.hasImage('stop-mark')) map.addImage('stop-mark', { width: 16, height: 16, data: new Uint8Array(16 * 16 * 4) });
  map.addLayer({
    id: 'stop-marks',
    type: 'symbol',
    source: 'stops',
    minzoom: 15,
    layout: {
      'icon-image': 'stop-mark',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 15, 0.6, 18, 1],
      'icon-allow-overlap': true,
    },
    paint: { 'icon-opacity': 0 },
  });
  map.addLayer({
    id: 'me-halo',
    type: 'circle',
    source: 'me',
    paint: { 'circle-radius': 14, 'circle-color': '#2b7bf3', 'circle-opacity': 0.18 },
  });
  map.addLayer({
    id: 'me',
    type: 'circle',
    source: 'me',
    paint: { 'circle-radius': 6.5, 'circle-color': '#2b7bf3', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 },
  });
  if (!map.hasImage('heading')) map.addImage('heading', arrow('#ffffff'), { pixelRatio: 2 });
  paintBus();
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

const BUS_SIZE = ['interpolate', ['linear'], ['zoom'], 13, 0.64, 17, 1];
const busSize = (zoom) => Math.max(0.64, Math.min(1, 0.64 + ((zoom - 13) * 0.36) / 4));

function paintBus() {
  const paper = pagePaper();
  const color = colorOf(selected.get());
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

function dim(on) {
  dimmed = on;
  if (!map?.getLayer('buses')) return;
  for (const id of ['buses', 'bus-heading', 'bus-on']) map.setPaintProperty(id, 'icon-opacity', on ? 0.4 : 1);
}

function highlight() {
  if (!map?.getLayer('routes')) return;
  const svc = selected.get();
  map.setFilter('route-on', ['==', ['get', 'svc'], svc ?? '']);
  map.setPaintProperty('routes', 'line-opacity', svc ? 0.18 : 0.9);
  map.setPaintProperty('route-casing', 'line-opacity', svc ? 0.3 : 0.9);
  const on = svc ? ['in', ` ${svc} `, ['get', 'services']] : true;
  map.setPaintProperty('stops', 'circle-opacity', svc ? ['case', on, 1, 0.35] : 1);
  map.setPaintProperty('stops', 'circle-stroke-opacity', svc ? ['case', on, 1, 0.35] : 1);
  map.setPaintProperty('stop-names', 'text-opacity', svc ? ['case', on, 1, 0.4] : 1);
}

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
  status.set(t('Finding {0} buses…', svc));
  requestAnimationFrame(() => {
    if (selected.get() === svc) fitLine(600);
  });
  pollBuses();
}

let lineFitted = null;

function fitLine(duration) {
  const svc = selected.get();
  const line = svc && campusData.get()?.routes[svc]?.line;
  if (!map || !line) return;
  const [box, covers] = coversOnMap();
  const kept = map.getPadding();
  const camera = (margin) => {
    const free = freePadding(box, covers, margin);
    const padding = Object.fromEntries(Object.entries(free).map(([side, px]) => [side, px - (kept[side] ?? 0)]));
    return map.cameraForBounds(boundsOf(line), { padding, maxZoom: 16.5 });
  };
  let to = camera(24);
  if (to && to.zoom < leastZoom(box, covers)) to = camera(4);
  if (!to) return;
  map.setMaxBounds(underSheet(covers, to.zoom));
  map.easeTo({ ...to, duration });
  lineFitted = svc;
}

function leastZoom(box, covers) {
  const sheet = covers.find((c) => c.sheet);
  const across = sheet?.side === 'bottom' ? sheet.rect.bottom - sheet.rect.top : 0;
  const beside = sheet?.side === 'left' ? sheet.rect.right - sheet.rect.left : 0;
  const y = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;
  const [[west, south], [east, north]] = BOUNDS;
  const tall = (box.bottom - box.top - across) / ((y(south) - y(north)) * 512);
  const wide = (box.right - box.left - beside) / (((east - west) / 360) * 512);
  return Math.log2(Math.max(tall, wide));
}

function underSheet(covers, zoom) {
  const sheet = covers.find((c) => c.sheet);
  if (!sheet) return BOUNDS;
  const deg = (px) => (px * 360) / (512 * 2 ** zoom);
  const [[west, south], [east, north]] = BOUNDS;
  return sheet.side === 'bottom'
    ? [
        [west, south - deg(sheet.rect.bottom - sheet.rect.top)],
        [east, north],
      ]
    : [
        [west - deg(sheet.rect.right - sheet.rect.left), south],
        [east, north],
      ];
}

function coversOnMap() {
  const box = map.getContainer().getBoundingClientRect();
  const seen = (el) => el.offsetWidth > 2 && el.offsetHeight > 2;
  const over = (sel, side) => [...document.querySelectorAll(sel)].filter(seen).map((el) => ({ rect: el.getBoundingClientRect(), side }));
  const covers = [...over('.map-top > *', 'top'), ...over('.map .maplibregl-ctrl-bottom-right > .maplibregl-ctrl', 'right')];
  const sheet = document.querySelector('.map-sheet');
  if (sheet && seen(sheet))
    covers.push({
      rect: sheet.getBoundingClientRect(),
      side: window.matchMedia('(min-width: 700px)').matches ? 'left' : 'bottom',
      sheet: true,
    });
  return [box, covers];
}

export function freePadding(box, covers, margin = 24) {
  const pad = { top: margin, right: margin, bottom: margin, left: margin };
  for (const { rect, side } of covers) {
    const clear = {
      top: rect.bottom - box.top,
      bottom: box.bottom - rect.top,
      left: rect.right - box.left,
      right: box.right - rect.left,
    };
    const edge = side ?? Object.keys(clear).reduce((a, b) => (clear[b] < clear[a] ? b : a));
    pad[edge] = Math.max(pad[edge], clear[edge] + margin);
  }
  const fit = (a, b, size) => {
    const most = size * 0.85;
    if (pad[a] + pad[b] <= most) return;
    const less = Math.min(margin - 4, (pad[a] + pad[b] - most) / 2);
    pad[a] -= less;
    pad[b] -= less;
    if (pad[a] + pad[b] > most) {
      const k = most / (pad[a] + pad[b]);
      pad[a] = Math.round(pad[a] * k);
      pad[b] = Math.round(pad[b] * k);
    }
  };
  fit('left', 'right', box.right - box.left);
  fit('top', 'bottom', box.bottom - box.top);
  return pad;
}

let busFails = 0;
let busPolling = false;

async function pollBuses() {
  clearTimeout(busTimer);
  const svc = selected.get();
  if (!svc || !visible || busPolling) return;
  busPolling = true;
  let got;
  try {
    got = await pollOnce(svc);
  } finally {
    busPolling = false;
  }
  if (got === 'signed out') return;
  if (svc !== selected.get()) return void pollBuses();
  busFails = got === 'ok' ? 0 : busFails + 1;
  if (visible && document.visibilityState === 'visible') busTimer = setTimeout(pollBuses, busesWaitMs(busFails, quietMs('/api/buses')));
}

async function pollOnce(svc) {
  try {
    const data = await getJSON(`/api/buses?svc=${encodeURIComponent(svc)}`, BUSES_TIMEOUT_MS);
    if (svc !== selected.get()) return 'moved on';
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
    if (Date.now() - lastAnswer > STALE_MS) dim(true);
    return 'failed';
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && visible && selected.get()) pollBuses();
});

function moveTo(buses) {
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

export function aheadBy(path, f, b) {
  if (f.along == null || b.along == null || path.total <= 0 || f.along > path.total + 1 || b.along > path.total + 1) return null;
  let d = b.along - f.along;
  if (path.loop && d < -path.total / 2) d += path.total;
  return d > 0 && d <= SLIDE_MAX_M ? d : null;
}

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

let openBus = null;

function markOpen(b) {
  openBus = b;
  if (!map?.getSource('stretch')) return;
  map.setFilter('bus-on', ['==', ['get', 'id'], b?.id ?? '']);
  const route = campusData.get()?.routes[b?.svc];
  const path = b?.stretch && pathOf(route?.line, route?.loop);
  const line = path ? sliceOf(path, b.stretch.from, b.stretch.to) : null;
  map
    .getSource('stretch')
    .setData(line ? { type: 'Feature', properties: { color: b.color }, geometry: { type: 'LineString', coordinates: line } } : empty);
  map.setPaintProperty('route-on', 'line-opacity', line ? 0.2 : 1);
}

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

const tapSlop = () => (window.matchMedia('(pointer: coarse)').matches ? 24 : 10);

function onClick(e) {
  const r = tapSlop();
  const around = (n) => [
    [e.point.x - n, e.point.y - n],
    [e.point.x + n, e.point.y + n],
  ];
  let best = null;
  for (const f of map.queryRenderedFeatures(around(r), { layers: ['buses', 'stops'] })) {
    const p = f.layer.id === 'buses' ? drawnAt(f) : map.project(f.geometry.coordinates);
    const d = Math.hypot(p.x - e.point.x, p.y - e.point.y) - (f.layer.id === 'buses' ? 12 : 0);
    if (d <= r && (!best || d < best.d)) best = { f, d };
  }
  if (!best) {
    const [name] = map.queryRenderedFeatures(around(4), { layers: ['stop-names'] });
    if (name) best = { f: name };
  }
  if (!best) return openSheet(null);
  openSheet(best.f.layer.id === 'buses' ? { bus: best.f.properties.id } : { stop: best.f.properties.code });
}

function drawnAt(f) {
  const p = map.project(f.geometry.coordinates);
  const o = f.properties.offset;
  const [ox, oy] = typeof o === 'string' ? JSON.parse(o) : (o ?? [0, 0]);
  const k = busSize(map.getZoom());
  const r = ((f.properties.heading - map.getBearing()) * Math.PI) / 180;
  return { x: p.x + k * (ox * Math.cos(r) - oy * Math.sin(r)), y: p.y + k * (ox * Math.sin(r) + oy * Math.cos(r)) };
}

function directions(s) {
  const apple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
  return apple
    ? `https://maps.apple.com/?daddr=${s.lat},${s.lon}&dirflg=w`
    : `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}&travelmode=walking`;
}

const SvcTag = ({ svc, onClick }) =>
  html`<button type="button" class="svc-tag" style=${svcVars(svc)} aria-label=${t('Show {0} on the map', svc)} onClick=${onClick}>${svc}</button>`;

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
    <p class="sr-only">${t("The Stops tab has every stop's buses in words.")}</p>
  `;
}

function Status() {
  const text = useStore(status);
  return html`<div class=${text ? 'map-status' : 'sr-only'} role="status">${text ?? ''}</div>`;
}

const DRAG = { start: 12, open: 24, close: 96, flick: 0.8 };

function Frame({ id, title, sub, lead, facts, onHandle, footer, children, box }) {
  const head = useRef(null);
  const drag = useRef(null);
  const dragged = useRef(false);
  useEffect(() => {
    head.current?.focus({ preventScroll: true });
  }, [id]);
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
      if (e.pointerType === 'mouse' && !(e.buttons & 1)) {
        drag.current = null;
        return;
      }
      const dy = e.clientY - d.y;
      if (!d.moved) {
        if (Math.abs(dy) < DRAG.start) return;
        d.moved = true;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {}
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

function SectionBand({ text, open = true, onToggle, controls }) {
  if (!onToggle) return html`<h3 class="sheet-band">${text}</h3>`;
  return html`
    <button type="button" class="sheet-band" aria-expanded=${String(open)} aria-controls=${open ? controls : undefined} onClick=${onToggle}>
      ${text}<${Icon} paths=${CHEVRON_DOWN} class="chev" />
    </button>
  `;
}

function CrowdMeter({ crowd }) {
  const word = { low: t('Seats'), medium: t('Busy'), high: t('Packed') }[crowd];
  if (!word) return null;
  return html`<span class=${`bus-crowd ${crowd}`}><span class="bars" aria-hidden="true"><i></i><i></i><i></i></span>${word}</span>`;
}

const AHEAD_SHOWN = 4;
const CHEVRON_DOWN = '<path d="m6 9 6 6 6-6" />';
const CHEVRON_END = '<path d="m9 6 6 6-6 6" />';

function StopStrip({ b, all, onStop }) {
  const ahead = stopsAhead(b);
  const rows = [];
  if (b.at) rows.push({ key: `at-${b.at.code}`, code: b.at.code, name: b.at.name, kind: 'here', said: t('here') });
  else if (b.stretch) {
    rows.push({
      key: `last-${b.stretch.last.code}`,
      code: b.stretch.last.code,
      name: b.stretch.last.name,
      kind: 'passed',
      said: t('passed'),
    });
    rows.push({ key: 'bus', name: t('On its way'), kind: 'bus' });
  }
  const shownAhead = all || hiddenAhead(b) <= 1 ? ahead : ahead.slice(0, AHEAD_SHOWN + 1);
  shownAhead.forEach((s, i) =>
    rows.push({ key: `${i}-${s.code}`, code: s.code, name: s.name, kind: i === 0 ? 'next' : 'stop', said: i === 0 ? t('next') : null }),
  );
  const fades = shownAhead.length < ahead.length;
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
            ${
              r.kind === 'bus'
                ? html`<div class="bus-row">${rail}${name}</div>`
                : html`
                  <button type="button" class="bus-row" onClick=${() => onStop(r.code, r.name)}>
                    ${rail}${name}<span class="sr-only">. ${t('Show this stop')}</span><${Icon} paths=${CHEVRON_END} class="go" />
                  </button>
                `
            }
          </li>
        `;
      })}
      ${fades && html`<li key="fade" class="bus-stop fade" aria-hidden="true"><span class="rail"></span></li>`}
    </ol>
  `;
}

function stopsAhead(b) {
  const ahead = b.upcoming ?? (b.nextStop ? [b.nextStop] : []);
  return b.at && ahead[0]?.code === b.at.code ? ahead.slice(1) : ahead;
}

const hiddenAhead = (b) => Math.max(0, stopsAhead(b).length - (AHEAD_SHOWN + 1));

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
  const head = b.towards ? t('Towards {0}', b.towards.name) : where;
  const title = head ? html`<span class="sr-only">${t('{0} bus', b.svc)} </span>${head}` : t('{0} bus', b.svc);
  const sub = b.towards ? where : null;
  const stop = stopOfBus(campus, b);
  const go = (code) => showStop(code, { bus: id, stops: open, all });
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
  const footer =
    stop && html`<button type="button" class="btn small ghost" onClick=${() => go(stop.code)}>${t('Show {0}', stop.name)}</button>`;
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

const PEEK_ROWS = 3;
const WALKER =
  '<circle cx="13" cy="4" r="2" fill="currentColor"/><path d="M12 8l-2 6-3 7M10 14l3 3v4M7 12l2-4h3l2 3 3 1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
const PIN = '<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/>';
const STAR =
  '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>';

function StopSheet({ code, box, onGoTo, onSaved, active }) {
  const campus = useStore(campusData);
  const picked = useStore(selected);
  const p = useStore(profile);
  const stop = campus?.stops.find((s) => s.code === code);
  const [board, setBoard] = useState(null);
  const [all, setAll] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    setSaveMsg(null);
    setAll(false);
    reloadProfile()
      .catch(() => {})
      .finally(() => setAsked(true));
  }, [code]);

  const pub = p?.publicBuses === true;
  const known = Boolean(p) || asked;
  useEffect(() => {
    setBoard(null);
    if (!active || !known) return;
    let timer = null;
    let gone = false;
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
        const data = await getJSON(`/api/arrivals?stop=${encodeURIComponent(code)}${pub ? '&public=1' : ''}&stopped=1`);
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
  const save = async () => {
    setSaving(true);
    try {
      if (!profile.get()) await reloadProfile();
      if (same) {
        let removed = null;
        await saveNow((x) => {
          removed = withoutPlace(x, same.key) ?? removed;
        });
        onSaved?.();
        if (removed) {
          const undo = () =>
            saveNow((x) => restorePlace(x, removed)).then(
              () => onSaved?.(),
              () => toast(t('Not saved. Check your connection.'), { error: true }),
            );
          toast(t('{0} removed from favourites', same.label), { action: { label: t('Undo'), run: undo } });
        }
      } else {
        const keep = {};
        await saveNow((x) => withPlace(x, stop.code, stop.name, keep));
        onSaved?.();
      }
    } catch (err) {
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
  const tile = html`<span class="sheet-tile stop-tile" aria-hidden="true"><${Icon} paths=${PIN} /></span>`;
  const footer = html`
    <button type="button" class="btn small accent" onClick=${() => onGoTo({ code: stop.code, name: stop.name, place: same?.key ?? null })}>${t('Go there')}</button>
    <a class="btn small ghost icon" href=${directions(stop)} target="_blank" rel="noopener" aria-label=${t('Walking directions')} title=${t('Walking directions')}><${Icon} paths=${WALKER} /></a>
    <button type="button" class=${`btn small ghost icon${same ? ' on' : ''}`} disabled=${saving} onClick=${save} aria-pressed=${Boolean(same)} aria-label=${same ? t('Remove from favourites') : t('Add to favourites')} title=${same ? t('Remove from favourites') : t('Add to favourites')}><${Icon} paths=${STAR} /></button>
    ${saveMsg && html`<p class="hint" role="alert">${saveMsg}</p>`}
  `;
  return html`
    <${Frame} id=${`stop-${code}`} title=${stop.name} sub=${sub} lead=${tile} footer=${footer} box=${box}>
      <${SectionBand} text=${t('Buses here')} />
      ${
        !board &&
        html`
        <${Skeleton} said=${t('Checking…')} cls="sheet-board"
          ><${WaitingRows} services=${stop.services.length - PEEK_ROWS > 1 ? stop.services.slice(0, PEEK_ROWS) : stop.services}
        /><//>
      `
      }
      ${
        board?.text &&
        html`
        <div class="sheet-note">
          <div class="hint">${board.text}</div>
          <div class="svc-tags">${stop.services.map((svc) => html`<${SvcTag} svc=${svc} key=${svc} onClick=${() => choose(svc)} />`)}</div>
        </div>
      `
      }
      ${
        rows.length > 0 &&
        html`
        <div class="sheet-board" id="sheet-board">
          ${(all || more <= 1 ? rows : rows.slice(0, PEEK_ROWS)).map((r) => html`<${Row} key=${r.svc} r=${r} picked=${r.svc === picked} onPick=${(svc) => choose(svc === selected.get() ? null : svc)} />`)}
        </div>
        ${more > 1 && html`<button type="button" class="sheet-more" aria-expanded=${String(all)} aria-controls="sheet-board" onClick=${() => setAll(!all)}>${all ? t('Show fewer') : t('Show {0} more', more)}</button>`}
      `
      }
    <//>
  `;
}

export function MapTab({ visible: on, onGoTo, onSaved }) {
  const container = useRef(null);
  const sheetBox = useRef(null);
  const open = useStore(sheet);
  const [state, setState] = useState(map ? 'ready' : 'idle');

  useEffect(() => {
    if (!on) return hide();
    if (map) return resume();
    visible = true;
    setState('loading');
    ensureMap(container.current)
      .then(() => {
        setState('ready');
        if (visible) resume();
      })
      .catch((err) => setState(err.message === 'signed out' ? 'idle' : 'failed'));
  }, [on]);

  useLayoutEffect(() => {
    const code = centreOn;
    const bus = code?.bus;
    const at = bus
      ? open?.bus === bus && (glides.get(bus)?.to ?? shown.get().get(bus))
      : open?.stop === code && campusData.get()?.stops.find((s) => s.code === code);
    if (!at || at.lat == null || !map) return;
    centreOn = null;
    lineFitted = null;
    const sheet = sheetBox.current;
    const beside = window.matchMedia('(min-width: 700px)').matches;
    const go = () =>
      map.easeTo({
        center: [at.lon, at.lat],
        zoom: Math.max(map.getZoom(), 17),
        padding: beside
          ? { top: 70, bottom: 20, left: (sheet?.offsetWidth ?? 0) + 36, right: 20 }
          : { top: 70, bottom: (sheet?.offsetHeight ?? 0) + 20, left: 0, right: 0 },
        duration: 600,
      });
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
