/**
 * Local API with fake live buses, for building and screenshotting the apps.
 *
 *   node scripts/dev-stub.mjs            # http://localhost:8787
 *
 * It answers this machine only (127.0.0.1 and ::1): its admin token is
 * "dev", it prints sign-in codes, and it may hold real keys from .dev.vars.
 * STUB_HOST=0.0.0.0 (or ::) opens it to the network, for a phone on the
 * same Wi-Fi; adb reverse and the emulator don't need it. PORT moves it
 * from 8787.
 *
 * Runs the real Worker code in Node with:
 *   - a stubbed NUS feed: every service arrives every 12 minutes, offset per
 *     service, moving with the real clock (so countdowns and dimming behave)
 *   - every service treated as running at any hour; with STUB_HOURS=real,
 *     the real hours (data/service-hours.json) instead, and no buses or
 *     times for a service outside them (the Buses tab's stopped rows)
 *   - an in-memory database with a test account (you@u.nus.edu),
 *     three saved places, a class later today, and pairing codes TEST67, TEST78, TEST89
 *   - crowd history saying every bus at PGP is usually packed (the full-bus warning)
 *   - live buses: three per service, driving round its route line
 *   - the map's files from dev/map/ when it's there (fonts and icons:
 *     scripts/map-tiles.sh --dry-run, then copy build/map to dev/map)
 *   - a fake NUSMods (every module has a lab, an online tutorial and an
 *     off-campus lecture; XX9999 is not offered; DOWN1000 fails)
 *
 * POST /__stub/freeze and /__stub/thaw stop and restart the clock, for
 * light and dark screenshots of the same moment. POST /__stub/skip?min=N
 * moves it ahead, to walk through a trip.
 * STUB_NOW=<ISO time> starts the clock there, and POST /__stub/at?t=<ISO time>
 * moves it there (it runs on from it): STUB_NOW=2026-10-07T13:30:00Z is a
 * Wednesday 21:30 in Singapore, when R1 and R2 have stopped.
 *
 * The timelapse recorder runs too, on the fake buses, as it would in its
 * window (the cron that starts it is a timer here). POST
 * /__stub/timelapse?minutes=N records N minutes at once, moving the clock
 * ahead with it (from the window's opening if it's closed now): an hour of
 * buses for the timelapse page (/admin/timelapse/, token "dev") in a few
 * seconds. Past the window's close, the day is written to the fake R2.
 *
 * Point a debug Android build at it:
 *   ./gradlew installStableDebug -PapiBase=http://localhost:8787
 *   adb reverse tcp:8787 tcp:8787
 * and the Mac app: TERMINUS_API_BASE=http://localhost:8787
 */

import http from 'node:http';
import https from 'node:https';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { installGlobals, makeBucket, makeDurableObjects, makeEnv, makeCtx, shuttlePayload } from '../test/_stubs.mjs';
import { Trip } from '../src/tripdo.ts';
import { TimelapseRecorder } from '../src/timelapsedo.ts';
import { ensureRecorder, inWindow, nextOpen } from '../src/timelapse.ts';
import { SESSION_COOKIE as DEV_COOKIE } from '../src/accounts.ts';
import { API_VERSION } from '../src/openapi.ts';
import { makeD1, makeEmail } from '../test/_d1.mjs';

const PORT = Number(process.env.PORT ?? 8787);
// Anything the stub doesn't fake (Firebase, for push) goes out for real.
const realFetch = globalThis.fetch;
const realNow = Date.now.bind(Date);
// POST /__stub/freeze holds the clock (and so every bus time) still, for
// screenshots that must match in light and dark; /__stub/thaw lets it run.
let frozenAt = null;
// POST /__stub/skip?min=N moves the clock N minutes ahead (and keeps it
// there), to walk through a trip without waiting for it.
let skipMs = process.env.STUB_NOW ? Date.parse(process.env.STUB_NOW) - realNow() : 0;
if (Number.isNaN(skipMs)) throw new Error('STUB_NOW must be an ISO time, such as 2026-10-07T13:30:00Z');
const stubNow = () => (frozenAt ?? realNow()) + skipMs;
// STUB_HOURS=real: services keep their real hours, and the fake feed has
// nothing for one outside them. Set once the Worker's graph is loaded.
const REAL_HOURS = process.env.STUB_HOURS === 'real';
let running = (_svc) => true;

