/**
 * The OpenAPI spec (src/openapi.ts) against what the Worker really sends.
 *
 * worker.smoke.js checks the spec lists every route; this checks what it says
 * about them: its examples fit its schemas, the golden answers fit them too,
 * every operation answers with a status it documents and a body its schema
 * describes (with no keys the schema doesn't name), the routes that need
 * credentials refuse a caller without them, and no schema is left unused.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { FROZEN_NOW, installGlobals, makeBucket, makeCtx, makeDurableObjects, makeEnv, makeFetch, makeKV } from './_stubs.mjs';
import { makeD1, makeEmail } from './_d1.mjs';
import { validate } from './_schema.mjs';
import worker from '../src/index.ts';
import { Trip } from '../src/tripdo.ts';
import { API_VERSION, openApiSpec } from '../src/openapi.ts';

const BASE = 'https://bus.example.test';
const spec = openApiSpec(BASE);
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const OPS = Object.entries(spec.paths).flatMap(([path, item]) =>
  METHODS.filter((m) => item[m]).map((m) => ({ key: `${m.toUpperCase()} ${path}`, path, method: m.toUpperCase(), op: item[m] })),
);
const opOf = (key) => OPS.find((o) => o.key === key) ?? assert.fail(`no operation ${key} in the spec`);
const check = (schema, value) => validate(schema, value, { root: spec, strict: true });

/* ---------- 1. examples ---------- */

test('every example in the spec fits its schema', () => {
  const bad = [];
  const walk = (node, at) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach((x, i) => walk(x, `${at}[${i}]`));
    // A parameter or a media type: its example(s) against its schema.
    if (node.schema && node.example !== undefined) bad.push(...check(node.schema, node.example).map((e) => `${at}.example ${e}`));
    if (node.schema && node.examples && !Array.isArray(node.examples)) {
      for (const [name, ex] of Object.entries(node.examples)) bad.push(...check(node.schema, ex.value).map((e) => `${at}.examples.${name} ${e}`));
    }
    // A schema with an example of its own.
    if (!node.schema && node.example !== undefined && (node.type || node.$ref || node.oneOf || node.allOf)) {
      const { example, ...schema } = node;
      bad.push(...check(schema, example).map((e) => `${at}.example ${e}`));
    }
    for (const [k, v] of Object.entries(node)) if (k !== 'example' && k !== 'examples') walk(v, `${at}.${k}`);
  };
  walk(spec.paths, 'paths');
  walk(spec.components, 'components');
  assert.deepEqual(bad, []);
});

/* ---------- 2. the golden answers ---------- */

const bodySchema = (key, status = '200') => opOf(key).op.responses[status].content['application/json'].schema;

test('every golden answer fits the schema of the route it came from, with nothing the schema leaves out', () => {
  const dir = new URL('./fixtures/answers/', import.meta.url);
  const files = [
    ...fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => new URL(f, dir)),
    ...fs.readdirSync(new URL('zh/', dir)).filter((f) => f.endsWith('.json')).map((f) => new URL(`zh/${f}`, dir)),
  ];
  assert.ok(files.length >= 40, 'the fixtures are found');
  const bad = [];
  for (const file of files) {
    const body = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Which route a fixture is from, by its shape: /me/day has items, /me/nearby a list of stops, the rest are /me/next.
    const route = Array.isArray(body.items) && body.date ? 'GET /me/day' : Array.isArray(body.stops) && !('label' in body) ? 'GET /me/nearby' : 'GET /me/next';
    bad.push(...check(bodySchema(route), body).map((e) => `${file.pathname.split('/answers/')[1]} (${route}) ${e}`));
  }
  assert.deepEqual(bad, []);
});

/* ---------- 3. every operation, called ---------- */

const FEED = {};
for (const code of ['PGP', 'PGPR', 'COM3', 'UTOWN', 'KR-MRT', 'KR-MRT-OPP', 'CLB', 'LT27', 'YIH', 'AS5']) {
  FEED[code] = [
    { name: 'D2', arrivalTime: '4', nextArrivalTime: '14', passengers: 'low', arrivalTime_veh_plate: 'PD726D' },
    { name: 'A1', arrivalTime: '9', nextArrivalTime: '19', passengers: 'high' },
    { name: 'D1', arrivalTime: '7', nextArrivalTime: '17', passengers: 'low' },
  ];
}

/** NUSMods' module files, by code: 'fail' answers 500; a code not here, 404. */
const NUSMODS = {
  MA1100: { semesterData: [{ semester: 1, timetable: [{ lessonType: 'Lecture', classNo: '1', day: 'Monday', startTime: '0800', endTime: '1000', venue: 'UTOWN' }] }] },
  BZ1000: 'fail',
};

