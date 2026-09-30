/**
 * Local API with fake live buses, for building and screenshotting the apps.
 *
 *   node scripts/dev-stub.mjs            # http://localhost:8787
 *
 * Runs the real Worker code in Node with:
 *   - a stubbed NUS feed: every service arrives every 12 minutes, offset per
 *     service, moving with the real clock (so countdowns and dimming behave)
 *   - every service treated as running at any hour
 *   - an in-memory database with a test account (you@u.nus.edu),
 *     three saved places, a class later today, and pairing codes TEST67, TEST78, TEST89
 *   - crowd history saying every bus at PGP is usually packed (the full-bus warning)
 *   - a fake NUSMods (every module has a lab, an online tutorial and an
 *     off-campus lecture; XX9999 is not offered; DOWN1000 fails)
 *
 * POST /__stub/freeze and /__stub/thaw stop and restart the clock, for
 * light and dark screenshots of the same moment.
 *
 * Point a debug Android build at it:
 *   ./gradlew installDebug -PapiBase=http://localhost:8787
 *   adb reverse tcp:8787 tcp:8787
 * and the Mac app: TERMINUS_API_BASE=http://localhost:8787
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { installGlobals, makeDurableObjects, makeEnv, makeCtx, shuttlePayload } from '../test/_stubs.mjs';
import { Trip } from '../src/tripdo.ts';
import { makeD1, makeEmail } from '../test/_d1.mjs';

const PORT = Number(process.env.PORT ?? 8787);
// Anything the stub doesn't fake (Firebase, for push) goes out for real.
const realFetch = globalThis.fetch;
const realNow = Date.now.bind(Date);
// POST /__stub/freeze holds the clock (and so every bus time) still, for
// screenshots that must match in light and dark; /__stub/thaw lets it run.
let frozenAt = null;
const stubNow = () => frozenAt ?? realNow();

const graph = (await import('../data/stops.json', { with: { type: 'json' } })).default;
const servingStop = new Map();
for (const [svc, seq] of Object.entries(graph.routes)) for (const code of new Set(seq)) servingStop.set(code, [...(servingStop.get(code) ?? []), svc]);

const crowds = ['low', 'medium', 'high'];
async function feed(input, init = {}) {
  const url = String(typeof input === 'string' ? input : input.url);
  if (url.includes('get-access-token')) {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const jwt = `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(realNow() / 1000) + 86400 })}.sig`;
    return Response.json({ code: '00000', msg: '', data: { token: jwt, userid: 'DEV', domain: 'PUBLIC', username: 'dev' } });
  }
  if (url.includes('bus-proxy')) {
    const stop = JSON.parse(init.body ?? '{}').busstopname;
    const nowMin = stubNow() / 60_000;
    const shuttles = (servingStop.get(stop) ?? []).map((svc, i) => {
      const offset = (svc.charCodeAt(0) * 7 + i * 5) % 12;
      const eta = Math.max(1, Math.round(((offset - nowMin) % 12 + 12) % 12) + 1);
      return { name: svc, arrivalTime: String(eta), nextArrivalTime: String(eta + 12), passengers: crowds[(eta + i) % 3] };
    });
    return Response.json(shuttlePayload(shuttles));
  }
  // Fake NUSMods: any module has a Monday lab and an online tutorial;
  // XX9999 is not offered, DOWN1000 times out as NUSMods being down.
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

installGlobals(feed);
Date.now = stubNow; // installGlobals freezes the clock for tests; the dev server wants real time.

const { default: worker, GRAPH } = await import('../src/index.ts');
GRAPH.serviceHours = {}; // every service "running", whatever the hour

const db = makeD1();
const email = makeEmail();
const today = new Date(realNow() + 8 * 3_600_000).getUTCDay();
const inAnHour = Math.min(1380, Math.floor(((realNow() + 8 * 3_600_000) % 86_400_000) / 60_000) + Number(process.env.CLASS_IN_MIN ?? 50));
const profile = {
  home: { stops: ['PGP'] },
  gapHours: 2,
  dayStartMin: 0,
  dayEndMin: 1439,
  trips: [],
  manual: [{ day: today, arriveByMin: inAnHour, endMin: inAnHour + 60, to: 'UTOWN', label: 'GEA1000 @ UTown', venue: '' }],
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
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json' };
const ASSETS = {
  async fetch(req) {
    let p = decodeURIComponent(new URL(req.url).pathname);
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

// Locked like production: the bus answers need a key or a signed-in account.
// The /admin dashboard opens with the token "dev" here.
// Push (phase 3): the real Firebase project, when its service account is in
// .private/ (gitignored). Pushes then reach a real device or emulator.
const FCM = await readFile(new URL('../../../.private/fcm-service-account.json', import.meta.url), 'utf8').catch(() => undefined);
let env;
// The trip engine's Durable Object, in-process; its alarms fire on time below.
const TRIPS = makeDurableObjects(Trip, () => env);
// Web Push: a fresh VAPID key each run (browsers subscribed to an old one just subscribe again).
const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const VAPID = JSON.stringify(await crypto.subtle.exportKey('jwk', vapid.privateKey));
env = { ...makeEnv(), PUBLIC_API_OPEN: undefined, DB: db, EMAIL: email, EMAIL_FROM: 'login@example.test', ASSETS, HEALTH_TOKEN: 'dev', TRIPS, VAPID_PRIVATE_KEY: VAPID, ...(FCM ? { FCM_SERVICE_ACCOUNT: FCM } : {}) };
console.log(FCM ? 'push: on (Firebase project from .private/)' : 'push: off (no .private/fcm-service-account.json)');
setInterval(() => {
  const due = [...TRIPS.alarms.values()].filter((at) => at <= stubNow()).length;
  if (due) console.log(`trips: ${due} alarm(s) due`);
  TRIPS.fireDue(stubNow()).catch((e) => console.error('trip alarm', e));
}, 5_000);

http
  .createServer(async (req, res) => {
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
        storage: Object.fromEntries([...o.storage._map.entries()]),
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
    if (req.method === 'POST' && (req.url === '/__stub/freeze' || req.url === '/__stub/thaw')) {
      frozenAt = req.url.endsWith('freeze') ? realNow() : null;
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(frozenAt ? `frozen at ${new Date(frozenAt).toISOString()}\n` : 'running\n');
    }
    const request = new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers: req.headers, body });
    const ctx = makeCtx();
    const out = await worker.fetch(request, env, ctx);
    await ctx.settle();
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
    if (email.sent.length) console.log('sign-in code:', email.lastCode(), ' link:', email.lastToken() && `http://localhost:${PORT}/auth/verify?t=${email.lastToken()}`), (email.sent.length = 0);
  })
  .listen(PORT, () => console.log(`dev API with fake buses on http://localhost:${PORT} (pairing codes TEST67, TEST78, TEST89)`));
