import test from 'node:test';
import assert from 'node:assert/strict';

import { installGlobals, makeCtx, makeEnv, makeFetch } from './_stubs.mjs';
import { makeD1, makeEmail } from './_d1.mjs';
import worker from '../src/index.ts';
import { newPairCode, normalizePairCode } from '../src/accounts.ts';

const BASE = 'https://bus.example.test';
const INVITED = 'friend@u.nus.edu';

function setup() {
  installGlobals(makeFetch());
  const db = makeD1();
  db.exec(`INSERT INTO invites VALUES ('${INVITED}', 0)`);
  const email = makeEmail();
  const env = { ...makeEnv(), DB: db, EMAIL: email, EMAIL_FROM: 'nusbus@example.test' };
  return { db, email, env };
}

async function call(env, path, { method = 'GET', body, token, form, cookie } = {}) {
  const headers = {};
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(form).toString();
  }
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  const ctx = makeCtx();
  const res = await worker.fetch(new Request(BASE + path, { method, headers, body: payload }), env, ctx);
  await ctx.settle();
  return res;
}

/** Full email sign-in; returns the cookie header value. */
async function signIn(env, email) {
  await call(env, '/auth/login', { method: 'POST', body: { email: INVITED } });
  const res = await call(env, '/auth/verify', { method: 'POST', form: { t: email.lastToken() } });
  assert.equal(res.status, 303);
  return res.headers.get('set-cookie').split(';')[0];
}

test('an invited address gets a link; an uninvited one gets the same reply and no email', async () => {
  const { env, email } = setup();
  const a = await call(env, '/auth/login', { method: 'POST', body: { email: 'Friend@U.NUS.edu ' } });
  const b = await call(env, '/auth/login', { method: 'POST', body: { email: 'stranger@example.com' } });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(await a.json(), await b.json(), 'the reply must not reveal the invite list');
  assert.equal(email.sent.length, 1);
  assert.equal(email.sent[0].to, INVITED);
});

test('opening the link does not spend it; the POST does, once', async () => {
  const { env, email } = setup();
  await call(env, '/auth/login', { method: 'POST', body: { email: INVITED } });
  const t = email.lastToken();

  // A mail scanner fetching the link must not use it up.
  const get = await call(env, `/auth/verify?t=${t}`);
  assert.equal(get.status, 200);
  assert.match(await get.text(), /method="post"/);

  const first = await call(env, '/auth/verify', { method: 'POST', form: { t } });
  assert.equal(first.status, 303);
  assert.match(first.headers.get('set-cookie'), /nb_s=.+HttpOnly; Secure; SameSite=Lax/);

  const again = await call(env, '/auth/verify', { method: 'POST', form: { t } });
  assert.equal(again.status, 400);
});

test('an expired link is refused', async () => {
  const { env, email, db } = setup();
  await call(env, '/auth/login', { method: 'POST', body: { email: INVITED } });
  db.exec('UPDATE magic_links SET expires = 0');
  const res = await call(env, '/auth/verify', { method: 'POST', form: { t: email.lastToken() } });
  assert.equal(res.status, 400);
});

test('a second link inside the cooldown is not sent', async () => {
  const { env, email } = setup();
  await call(env, '/auth/login', { method: 'POST', body: { email: INVITED } });
  await call(env, '/auth/login', { method: 'POST', body: { email: INVITED } });
  assert.equal(email.sent.length, 1);
});

test('tokens are stored hashed, never raw', async () => {
  const { env, email, db } = setup();
  const cookie = await signIn(env, email);
  const raw = cookie.split('=')[1];
  const rows = db._db.prepare('SELECT token_hash FROM sessions').all();
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, raw);
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
});

test('/me needs a session', async () => {
  const { env } = setup();
  assert.equal((await call(env, '/me')).status, 401);
  assert.equal((await call(env, '/me', { token: 'made-up' })).status, 401);
});

test('pairing: a code from the web session becomes a device token that can be revoked', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);

  const { code } = await (await call(env, '/me/pair-code', { method: 'POST', cookie })).json();
  assert.match(code, /^[2-9A-HJ-NP-TV-Z]{6}$/);

  const paired = await call(env, '/pair', { method: 'POST', body: { code: code.toLowerCase(), name: 'Pixel' } });
  assert.equal(paired.status, 200);
  const { token } = await paired.json();

  const me = await (await call(env, '/me', { token })).json();
  assert.deepEqual(me, { email: INVITED, kind: 'device', needsReimport: false });

  // Codes are single use.
  assert.equal((await call(env, '/pair', { method: 'POST', body: { code, name: 'x' } })).status, 400);

  // A device cannot mint pairing codes or revoke devices.
  assert.equal((await call(env, '/me/pair-code', { method: 'POST', token })).status, 403);

  const { devices } = await (await call(env, '/me/devices', { cookie })).json();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, 'Pixel');
  const del = await call(env, `/me/devices/${devices[0].id}`, { method: 'DELETE', cookie });
  assert.equal(del.status, 200);
  assert.equal((await call(env, '/me', { token })).status, 401, 'a revoked device is signed out');
});

test('an expired pairing code is refused', async () => {
  const { env, email, db } = setup();
  const cookie = await signIn(env, email);
  const { code } = await (await call(env, '/me/pair-code', { method: 'POST', cookie })).json();
  db.exec('UPDATE pair_codes SET expires = 0');
  assert.equal((await call(env, '/pair', { method: 'POST', body: { code } })).status, 400);
});

test('web sessions expire', async () => {
  const { env, email, db } = setup();
  const cookie = await signIn(env, email);
  db.exec('UPDATE sessions SET expires = 1');
  assert.equal((await call(env, '/me', { cookie })).status, 401);
});

