// The dashboard's Timelapse section (#/timelapse, loaded by admin.js when
// it's opened): a day of NUS shuttles, as the recorder kept it
// (/api/timelapse/days, apps/api/src/map/timelapse.ts), replayed on the campus map
// and exported as a video. English only: it's for the operator.
//
// Its state, the map and an export in progress live in this module, not in
// the section: leaving for another section and coming back finds the export
// still running.
//
// The export never records the screen. Each frame is made on purpose: the
// clock is set, the buses' source gets their places at that moment, the
// map is left to finish drawing, and the map and the overlay (clock, date,
// buses per service, the wordmark; or only the map's credit, for footage
// that gets its own words on top) are drawn onto one canvas, which
// Mediabunny encodes. Awaiting each frame's add() lets the encoder set the
// pace, so a slow machine makes the same video, only more slowly.
//
// The map is built here rather than shared with app/map.js: that one is
// the app's interactive map, with its stores, sheets and live polling. This
// one is fixed to the video's size, drawn once per frame, and never moves.

import { html, store, useEffect, useMemo, useRef, useStore } from '/assets/ui.js';
import { busesAt, busesOut, clockAt, countBySvc, decodeDay, timeOn } from '/admin/timelapse/replay.js';
import { MAPLIBRE, PMTILES } from '/app/map-files.js';
import { inkOn } from '/account/dom.js';

// "@" spelled %40, as in app/map-files.js: the static assets redirect the "@" form.
const MEDIABUNNY = '/vendor/mediabunny%401.61.3/mediabunny.min.mjs';
const FPS = 30;
const PRESETS = {
  story: { w: 1080, h: 1920, label: 'Stories' },
  wide: { w: 1920, h: 1080, label: 'Landscape' },
};
/** A frame the map hasn't finished in this long is taken as it is (a tile that never came). */
const SETTLE_MS = 5_000;
const THEMES = {
  dark: { paper: '#0f0e0d', ink: '#f2efeb', muted: '#a39d97', casing: '#0f0e0d' },
  light: { paper: '#fafaf9', ink: '#1c1917', muted: '#6b6560', casing: '#ffffff' },
};

const view = store({
  days: null,
  recording: null,
  date: '',
  day: null,
  loading: false,
  preset: 'story',
  theme: 'dark',
  /** Off: the map and its buses only, centred, for footage cut into another video. */
  overlay: true,
  seconds: 60,
  /** The chosen start and end (epoch ms), or null for the first and last readings. */
  from: null,
  to: null,
  /** Where the preview is, 0 to 1 of the chosen range. */
  scrub: 0,
  /** The preview is playing through the range at the video's speed. */
  playing: false,
  job: null,
  /** The map is being made or changed: nothing can be drawn from it yet. */
  preparing: false,
  note: '',
});

/** The dashboard's session: its token, and how to sign out when it's refused. Set by connect(). */
let session = { token: () => null, signedOut: () => {} };

export function connect(s) {
  session = s;
}

/** What was there when the dashboard signs out (Lock, or a refused token): an export stops, and the day and video go. */
export function forget() {
  const { job } = view.get();
  if (job?.running) job.cancelled = true;
  if (job?.url) URL.revokeObjectURL(job.url);
  view.set((v) => ({
    ...v,
    days: null,
    recording: null,
    date: '',
    day: null,
    loading: false,
    job: null,
    note: '',
    scrub: 0,
    playing: false,
  }));
}

async function api(path) {
  const t = session.token();
  if (!t) {
    session.signedOut();
    return null;
  }
  const res = await fetch(path, { headers: { 'x-health-token': t } }).catch(() => null);
  if (!res) throw new Error("Couldn't reach terminus.");
  if (res.status === 404 && path === '/api/timelapse/days') {
    session.signedOut();
    return null;
  }
  if (!res.ok) throw new Error(res.status === 404 ? 'Nothing was recorded that day.' : `The server answered ${res.status}.`);
  return res;
}

async function loadDays() {
  try {
    const res = await api('/api/timelapse/days');
    if (!res) return;
    const { days, recording } = await res.json();
    view.set((v) => ({ ...v, days, recording, note: '' }));
    if (days.length && !view.get().date) await pick(days[0].date);
  } catch (err) {
    view.set((v) => ({ ...v, note: err.message }));
  }
}

