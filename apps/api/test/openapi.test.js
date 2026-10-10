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
import { makeAuthenticator } from './_passkey.mjs';
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
    const route = Array.isArray(body.items) && body.date ? 'GET /api/me/day' : Array.isArray(body.stops) && !('label' in body) ? 'GET /api/me/nearby' : 'GET /api/me/next';
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

  await call('/api/auth/login', { method: 'POST', body: { email: 'you@u.nus.edu' } });
  const verified = await call('/auth/verify', { method: 'POST', form: { t: w.email.lastToken() } });
  w.cookie = verified.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/api/me/profile', { method: 'PUT', auth: 'cookie', body: PROFILE })).status, 200);
  const key = await (await call('/api/me/keys', { method: 'POST', auth: 'cookie', body: { name: 'script' } })).json();
  w.key = key.key;
  w.keyId = key.id;
  const { code } = await (await call('/api/me/pair-code', { method: 'POST', auth: 'cookie' })).json();
  w.device = (await (await call('/api/pair', { method: 'POST', body: { code, name: 'Pixel 8' } })).json()).token;
  w.anon = (await (await call('/api/auth/anon', { method: 'POST', body: { name: 'Phone', platform: 'android' } })).json()).token;
  assert.ok(w.cookie && w.key && w.device && w.anon, 'the world has its callers');
  return w;
}