const VAPID = await (async () => {
  const { privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return JSON.stringify(await crypto.subtle.exportKey('jwk', privateKey));
})();

const enc = (s) => new TextEncoder().encode(s);
const LATEST = {
  version: API_VERSION,
  released: '2026-08-20T00:00:00Z',
  android: { file: `releases/${API_VERSION}/terminus-${API_VERSION}.apk`, sha256: 'ab'.repeat(32), size: 3 },
  mac: { file: `releases/${API_VERSION}/terminus-${API_VERSION}.dmg`, sha256: 'cd'.repeat(32), size: 3 },
};
const FILES = {
  'map/campus.pmtiles': 'x'.repeat(100),
  'map/fonts/Noto Sans Regular/0-255.pbf': 'glyphs',
  'map/sprites/v4/light.json': '{}',
  'latest.json': JSON.stringify(LATEST),
  'appcast.xml': '<rss/>',
  [LATEST.android.file]: 'apk',
  [LATEST.mac.file]: 'dmg',
  'timelapse/2026-08-26.json.gz': 'gz',
};
const downloads = (files = FILES) => makeBucket(async (key) => (key in files ? enc(files[key]) : null));

const LIMITERS = ['RL_AUTH', 'RL_PUBLIC', 'RL_ME', 'RL_MAP', 'RL_ANON', 'RL_PAIR', 'RL_MAIL'];
function limiter() {
  return { block: false, async limit() { return { success: !this.block }; } };
}

const THU = 4; // FROZEN_NOW is Thursday 2026-08-27, 09:00 SGT
const PROFILE = {
  home: { stops: ['PGP'] },
  manual: [{ day: THU, arriveByMin: 600, endMin: 660, to: 'UTOWN', label: 'GEA1000 @ UTown', venue: '' }],
  places: [{ key: 'mrt', label: 'KR MRT', to: 'KR-MRT' }],
};
const CLASS_KEY = '4:600:UTOWN';
const DORM = 'lat=1.2915&lon=103.7828';

/** One request to the Worker. `auth`: who asks (see world()). */
async function send(w, path, { method = 'GET', body, form, auth, headers = {} } = {}) {
  const h = { ...headers };
  if (auth === 'cookie') h.cookie = w.cookie;
  if (auth === 'device') h.authorization = `Bearer ${w.device}`;
  if (auth === 'anon') h.authorization = `Bearer ${w.anon}`;
  if (auth === 'key') h['x-api-key'] = w.key;
  if (auth === 'operator') h['x-health-token'] = 'op-token';
  let payload;
  if (body !== undefined) {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (form) {
    h['content-type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(form).toString();
  }
  const ctx = makeCtx();
  const res = await worker.fetch(new Request(BASE + path, { method, headers: h, ...(payload === undefined ? {} : { body: payload }) }), w.env, ctx);
  await ctx.settle();
  return res;
}

/**
 * A fresh Worker with everything bound, and four callers: a browser signed
 * in with an email (`cookie`), a device paired to that account (`device`),
 * an app's account without an email (`anon`) and an API key (`key`).
 * `w.turnstile` ('ok', 'fail', 'down') is what Turnstile answers once
 * TURNSTILE_SECRET is set; `w.limit.RL_*.block` refuses that limiter.
 */
async function world() {
  const w = { turnstile: 'ok' };
  const feed = makeFetch({ byStop: FEED });
  installGlobals(async (input, init) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (url.startsWith('https://api.nusmods.com/')) {
      const mod = NUSMODS[/modules\/([^.]+)\.json/.exec(url)?.[1]];
      return mod === 'fail' ? new Response('busy', { status: 500 }) : mod ? Response.json(mod) : new Response('not found', { status: 404 });
    }
    if (url.includes('challenges.cloudflare.com')) {
      if (w.turnstile === 'down') throw new TypeError('fetch failed');
      return Response.json({ success: w.turnstile === 'ok', action: 'signin', hostname: 'terminus.run' });
    }
    return feed(input, init);
  });
  w.limit = Object.fromEntries(LIMITERS.map((k) => [k, limiter()]));
  w.email = makeEmail();
  w.env = {
    ...makeEnv(makeKV()),
    DB: makeD1(),
    EMAIL: w.email,
    EMAIL_FROM: 'terminus@example.test',
    HEALTH_TOKEN: 'op-token',
    TRIPS: makeDurableObjects(Trip),
    VAPID_PRIVATE_KEY: VAPID,
    DOWNLOADS: downloads(),
    ...w.limit,
  };
  // The answer routes as deployed: a key or a session, nothing open.
  delete w.env[Symbol.for('terminus.testOpen')];
  const call = (path, opts) => send(w, path, opts);
  w.call = call;

  await call('/auth/login', { method: 'POST', body: { email: 'you@u.nus.edu' } });
  const verified = await call('/auth/verify', { method: 'POST', form: { t: w.email.lastToken() } });
  w.cookie = verified.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/me/profile', { method: 'PUT', auth: 'cookie', body: PROFILE })).status, 200);
  const key = await (await call('/me/keys', { method: 'POST', auth: 'cookie', body: { name: 'script' } })).json();
  w.key = key.key;
  w.keyId = key.id;
  const { code } = await (await call('/me/pair-code', { method: 'POST', auth: 'cookie' })).json();
  w.device = (await (await call('/pair', { method: 'POST', body: { code, name: 'Pixel 8' } })).json()).token;
  w.anon = (await (await call('/auth/anon', { method: 'POST', body: { name: 'Phone', platform: 'android' } })).json()).token;
  assert.ok(w.cookie && w.key && w.device && w.anon, 'the world has its callers');
  return w;
}

/** Starts an app's sign-in for a new address: `w.started` and the email's code and link. */
async function startApp(w, address = 'app@u.nus.edu') {
  w.started = await (await w.call('/auth/app/start', { method: 'POST', body: { email: address, name: 'MacBook' } })).json();
  w.appCode = /code is ([2-9A-Z]{6})/.exec(w.email.sent.at(-1).text)[1];
  w.approveLink = /\/auth\/approve\?r=([A-Za-z0-9_-]+)/.exec(w.email.sent.at(-1).text)[1];
}

const mailFails = (w) => {
  w.email.send = async () => {
    throw new Error('send failed');
  };
};
const turnstile = (state) => (w) => {
  w.env.TURNSTILE_SECRET = 's';
  w.env.TURNSTILE_SITE_KEY = 'site';
  w.env.TURNSTILE_HOSTNAMES = 'terminus.run';
  w.turnstile = state;
};
const r2Fails = (w) => {
  w.env.DOWNLOADS.get = async () => {
    throw new Error('R2 down');
  };
};
const etagOf = (path) => async (w) => {
  w.etag = (await w.call(path, { auth: 'cookie' })).headers.get('etag');
};
const cross = { 'sec-fetch-site': 'cross-site' };

/**
 * [operation, status, options]: options as send() takes them, plus `path`
 * (the request's own, by default the operation's), `block` (limiters that
 * refuse), and `before(w)`. A function of `w` for path, body or form or
 * headers is called with the world once `before` has run.
 */
const CASES = [
  // Answers and stops: a key or a session.
  ['GET /next', 200, { auth: 'cookie', why: 'nothing sent: set up' }],
  ['GET /next', 200, { auth: 'key', path: `/next?to=UTOWN&${DORM}`, why: 'with a key' }],
  ['GET /next', 200, { auth: 'device', path: '/next?from=PGP&to=COM3', why: 'with a device token' }],
  ['GET /next', 401, { why: 'no key' }],
  ['GET /next', 401, { headers: { 'x-api-key': 'tk_nope' }, why: 'a wrong key' }],
  ['GET /next', 429, { auth: 'key', block: ['RL_PUBLIC'], why: 'a key over its limit' }],
  ['GET /next', 429, { auth: 'cookie', block: ['RL_ME'], why: 'an account over its limit' }],
  ['GET /trip', 200, { auth: 'cookie', path: '/trip?to=UTOWN&from=PGP' }],
  ['GET /trip', 400, { auth: 'cookie', path: '/trip?to=NARNIA&from=PGP' }],
  ['GET /trip', 400, { auth: 'cookie', path: '/trip?to=UTOWN', why: 'no location and no from' }],
  ['GET /trip', 401, { path: '/trip?to=UTOWN&from=PGP' }],
  ['GET /arrivals', 200, { auth: 'cookie', path: '/arrivals?stop=COM3' }],
  ['GET /arrivals', 200, { auth: 'cookie', path: '/arrivals?stop=COM3&stopped=1&public=1' }],
  ['GET /arrivals', 400, { auth: 'cookie', path: '/arrivals?stop=NARNIA' }],
  ['GET /arrivals', 429, { block: ['RL_PUBLIC'], path: '/arrivals?stop=COM3', why: 'by IP, before the key is asked for' }],
  ['GET /buses', 200, { auth: 'cookie', path: '/buses?svc=D2' }],
  ['GET /buses', 400, { auth: 'cookie', path: '/buses?svc=Z9' }],
  ['GET /line', 200, { auth: 'cookie', path: '/line?svc=D1' }],
  ['GET /line', 200, { auth: 'cookie', path: '/line?svc=D1&stop=YIH' }],
  ['GET /line', 400, { auth: 'cookie', path: '/line?svc=D1&stop=PGP' }],
  ['GET /campus', 200, { auth: 'cookie' }],
  ['GET /campus', 304, { auth: 'cookie', before: etagOf('/campus'), headers: (w) => ({ 'if-none-match': w.etag }) }],
  ['GET /stops/pairs', 200, { auth: 'key' }],
  ['GET /stops/pairs', 401, {}],

  // Service.
  ['GET /status.json', 200, {}],
  ['GET /status.json', 429, { block: ['RL_PUBLIC'] }],
  ['GET /health', 200, {}],
  ['GET /health', 200, { auth: 'operator', path: '/health?probe=1&versions=1', why: 'the operator’s probe and versions' }],
  ['GET /health', 503, { before: (w) => w.env.KV.put('monitor:upstream', JSON.stringify({ up: false, since: FROZEN_NOW - 3_600_000, checkedAt: FROZEN_NOW - 60_000, reason: 'feed' })), why: 'the feed is down' }],
  ['GET /health', 429, { block: ['RL_PUBLIC'] }],
  ['GET /docs', 200, {}],
  ['GET /openapi.json', 200, {}],
  ['GET /admin/stats', 200, { auth: 'operator' }],
  ['GET /admin/stats', 404, {}],
  ['GET /admin/stats', 429, { auth: 'operator', block: ['RL_PUBLIC'] }],
  ['GET /timelapse/days', 200, { auth: 'operator' }],
  ['GET /timelapse/days', 404, {}],
  ['GET /timelapse/days', 429, { auth: 'operator', block: ['RL_PUBLIC'] }],
  ['GET /timelapse/days/{date}', 200, { auth: 'operator', path: '/timelapse/days/2026-08-26' }],
  ['GET /timelapse/days/{date}', 404, { auth: 'operator', path: '/timelapse/days/2026-08-01' }],

  // Signing in.
  ['GET /auth/config', 200, {}],
  ['GET /auth/config', 429, { block: ['RL_PUBLIC'] }],
  ['POST /auth/login', 200, { body: { email: 'new@u.nus.edu' } }],
  ['POST /auth/login', 400, { body: { email: 'not an email' } }],
  ['POST /auth/login', 400, { before: turnstile('fail'), body: { email: 'new@u.nus.edu', turnstile: 'bad' }, why: 'the human check failed' }],
  ['POST /auth/login', 429, { block: ['RL_AUTH'], body: { email: 'new@u.nus.edu' } }],
  ['POST /auth/login', 429, { block: ['RL_MAIL'], body: { email: 'new@u.nus.edu' }, why: 'too many emails for everyone' }],
  ['POST /auth/login', 502, { before: mailFails, body: { email: 'new@u.nus.edu' } }],
  ['POST /auth/login', 503, { before: turnstile('down'), body: { email: 'new@u.nus.edu', turnstile: 'x' } }],
  ['POST /auth/code', 200, { before: async (w) => { await w.call('/auth/login', { method: 'POST', body: { email: 'new@u.nus.edu' } }); w.code = w.email.lastCode(); }, body: (w) => ({ email: 'new@u.nus.edu', code: w.code }) }],
  ['POST /auth/code', 400, { body: { email: 'new@u.nus.edu', code: 'ABCDEF' } }],
  ['POST /auth/code', 403, { headers: cross, body: { email: 'new@u.nus.edu', code: 'ABCDEF' } }],
  ['POST /auth/code', 429, { block: ['RL_AUTH'], body: { email: 'new@u.nus.edu', code: 'ABCDEF' } }],
  ['GET /auth/verify', 200, { before: async (w) => { await w.call('/auth/login', { method: 'POST', body: { email: 'new@u.nus.edu' } }); w.t = w.email.lastToken(); }, path: (w) => `/auth/verify?t=${w.t}` }],
  ['GET /auth/verify', 400, { path: '/auth/verify?t=nope' }],
  ['GET /auth/verify', 429, { block: ['RL_PUBLIC'], path: '/auth/verify?t=nope' }],
  ['POST /auth/verify', 303, { before: async (w) => { await w.call('/auth/login', { method: 'POST', body: { email: 'new@u.nus.edu' } }); w.t = w.email.lastToken(); }, form: (w) => ({ t: w.t }) }],
  ['POST /auth/verify', 400, { form: { t: 'nope' } }],
  ['POST /auth/verify', 403, { headers: cross, form: { t: 'nope' } }],
  ['POST /auth/anon', 201, { body: { name: 'Pixel 8', platform: 'android' } }],
  ['POST /auth/anon', 429, { block: ['RL_AUTH'], body: {} }],
  ['POST /auth/anon', 429, { block: ['RL_ANON'], body: {}, why: 'too many for everyone' }],
  ['POST /auth/anon/web', 201, { body: {} }],
  ['POST /auth/anon/web', 400, { before: turnstile('fail'), body: { turnstile: 'bad' } }],
  ['POST /auth/anon/web', 403, { headers: cross, body: {} }],
  ['POST /auth/anon/web', 429, { block: ['RL_AUTH'], body: {} }],
  ['POST /auth/anon/web', 503, { before: turnstile('down'), body: { turnstile: 'x' } }],
  ['POST /auth/app/start', 201, { body: { email: 'app@u.nus.edu', name: 'MacBook Air' } }],
  ['POST /auth/app/start', 201, { auth: 'anon', body: { email: 'app@u.nus.edu' }, why: 'keeping the app’s setup' }],
  ['POST /auth/app/start', 400, { body: { email: 'nope' } }],
  ['POST /auth/app/start', 409, { auth: 'device', body: { email: 'app@u.nus.edu' } }],
  ['POST /auth/app/start', 429, { block: ['RL_AUTH'], body: { email: 'app@u.nus.edu' } }],
  ['POST /auth/app/start', 429, { before: (w) => startApp(w), body: { email: 'app@u.nus.edu' }, why: 'an email a moment ago' }],
  ['POST /auth/app/start', 502, { before: mailFails, body: { email: 'app@u.nus.edu' } }],
  ['POST /auth/app/poll', 200, { before: (w) => startApp(w), body: (w) => ({ request: w.started.request, poll: w.started.poll }) }],
  ['POST /auth/app/poll', 400, { body: {} }],
  ['POST /auth/app/poll', 429, { block: ['RL_PUBLIC'], body: {} }],
  ['POST /auth/app/code', 200, { before: (w) => startApp(w), body: (w) => ({ request: w.started.request, poll: w.started.poll, code: w.appCode }) }],
  ['POST /auth/app/code', 400, { before: (w) => startApp(w), body: (w) => ({ request: w.started.request, poll: w.started.poll, code: 'ZZZZZZ' }) }],
  ['POST /auth/app/code', 429, { block: ['RL_AUTH'], body: {} }],
  ['POST /auth/app/merge', 200, { auth: 'device', body: (w) => ({ anon: w.anon, keep: 'account' }) }],
  ['POST /auth/app/merge', 400, { auth: 'device', body: { anon: 'nope', keep: 'account' } }],
  ['POST /auth/app/merge', 401, { body: { anon: 'nope', keep: 'account' } }],
  ['GET /auth/approve', 200, { before: (w) => startApp(w), path: (w) => `/auth/approve?r=${w.approveLink}` }],
  ['GET /auth/approve', 400, { path: '/auth/approve?r=nope' }],
  ['GET /auth/approve', 429, { block: ['RL_PUBLIC'], path: '/auth/approve?r=nope' }],
  ['POST /auth/approve', 200, { before: (w) => startApp(w), form: (w) => ({ r: w.approveLink, n: String(w.started.match) }) }],
  ['POST /auth/approve', 200, { before: (w) => startApp(w), form: (w) => ({ r: w.approveLink, n: 'none' }), why: '“This wasn’t me”' }],
  ['POST /auth/approve', 400, { before: (w) => startApp(w), form: (w) => ({ r: w.approveLink, n: String(w.started.match === 1 ? 2 : 1) }), why: 'the wrong number' }],
  ['POST /auth/approve', 403, { headers: cross, form: { r: 'nope', n: '1' } }],
  ['POST /auth/approve', 429, { block: ['RL_AUTH'], form: { r: 'nope', n: '1' } }],
  ['POST /auth/logout', 200, { auth: 'cookie' }],
  ['POST /auth/logout', 200, { why: 'signed out already' }],
  ['POST /auth/logout', 403, { auth: 'cookie', headers: cross }],
  ['POST /pair', 200, { before: async (w) => { w.code = (await (await w.call('/me/pair-code', { method: 'POST', auth: 'cookie' })).json()).code; }, body: (w) => ({ code: w.code, name: 'Tablet' }) }],
  ['POST /pair', 400, { body: { code: 'ZZZZZZ' } }],
  ['POST /pair', 429, { block: ['RL_AUTH'], body: { code: 'ZZZZZZ' } }],
  ['POST /pair', 429, { block: ['RL_PAIR'], body: { code: 'ZZZZZZ' } }],
  ['POST /pair/check', 200, { before: async (w) => { w.code = (await (await w.call('/me/pair-code', { method: 'POST', auth: 'cookie' })).json()).code; }, body: (w) => ({ code: w.code }) }],
  ['POST /pair/check', 400, { body: { code: 'ZZZZZZ' } }],
  ['POST /pair/check', 429, { block: ['RL_PAIR'], body: { code: 'ZZZZZZ' } }],

  // The account.
  ['GET /me', 200, { auth: 'cookie' }],
  ['GET /me', 200, { auth: 'anon' }],
  ['GET /me', 401, {}],
  ['GET /me', 401, { headers: { authorization: 'Bearer nope' }, why: 'a token that is no session' }],
  ['GET /me', 401, { auth: 'key', why: 'an API key opens only the answers' }],
  ['GET /me', 429, { auth: 'cookie', block: ['RL_ME'] }],
  ['GET /me', 429, { headers: { authorization: 'Bearer nope' }, block: ['RL_AUTH'], why: 'guessing tokens' }],
  ['DELETE /me', 200, { auth: 'cookie' }],
  ['DELETE /me', 200, { auth: 'anon' }],
  ['DELETE /me', 403, { auth: 'device' }],
  ['GET /me/next', 200, { auth: 'cookie' }],
  ['GET /me/next', 200, { auth: 'device', path: `/me/next?place=mrt&${DORM}&h12=1&lang=zh` }],
  ['GET /me/next', 401, { auth: 'key' }],
  ['GET /me/nearby', 200, { auth: 'cookie', path: `/me/nearby?${DORM}&stopped=1` }],
  ['GET /me/nearby', 400, { auth: 'anon', why: 'no location and no home' }],
  ['GET /me/day', 200, { auth: 'cookie' }],
  ['GET /me/day', 401, {}],
  ['POST /me/signal', 200, { auth: 'cookie', body: { kind: 'skipped', trip: CLASS_KEY } }],
  ['POST /me/signal', 200, { auth: 'device', body: { kind: 'away' } }],
  ['POST /me/signal', 400, { auth: 'cookie', body: { kind: 'flew' } }],
  ['POST /me/signal', 400, { auth: 'cookie', body: { kind: 'skipped', trip: '1:2:NOPE' }, why: 'no such trip' }],
  ['POST /me/signal', 409, { auth: 'anon', body: { kind: 'boarded' } }],
  ['POST /me/signal', 503, { auth: 'cookie', before: (w) => delete w.env.TRIPS, body: { kind: 'reset' } }],
  ['POST /me/push', 200, { auth: 'device', body: { token: 'fcm-token' } }],
  ['POST /me/push', 400, { auth: 'device', body: {} }],
  ['POST /me/push', 503, { auth: 'cookie', before: (w) => delete w.env.VAPID_PRIVATE_KEY, body: { subscription: { endpoint: 'https://push.example.test/x', keys: { p256dh: 'a', auth: 'b' } } } }],
  ['DELETE /me/push', 200, { auth: 'device' }],
  ['DELETE /me/push', 401, {}],
  ['GET /me/push/key', 200, { auth: 'cookie' }],
  ['GET /me/push/key', 503, { auth: 'cookie', before: (w) => delete w.env.VAPID_PRIVATE_KEY }],
  ['POST /me/choice', 200, { auth: 'cookie', body: { trip: CLASS_KEY, pref: 'earlier', choice: 'undo' } }],
  ['POST /me/choice', 400, { auth: 'cookie', body: {} }],
  ['GET /me/notice', 200, { auth: 'cookie' }],
  ['GET /me/choices', 200, { auth: 'cookie' }],
  ['DELETE /me/history', 200, { auth: 'cookie' }],
  ['POST /me/feedback', 201, { auth: 'cookie', body: { kind: 'wrong', note: 'The D2 never came', platform: 'web', appVersion: '2.4.2', context: { label: 'D2 · 4 min' } } }],
  ['POST /me/feedback', 400, { auth: 'cookie', body: { note: '', platform: 'web' } }],
  ['POST /me/feedback', 403, { auth: 'anon', body: { note: 'hi', platform: 'android' } }],
  ['POST /me/feedback', 429, { auth: 'cookie', before: async (w) => { for (let i = 0; i < 10; i++) await w.call('/me/feedback', { method: 'POST', auth: 'cookie', body: { note: `n${i}`, platform: 'web' } }); }, body: { note: 'again', platform: 'web' } }],
  ['GET /me/keys', 200, { auth: 'cookie' }],
  ['POST /me/keys', 201, { auth: 'cookie', body: { name: 'Another' } }],
  ['POST /me/keys', 400, { auth: 'cookie', body: {} }],
  ['POST /me/keys', 403, { auth: 'device', body: { name: 'From a phone' } }],
  ['POST /me/keys', 409, { auth: 'cookie', before: async (w) => { for (let i = 0; i < 4; i++) await w.call('/me/keys', { method: 'POST', auth: 'cookie', body: { name: `k${i}` } }); }, body: { name: 'Sixth' } }],
  ['DELETE /me/keys/{id}', 200, { auth: 'cookie', path: (w) => `/me/keys/${w.keyId}` }],
  ['DELETE /me/keys/{id}', 403, { auth: 'device', path: (w) => `/me/keys/${w.keyId}` }],
  ['DELETE /me/keys/{id}', 404, { auth: 'cookie', path: '/me/keys/nope' }],
  ['GET /me/profile', 200, { auth: 'cookie' }],
  ['PUT /me/profile', 200, { auth: 'cookie', body: { ...PROFILE, publicBuses: true, lang: 'en' } }],
  ['PUT /me/profile', 400, { auth: 'cookie', body: { gapHours: 99 } }],
  ['PUT /me/profile', 412, { auth: 'cookie', headers: { 'if-match': '"1"' }, body: PROFILE }],
  ['POST /me/once', 200, { auth: 'cookie', body: { to: 'CLB', atMin: 840, label: 'Science library' } }],
  ['POST /me/once', 400, { auth: 'cookie', body: { to: 'CLB', atMin: 60 }, why: 'a time already past' }],
  ['POST /me/import', 200, { auth: 'cookie', body: { share: 'https://nusmods.com/timetable/sem-1/share?MA1100=LEC:1' } }],
  ['POST /me/import', 400, { auth: 'cookie', body: { share: 'https://example.test/' } }],
  ['POST /me/import', 422, { auth: 'cookie', body: { share: 'https://nusmods.com/timetable/sem-1/share?CS9999=LEC:1' }, why: 'NUSMods has no such module' }],
  ['POST /me/import', 429, { auth: 'cookie', block: ['RL_AUTH'], body: { share: 'https://nusmods.com/timetable/sem-1/share?MA1100=LEC:1' } }],
  ['POST /me/import', 502, { auth: 'cookie', body: { share: 'https://nusmods.com/timetable/sem-1/share?BZ1000=LEC:1' }, why: 'NUSMods did not answer' }],
  ['GET /me/export', 200, { auth: 'cookie', before: (w) => w.call('/me/feedback', { method: 'POST', auth: 'cookie', body: { note: 'kept', platform: 'web', context: { label: 'x' } } }) }],
  ['DELETE /me/sessions', 200, { auth: 'cookie' }],
  ['DELETE /me/sessions', 403, { auth: 'device' }],
  ['POST /me/pair-code', 200, { auth: 'cookie' }],
  ['POST /me/pair-code', 403, { auth: 'anon' }],
  ['GET /me/devices', 200, { auth: 'device' }],
  ['DELETE /me/devices/{id}', 200, { auth: 'cookie', before: async (w) => { w.deviceId = (await (await w.call('/me/devices', { auth: 'cookie' })).json()).devices[0].id; }, path: (w) => `/me/devices/${w.deviceId}` }],
  ['DELETE /me/devices/{id}', 403, { auth: 'anon', path: '/me/devices/nope' }],
  ['DELETE /me/devices/{id}', 404, { auth: 'cookie', path: '/me/devices/nope' }],

  // The map.
  ['GET /map/style.json', 200, { path: '/map/style.json?theme=dark&lang=zh' }],
  ['GET /map/campus.pmtiles', 200, {}],
  ['GET /map/campus.pmtiles', 206, { headers: { range: 'bytes=0-9' } }],
  ['GET /map/campus.pmtiles', 304, { before: etagOf('/map/campus.pmtiles'), headers: (w) => ({ 'if-none-match': w.etag }) }],
  ['GET /map/campus.pmtiles', 404, { before: (w) => { w.env.DOWNLOADS = downloads({}); } }],
  ['GET /map/campus.pmtiles', 416, { headers: { range: 'bytes=1000-' } }],
  ['GET /map/campus.pmtiles', 429, { block: ['RL_MAP'] }],
  ['GET /map/campus.pmtiles', 503, { before: r2Fails }],
  ['GET /map/fonts/{fontstack}/{range}.pbf', 200, { path: '/map/fonts/Noto%20Sans%20Regular/0-255.pbf' }],
  ['GET /map/fonts/{fontstack}/{range}.pbf', 304, { before: etagOf('/map/fonts/Noto%20Sans%20Regular/0-255.pbf'), headers: (w) => ({ 'if-none-match': w.etag }), path: '/map/fonts/Noto%20Sans%20Regular/0-255.pbf' }],
  ['GET /map/fonts/{fontstack}/{range}.pbf', 404, { path: '/map/fonts/Noto%20Sans%20Regular/1-2.pbf' }],
  ['GET /map/fonts/{fontstack}/{range}.pbf', 429, { block: ['RL_MAP'], path: '/map/fonts/Noto%20Sans%20Regular/0-255.pbf' }],
  ['GET /map/fonts/{fontstack}/{range}.pbf', 503, { before: r2Fails, path: '/map/fonts/Noto%20Sans%20Regular/0-255.pbf' }],
  ['GET /map/sprites/v4/{sprite}', 200, { path: '/map/sprites/v4/light.json' }],
  ['GET /map/sprites/v4/{sprite}', 304, { before: etagOf('/map/sprites/v4/light.json'), headers: (w) => ({ 'if-none-match': w.etag }), path: '/map/sprites/v4/light.json' }],
  ['GET /map/sprites/v4/{sprite}', 404, { path: '/map/sprites/v4/dark.png' }],
  ['GET /map/sprites/v4/{sprite}', 429, { block: ['RL_MAP'], path: '/map/sprites/v4/light.json' }],

  // Downloads.
  ['GET /download/latest.json', 200, {}],
  ['GET /download/latest.json', 404, { before: (w) => { w.env.DOWNLOADS = downloads({}); } }],
  ['GET /download/latest.json', 429, { block: ['RL_PUBLIC'] }],
  ['GET /download/latest.json', 503, { before: (w) => delete w.env.DOWNLOADS }],
  ['GET /download/android', 200, {}],
  ['GET /download/android', 404, { before: (w) => { w.env.DOWNLOADS = downloads({}); } }],
  ['GET /download/mac', 200, {}],
  ['GET /download/appcast.xml', 200, {}],
  ['GET /download/appcast.xml', 404, { before: (w) => { w.env.DOWNLOADS = downloads({}); } }],
  ['GET /download/releases/{version}/{file}', 200, { path: `/download/releases/${API_VERSION}/terminus-${API_VERSION}.apk` }],
  ['GET /download/releases/{version}/{file}', 404, { path: '/download/releases/1.0.0/terminus-1.0.0.apk' }],
];

const at = (w, v) => (typeof v === 'function' ? v(w) : v);

/** What the spec says of `res` for `op`: the status listed, the body its schema, the headers it names. */
async function conforms(op, res) {
  const status = String(res.status);
  const doc = op.op.responses[status];
  assert.ok(doc, `${op.key} answered ${status}, which the spec does not list (it lists ${Object.keys(op.op.responses).join(', ')}): ${await res.clone().text()}`);
  for (const name of Object.keys(doc.headers ?? {})) assert.ok(res.headers.has(name), `${op.key} ${status}: no ${name} header, which the spec promises`);
  if (!doc.content) return;
  const type = (res.headers.get('content-type') ?? '').split(';')[0];
  const text = await res.text();
  if (!text) return;
  assert.ok(Object.keys(doc.content).includes(type), `${op.key} ${status}: sent ${type}, the spec says ${Object.keys(doc.content).join(' or ')}`);
  const schema = doc.content[type]?.schema;
  if (type !== 'application/json' || !schema) return;
  assert.deepEqual(check(schema, JSON.parse(text)), [], `${op.key} ${status}: the body does not fit its schema`);
}

for (const [key, status, opts] of CASES) {
  test(`spec: ${key} → ${status}${opts.why ? ` (${opts.why})` : ''}`, async () => {
    const op = opOf(key);
    const w = await world();
    await opts.before?.(w);
    for (const name of opts.block ?? []) w.limit[name].block = true;
    const res = await send(w, at(w, opts.path) ?? op.path, { method: op.method, auth: opts.auth, body: at(w, opts.body), form: at(w, opts.form), headers: at(w, opts.headers) });
    assert.equal(res.status, status, `the case itself: ${await res.clone().text()}`);
    await conforms(op, res);
  });
}

test('every operation has a case that succeeds', () => {
  const covered = new Set(CASES.filter(([, s]) => s < 400).map(([k]) => k));
  assert.deepEqual(OPS.map((o) => o.key).filter((k) => !covered.has(k)), []);
});

/* ---------- 4. security ---------- */

const SAMPLE = { id: 'x', date: '2026-08-26', fontstack: 'Noto%20Sans%20Regular', range: '0-255', sprite: 'light.json', version: API_VERSION, file: `terminus-${API_VERSION}.apk` };

test('an operation refuses a caller without credentials (401) exactly when its security asks for some', async () => {
  const w = await world();
  const wrong = [];
  for (const op of OPS) {
    const security = op.op.security ?? spec.security;
    // `{}` among the requirements: credentials are optional.
    const needs = security.length > 0 && !security.some((r) => Object.keys(r).length === 0);
    // The operator's routes hide behind a 404, as if they weren't there.
    const operator = needs && security.every((r) => Object.keys(r).every((k) => k === 'operator'));
    const path = op.path.replace(/\{(\w+)\}/g, (_, k) => SAMPLE[k]);
    const res = await send(w, path, { method: op.method, ...(op.method === 'GET' || op.method === 'DELETE' ? {} : { body: {} }) });
    const expected = operator ? 404 : needs ? 401 : null;
    if (expected ? res.status !== expected : res.status === 401) wrong.push(`${op.key}: ${res.status}, expected ${expected ?? 'not 401'}`);
    if (res.status === 401 && op.op.responses['401'] === undefined) wrong.push(`${op.key}: 401 not documented`);
  }
  assert.deepEqual(wrong, []);
});

/* ---------- 5. no unused schemas ---------- */

test('every component schema is used', () => {
  const text = JSON.stringify(spec);
  const unused = Object.keys(spec.components.schemas).filter((name) => {
    const own = JSON.stringify(spec.components.schemas[name]);
    const ref = `"#/components/schemas/${name}"`;
    // Referenced somewhere other than inside itself.
    return text.split(ref).length - own.split(ref).length < 1;
  });
  assert.deepEqual(unused, []);
});