async function pick(date) {
  view.set((v) => ({ ...v, date, day: null, loading: true, note: '', scrub: 0, from: null, to: null, playing: false }));
  try {
    const res = await api(`/api/timelapse/days/${date}`);
    if (!res) return;
    const file = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).json();
    const day = decodeDay(file);
    if (date !== view.get().date) return;
    view.set((v) => ({ ...v, day, loading: false }));
    await setUp();
    await preview();
  } catch (err) {
    view.set((v) => ({ ...v, loading: false, note: `Couldn't load ${date}: ${err.message}` }));
  }
}

/** The stretch of the day the video covers: the chosen times, else every reading. */
function range() {
  const { day, from, to } = view.get();
  if (!day) return null;
  const a = from == null ? day.start : Math.max(day.start, from);
  const b = to == null ? day.end : Math.min(day.end, to);
  return b > a ? { a, b } : null;
}

/** The timeline's span: the recorder's whole window (06:30 to 00:30), so a day still recording shows how much is to come. */
function windowOf(day) {
  return { a: Math.min(day.start, timeOn(day.date, '06:30')), b: Math.max(day.end, timeOn(day.date, '00:30')) };
}

/** Plays the preview through the range at the speed the video will, from where it is (or the start, at the end). */
function play() {
  const v = view.get();
  if (v.playing) return stop();
  if (!range() || v.job?.running) return;
  const from = v.scrub >= 1 ? 0 : v.scrub;
  const t0 = performance.now();
  view.set((x) => ({ ...x, playing: true, scrub: from }));
  const tick = () => {
    const now = view.get();
    if (!now.playing) return;
    const scrub = Math.min(1, from + (performance.now() - t0) / (now.seconds * 1000));
    view.set((x) => ({ ...x, scrub, playing: scrub < 1 }));
    // preview() draws the latest moment asked for and skips the ones it couldn't keep up with.
    preview().catch(() => {});
    if (scrub < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function stop() {
  if (view.get().playing) view.set((x) => ({ ...x, playing: false }));
}

let ml = null;
let map = null;
/** What the map is set up for: size, theme and day. */
let shape = '';
/** The canvas the video is made from: the map, then the overlay on top. */
const composite = document.createElement('canvas');
const overlay = document.createElement('canvas');
const mark = new Image();
mark.src = '/assets/mark.svg';
/** The map draws here at the video's exact size, off screen; the preview shows its frames. Outside
 *  the section, so the map outlives a visit to another one. */
const stage = document.createElement('div');
stage.id = 'stage';
stage.setAttribute('aria-hidden', 'true');
document.body.append(stage);

const sizeOf = () => PRESETS[view.get().preset];
const scaleOf = ({ w, h }) => Math.min(w, h) / 1080;
const styleUrl = () => `/map/style.json?theme=${view.get().theme}&lang=en`;

/** The setup in progress, if any. One at a time; an export waits for it,
 *  and the button stays off until it's done (`preparing`). */
let setting = null;

/** The map at the video's size, theme and day, made or changed to fit. */
function setUp() {
  const run = (setting ?? Promise.resolve()).catch(() => {}).then(prepare);
  setting = run;
  view.set((v) => ({ ...v, preparing: true }));
  run
    .finally(() => {
      if (setting !== run) return;
      setting = null;
      view.set((v) => ({ ...v, preparing: false }));
    })
    .catch(() => {});
  return run;
}

/** [event] from the map, or an error after a minute: a style that never
 *  loads mustn't hold every later setup (and the export) behind it. */
const mapEvent = (event) =>
  new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`The map did not finish loading (${event}).`)), 60_000);
    map.once(event, () => {
      clearTimeout(timer);
      ok();
    });
  });