const graph = (await import('../data/stops.json', { with: { type: 'json' } })).default;
const servingStop = new Map();
for (const [svc, seq] of Object.entries(graph.routes)) for (const code of new Set(seq)) servingStop.set(code, [...(servingStop.get(code) ?? []), svc]);

const crowds = ['low', 'medium', 'high'];
// The public buses (data/public.json): which call at each LTA stop code, and
// which way a two-way service is going there, for the fake DataMall below.
const pub = (await import('../data/public.json', { with: { type: 'json' } })).default;
const ltaToGraph = new Map([...Object.entries(pub.merged), ...pub.stops.map((s) => [s.code, s.code])]);
const publicAt = (ltaCode) => {
  const code = ltaToGraph.get(ltaCode);
  return Object.entries(pub.routes).filter(([, seq]) => seq.includes(code)).map(([key]) => pub.public[key]);
};
const shapes = (await import('../data/shapes.json', { with: { type: 'json' } })).default.routes;

/** Three buses per service, a third of the route apart, at 20 km/h along its
 *  line. Like the real feed, a bus's position only moves every 18 s. */
function fakeBuses(svc) {
  const shape = shapes[svc];
  if (!shape || !running(svc)) return [];
  const t = Math.floor(stubNow() / 18_000) * 18_000;
  const pts = shape.line;
  const seg = pts.slice(1).map((p, i) => Math.hypot((p[0] - pts[i][0]) * 111_320, (p[1] - pts[i][1]) * 110_540));
  const total = seg.reduce((a, b) => a + b, 0);
  return [0, 1, 2].map((n) => {
    let at = ((t / 1000) * 5.5 + (n * total) / 3) % total;
    let i = 0;
    while (i < seg.length - 1 && at > seg[i]) at -= seg[i++];
    const k = seg[i] ? at / seg[i] : 0;
    const [a, b] = [pts[i], pts[i + 1]];
    const heading = (Math.atan2((b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), b[1] - a[1]) * 180) / Math.PI;
    return {
      vehplate: `PD${100 + n}${svc}`,
      lat: a[1] + (b[1] - a[1]) * k,
      lng: a[0] + (b[0] - a[0]) * k,
      speed: n === 2 ? 0 : 20,
      direction: (heading + 360) % 360,
      loadInfo: { capacity: 88, ridership: [12, 50, 84][n] },
    };
  });
}
async function feed(input, init = {}) {
  const url = String(typeof input === 'string' ? input : input.url);
  if (url.includes('get-access-token')) {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const jwt = `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(realNow() / 1000) + 86400 })}.sig`;
    return Response.json({ code: '00000', msg: '', data: { token: jwt, userid: 'DEV', domain: 'PUBLIC', username: 'dev' } });
  }
  if (url.endsWith('/active-bus')) {
    const svc = JSON.parse(init.body ?? '{}').route_code;
    return Response.json({ code: '00000', msg: '', data: { ActiveBusCount: 3, TimeStamp: '', activebus: fakeBuses(svc) } });
  }
  // LTA DataMall: each public bus at the stop every 10 min or so, the third
  // of them from the timetable (Monitored 0), as the real feed does at night.
  if (url.startsWith('https://datamall2.mytransport.sg/')) {
    const ltaCode = new URL(url).searchParams.get('BusStopCode') ?? '';
    const nowMin = stubNow() / 60_000;
    const Services = publicAt(ltaCode).map((p, i) => {
      const offset = (p.svc.charCodeAt(0) * 3 + i * 4) % 10;
      const eta = Math.max(1, Math.round(((offset - nowMin) % 10 + 10) % 10) + 1);
      const bus = (n, monitored) => ({ OriginCode: p.origin, DestinationCode: p.dest, EstimatedArrival: new Date(stubNow() + (eta + n * 10) * 60_000).toISOString(), Monitored: monitored ? 1 : 0, Latitude: monitored ? '1.2966' : '0.0', Longitude: monitored ? '103.7724' : '0.0', VisitNumber: '1', Load: ['SEA', 'SDA', 'LSD'][(eta + n) % 3], Feature: 'WAB', Type: 'DD' });
      return { ServiceNo: p.svc, Operator: p.operator, NextBus: bus(0, true), NextBus2: bus(1, true), NextBus3: bus(2, false) };
    });
    return Response.json({ 'odata.metadata': 'https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival', BusStopCode: ltaCode, Services });
  }
  if (url.includes('bus-proxy')) {
    const stop = JSON.parse(init.body ?? '{}').busstopname;
    const nowMin = stubNow() / 60_000;
    const shuttles = (servingStop.get(stop) ?? []).filter((svc) => running(svc)).map((svc, i) => {
      const offset = (svc.charCodeAt(0) * 7 + i * 5) % 12;
      const eta = Math.max(1, Math.round(((offset - nowMin) % 12 + 12) % 12) + 1);
      return { name: svc, arrivalTime: String(eta), nextArrivalTime: String(eta + 12), passengers: crowds[(eta + i) % 3] };
    });
    return Response.json(shuttlePayload(shuttles));
  }
  // Fake NUSMods: any module has a Monday lab, a Tuesday online tutorial and
  // a Wednesday off-campus lecture; XX9999 is not offered, DOWN1000 answers
  // 502 as NUSMods being down.
  const mod = /api\.nusmods\.com\/v2\/[^/]+\/modules\/([^.]+)\.json/.exec(url);
  if (mod) {
    if (mod[1] === 'XX9999') return new Response('not found', { status: 404 });
    if (mod[1] === 'DOWN1000') return new Response('bad gateway', { status: 502 });
    const lesson = (lessonType, day, startTime, venue) => ({ lessonType, classNo: '1', day, startTime, endTime: String(Number(startTime) + 200).padStart(4, '0'), venue, weeks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] });
    const timetable = [lesson('Laboratory', 'Monday', '1000', 'COM3-0120'), lesson('Tutorial', 'Tuesday', '1400', 'E-Learn_C'), lesson('Lecture', 'Wednesday', '0900', 'DUKENUS')];
    return Response.json({ semesterData: [1, 2, 3, 4].map((semester) => ({ semester, timetable })) });
  }
  // Firebase for real, with each send logged (status only; no tokens or keys).
  const res = await realFetch(input, init);
  // Chrome's Web Push endpoints are on fcm.googleapis.com too, with an encrypted (binary) body.
  if (url.startsWith('https://fcm.googleapis.com/') && typeof init?.body === 'string') console.log(`push: FCM ${res.status}`, JSON.parse(init.body).message?.data ?? '');
  else if (init?.headers && new Headers(init.headers).get('content-encoding') === 'aes128gcm') console.log(`push: web ${res.status} ${new URL(url).host}`);
  return res;
}