test('logout ends the session', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);
  const out = await call(env, '/auth/logout', { method: 'POST', cookie });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await call(env, '/me', { cookie })).status, 401);
});

test('profile: defaults, validated writes, and unknown stops rejected', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);

  const empty = await (await call(env, '/me/profile', { cookie })).json();
  assert.equal(empty.gapHours, 2);
  assert.deepEqual(empty.places, []);

  const bad = await call(env, '/me/profile', { method: 'PUT', cookie, body: { places: [{ key: 'gym', label: 'Gym', to: 'NOWHERE' }] } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /known stop/);

  const good = await call(env, '/me/profile', {
    method: 'PUT',
    cookie,
    body: { home: { lat: 1.2918, lon: 103.7804, stops: ['PGP'] }, places: [{ key: 'mrt', label: 'KR MRT', to: 'KR-MRT' }] },
  });
  assert.equal(good.status, 200);
  const saved = await (await call(env, '/me/profile', { cookie })).json();
  assert.deepEqual(saved.home.stops, ['PGP']);
  assert.equal(saved.places[0].to, 'KR-MRT');
});

test('profile writes need a JSON body', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);
  const res = await call(env, '/me/profile', { method: 'PUT', cookie, form: { gapHours: '3' } });
  assert.equal(res.status, 400);
});

test('/me/next with nothing set up asks for setup instead of inventing a trip', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);
  const body = await (await call(env, '/me/next', { cookie })).json();
  assert.equal(body.mode, 'nearby');
  assert.equal(body.label, 'Set up');
});

test('/me/next goes to a saved place by key and returns the chips', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);
  await call(env, '/me/profile', {
    method: 'PUT',
    cookie,
    body: { home: { lat: 1.2918, lon: 103.7804, stops: ['PGP'] }, places: [{ key: 'mrt', label: 'KR MRT', to: 'KR-MRT' }] },
  });
  const body = await (await call(env, '/me/next?place=mrt', { cookie })).json();
  assert.equal(body.mode, 'trip');
  assert.deepEqual(body.dest, { to: 'KR-MRT', label: 'KR MRT', why: 'place' });
  assert.deepEqual(body.places, [{ key: 'mrt', label: 'KR MRT' }]);
  assert.equal(body.stop.code, 'PGP', 'no coordinates: starts from home');
});

test('/me/next follows the timetable (Thursday 09:00 frozen clock)', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);
  await call(env, '/me/profile', {
    method: 'PUT',
    cookie,
    body: {
      home: { lat: 1.2918, lon: 103.7804, stops: ['PGP'] },
      manual: [{ day: 4, arriveByMin: 600, endMin: 720, to: 'COM3', label: 'CS2030 @ COM1' }],
    },
  });
  const body = await (await call(env, '/me/next', { cookie })).json();
  assert.equal(body.mode, 'trip');
  assert.deepEqual(body.dest, { to: 'COM3', label: 'CS2030 @ COM1', why: 'class' });
});

test('/me/nearby lists boards for stops near the given point', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);
  const res = await call(env, '/me/nearby?lat=1.2918&lon=103.7804', { cookie });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.stops.length >= 1);
  assert.equal(body.stops[0].stop.code, 'PGP');
});

test('the public API still works without the DB binding', async () => {
  installGlobals(makeFetch());
  const ctx = makeCtx();
  const res = await worker.fetch(new Request(`${BASE}/me`), makeEnv(), ctx);
  assert.equal(res.status, 503);
  const health = await worker.fetch(new Request(`${BASE}/health`), makeEnv(), ctx);
  assert.equal(health.status, 200);
});

test('pairing codes avoid look-alike characters and normalise user input', () => {
  for (let i = 0; i < 200; i++) assert.match(newPairCode(), /^[2-9A-HJ-NP-TV-Z]{6}$/);
  assert.equal(normalizePairCode('ab3-d4'), null, 'too short once cleaned');
  assert.equal(normalizePairCode(' abc-def '), 'ABCDEF');
  assert.equal(normalizePairCode('ABCDE0'), null, 'zero is not in the alphabet');
});

test('/me/next rests outside the day, but saved places still answer', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);
  await call(env, '/me/profile', {
    method: 'PUT',
    cookie,
    body: {
      home: { lat: 1.2918, lon: 103.7804, stops: ['PGP'] },
      places: [{ key: 'mrt', label: 'KR MRT', to: 'KR-MRT' }],
      manual: [{ day: 5, arriveByMin: 600, endMin: 720, to: 'COM3', label: 'CS2030 @ COM1' }],
    },
  });
  installGlobals(makeFetch(), Date.UTC(2026, 7, 27, 12, 30)); // Thu 20:30 SGT
  const rest = await (await call(env, '/me/next', { cookie })).json();
  assert.equal(rest.mode, 'rest');
  assert.equal(rest.label, 'Done for today');
  assert.equal(rest.detail, 'Next: CS2030 @ COM1, tomorrow 10:00');
  assert.deepEqual(rest.places, [{ key: 'mrt', label: 'KR MRT' }]);

  const place = await (await call(env, '/me/next?place=mrt', { cookie })).json();
  assert.equal(place.mode, 'trip');
});

test('a device idle for 90 days is signed out', async () => {
  const { env, email, db } = setup();
  const cookie = await signIn(env, email);
  const { code } = await (await call(env, '/me/pair-code', { method: 'POST', cookie })).json();
  const { token } = await (await call(env, '/pair', { method: 'POST', body: { code } })).json();
  assert.equal((await call(env, '/me', { token })).status, 200);
  db.exec(`UPDATE sessions SET last_seen = 0 WHERE kind = 'device'`);
  installGlobals(makeFetch(), 91 * 86_400_000);
  assert.equal((await call(env, '/me', { token })).status, 401);
});
