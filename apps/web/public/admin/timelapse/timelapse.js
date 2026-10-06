// The timelapse: a day of NUS shuttles, as the recorder kept it
// (/timelapse/days, apps/api/src/timelapse.ts), replayed on the campus map
// and exported as a video. English only: it's for the operator.
//
// The export never records the screen. Each frame is made on purpose: the
// clock is set, the buses' source gets their places at that moment, the
// map is left to finish drawing, and the map and the overlay (clock, date,
// buses per service, the wordmark) are drawn onto one canvas, which
// Mediabunny encodes. Awaiting each frame's add() lets the encoder set the
// pace, so a slow machine makes the same video, only more slowly.
//
// The map is built here rather than shared with app/map.js: that one is
// the app's interactive map, with its stores, sheets and live polling. This
// one is fixed to the video's size, drawn once per frame, and never moves.

import { html, render, store, useEffect, useRef, useStore } from '/assets/ui.js';
import { busesAt, clockAt, countBySvc, decodeDay, timeOn } from '/admin/timelapse/replay.js';

// "@" spelled %40, as in app/map.js: the static assets redirect the "@" form.
const MAPLIBRE = '/vendor/maplibre-gl%406.11.2/';
const PMTILES = '/vendor/pmtiles%404.5.0/pmtiles.mjs';
const MEDIABUNNY = '/vendor/mediabunny%401.61.3/mediabunny.min.mjs';
const KEY = 'terminus-operator-token';
const FPS = 30;
const PRESETS = {
  story: { w: 1080, h: 1920, label: 'Stories, 1080 × 1920' },
  wide: { w: 1920, h: 1080, label: 'Landscape, 1920 × 1080' },
};
/** A frame the map hasn't finished in this long is taken as it is (a tile that never came). */
const SETTLE_MS = 5_000;
const THEMES = {
  dark: { paper: '#0f0e0d', ink: '#f2efeb', muted: '#a39d97', casing: '#0f0e0d' },
  light: { paper: '#fafaf9', ink: '#1c1917', muted: '#6b6560', casing: '#ffffff' },
};

const view = store({
  locked: false,
  msg: '',
  days: null,
  recording: null,
  date: '',
  day: null,
  loading: false,
  preset: 'story',
  theme: 'dark',
  seconds: 60,
  from: '',
  to: '',
  /** Where the preview is, 0 to 1 of the chosen range. */
  scrub: 0,
  job: null,
  /** The map is being made or changed: nothing can be drawn from it yet. */
  preparing: false,
  note: '',
});

/* ---------- the token ---------- */