const edgeCache = installGlobals(feed);
Date.now = stubNow; // installGlobals freezes the clock for tests; the dev server wants real time.

const { default: worker, GRAPH } = await import('../src/index.ts');
if (REAL_HOURS) {
  const { inService } = await import('../src/resolve.ts');
  running = (svc) => inService(GRAPH, svc, stubNow());
} else {
  GRAPH.serviceHours = {}; // every service "running", whatever the hour
}

const db = makeD1();
const email = makeEmail();
const today = new Date(realNow() + 8 * 3_600_000).getUTCDay();
const inAnHour = Math.min(1425, Math.floor(((realNow() + 8 * 3_600_000) % 86_400_000) / 60_000) + Number(process.env.CLASS_IN_MIN ?? 50));
const profile = {
  home: { stops: ['PGP'] },
  gapHours: 2,
  dayStartMin: 0,
  dayEndMin: 1439,
  trips: [],
  manual: [{ day: today, arriveByMin: inAnHour, endMin: Math.min(1439, inAnHour + 60), to: 'UTOWN', label: 'GEA1000 @ UTown', venue: '' }],
  places: [
    { key: 'mrt', label: 'KR MRT', to: 'KR-MRT' },
    { key: 'utown', label: 'UTown', to: 'UTOWN' },
    { key: 'gym', label: 'Gym', to: 'UHALL' },
  ],
  share: null,
  term: null,
};
db.exec(`INSERT INTO users (id, email, created, last_seen, via) VALUES ('test-user', 'you@u.nus.edu', 0, 0, 'web')`);
db._db.prepare('INSERT INTO profiles VALUES (?, ?, 0)').run('test-user', JSON.stringify(profile));
for (const code of ['TEST67', 'TEST78', 'TEST89']) db.exec(`INSERT INTO pair_codes VALUES ('${code}', 'test-user', 9999999999999)`);
// Crowd history, so the full-bus warning shows: every bus at PGP is usually packed.
for (const svc of servingStop.get('PGP') ?? []) {
  for (const daytype of ['term', 'exam', 'break', 'sat', 'sun']) {
    for (let slot = 0; slot < 48; slot++) db.exec(`INSERT INTO crowd_stats VALUES ('${svc}', 'PGP', '${daytype}', ${slot}, 20, 15)`);
  }
}