/** Starts an app's sign-in for a new address: `w.started` and the email's code and link. */
async function startApp(w, address = 'app@u.nus.edu') {
  w.started = await (await w.call('/api/auth/app/start', { method: 'POST', body: { email: address, name: 'MacBook' } })).json();
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
const challengeOf = async (w) => (await (await w.call('/api/admin/passkey/challenge')).json()).challenge;
/** A new passkey, made but not yet kept, in `w.made`. */
const passkey = async (w) => {
  w.authenticator = await makeAuthenticator({ origin: BASE });
  w.made = await w.authenticator.create(await challengeOf(w));
};
/** A kept passkey, and its answer to a fresh challenge in `w.assertion`. */
const signedIn = async (w) => {
  await passkey(w);
  await w.call('/api/admin/passkey/register', { method: 'POST', auth: 'operator', body: w.made });
  w.assertion = await w.authenticator.get(await challengeOf(w));
};

/**
 * [operation, status, options]: options as send() takes them, plus `path`
 * (the request's own, by default the operation's), `block` (limiters that
 * refuse), and `before(w)`. A function of `w` for path, body or form or
 * headers is called with the world once `before` has run.
 */
const CASES = [
  // Answers and stops: a key or a session.
  ['GET /api/next', 200, { auth: 'cookie', why: 'nothing sent: set up' }],
  ['GET /api/next', 200, { auth: 'key', path: `/api/next?to=UTOWN&${DORM}`, why: 'with a key' }],
  ['GET /api/next', 200, { auth: 'device', path: '/api/next?from=PGP&to=COM3', why: 'with a device token' }],
  ['GET /api/next', 401, { why: 'no key' }],
  ['GET /api/next', 401, { headers: { 'x-api-key': 'tk_nope' }, why: 'a wrong key' }],
  ['GET /api/next', 429, { auth: 'key', block: ['RL_PUBLIC'], why: 'a key over its limit' }],
  ['GET /api/next', 429, { auth: 'cookie', block: ['RL_ME'], why: 'an account over its limit' }],
  ['GET /api/trip', 200, { auth: 'cookie', path: '/api/trip?to=UTOWN&from=PGP' }],
  ['GET /api/trip', 400, { auth: 'cookie', path: '/api/trip?to=NARNIA&from=PGP' }],
  ['GET /api/trip', 400, { auth: 'cookie', path: '/api/trip?to=UTOWN', why: 'no location and no from' }],
  ['GET /api/trip', 401, { path: '/api/trip?to=UTOWN&from=PGP' }],
  ['GET /api/arrivals', 200, { auth: 'cookie', path: '/api/arrivals?stop=COM3' }],
  ['GET /api/arrivals', 200, { auth: 'cookie', path: '/api/arrivals?stop=COM3&stopped=1&public=1' }],
  ['GET /api/arrivals', 400, { auth: 'cookie', path: '/api/arrivals?stop=NARNIA' }],
  ['GET /api/arrivals', 429, { block: ['RL_PUBLIC'], path: '/api/arrivals?stop=COM3', why: 'by IP, before the key is asked for' }],
  ['GET /api/buses', 200, { auth: 'cookie', path: '/api/buses?svc=D2' }],
  ['GET /api/buses', 400, { auth: 'cookie', path: '/api/buses?svc=Z9' }],
  ['GET /api/line', 200, { auth: 'cookie', path: '/api/line?svc=D1' }],
  ['GET /api/line', 200, { auth: 'cookie', path: '/api/line?svc=D1&stop=YIH' }],
  ['GET /api/line', 400, { auth: 'cookie', path: '/api/line?svc=D1&stop=PGP' }],
  ['GET /api/campus', 200, { auth: 'cookie' }],
  ['GET /api/campus', 304, { auth: 'cookie', before: etagOf('/api/campus'), headers: (w) => ({ 'if-none-match': w.etag }) }],
  ['GET /api/stops/pairs', 200, { auth: 'key' }],
  ['GET /api/stops/pairs', 401, {}],

  // Service.
  ['GET /api/status.json', 200, {}],
  ['GET /api/status.json', 429, { block: ['RL_PUBLIC'] }],
  ['GET /api/health', 200, {}],
  ['GET /api/health', 200, { auth: 'operator', path: '/api/health?probe=1&versions=1', why: 'the operator’s probe and versions' }],
  ['GET /api/health', 503, { before: (w) => w.env.KV.put('monitor:upstream', JSON.stringify({ up: false, since: FROZEN_NOW - 3_600_000, checkedAt: FROZEN_NOW - 60_000, reason: 'feed' })), why: 'the feed is down' }],
  ['GET /api/health', 429, { block: ['RL_PUBLIC'] }],
  ['GET /docs', 200, {}],
  ['GET /api/openapi.json', 200, {}],
  ['GET /api/admin/stats', 200, { auth: 'operator' }],
  ['POST /api/admin/collect', 200, { auth: 'operator', body: { name: 'errors', on: true } }],
  ['POST /api/admin/collect', 400, { auth: 'operator', body: { name: 'everything', on: true } }],
  ['POST /api/admin/collect', 404, { body: { name: 'errors', on: true } }],
  ['POST /api/errors', 204, { body: { platform: 'web', version: '3.1.0', os: 'Chrome 140', type: 'TypeError', message: 'x is undefined', stack: 'at f (https://terminus.run/app/app.js:1:2)' } }],
  ['POST /api/errors', 400, { body: { platform: 'pager', version: '1', type: 'x' } }],
  ['POST /api/errors', 429, { block: ['RL_PUBLIC'], body: { platform: 'web', version: '3.1.0', type: 'TypeError' } }],
  ['GET /api/admin/stats', 404, {}],
  ['GET /api/admin/stats', 429, { auth: 'operator', block: ['RL_PUBLIC'] }],
  ['GET /api/admin/passkey/challenge', 200, {}],
  ['GET /api/admin/passkey/challenge', 200, { auth: 'operator', path: '/api/admin/passkey/challenge?register=1', why: 'to add a passkey' }],
  ['GET /api/admin/passkey/challenge', 404, { path: '/api/admin/passkey/challenge?register=1', why: 'to add one, without the token' }],
  ['GET /api/admin/passkey/challenge', 404, { before: (w) => delete w.env.HEALTH_TOKEN }],
  ['GET /api/admin/passkey/challenge', 429, { block: ['RL_PUBLIC'] }],
  ['POST /api/admin/passkey/register', 201, { auth: 'operator', before: passkey, body: (w) => w.made }],
  ['POST /api/admin/passkey/register', 400, { auth: 'operator', body: { id: 'x' } }],
  ['POST /api/admin/passkey/register', 403, { auth: 'operator', before: passkey, body: (w) => ({ ...w.made, id: 'AAAA' }) }],
  ['POST /api/admin/passkey/register', 404, { before: passkey, body: (w) => w.made }],
  ['POST /api/admin/passkey/register', 409, { auth: 'operator', before: async (w) => { await passkey(w); await w.env.KV.put('operator:passkeys', JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ id: `k${i}`, rpId: 'x', alg: -7, key: 'x', name: '', created: '' })))); }, body: (w) => w.made }],
  ['POST /api/admin/passkey/register', 429, { auth: 'operator', block: ['RL_PUBLIC'], body: {} }],
  ['POST /api/admin/passkey/signin', 200, { before: signedIn, body: (w) => w.assertion }],
  ['POST /api/admin/passkey/signin', 400, { body: {} }],
  ['POST /api/admin/passkey/signin', 403, { before: async (w) => { await passkey(w); w.assertion = await w.authenticator.get(await challengeOf(w)); }, body: (w) => w.assertion, why: 'a passkey never kept' }],
  ['POST /api/admin/passkey/signin', 404, { before: (w) => delete w.env.HEALTH_TOKEN, body: {} }],
  ['POST /api/admin/passkey/signin', 429, { block: ['RL_PUBLIC'], body: {} }],
  ['GET /api/timelapse/days', 200, { auth: 'operator' }],
  ['GET /api/timelapse/days', 404, {}],
  ['GET /api/timelapse/days', 429, { auth: 'operator', block: ['RL_PUBLIC'] }],
  ['GET /api/timelapse/days/{date}', 200, { auth: 'operator', path: '/api/timelapse/days/2026-08-26' }],
  ['GET /api/timelapse/days/{date}', 404, { auth: 'operator', path: '/api/timelapse/days/2026-08-01' }],

  // Signing in.
  ['GET /api/auth/config', 200, {}],
  ['GET /api/auth/config', 429, { block: ['RL_PUBLIC'] }],
  ['POST /api/auth/login', 200, { body: { email: 'new@u.nus.edu' } }],
  ['POST /api/auth/login', 400, { body: { email: 'not an email' } }],
  ['POST /api/auth/login', 400, { before: turnstile('fail'), body: { email: 'new@u.nus.edu', turnstile: 'bad' }, why: 'the human check failed' }],
  ['POST /api/auth/login', 429, { block: ['RL_AUTH'], body: { email: 'new@u.nus.edu' } }],
  ['POST /api/auth/login', 429, { block: ['RL_MAIL'], body: { email: 'new@u.nus.edu' }, why: 'too many emails for everyone' }],
  ['POST /api/auth/login', 502, { before: mailFails, body: { email: 'new@u.nus.edu' } }],
  ['POST /api/auth/login', 503, { before: turnstile('down'), body: { email: 'new@u.nus.edu', turnstile: 'x' } }],
  ['POST /api/auth/code', 200, { before: async (w) => { await w.call('/api/auth/login', { method: 'POST', body: { email: 'new@u.nus.edu' } }); w.code = w.email.lastCode(); }, body: (w) => ({ email: 'new@u.nus.edu', code: w.code }) }],
  ['POST /api/auth/code', 400, { body: { email: 'new@u.nus.edu', code: 'ABCDEF' } }],
  ['POST /api/auth/code', 403, { headers: cross, body: { email: 'new@u.nus.edu', code: 'ABCDEF' } }],
  ['POST /api/auth/code', 429, { block: ['RL_AUTH'], body: { email: 'new@u.nus.edu', code: 'ABCDEF' } }],
  ['GET /auth/verify', 200, { before: async (w) => { await w.call('/api/auth/login', { method: 'POST', body: { email: 'new@u.nus.edu' } }); w.t = w.email.lastToken(); }, path: (w) => `/auth/verify?t=${w.t}` }],
  ['GET /auth/verify', 400, { path: '/auth/verify?t=nope' }],
  ['GET /auth/verify', 429, { block: ['RL_PUBLIC'], path: '/auth/verify?t=nope' }],
  ['POST /auth/verify', 303, { before: async (w) => { await w.call('/api/auth/login', { method: 'POST', body: { email: 'new@u.nus.edu' } }); w.t = w.email.lastToken(); }, form: (w) => ({ t: w.t }) }],
  ['POST /auth/verify', 400, { form: { t: 'nope' } }],
  ['POST /auth/verify', 403, { headers: cross, form: { t: 'nope' } }],
  ['POST /api/auth/anon', 201, { body: { name: 'Pixel 8', platform: 'android' } }],
  ['POST /api/auth/anon', 429, { block: ['RL_AUTH'], body: {} }],
  ['POST /api/auth/anon', 429, { block: ['RL_ANON'], body: {}, why: 'too many for everyone' }],
  ['POST /api/auth/anon/web', 201, { body: {} }],
  ['POST /api/auth/anon/web', 400, { before: turnstile('fail'), body: { turnstile: 'bad' } }],
  ['POST /api/auth/anon/web', 403, { headers: cross, body: {} }],
  ['POST /api/auth/anon/web', 429, { block: ['RL_AUTH'], body: {} }],
  ['POST /api/auth/anon/web', 503, { before: turnstile('down'), body: { turnstile: 'x' } }],
  ['POST /api/auth/app/start', 201, { body: { email: 'app@u.nus.edu', name: 'MacBook Air' } }],
  ['POST /api/auth/app/start', 201, { auth: 'anon', body: { email: 'app@u.nus.edu' }, why: 'keeping the app’s setup' }],
  ['POST /api/auth/app/start', 400, { body: { email: 'nope' } }],
  ['POST /api/auth/app/start', 409, { auth: 'device', body: { email: 'app@u.nus.edu' } }],
  ['POST /api/auth/app/start', 429, { block: ['RL_AUTH'], body: { email: 'app@u.nus.edu' } }],
  ['POST /api/auth/app/start', 429, { before: (w) => startApp(w), body: { email: 'app@u.nus.edu' }, why: 'an email a moment ago' }],
  ['POST /api/auth/app/start', 502, { before: mailFails, body: { email: 'app@u.nus.edu' } }],
  ['POST /api/auth/app/poll', 200, { before: (w) => startApp(w), body: (w) => ({ request: w.started.request, poll: w.started.poll }) }],
  ['POST /api/auth/app/poll', 400, { body: {} }],
  ['POST /api/auth/app/poll', 429, { block: ['RL_PUBLIC'], body: {} }],
  ['POST /api/auth/app/code', 200, { before: (w) => startApp(w), body: (w) => ({ request: w.started.request, poll: w.started.poll, code: w.appCode }) }],
  ['POST /api/auth/app/code', 400, { before: (w) => startApp(w), body: (w) => ({ request: w.started.request, poll: w.started.poll, code: 'ZZZZZZ' }) }],
  ['POST /api/auth/app/code', 429, { block: ['RL_AUTH'], body: {} }],
  ['POST /api/auth/app/merge', 200, { auth: 'device', body: (w) => ({ anon: w.anon, keep: 'account' }) }],
  ['POST /api/auth/app/merge', 400, { auth: 'device', body: { anon: 'nope', keep: 'account' } }],
  ['POST /api/auth/app/merge', 401, { body: { anon: 'nope', keep: 'account' } }],
  ['GET /auth/approve', 200, { before: (w) => startApp(w), path: (w) => `/auth/approve?r=${w.approveLink}` }],
  ['GET /auth/approve', 400, { path: '/auth/approve?r=nope' }],
  ['GET /auth/approve', 429, { block: ['RL_PUBLIC'], path: '/auth/approve?r=nope' }],
  ['POST /auth/approve', 200, { before: (w) => startApp(w), form: (w) => ({ r: w.approveLink, n: String(w.started.match) }) }],
  ['POST /auth/approve', 200, { before: (w) => startApp(w), form: (w) => ({ r: w.approveLink, n: 'none' }), why: '“This wasn’t me”' }],
  ['POST /auth/approve', 400, { before: (w) => startApp(w), form: (w) => ({ r: w.approveLink, n: String(w.started.match === 1 ? 2 : 1) }), why: 'the wrong number' }],
  ['POST /auth/approve', 403, { headers: cross, form: { r: 'nope', n: '1' } }],
  ['POST /auth/approve', 429, { block: ['RL_AUTH'], form: { r: 'nope', n: '1' } }],
  ['POST /api/auth/logout', 200, { auth: 'cookie' }],
  ['POST /api/auth/logout', 200, { why: 'signed out already' }],
  ['POST /api/auth/logout', 403, { auth: 'cookie', headers: cross }],
  ['POST /api/pair', 200, { before: async (w) => { w.code = (await (await w.call('/api/me/pair-code', { method: 'POST', auth: 'cookie' })).json()).code; }, body: (w) => ({ code: w.code, name: 'Tablet' }) }],
  ['POST /api/pair', 400, { body: { code: 'ZZZZZZ' } }],
  ['POST /api/pair', 429, { block: ['RL_AUTH'], body: { code: 'ZZZZZZ' } }],
  ['POST /api/pair', 429, { block: ['RL_PAIR'], body: { code: 'ZZZZZZ' } }],
  ['POST /api/pair/check', 200, { before: async (w) => { w.code = (await (await w.call('/api/me/pair-code', { method: 'POST', auth: 'cookie' })).json()).code; }, body: (w) => ({ code: w.code }) }],
  ['POST /api/pair/check', 400, { body: { code: 'ZZZZZZ' } }],
  ['POST /api/pair/check', 429, { block: ['RL_PAIR'], body: { code: 'ZZZZZZ' } }],

  // The account.
  ['GET /api/me', 200, { auth: 'cookie' }],
  ['GET /api/me', 200, { auth: 'anon' }],
  ['GET /api/me', 401, {}],
  ['GET /api/me', 401, { headers: { authorization: 'Bearer nope' }, why: 'a token that is no session' }],
  ['GET /api/me', 401, { auth: 'key', why: 'an API key opens only the answers' }],
  ['GET /api/me', 429, { auth: 'cookie', block: ['RL_ME'] }],
  ['GET /api/me', 429, { headers: { authorization: 'Bearer nope' }, block: ['RL_AUTH'], why: 'guessing tokens' }],
  ['DELETE /api/me', 200, { auth: 'cookie' }],
  ['DELETE /api/me', 200, { auth: 'anon' }],
  ['DELETE /api/me', 403, { auth: 'device' }],
  ['GET /api/me/next', 200, { auth: 'cookie' }],
  ['GET /api/me/next', 200, { auth: 'device', path: `/api/me/next?place=mrt&${DORM}&h12=1&lang=zh` }],
  ['GET /api/me/next', 401, { auth: 'key' }],
  ['GET /api/me/nearby', 200, { auth: 'cookie', path: `/api/me/nearby?${DORM}&stopped=1` }],
  ['GET /api/me/nearby', 400, { auth: 'anon', why: 'no location and no home' }],
  ['GET /api/me/day', 200, { auth: 'cookie' }],
  ['GET /api/me/day', 401, {}],
  ['POST /api/me/signal', 200, { auth: 'cookie', body: { kind: 'skipped', trip: CLASS_KEY } }],
  ['POST /api/me/signal', 200, { auth: 'device', body: { kind: 'away' } }],
  ['POST /api/me/signal', 400, { auth: 'cookie', body: { kind: 'flew' } }],
  ['POST /api/me/signal', 400, { auth: 'cookie', body: { kind: 'skipped', trip: '1:2:NOPE' }, why: 'no such trip' }],
  ['POST /api/me/signal', 409, { auth: 'anon', body: { kind: 'boarded' } }],
  ['POST /api/me/signal', 503, { auth: 'cookie', before: (w) => delete w.env.TRIPS, body: { kind: 'reset' } }],
  ['POST /api/me/push', 200, { auth: 'device', body: { token: 'fcm-token' } }],
  ['POST /api/me/push', 400, { auth: 'device', body: {} }],
  ['POST /api/me/push', 503, { auth: 'cookie', before: (w) => delete w.env.VAPID_PRIVATE_KEY, body: { subscription: { endpoint: 'https://push.example.test/x', keys: { p256dh: 'a', auth: 'b' } } } }],
  ['DELETE /api/me/push', 200, { auth: 'device' }],
  ['DELETE /api/me/push', 401, {}],
  ['GET /api/me/push/key', 200, { auth: 'cookie' }],
  ['GET /api/me/push/key', 503, { auth: 'cookie', before: (w) => delete w.env.VAPID_PRIVATE_KEY }],
  ['POST /api/me/choice', 200, { auth: 'cookie', body: { trip: CLASS_KEY, pref: 'earlier', choice: 'undo' } }],
  ['POST /api/me/choice', 400, { auth: 'cookie', body: {} }],
  ['GET /api/me/notice', 200, { auth: 'cookie' }],
  ['GET /api/me/choices', 200, { auth: 'cookie' }],
  ['DELETE /api/me/history', 200, { auth: 'cookie' }],
  ['POST /api/me/feedback', 201, { auth: 'cookie', body: { kind: 'wrong', note: 'The D2 never came', platform: 'web', appVersion: '2.4.2', context: { label: 'D2 · 4 min' } } }],
  ['POST /api/me/feedback', 400, { auth: 'cookie', body: { note: '', platform: 'web' } }],
  ['POST /api/me/feedback', 403, { auth: 'anon', body: { note: 'hi', platform: 'android' } }],
  ['POST /api/me/feedback', 429, { auth: 'cookie', before: async (w) => { for (let i = 0; i < 10; i++) await w.call('/api/me/feedback', { method: 'POST', auth: 'cookie', body: { note: `n${i}`, platform: 'web' } }); }, body: { note: 'again', platform: 'web' } }],
  ['GET /api/me/keys', 200, { auth: 'cookie' }],
  ['POST /api/me/keys', 201, { auth: 'cookie', body: { name: 'Another' } }],
  ['POST /api/me/keys', 400, { auth: 'cookie', body: {} }],
  ['POST /api/me/keys', 403, { auth: 'device', body: { name: 'From a phone' } }],
  ['POST /api/me/keys', 409, { auth: 'cookie', before: async (w) => { for (let i = 0; i < 4; i++) await w.call('/api/me/keys', { method: 'POST', auth: 'cookie', body: { name: `k${i}` } }); }, body: { name: 'Sixth' } }],
  ['DELETE /api/me/keys/{id}', 200, { auth: 'cookie', path: (w) => `/api/me/keys/${w.keyId}` }],
  ['DELETE /api/me/keys/{id}', 403, { auth: 'device', path: (w) => `/api/me/keys/${w.keyId}` }],
  ['DELETE /api/me/keys/{id}', 404, { auth: 'cookie', path: '/api/me/keys/nope' }],
  ['GET /api/me/profile', 200, { auth: 'cookie' }],
  ['PUT /api/me/profile', 200, { auth: 'cookie', body: { ...PROFILE, publicBuses: true, lang: 'en' } }],
  ['PUT /api/me/profile', 400, { auth: 'cookie', body: { gapHours: 99 } }],
  ['PUT /api/me/profile', 412, { auth: 'cookie', headers: { 'if-match': '"1"' }, body: PROFILE }],
  ['POST /api/me/once', 200, { auth: 'cookie', body: { to: 'CLB', atMin: 840, label: 'Science library' } }],
  ['POST /api/me/once', 400, { auth: 'cookie', body: { to: 'CLB', atMin: 60 }, why: 'a time already past' }],
  ['POST /api/me/import', 200, { auth: 'cookie', body: { share: 'https://nusmods.com/timetable/sem-1/share?MA1100=LEC:1' } }],
  ['POST /api/me/import', 400, { auth: 'cookie', body: { share: 'https://example.test/' } }],
  ['POST /api/me/import', 422, { auth: 'cookie', body: { share: 'https://nusmods.com/timetable/sem-1/share?CS9999=LEC:1' }, why: 'NUSMods has no such module' }],
  ['POST /api/me/import', 429, { auth: 'cookie', block: ['RL_AUTH'], body: { share: 'https://nusmods.com/timetable/sem-1/share?MA1100=LEC:1' } }],
  ['POST /api/me/import', 502, { auth: 'cookie', body: { share: 'https://nusmods.com/timetable/sem-1/share?BZ1000=LEC:1' }, why: 'NUSMods did not answer' }],
  ['GET /api/me/export', 200, { auth: 'cookie', before: (w) => w.call('/api/me/feedback', { method: 'POST', auth: 'cookie', body: { note: 'kept', platform: 'web', context: { label: 'x' } } }) }],
  ['DELETE /api/me/sessions', 200, { auth: 'cookie' }],
  ['DELETE /api/me/sessions', 403, { auth: 'device' }],
  ['POST /api/me/pair-code', 200, { auth: 'cookie' }],
  ['POST /api/me/pair-code', 403, { auth: 'anon' }],
  ['GET /api/me/devices', 200, { auth: 'device' }],
  ['DELETE /api/me/devices/{id}', 200, { auth: 'cookie', before: async (w) => { w.deviceId = (await (await w.call('/api/me/devices', { auth: 'cookie' })).json()).devices[0].id; }, path: (w) => `/api/me/devices/${w.deviceId}` }],
  ['DELETE /api/me/devices/{id}', 403, { auth: 'anon', path: '/api/me/devices/nope' }],
  ['DELETE /api/me/devices/{id}', 404, { auth: 'cookie', path: '/api/me/devices/nope' }],

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