function token() {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function remember(t) {
  try {
    if (t) sessionStorage.setItem(KEY, t);
    else sessionStorage.removeItem(KEY);
  } catch {
    // Without storage the token lasts until the page reloads.
  }
}

let memory = null;

async function api(path) {
  const t = memory ?? token();
  if (!t) {
    view.set((v) => ({ ...v, locked: true }));
    return null;
  }
  const res = await fetch(path, { headers: { 'x-health-token': t } }).catch(() => null);
  if (!res) throw new Error("Couldn't reach terminus.");
  if (res.status === 404 && path === '/timelapse/days') {
    remember(null);
    memory = null;
    view.set((v) => ({ ...v, locked: true, msg: 'That token was not accepted.' }));
    return null;
  }
  if (!res.ok) throw new Error(res.status === 404 ? 'Nothing was recorded that day.' : `The server answered ${res.status}.`);
  return res;
}

async function loadDays() {
  try {
    const res = await api('/timelapse/days');
    if (!res) return;
    const { days, recording } = await res.json();
    view.set((v) => ({ ...v, locked: false, msg: '', days, recording, note: '' }));
    if (days.length && !view.get().date) await pick(days[0].date);
  } catch (err) {
    view.set((v) => ({ ...v, note: err.message }));
  }
}

/* ---------- a day ---------- */

async function pick(date) {
  view.set((v) => ({ ...v, date, day: null, loading: true, note: '', scrub: 0 }));
  try {
    const res = await api(`/timelapse/days/${date}`);
    if (!res) return;
    // The day file is gzipped JSON, as it's kept.
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
  const a = from ? Math.max(day.start, timeOn(day.date, from)) : day.start;
  const b = to ? Math.min(day.end, timeOn(day.date, to)) : day.end;
  return b > a ? { a, b } : null;
}

/* ---------- the map ---------- */

let ml = null;
let map = null;
/** What the map is set up for: size, theme and day. */
let shape = '';
/** The canvas the video is made from: the map, then the overlay on top. */
const composite = document.createElement('canvas');
const overlay = document.createElement('canvas');
const mark = new Image();
mark.src = '/assets/mark.svg';

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
  const { day, theme } = view.get();
  if (!day) return;
  const { w, h } = sizeOf();
  const stage = document.getElementById('stage');
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  for (const c of [composite, overlay]) {
    c.width = w;
    c.height = h;
  }
  const want = `${w}x${h} ${theme} ${day.date}`;
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
  await Promise.all([document.fonts.load('700 100px "Space Grotesk"'), document.fonts.load('500 40px Inter'), mark.decode().catch(() => {})]);
  if (!map) {
    map = new ml.Map({
      container: stage,
      style: styleUrl(),
      bounds: framing(day, w, h).bounds,
      fitBoundsOptions: { padding: framing(day, w, h).padding },
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
    const f = framing(day, w, h);
    map.fitBounds(f.bounds, { padding: f.padding, duration: 0 });
  }
  shape = want;
  await settled();
}

/** Where the campus sits in the frame: clear of the clock (above in a story, to the left in landscape). */
function framing(day, w, h) {
  const core = day.stops.filter((s) => s.core);
  const lons = core.map((s) => s.lon);
  const lats = core.map((s) => s.lat);
  const bounds = [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]];
  const padding = h > w ? { top: h * 0.24, bottom: h * 0.08, left: w * 0.06, right: w * 0.06 } : { top: h * 0.08, bottom: h * 0.08, left: w * 0.3, right: w * 0.05 };
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
    data: { type: 'FeatureCollection', features: Object.entries(day.routes).map(([svc, r]) => ({ type: 'Feature', properties: { svc, color: r.color }, geometry: { type: 'LineString', coordinates: r.line } })) },
  });
  map.addSource('stops', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: day.stops.map((s) => ({ type: 'Feature', properties: { code: s.code }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } })) },
  });
  map.addSource('buses', { type: 'geojson', data: empty });
  map.addLayer({ id: 'route-casing', type: 'line', source: 'routes', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': c.casing, 'line-width': 9 * k, 'line-opacity': 0.8 } });
  map.addLayer({ id: 'routes', type: 'line', source: 'routes', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 4.5 * k, 'line-opacity': 0.55 } });
  map.addLayer({ id: 'stops', type: 'circle', source: 'stops', paint: { 'circle-radius': 3.5 * k, 'circle-color': c.paper, 'circle-stroke-color': c.ink, 'circle-stroke-width': 1.5 * k } });
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

/* ---------- one frame ---------- */

/** Draws the moment [t] onto the composite canvas: the map with its buses, then the overlay. */
async function frameAt(t) {
  const { day } = view.get();
  if (!map?.getSource('buses')) throw new Error("The map isn't ready yet. Try again in a moment.");
  const buses = busesAt(day, t);
  // Listening before the change, so the map's "done" can't come and go unseen.
  const done = settled();
  map.getSource('buses').setData({
    type: 'FeatureCollection',
    features: buses.map((b) => ({ type: 'Feature', properties: { color: b.color, alpha: b.alpha }, geometry: { type: 'Point', coordinates: [b.lon, b.lat] } })),
  });
  await done;
  drawOverlay(t, countBySvc(buses));
  const g = composite.getContext('2d');
  g.drawImage(map.getCanvas(), 0, 0, composite.width, composite.height);
  g.drawImage(overlay, 0, 0);
}

/** Black or white, whichever reads on [hex]. */
function inkOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return l > 0.36 ? '#1c1917' : '#ffffff';
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
  const date = new Date(t).toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
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

  // Each service in its colour with its buses out now; none out, faded.
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

  // The wordmark, bottom right: the mark, then "termi" and a bold "nus".
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
  // The street map's data, credited as its licence asks.
  g.font = `400 ${20 * k}px Inter, sans-serif`;
  g.fillStyle = c.muted;
  g.fillText('Map data © OpenStreetMap contributors', 56 * k, h - 56 * k);
}

/* ---------- the preview ---------- */

/** One frame at a time; a newer request while one draws replaces the waiting one. */
let drawing = null;
let wanted = null;