// The website, standing in for the Workers ASSETS binding.
const WEB = new URL('../../web/public/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json' };
const ASSETS = {
  async fetch(req) {
    const p = decodeURIComponent(new URL(req.url).pathname);
    let file = path.join(WEB, p);
    if (!file.startsWith(WEB)) return new Response('not found', { status: 404 });
    try {
      if ((await stat(file)).isDirectory()) {
        if (!p.endsWith('/')) return Response.redirect(new URL(p + '/', req.url), 307);
        file = path.join(file, 'index.html');
      }
      return new Response(await readFile(file), { headers: { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  },
};

// The map's files (fonts, icons, the map file if there is one) from dev/map/,
// standing in for R2, byte ranges and all. latest.json names this version,
// for the landing page; there are no app files behind it.
const MAP_DIR = new URL('../../../dev/map/', import.meta.url).pathname;
const DOWNLOADS = makeBucket(async (key) => {
  if (key === 'latest.json') return new TextEncoder().encode(JSON.stringify({ version: API_VERSION }));
  if (!key.startsWith('map/')) return null;
  const file = path.join(MAP_DIR, key.slice(4));
  if (!file.startsWith(MAP_DIR)) return null;
  return readFile(file).catch(() => null);
});

// Locked like production: the bus answers need a key or a signed-in account.
// The /admin dashboard opens with the token "dev" here.
// Push: the real Firebase project, when its service account is in
// .private/ (gitignored). Pushes then reach a real device or emulator.
const FCM = await readFile(new URL('../../../.private/fcm-service-account.json', import.meta.url), 'utf8').catch(() => undefined);
let env;
// The trip engine's Durable Object, in-process; its alarms fire on time below.
const TRIPS = makeDurableObjects(Trip, () => env);
// The timelapse recorder, in-process too, on the fake feed.
const TIMELAPSE = makeDurableObjects(TimelapseRecorder, () => env);
// Web Push: a fresh VAPID key each run (browsers subscribed to an old one just subscribe again).
const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const VAPID = JSON.stringify(await crypto.subtle.exportKey('jwk', vapid.privateKey));
env = { ...makeEnv(), LTA_ACCOUNT_KEY: 'dev', [Symbol.for('terminus.testOpen')]: false, DB: db, EMAIL: email, EMAIL_FROM: 'login@example.test', ASSETS, DOWNLOADS, HEALTH_TOKEN: 'dev', TRIPS, TIMELAPSE, TIMELAPSE_ENABLED: 'on', VAPID_PRIVATE_KEY: VAPID, ...(FCM ? { FCM_SERVICE_ACCOUNT: FCM } : {}) };
console.log(FCM ? 'push: on (Firebase project from .private/)' : 'push: off (no .private/fcm-service-account.json)');
setInterval(() => {
  const due = [...TRIPS.alarms.values()].filter((at) => at <= stubNow()).length;
  if (due) console.log(`trips: ${due} alarm(s) due`);
  TRIPS.fireDue(stubNow()).catch((e) => console.error('trip alarm', e));
}, 5_000);
// The recorder's alarms (one service every few seconds), and the cron that
// starts each day's recorder, every minute here rather than every 15.
setInterval(() => TIMELAPSE.fireDue(stubNow()).catch((e) => console.error('timelapse alarm', e)), 1_000);
const startTimelapse = () => ensureRecorder(env, stubNow()).catch((e) => console.error('timelapse start', e));
setInterval(startTimelapse, 60_000);
startTimelapse();

/** Records [minutes] of buses at once: the clock jumps from one alarm to the next. */
async function fastForward(minutes) {
  if (!inWindow(stubNow())) skipMs += nextOpen(stubNow()) - stubNow();
  await ensureRecorder(env, stubNow());
  const until = stubNow() + minutes * 60_000;
  let polls = 0;
  for (;;) {
    const due = [...TIMELAPSE.alarms.values()];
    const next = Math.min(...due);
    if (!due.length || next > until) break;
    if (next > stubNow()) skipMs += next - stubNow();
    await TIMELAPSE.fireDue(stubNow());
    polls++;
  }
  if (until > stubNow()) skipMs += until - stubNow();
  await ensureRecorder(env, stubNow());
  return polls;
}

async function serve(req, res) {
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await new Promise((r) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => r(Buffer.concat(chunks)));
  });
  if (req.method === 'GET' && req.url === '/__stub/trips') {
    // Each Trip object's alarm and what it holds, for checking push.
    const out = [...TRIPS.instances.entries()].map(([id, o]) => ({
      id,
      alarm: TRIPS.alarms.has(id) ? new Date(TRIPS.alarms.get(id)).toISOString() : null,
      storage: Object.fromEntries(o.storage._map.entries()),
    }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out, null, 1));
    return;
  }
  if (req.method === 'GET' && req.url === '/__stub/push') {
    // Which devices take push, token masked: for checking registration.
    const rows = db._db.prepare('SELECT name, push_token FROM sessions WHERE push_token IS NOT NULL').all();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(rows.map((r) => ({ name: r.name, token: `${r.push_token.slice(0, 8)}…` }))));
    return;
  }
  if (req.method === 'POST' && req.url.startsWith('/__stub/timelapse')) {
    const minutes = Number(new URL(req.url, 'http://x').searchParams.get('minutes') ?? 60);
    const polls = await fastForward(minutes);
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(`recorded ${minutes} min (${polls} polls); now ${new Date(stubNow()).toISOString()}\n`);
  }
  if (req.method === 'POST' && req.url.startsWith('/__stub/skip')) {
    skipMs += Number(new URL(req.url, 'http://x').searchParams.get('min') ?? 0) * 60_000;
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(`now ${new Date(stubNow()).toISOString()}\n`);
  }
  if (req.method === 'POST' && req.url.startsWith('/__stub/at')) {
    const at = Date.parse(new URL(req.url, 'http://x').searchParams.get('t') ?? '');
    if (Number.isNaN(at)) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('t must be an ISO time, such as 2026-10-07T13:30:00Z\n');
    }
    skipMs = at - (frozenAt ?? realNow());
    // What's cached was cached at the old time: going back, it would never expire.
    edgeCache._store.clear();
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(`now ${new Date(stubNow()).toISOString()}\n`);
  }
  if (req.method === 'POST' && (req.url === '/__stub/freeze' || req.url === '/__stub/thaw')) {
    frozenAt = req.url.endsWith('freeze') ? realNow() : null;
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(frozenAt ? `frozen at ${new Date(frozenAt).toISOString()}\n` : 'running\n');
  }
  // WebKit (iOS Safari, the installed web app) won't keep a Secure or
  // __Host- cookie over plain http, even on localhost, so over the wire the
  // session cookie is a plain one here and is renamed back for the Worker.
  const headers = { ...req.headers };
  if (headers.cookie) headers.cookie = headers.cookie.replace(/(^|;\s*)tm_dev=/, `$1${DEV_COOKIE}=`);
  const request = new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers, body });
  const ctx = makeCtx();
  const out = await worker.fetch(request, env, ctx);
  await ctx.settle();
  const outHeaders = Object.fromEntries(out.headers);
  const cookies = out.headers.getSetCookie();
  if (cookies.length) outHeaders['set-cookie'] = cookies.map((c) => c.replace(`${DEV_COOKIE}=`, 'tm_dev=').replace(/; Secure/i, ''));
  // The apps set their clock by Date, so it's the stub's time: a real one
  // would make every answer from a moved clock look hours old.
  outHeaders.date = new Date(stubNow()).toUTCString();
  res.writeHead(out.status, outHeaders);
  res.end(Buffer.from(await out.arrayBuffer()));
  if (email.sent.length) {
    // An app's sign-in mails an approval link instead of a verify link.
    const approve = /\/auth\/approve\?r=[A-Za-z0-9_-]+/.exec(email.sent.at(-1)?.text ?? '')?.[0];
    console.log('sign-in code:', email.lastCode(), ' link:', approve ? `http://localhost:${PORT}${approve}` : email.lastToken() && `http://localhost:${PORT}/auth/verify?t=${email.lastToken()}`);
    email.sent.length = 0;
  }
}