async function prepare() {
  const { day, theme, overlay: words } = view.get();
  if (!day) return;
  const { w, h } = sizeOf();
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  for (const c of [composite, overlay]) {
    c.width = w;
    c.height = h;
  }
  const want = `${w}x${h} ${theme} ${day.date} ${words}`;
  if (shape === want && map) return;
  // Unknown until this finishes: a change that fails part way leaves the map
  // in neither shape, and the next setup redoes it in full.
  const was = shape;
  shape = '';
  if (!ml) {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${MAPLIBRE}maplibre-gl.css`;
    document.head.append(css);
    const [maplibre, { Protocol }] = await Promise.all([import(`${MAPLIBRE}maplibre-gl.mjs`), import(PMTILES)]);
    ml = maplibre;
    ml.addProtocol('pmtiles', new Protocol({ metadata: true }).tile);
  }
  // The fonts the overlay is drawn in, before the first frame uses them.
  await Promise.all([
    document.fonts.load('700 100px "Space Grotesk"'),
    document.fonts.load('500 40px Inter'),
    mark.decode().catch(() => {}),
  ]);
  const f = framing(day, w, h, words);
  if (!map) {
    map = new ml.Map({
      container: stage,
      style: styleUrl(),
      bounds: f.bounds,
      fitBoundsOptions: { padding: f.padding },
      interactive: false,
      attributionControl: false,
      // One map pixel per video pixel, whatever the screen.
      pixelRatio: 1,
      // Kept after drawing, so each frame can be copied off the map's canvas.
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
      // Labels appear at once: a fade would differ from frame to frame.
      fadeDuration: 0,
      localIdeographFontFamily: "'PingFang SC', 'Noto Sans SC', sans-serif",
    });
    map.on('style.load', () => addLayers());
    await mapEvent('load');
  } else {
    map.resize();
    if (!was.includes(` ${theme} `)) {
      map.setStyle(styleUrl());
      await mapEvent('style.load');
    } else {
      addLayers();
    }
    map.fitBounds(f.bounds, { padding: f.padding, duration: 0 });
  }
  shape = want;
  await settled();
}

/** Where the campus sits in the frame: clear of the clock (above in a story, to the left in landscape), or centred without it. */
function framing(day, w, h, words) {
  const core = day.stops.filter((s) => s.core);
  const lons = core.map((s) => s.lon);
  const lats = core.map((s) => s.lat);
  const bounds = [
    [Math.min(...lons), Math.min(...lats)],
    [Math.max(...lons), Math.max(...lats)],
  ];
  const padding = !words
    ? { top: h * 0.08, bottom: h * 0.08, left: w * 0.06, right: w * 0.06 }
    : h > w
      ? { top: h * 0.24, bottom: h * 0.08, left: w * 0.06, right: w * 0.06 }
      : { top: h * 0.08, bottom: h * 0.08, left: w * 0.3, right: w * 0.05 };
  return { bounds, padding };
}

const empty = { type: 'FeatureCollection', features: [] };

/** Routes, stops and buses, sized for the video. Again after each style change. */
function addLayers() {
  const { day, theme } = view.get();
  if (!map || !day) return;
  const k = scaleOf(sizeOf());
  const c = THEMES[theme];
  for (const id of ['buses', 'stops', 'routes', 'route-casing']) if (map.getLayer(id)) map.removeLayer(id);
  for (const id of ['buses', 'stops', 'routes']) if (map.getSource(id)) map.removeSource(id);
  map.addSource('routes', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: Object.entries(day.routes).map(([svc, r]) => ({
        type: 'Feature',
        properties: { svc, color: r.color },
        geometry: { type: 'LineString', coordinates: r.line },
      })),
    },
  });
  map.addSource('stops', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: day.stops.map((s) => ({
        type: 'Feature',
        properties: { code: s.code },
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      })),
    },
  });
  map.addSource('buses', { type: 'geojson', data: empty });
  map.addLayer({
    id: 'route-casing',
    type: 'line',
    source: 'routes',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': c.casing, 'line-width': 9 * k, 'line-opacity': 0.8 },
  });
  map.addLayer({
    id: 'routes',
    type: 'line',
    source: 'routes',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 4.5 * k, 'line-opacity': 0.55 },
  });
  map.addLayer({
    id: 'stops',
    type: 'circle',
    source: 'stops',
    paint: { 'circle-radius': 3.5 * k, 'circle-color': c.paper, 'circle-stroke-color': c.ink, 'circle-stroke-width': 1.5 * k },
  });
  map.addLayer({
    id: 'buses',
    type: 'circle',
    source: 'buses',
    paint: {
      'circle-radius': 10 * k,
      'circle-color': ['get', 'color'],
      'circle-opacity': ['get', 'alpha'],
      'circle-stroke-color': c.paper,
      'circle-stroke-width': 3 * k,
      'circle-stroke-opacity': ['get', 'alpha'],
    },
  });
}

/** Resolves once the map has drawn everything it was given (or SETTLE_MS on). */
function settled() {
  return new Promise((ok) => {
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      map.off('idle', done);
      ok();
    };
    map.on('idle', done);
    timer = setTimeout(done, SETTLE_MS);
    map.triggerRepaint();
  });
}

/** Draws the moment [t] onto the composite canvas: the map with its buses, then the overlay. */
async function frameAt(t) {
  const { day } = view.get();
  if (!map?.getSource('buses')) throw new Error("The map isn't ready yet. Try again in a moment.");
  const buses = busesAt(day, t);
  // Listening before the change, so the map's "done" can't come and go unseen.
  const done = settled();
  map.getSource('buses').setData({
    type: 'FeatureCollection',
    features: buses.map((b) => ({
      type: 'Feature',
      properties: { color: b.color, alpha: b.alpha },
      geometry: { type: 'Point', coordinates: [b.lon, b.lat] },
    })),
  });
  await done;
  drawOverlay(t, countBySvc(buses));
  const g = composite.getContext('2d');
  g.drawImage(map.getCanvas(), 0, 0, composite.width, composite.height);
  g.drawImage(overlay, 0, 0);
}

/** The clock, the date, buses per service and the wordmark, on a clear canvas. */
function drawOverlay(t, counts) {
  const { day, theme } = view.get();
  const { w, h } = sizeOf();
  const k = scaleOf({ w, h });
  const c = THEMES[theme];
  const story = h > w;
  const g = overlay.getContext('2d');
  g.clearRect(0, 0, w, h);
  if (!view.get().overlay) return credit(g, w, h, k, c);

  // A wash behind the text, so it reads over the streets.
  const wash = story ? g.createLinearGradient(0, 0, 0, h * 0.3) : g.createLinearGradient(0, 0, w * 0.36, 0);
  wash.addColorStop(0, `${c.paper}f0`);
  wash.addColorStop(0.7, `${c.paper}b0`);
  wash.addColorStop(1, `${c.paper}00`);
  g.fillStyle = wash;
  g.fillRect(0, 0, story ? w : w * 0.36, story ? h * 0.3 : h);

  const x = 64 * k;
  let y = (story ? 210 : 230) * k;
  g.textBaseline = 'alphabetic';
  g.fillStyle = c.ink;
  g.font = `700 ${170 * k}px "Space Grotesk", sans-serif`;
  g.fillText(clockAt(t), x - 6 * k, y);
  y += 64 * k;
  const date = new Date(t).toLocaleDateString('en-SG', {
    timeZone: 'Asia/Singapore',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const out = `${total} ${total === 1 ? 'bus' : 'buses'} out`;
  g.font = `500 ${40 * k}px Inter, sans-serif`;
  g.fillStyle = c.muted;
  // A story has the width for one line; landscape keeps to its column, left of the map.
  if (story) g.fillText(`${date} · ${out}`, x, y);
  else {
    g.fillText(date, x, y);
    y += 54 * k;
    g.fillText(out, x, y);
  }

  y += 40 * k;
  const chipH = 58 * k;
  const gap = 12 * k;
  let cx = x;
  g.font = `700 ${30 * k}px "Space Grotesk", sans-serif`;
  for (const svc of day.services) {
    const n = counts[svc] ?? 0;
    const label = `${svc}  ${n}`;
    const chipW = g.measureText(label).width + 36 * k;
    if (story && cx + chipW > w - x) {
      cx = x;
      y += chipH + gap;
    }
    g.globalAlpha = n ? 1 : 0.35;
    g.fillStyle = day.routes[svc].color;
    g.beginPath();
    g.roundRect(cx, y, chipW, chipH, chipH / 2);
    g.fill();
    g.fillStyle = inkOn(day.routes[svc].color);
    g.fillText(label, cx + 18 * k, y + chipH / 2 + 11 * k);
    g.globalAlpha = 1;
    if (story) cx += chipW + gap;
    else y += chipH + gap;
  }

  const size = 46 * k;
  const by = h - 56 * k;
  g.font = `700 ${size}px "Space Grotesk", sans-serif`;
  const nus = g.measureText('nus').width;
  g.font = `400 ${size}px "Space Grotesk", sans-serif`;
  const termi = g.measureText('termi').width;
  const right = w - 56 * k;
  const left = right - nus - termi;
  g.fillStyle = c.ink;
  g.fillText('termi', left, by);
  g.font = `700 ${size}px "Space Grotesk", sans-serif`;
  g.fillText('nus', left + termi, by);
  if (mark.complete && mark.naturalWidth) g.drawImage(mark, left - size * 1.25, by - size * 0.95, size, size);
  credit(g, w, h, k, c);
}

/** The street map's data, credited as its licence asks: with the overlay off too. */
function credit(g, w, h, k, c) {
  g.font = `400 ${20 * k}px Inter, sans-serif`;
  g.fillStyle = c.muted;
  g.fillText('Map data © OpenStreetMap contributors', 56 * k, h - 56 * k);
}

/** One frame at a time; a newer request while one draws replaces the waiting one. */
let drawing = null;
let wanted = null;

async function preview() {
  const r = range();
  // Not while the map is being set up: preview() runs again once it is.
  if (!r || !map || setting || view.get().job?.running) return;
  wanted = r.a + (r.b - r.a) * view.get().scrub;
  if (drawing) return;
  try {
    while (wanted !== null) {
      const t = wanted;
      wanted = null;
      drawing = frameAt(t);
      await drawing;
    }
  } finally {
    // A frame that failed mustn't leave the preview (and the export, which waits for it) stuck on it.
    drawing = null;
    wanted = null;
  }
  view.set((v) => ({ ...v }));
}

async function exportVideo() {
  const r = range();
  if (!r) return view.set((v) => ({ ...v, note: 'Pick an end time after the start time.' }));
  const { w, h } = sizeOf();
  const { seconds, date, preset } = view.get();
  const frames = Math.max(1, Math.round(seconds * FPS));
  const prev = view.get().job;
  if (prev?.url) URL.revokeObjectURL(prev.url);
  const job = {
    running: true,
    cancelled: false,
    done: 0,
    total: frames,
    started: performance.now(),
    eta: null,
    url: null,
    error: null,
    codec: null,
    size: 0,
  };
  view.set((v) => ({ ...v, job, note: '', playing: false }));
  // Not once forget() has dropped it: a stopped export doesn't come back.
  const update = (patch) => view.set((v) => (v.job === job ? { ...v, job: Object.assign(job, patch) } : v));

  let output = null;
  try {
    // The map first: a frame needs its layers in place.
    await setting;
    // The preview's frame out of the way; if it failed, that was the preview's problem, not this video's.
    await drawing?.catch(() => {});
    const { BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH, WebMOutputFormat, canEncodeVideo } = await import(
      MEDIABUNNY
    );
    const opts = { width: w, height: h, frameRate: FPS, quality: QUALITY_HIGH };
    // H.264 in MP4 where the browser can; VP9 in WebM where it can't.
    const avc = await canEncodeVideo('avc', opts);
    if (!avc && !(await canEncodeVideo('vp9', opts))) throw new Error('This browser can encode neither H.264 nor VP9 video.');
    update({ codec: avc ? 'H.264 MP4' : 'VP9 WebM' });
    output = new Output({
      format: avc ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
      target: new BufferTarget(),
    });
    const source = new CanvasSource(composite, { codec: avc ? 'avc' : 'vp9', quality: QUALITY_HIGH });
    output.addVideoTrack(source, { frameRate: FPS });
    await output.start();
    for (let i = 0; i < frames; i++) {
      if (job.cancelled) {
        await output.cancel();
        return update({ running: false, done: 0 });
      }
      // The first frame is the start, the last the end.
      await frameAt(r.a + ((r.b - r.a) * i) / Math.max(1, frames - 1));
      await source.add(i / FPS, 1 / FPS);
      if (i % 5 === 4 || i === frames - 1) {
        const spent = performance.now() - job.started;
        update({ done: i + 1, eta: (spent / (i + 1)) * (frames - i - 1) });
      }
    }
    await output.finalize();
    const blob = new Blob([output.target.buffer], { type: avc ? 'video/mp4' : 'video/webm' });
    const name = `terminus-${date}-${preset}${view.get().overlay ? '' : '-clean'}.${avc ? 'mp4' : 'webm'}`;
    update({ running: false, url: URL.createObjectURL(blob), size: blob.size, name, took: performance.now() - job.started });
  } catch (err) {
    if (output && output.state !== 'canceled' && output.state !== 'finalized') await output.cancel().catch(() => {});
    update({ running: false, error: err.message ?? String(err) });
  }
}

const mins = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
};
const mb = (n) => (n < 1_048_576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1_048_576).toFixed(1)} MB`);
/** "Fri 6 Nov", for a day's date. */
const dayName = (date) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
const count = (n) => n.toLocaleString('en-GB');

const MIN = 60_000;
const SGT_MS = 8 * 3_600_000;
/** The timeline's chart: ten-minute slices of the 18-hour window. */
const SLICES = 108;
const LENGTHS = [30, 60, 90];

function Recording({ r }) {
  if (!r) return null;
  const words = {
    polling: 'recording',
    resting: 'waiting for the first bus',
    off: 'switched off',
    done: 'finished for the day',
    idle: 'not started',
  };
  const live = r.enabled && r.state === 'polling';
  return html`<p class=${live ? 'rec live' : 'rec'}>${`Today: ${r.enabled ? (words[r.state] ?? r.state) : 'switched off'}${r.samples ? ` · ${count(r.samples)} readings so far` : ''}`}</p>`;
}

function Progress({ job }) {
  if (!job) return null;
  if (job.error) return html`<p class="bad job">${`The export stopped: ${job.error}`}</p>`;
  if (job.running) {
    return html`
      <div class="job">
        <div class="bar"><div style=${{ width: `${(job.done / job.total) * 100}%` }}></div></div>
        <div class="meta">${`Frame ${job.done} of ${job.total}${job.codec ? ` · ${job.codec}` : ''}${job.eta != null ? ` · about ${mins(job.eta)} left` : ''}`}</div>
        <button class="btn ghost small" type="button" onClick=${() => (job.cancelled = true)}>Cancel</button>
      </div>
    `;
  }
  if (job.url) {
    return html`
      <div class="job done">
        <div class="meta">${`Ready: ${job.codec} · ${mb(job.size)} · ${job.total} frames in ${mins(job.took)}`}</div>
        <a class="btn accent" href=${job.url} download=${job.name}>Download the video</a>
      </div>
    `;
  }
  return html`<p class="hint job">Cancelled.</p>`;
}

/** Buttons for one choice of a few, the chosen one lit. */
function Seg({ label, value, options, onPick, disabled }) {
  return html`
    <div class="seg" role="group" aria-label=${label}>
      ${options.map(
        ([key, text]) =>
          html`<button type="button" class=${value === key ? 'on' : ''} aria-pressed=${value === key} disabled=${disabled} onClick=${() => value !== key && onPick(key)}>${text}</button>`,
      )}
    </div>
  `;
}

/** Every three hours on the clock across the window, with its ends, clear of each other. */
function ticksOf(win) {
  const step = 3 * 3_600_000;
  const out = [win.a];
  for (let t = Math.ceil((win.a + SGT_MS) / step) * step - SGT_MS; t < win.b; t += step) {
    if (t - win.a > 40 * MIN && win.b - t > 40 * MIN) out.push(t);
  }
  return [...out, win.b];
}

const PLAY = html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9.5-5.5z" /></svg>`;
const PAUSE = html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z" /></svg>`;

/**
 * The day as a chart of buses out, with the video's start and end as handles
 * to drag and the preview's moment as a line. Dragging a handle previews that
 * end; a click anywhere else moves the preview there.
 */
function Timeline({ v, r, busy, set }) {
  const box = useRef(null);
  const drag = useRef(null);
  const { day } = v;
  const win = windowOf(day);
  const counts = useMemo(() => busesOut(day, win.a, win.b, SLICES), [day, win.a, win.b]);
  const most = Math.max(1, ...counts);
  const span = win.b - win.a;
  const pct = (t) => `${((t - win.a) / span) * 100}%`;
  const live = v.days?.some((d) => d.date === day.date && !d.closed);
  const head = r.a + (r.b - r.a) * v.scrub;

  const timeAt = (e) => {
    const rect = box.current.getBoundingClientRect();
    const k = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    return Math.round((win.a + k * span) / MIN) * MIN;
  };
  // From the range as it is now, not as it was drawn: a drag changes it between renders.
  const move = (what, t) => {
    const now = range();
    if (!now) return;
    if (what === 'from') set({ from: Math.max(day.start, Math.min(t, now.b - MIN)), scrub: 0 });
    else if (what === 'to') set({ to: Math.min(day.end, Math.max(t, now.a + MIN)), scrub: 1 });
    else set({ scrub: Math.max(0, Math.min(1, (t - now.a) / (now.b - now.a))) });
  };
  const down = (e) => {
    if (busy || e.button !== 0) return;
    stop();
    // A handle under the pointer wins over the line drawn on top of it: at either end of the range they overlap.
    const under = document.elementsFromPoint(e.clientX, e.clientY).map((el) => el.closest('[data-grip]')?.dataset.grip);
    drag.current = under.find((g) => g === 'from' || g === 'to') ?? 'head';
    e.currentTarget.setPointerCapture(e.pointerId);
    move(drag.current, timeAt(e));
  };
  const dragTo = (e) => drag.current && move(drag.current, timeAt(e));
  const up = () => (drag.current = null);
  const key = (what) => (e) => {
    const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    const now = range();
    if (!step || busy || !now) return;
    e.preventDefault();
    stop();
    const at = what === 'from' ? now.a : what === 'to' ? now.b : now.a + (now.b - now.a) * view.get().scrub;
    // From the minute the handle shows (clockAt rounds down), so every press moves what's shown.
    move(what, Math.floor(at / MIN) * MIN + step * (e.shiftKey ? 10 : 1) * MIN);
  };
  // A label near an end of the track keeps inside it.
  const edge = (t) => ((t - win.a) / span < 0.04 ? 'grip at-a' : (win.b - t) / span < 0.04 ? 'grip at-b' : 'grip');
  const slider = (what, label, t) => ({
    'data-grip': what,
    role: 'slider',
    tabindex: busy ? -1 : 0,
    'aria-label': label,
    'aria-valuemin': 0,
    'aria-valuemax': 100,
    'aria-valuenow': Math.round(((t - win.a) / span) * 100),
    'aria-valuetext': clockAt(t),
    style: { left: pct(t) },
    onKeyDown: key(what),
  });

  return html`
    <div class=${busy ? 'timeline busy' : 'timeline'}>
      <p class="cap">Buses out through the day. Drag the orange handles to choose what the video covers.</p>
      <button class="play" type="button" disabled=${busy} aria-label=${v.playing ? 'Pause the preview' : 'Play the preview'} onClick=${play}>
        ${v.playing ? PAUSE : PLAY}
      </button>
      <div class="track" ref=${box} onPointerDown=${down} onPointerMove=${dragTo} onPointerUp=${up} onPointerCancel=${up}>
        <div class="bars">
          ${counts.map((n, i) => {
            const t = win.a + ((i + 0.5) * span) / SLICES;
            // Nothing recorded there: before the first reading, or still to come.
            if (t < day.start || t > day.end) return html`<i class="none"></i>`;
            return html`<i class=${t < r.a || t > r.b ? 'out' : ''} style=${{ height: `${Math.max(4, (n / most) * 100)}%` }}></i>`;
          })}
        </div>
        ${
          live
            ? html`<div class="now" style=${{ left: pct(day.end) }}>
                ${Math.abs(head - day.end) > span * 0.04 ? html`<span>now</span>` : null}
              </div>`
            : null
        }
        <div class=${edge(r.a)} ...${slider('from', 'Start of the video', r.a)}><span>${clockAt(r.a)}</span></div>
        <div class=${edge(r.b)} ...${slider('to', 'End of the video', r.b)}><span>${clockAt(r.b)}</span></div>
        <div class="head" ...${slider('head', 'Moment shown in the preview', head)}><span>${clockAt(head)}</span></div>
      </div>
      <div class="ticks">${ticksOf(win).map((t) => html`<span style=${{ left: pct(t) }}>${clockAt(t)}</span>`)}</div>
    </div>
  `;
}

function Studio() {
  const v = useStore(view);
  const canvas = useRef(null);
  useEffect(() => {
    // The composite canvas is the preview: the frames show here as they're made.
    if (canvas.current && composite.parentNode !== canvas.current) canvas.current.replaceChildren(composite);
  });
  const busy = Boolean(v.job?.running);
  const set = (patch, redraw = 'frame') => {
    view.set((x) => ({ ...x, ...patch }));
    const failed = (err) => view.set((x) => ({ ...x, note: err.message }));
    if (redraw === 'setup') setUp().then(preview).catch(failed);
    else preview().catch(failed);
  };
  const setup = (patch) => {
    stop();
    set(patch, 'setup');
  };
  const length = (seconds) => {
    stop();
    view.set((x) => ({ ...x, seconds }));
  };
  const r = range();

  if (v.days && !v.days.length) {
    return html`<${Recording} r=${v.recording} /><p>No days recorded yet. The recorder runs from 06:30 to 00:30 Singapore time while it's switched on.</p>`;
  }
  const { w, h } = PRESETS[v.preset];
  const custom = !LENGTHS.includes(v.seconds);
  const faster = r ? Math.round((r.b - r.a) / (v.seconds * 1000)) : 0;
  return html`
    <${Recording} r=${v.recording} />
    <div class="tl-bar">
      <select aria-label="Day" value=${v.date} disabled=${busy} onChange=${(e) => pick(e.currentTarget.value)}>
        ${(v.days ?? []).map((d) => html`<option value=${d.date}>${`${dayName(d.date)} · ${d.closed ? mb(d.bytes) : 'recording'}`}</option>`)}
      </select>
      <span class="sep"></span>
      <${Seg}
        label="Shape of the video"
        value=${v.preset}
        options=${Object.entries(PRESETS).map(([key, p]) => [key, p.label])}
        disabled=${busy}
        onPick=${(preset) => setup({ preset })}
      />
      <${Seg}
        label="Map"
        value=${v.theme}
        options=${[
          ['dark', 'Dark map'],
          ['light', 'Light map'],
        ]}
        disabled=${busy}
        onPick=${(theme) => setup({ theme })}
      />
      <${Seg}
        label="Overlay"
        value=${v.overlay ? 'on' : 'off'}
        options=${[
          ['on', 'Clock and counts'],
          ['off', 'Map only'],
        ]}
        disabled=${busy}
        onPick=${(k) => setup({ overlay: k === 'on' })}
      />
      <span class="sep"></span>
      <span class="len">
        <${Seg} label="Length of the video" value=${custom ? null : v.seconds} options=${LENGTHS.map((s) => [s, `${s} s`])} disabled=${busy} onPick=${length} />
        <label class="secs">
          <input
            type="number"
            min="2"
            max="600"
            step="1"
            placeholder="Other"
            aria-label="Other length, in seconds"
            value=${custom ? v.seconds : ''}
            disabled=${busy}
            onChange=${(e) => {
              const n = Math.round(Number(e.currentTarget.value));
              if (n) length(Math.max(2, Math.min(600, n)));
              else e.currentTarget.value = custom ? v.seconds : '';
            }}
          />
          s
        </label>
      </span>
    </div>
    <div class=${`theatre ${v.preset}`}>
      ${v.loading ? html`<p class="hint">Loading the day…</p>` : null}
      <div class="screen" ref=${canvas}></div>
      ${v.day && r ? html`<${Timeline} v=${v} r=${r} busy=${busy} set=${set} />` : null}
    </div>
    <div class="export">
      <div class="what">
        <strong>${r ? `${v.seconds} s video of ${clockAt(r.a)} to ${clockAt(r.b)}` : v.day ? 'Nothing recorded to export' : 'Choose a day'}</strong>
        <span class="hint">${`${w} × ${h} · ${count(Math.round(v.seconds * FPS))} frames at ${FPS} a second${faster > 1 ? ` · ${count(faster)} times faster than real time` : ''}`}</span>
      </div>
      ${busy ? null : html`<button class="btn accent" type="button" disabled=${v.preparing || !r || !v.day} onClick=${exportVideo}>Export the video</button>`}
      <${Progress} job=${v.job} />
    </div>
  `;
}

/** The section. Each visit asks for the days again, so today's count of readings is current. */
export function Timelapse() {
  const v = useStore(view);
  useEffect(() => {
    loadDays();
  }, []);
  return html`
    <div class="timelapse">
      ${v.note && html`<p class="bad">${v.note}</p>`}
      ${v.days ? html`<${Studio} />` : html`<p class="hint">Loading…</p>`}
    </div>
  `;
}