async function preview() {
  const r = range();
  // Not while the map is being set up: preview() runs again once it is.
  if (!r || !map || setting || view.get().job?.running) return;
  wanted = r.a + (r.b - r.a) * view.get().scrub;
  if (drawing) return;
  while (wanted !== null) {
    const t = wanted;
    wanted = null;
    drawing = frameAt(t);
    await drawing;
    drawing = null;
  }
  view.set((v) => ({ ...v }));
}

/* ---------- the export ---------- */

async function exportVideo() {
  const r = range();
  if (!r) return view.set((v) => ({ ...v, note: 'Pick an end time after the start time.' }));
  const { w, h } = sizeOf();
  const { seconds, date, preset } = view.get();
  const frames = Math.max(1, Math.round(seconds * FPS));
  const prev = view.get().job;
  if (prev?.url) URL.revokeObjectURL(prev.url);
  const job = { running: true, cancelled: false, done: 0, total: frames, started: performance.now(), eta: null, url: null, error: null, codec: null, size: 0 };
  view.set((v) => ({ ...v, job, note: '' }));
  const update = (patch) => view.set((v) => ({ ...v, job: Object.assign(job, patch) }));

  let output = null;
  try {
    // The map first: a frame needs its layers in place.
    await setting;
    await drawing;
    const { BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH, WebMOutputFormat, canEncodeVideo } = await import(MEDIABUNNY);
    const opts = { width: w, height: h, frameRate: FPS, quality: QUALITY_HIGH };
    // H.264 in MP4 where the browser can; VP9 in WebM where it can't.
    const avc = await canEncodeVideo('avc', opts);
    if (!avc && !(await canEncodeVideo('vp9', opts))) throw new Error('This browser can encode neither H.264 nor VP9 video.');
    update({ codec: avc ? 'H.264 MP4' : 'VP9 WebM' });
    output = new Output({ format: avc ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(), target: new BufferTarget() });
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
      // Waits while the encoder catches up.
      await source.add(i / FPS, 1 / FPS);
      if (i % 5 === 4 || i === frames - 1) {
        const spent = performance.now() - job.started;
        update({ done: i + 1, eta: (spent / (i + 1)) * (frames - i - 1) });
      }
    }
    await output.finalize();
    const blob = new Blob([output.target.buffer], { type: avc ? 'video/mp4' : 'video/webm' });
    update({ running: false, url: URL.createObjectURL(blob), size: blob.size, name: `terminus-${date}-${preset}.${avc ? 'mp4' : 'webm'}` });
  } catch (err) {
    if (output && output.state !== 'canceled' && output.state !== 'finalized') await output.cancel().catch(() => {});
    update({ running: false, error: err.message ?? String(err) });
  }
}

/* ---------- drawing the page ---------- */

const mins = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
};
const mb = (n) => `${(n / 1_048_576).toFixed(1)} MB`;

function Unlock() {
  const v = useStore(view);
  const input = useRef(null);
  const submit = (e) => {
    e.preventDefault();
    const t = input.current.value.trim();
    if (!t) return;
    memory = t;
    remember(t);
    loadDays();
  };
  return html`
    <form class="unlock" onSubmit=${submit}>
      <label for="token">Operator token</label>
      <div class="row">
        <input id="token" ref=${input} type="password" autocomplete="off" />
        <button class="btn accent" type="submit">Unlock</button>
      </div>
      ${v.msg && html`<p class="bad">${v.msg}</p>`}
      <p class="hint">The HEALTH_TOKEN secret, as on the dashboard, or TIMELAPSE_TOKEN, which opens only this page.</p>
    </form>
  `;
}

function Recording({ r }) {
  if (!r) return null;
  const words = { polling: 'recording', resting: 'waiting for the first bus', off: 'switched off', done: 'finished for the day', idle: 'not started' };
  return html`<p class="hint">${`Today (${r.date}): ${r.enabled ? words[r.state] ?? r.state : 'switched off'}${r.samples ? `, ${r.samples} readings so far` : ''}.`}</p>`;
}