// Loopback only unless STUB_HOST says otherwise; both families, since
// "localhost" may be either. A Mac or container without IPv6 has no ::1.
const HOSTS = process.env.STUB_HOST ? [process.env.STUB_HOST] : ['127.0.0.1', '::1'];
const listen = (server, port, ready) => {
  let up = 0;
  for (const host of HOSTS) {
    const s = server();
    s.on('error', (err) => {
      if (host === '::1' && HOSTS.length > 1 && err.code === 'EADDRNOTAVAIL') return;
      throw err;
    });
    s.listen(port, host, () => up++ || ready());
  }
};
const where = process.env.STUB_HOST ? ` (listening on ${process.env.STUB_HOST}, open to the network)` : '';
listen(() => http.createServer(serve), PORT, () => console.log(`dev API with fake buses on http://localhost:${PORT}${where} (pairing codes TEST67, TEST78, TEST89)`));
// STUB_TLS=<dir with localhost.key and localhost.pem>: the same stub over
// HTTPS on PORT + 1, for browsers that need a real secure origin (Web Push on
// iOS). Trust the certificate's CA in the device first; a phone also needs
// STUB_HOST to reach it.
if (process.env.STUB_TLS) {
  const tls = process.env.STUB_TLS;
  const [key, cert] = await Promise.all([readFile(path.join(tls, 'localhost.key')), readFile(path.join(tls, 'localhost.pem'))]);
  listen(() => https.createServer({ key, cert }, serve), PORT + 1, () => console.log(`and over HTTPS on https://localhost:${PORT + 1}`));
}