function Progress({ job }) {
  if (!job) return null;
  if (job.error) return html`<p class="bad">${`The export stopped: ${job.error}`}</p>`;
  if (job.running) {
    return html`
      <div class="progress">
        <div class="bar"><div style=${{ width: `${(job.done / job.total) * 100}%` }}></div></div>
        <div class="meta">${`Frame ${job.done} of ${job.total}${job.codec ? ` · ${job.codec}` : ''}${job.eta != null ? ` · about ${mins(job.eta)} left` : ''}`}</div>
        <button class="btn ghost small" type="button" onClick=${() => (job.cancelled = true)}>Cancel</button>
      </div>
    `;
  }
  if (job.url) {
    return html`
      <div class="progress">
        <div class="meta">${`${job.codec} · ${mb(job.size)} · ${job.total} frames in ${mins(performance.now() - job.started)}`}</div>
        <a class="btn accent" href=${job.url} download=${job.name}>Download the video</a>
      </div>
    `;
  }
  return html`<p class="hint">Cancelled.</p>`;
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
    if (redraw === 'setup') setUp().then(preview, (err) => view.set((x) => ({ ...x, note: err.message })));
    else preview();
  };
  const r = range();

  if (v.days && !v.days.length) {
    return html`<${Recording} r=${v.recording} /><p>No days recorded yet. The recorder runs from 06:30 to 00:30 Singapore time while it's switched on.</p>`;
  }
  return html`
    <${Recording} r=${v.recording} />
    <div class="studio">
      <div class="controls card">
        <label>Day
          <select value=${v.date} disabled=${busy} onChange=${(e) => pick(e.currentTarget.value)}>
            ${(v.days ?? []).map((d) => html`<option value=${d.date}>${d.closed ? `${d.date} · ${mb(d.bytes)}` : `${d.date} · recording, ${d.samples} readings`}</option>`)}
          </select>
        </label>
        <label>Size
          <select value=${v.preset} disabled=${busy} onChange=${(e) => set({ preset: e.currentTarget.value }, 'setup')}>
            ${Object.entries(PRESETS).map(([key, p]) => html`<option value=${key}>${p.label}</option>`)}
          </select>
        </label>
        <label>Map
          <select value=${v.theme} disabled=${busy} onChange=${(e) => set({ theme: e.currentTarget.value }, 'setup')}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
        <label>Length of the video, seconds
          <input type="number" min="2" max="600" step="1" value=${v.seconds} disabled=${busy} onInput=${(e) => view.set((x) => ({ ...x, seconds: Math.max(2, Math.min(600, Number(e.currentTarget.value) || 60)) }))} />
          <span class="chips">
            ${[60, 90].map((s) => html`<button type="button" class=${`btn small ${v.seconds === s ? 'soft' : 'ghost'}`} disabled=${busy} onClick=${() => view.set((x) => ({ ...x, seconds: s }))}>${`${s} s`}</button>`)}
          </span>
        </label>
        <div class="pair">
          <label>From
            <input type="time" value=${v.from} disabled=${busy} onChange=${(e) => set({ from: e.currentTarget.value, scrub: 0 })} />
          </label>
          <label>To
            <input type="time" value=${v.to} disabled=${busy} onChange=${(e) => set({ to: e.currentTarget.value, scrub: 0 })} />
          </label>
        </div>
        <p class="hint">${r ? `${clockAt(r.a)} to ${clockAt(r.b)} Singapore time, ${FPS} frames a second, ${Math.round(v.seconds * FPS)} frames. Leave the times empty for the whole day.` : v.day ? 'The end must be after the start, within the recording.' : ''}</p>
        <button class="btn accent" type="button" disabled=${busy || v.preparing || !r || !v.day} onClick=${exportVideo}>Export the video</button>
        <${Progress} job=${v.job} />
      </div>
      <div class="preview">
        ${v.loading ? html`<p class="hint">Loading the day…</p>` : null}
        <div ref=${canvas}></div>
        ${v.day && r
          ? html`
              <input type="range" min="0" max="1000" value=${Math.round(v.scrub * 1000)} disabled=${busy} aria-label="Moment of the day" onInput=${(e) => set({ scrub: Number(e.currentTarget.value) / 1000 })} />
              <div class="scrub"><span>${clockAt(r.a)}</span><span>${clockAt(r.a + (r.b - r.a) * v.scrub)}</span><span>${clockAt(r.b)}</span></div>
            `
          : null}
      </div>
    </div>
  `;
}

function App() {
  const v = useStore(view);
  return html`
    ${v.note && html`<p class="bad">${v.note}</p>`}
    ${v.locked ? html`<${Unlock} />` : v.days ? html`<${Studio} />` : html`<p class="hint">Loading…</p>`}
  `;
}

render(html`<${App} />`, document.getElementById('timelapse'));
loadDays();
