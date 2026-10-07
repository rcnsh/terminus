import test from 'node:test';
import assert from 'node:assert/strict';

import { installGlobals, makeCtx, makeEnv, makeFetch } from './_stubs.mjs';
import { makeD1, makeEmail } from './_d1.mjs';
import worker from '../src/index.ts';
import { hashToken, newPairCode, normalizePairCode } from '../src/accounts.ts';
import venuesJson from '../data/venues.json' with { type: 'json' };
import residencesJson from '../data/residences.json' with { type: 'json' };

const BASE = 'https://bus.example.test';
const INVITED = 'friend@u.nus.edu';
const BLOCKED = 'spammer@example.com';

function setup() {
  installGlobals(makeFetch());
  const db = makeD1();
  db.exec(`INSERT INTO blocklist VALUES ('${BLOCKED}', 0)`);
  const email = makeEmail();
  const env = { ...makeEnv(), DB: db, EMAIL: email, EMAIL_FROM: 'terminus@example.test' };
  return { db, email, env };
}

async function call(env, path, { method = 'GET', body, token, form, cookie, key, accept } = {}) {
  const headers = {};
  if (key) headers['x-api-key'] = key;
  if (accept) headers.accept = accept;
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
  const res = await worker.fetch(new Request(BASE + path, { method, headers, ...(payload === undefined ? {} : { body: payload }) }), env, ctx);
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

test('sign-up is open; a blocked address gets the same reply and no email', async () => {
  const { env, email } = setup();
  const a = await call(env, '/auth/login', { method: 'POST', body: { email: 'Friend@U.NUS.edu ' } });
  const b = await call(env, '/auth/login', { method: 'POST', body: { email: BLOCKED } });
  const c = await call(env, '/auth/login', { method: 'POST', body: { email: 'anyone@gmail.com' } });
  assert.equal(a.status, 200);
  assert.deepEqual(await a.json(), await b.json(), 'the reply must not reveal the blocklist');
  assert.equal(c.status, 200);
  assert.deepEqual(email.sent.map((m) => m.to), [INVITED, 'anyone@gmail.com']);
});

test('Turnstile: enforced once a secret is set', async () => {
  const { env, email } = setup();
  const verify = [];
  globalThis.fetch = async (url, init) => {
    verify.push(String(url));
    const token = init.body.get('response');
    return Response.json({ success: token === 'good' });
  };
  const e = { ...env, TURNSTILE_SECRET: 's', TURNSTILE_SITE_KEY: 'site' };
  const cfg = await (await call(e, '/auth/config')).json();
  assert.equal(cfg.turnstileSiteKey, 'site');
  assert.equal((await call(e, '/auth/login', { method: 'POST', body: { email: INVITED } })).status, 400, 'no token');
  assert.equal((await call(e, '/auth/login', { method: 'POST', body: { email: INVITED, turnstile: 'bad' } })).status, 400);
  assert.equal((await call(e, '/auth/login', { method: 'POST', body: { email: INVITED, turnstile: 'good' } })).status, 200);
  assert.equal(email.sent.length, 1);
  assert.ok(verify.every((u) => u.includes('challenges.cloudflare.com')));
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
  assert.match(first.headers.get('set-cookie'), /tm_s=.+HttpOnly; Secure; SameSite=Lax/);

  const again = await call(env, '/auth/verify', { method: 'POST', form: { t } });
  assert.equal(again.status, 400);
});

test('wrong emailed codes sent all at once still only get five tries', async () => {
  const { env, email } = setup();
  await call(env, '/auth/login', { method: 'POST', body: { email: INVITED } });
  const code = email.lastCode();
  const wrong = code === '222222' ? '333333' : '222222';
  await Promise.all(Array.from({ length: 20 }, () => call(env, '/auth/code', { method: 'POST', body: { email: INVITED, code: wrong } })));
  assert.equal((await call(env, '/auth/code', { method: 'POST', body: { email: INVITED, code } })).status, 400);
});

test('signing in from the web app: the emailed link goes back to it, and nowhere else', async () => {
  const { env, email } = setup();
  await call(env, '/auth/login', { method: 'POST', body: { email: INVITED, next: '/app/' } });
  const text = email.sent.at(-1).text;
  assert.match(text, /\/auth\/verify\?t=[A-Za-z0-9_-]+&next=app/);
  const t = email.lastToken();
  assert.match(await (await call(env, `/auth/verify?t=${t}&next=app`)).text(), /name="next" value="app"/);
  const res = await call(env, '/auth/verify', { method: 'POST', form: { t, next: 'app' } });
  assert.equal(res.headers.get('location'), '/account/?next=/app/');

  const { env: env2, email: email2 } = setup();
  await call(env2, '/auth/login', { method: 'POST', body: { email: INVITED, next: 'https://evil.example/' } });
  assert.doesNotMatch(email2.sent.at(-1).text, /next=/);
  const other = await call(env2, '/auth/verify', { method: 'POST', form: { t: email2.lastToken(), next: 'https://evil.example/' } });
  assert.equal(other.headers.get('location'), '/account');
});

test('another site cannot post a sign-in link or a sign-out', async () => {
  const { env, email } = setup();
  await call(env, '/auth/login', { method: 'POST', body: { email: INVITED } });
  const t = email.lastToken();
  const post = async (path, site, body) => {
    const ctx = makeCtx();
    const headers = { 'content-type': 'application/x-www-form-urlencoded' };
    if (site) headers['sec-fetch-site'] = site;
    const res = await worker.fetch(new Request(BASE + path, { method: 'POST', headers, body }), env, ctx);
    await ctx.settle();
    return res;
  };
  for (const site of ['cross-site', 'same-site']) {
    assert.equal((await post('/auth/verify', site, new URLSearchParams({ t }).toString())).status, 403, site);
    assert.equal((await post('/auth/logout', site, '')).status, 403, site);
  }
  // The link is still good from our own page.
  assert.equal((await post('/auth/verify', 'same-origin', new URLSearchParams({ t }).toString())).status, 303);
});

test('an expired link is refused', async () => {
  const { env, email, db } = setup();
  await call(env, '/auth/login', { method: 'POST', body: { email: INVITED } });
  db.exec('UPDATE magic_links SET expires = 0');
  const res = await call(env, '/auth/verify', { method: 'POST', form: { t: email.lastToken() } });
  assert.equal(res.status, 400);
});

test('the emailed code signs in once, and spends the link with it', async () => {
  const { env, email } = setup();
  await call(env, '/auth/login', { method: 'POST', body: { email: INVITED } });
  const msg = email.sent.at(-1);
  const code = email.lastCode();
  assert.match(code, /^[A-Z0-9]{6}$/);
  assert.equal(msg.subject, `Your terminus code: ${code}`);
  assert.match(msg.text, /because someone entered this address/);

  // Case, spaces and a dash are forgiven, as with pairing codes.
  const typed = `${code.slice(0, 3).toLowerCase()} -${code.slice(3)}`;
  const res = await call(env, '/auth/code', { method: 'POST', body: { email: ' Friend@U.NUS.edu', code: typed } });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /tm_s=.+HttpOnly; Secure; SameSite=Lax/);
  const me = await call(env, '/me', { cookie: cookie.split(';')[0] });
  assert.equal((await me.json()).email, INVITED);

  assert.equal((await call(env, '/auth/code', { method: 'POST', body: { email: INVITED, code } })).status, 400, 'code is single-use');
  assert.equal((await call(env, '/auth/verify', { method: 'POST', form: { t: email.lastToken() } })).status, 400, 'its link went with it');
});

test('a spent link kills its code', async () => {
  const { env, email } = setup();
  await call(env, '/auth/login', { method: 'POST', body: { email: INVITED } });
  const code = email.lastCode();
  assert.equal((await call(env, '/auth/verify', { method: 'POST', form: { t: email.lastToken() } })).status, 303);
  assert.equal((await call(env, '/auth/code', { method: 'POST', body: { email: INVITED, code } })).status, 400);
});

test('a code only works for its own address, and dies after five wrong guesses', async () => {
  const { env, email } = setup();
  await call(env, '/auth/login', { method: 'POST', body: { email: INVITED } });
  const code = email.lastCode();
  const wrong = code === '222222' ? '333333' : '222222';

  assert.equal((await call(env, '/auth/code', { method: 'POST', body: { email: 'other@u.nus.edu', code } })).status, 400);
  assert.equal((await call(env, '/auth/code', { method: 'POST', body: { email: INVITED, code: 'nope' } })).status, 400);
  for (let i = 0; i < 5; i++) {
    assert.equal((await call(env, '/auth/code', { method: 'POST', body: { email: INVITED, code: wrong } })).status, 400);
  }
  assert.equal((await call(env, '/auth/code', { method: 'POST', body: { email: INVITED, code } })).status, 400, 'dead after 5 misses');
  // The link in the same email still works.
  assert.equal((await call(env, '/auth/verify', { method: 'POST', form: { t: email.lastToken() } })).status, 303);
});

test('an expired code is refused', async () => {
  const { env, email } = setup();
  await call(env, '/auth/login', { method: 'POST', body: { email: INVITED } });
  for (const [k, v] of env.KV._map) if (k.startsWith('code:')) env.KV._map.set(k, JSON.stringify({ ...JSON.parse(v), e: 0 }));
  assert.equal((await call(env, '/auth/code', { method: 'POST', body: { email: INVITED, code: email.lastCode() } })).status, 400);
});

test('the code is stored hashed, never raw', async () => {
  const { env, email } = setup();
  await call(env, '/auth/login', { method: 'POST', body: { email: INVITED } });
  const dump = JSON.stringify([...env.KV._map]);
  assert.ok(!dump.includes(email.lastCode()));
  assert.ok(!dump.includes(INVITED));
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

test('on the beta, emails come from "terminus beta" and link to the beta site', async () => {
  const { env, email } = setup();
  env.PUBLIC_ORIGIN = 'https://beta.terminus.rcn.sh';
  const cookie = await signIn(env, email);
  assert.equal(email.sent[0].from.name, 'terminus beta');

  const { code } = await (await call(env, '/me/pair-code', { method: 'POST', cookie })).json();
  await call(env, '/pair', { method: 'POST', body: { code, name: 'Pixel' } });
  assert.equal(email.sent.at(-1).from.name, 'terminus beta');
  assert.match(email.sent.at(-1).text, /https:\/\/beta\.terminus\.rcn\.sh\/account/);
  assert.doesNotMatch(email.sent.at(-1).text, /https:\/\/terminus\.rcn\.sh/);
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
  assert.deepEqual(me, { email: INVITED, anonymous: false, kind: 'device', needsReimport: false, reimportReason: null, term: null, onboarding: 'full' });

  // Codes are single use.
  assert.equal((await call(env, '/pair', { method: 'POST', body: { code, name: 'x' } })).status, 400);

  // A device added with a code: the owner hears about it.
  assert.equal(email.sent.at(-1).to, INVITED);
  assert.equal(email.sent.at(-1).subject, 'terminus was added to Pixel');

  // A device on an account with an email can add another (the owner is emailed each time).
  assert.equal((await call(env, '/me/pair-code', { method: 'POST', token })).status, 200);

  const { devices } = await (await call(env, '/me/devices', { cookie })).json();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, 'Pixel');
  assert.equal(devices[0].current, false, 'the browser asking is not the device');
  const mine = await (await call(env, '/me/devices', { token })).json();
  assert.equal(mine.devices[0].current, true);
  const del = await call(env, `/me/devices/${devices[0].id}`, { method: 'DELETE', cookie });
  assert.equal(del.status, 200);
  assert.equal(email.sent.at(-1).subject, 'terminus was added to Pixel', 'removing a device sends no email');
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

test('a web session in use renews itself; a fresh one is left alone', async () => {
  const { env, email, db } = setup();
  const cookie = await signIn(env, email);
  const fresh = await call(env, '/me', { cookie });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.headers.get('set-cookie'), null, 'nothing to renew yet');

  // A week and a bit from the end: the next page load extends it to 30 days again.
  const soon = Date.now() + 8 * 86_400_000;
  db.exec(`UPDATE sessions SET expires = ${soon}`);
  const res = await call(env, '/me', { cookie });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie'), /Max-Age=2592000/);
  const { expires } = await db.prepare('SELECT expires FROM sessions').first();
  assert.ok(expires > Date.now() + 29 * 86_400_000);
});

test('a web session in daily use still ends 180 days after sign-in, except with no email to sign in again', async () => {
  const { env, email, db } = setup();
  const cookie = await signIn(env, email);
  const old = Date.now() - 181 * 86_400_000;
  db.exec(`UPDATE sessions SET created = ${old}, expires = ${Date.now() + 20 * 86_400_000}`);
  assert.equal((await call(env, '/me', { cookie })).status, 401);
  // An account with no email keeps its browser: it has no other way in.
  const anon = db._db.prepare('SELECT user_id FROM sessions').get().user_id;
  db.exec(`UPDATE users SET email = NULL WHERE id = '${anon}'`);
  assert.equal((await call(env, '/me', { cookie })).status, 200);
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
  assert.equal(body.mode, 'free');
  assert.equal(body.label, 'No timetable yet');
  assert.equal(body.card.glance, 'Set up');
  assert.deepEqual(body.arrivals, [], 'no bus it has no reason to suggest');
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
  // Its twin is always there, for the widget to swap to.
  assert.equal(body.stops[0].opposite, 'PGPR');
  assert.ok(body.stops.some((s) => s.stop.code === 'PGPR'));
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

test('delete account removes every row for the user', async () => {
  const { env, email, db } = setup();
  const cookie = await signIn(env, email);
  await call(env, '/me/profile', { method: 'PUT', cookie, body: { places: [{ key: 'mrt', label: 'KR MRT', to: 'KR-MRT' }] } });
  const { code } = await (await call(env, '/me/pair-code', { method: 'POST', cookie })).json();
  const { token } = await (await call(env, '/pair', { method: 'POST', body: { code } })).json();
  assert.equal((await call(env, '/me', { method: 'DELETE', token })).status, 403, 'a device cannot delete the account');

  const res = await call(env, '/me', { method: 'DELETE', cookie });
  assert.equal(res.status, 200);
  for (const t of ['users', 'sessions', 'profiles', 'pair_codes', 'magic_links']) {
    assert.equal(db._db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, 0, t);
  }
  assert.equal((await call(env, '/me', { token })).status, 401);
});

test('export returns the profile and sessions, never token hashes', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);
  await call(env, '/me/profile', { method: 'PUT', cookie, body: { gapHours: 3 } });
  const res = await call(env, '/me/export', { cookie });
  assert.match(res.headers.get('content-disposition'), /attachment/);
  const body = await res.json();
  assert.equal(body.email, INVITED);
  assert.equal(body.profile.gapHours, 3);
  assert.equal(body.sessions.length, 1);
  assert.doesNotMatch(JSON.stringify(body), /[0-9a-f]{64}/);
});

test('sign out everywhere ends every session', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);
  const { code } = await (await call(env, '/me/pair-code', { method: 'POST', cookie })).json();
  const { token } = await (await call(env, '/pair', { method: 'POST', body: { code } })).json();
  const res = await call(env, '/me/sessions', { method: 'DELETE', cookie });
  assert.equal((await res.json()).ended, 2);
  assert.equal((await call(env, '/me', { token })).status, 401);
  assert.equal((await call(env, '/me', { cookie })).status, 401);
});

test('home keeps stops only: coordinates are dropped on save', async () => {
  const { env, email, db } = setup();
  const cookie = await signIn(env, email);
  await call(env, '/me/profile', { method: 'PUT', cookie, body: { home: { lat: 1.2918, lon: 103.7804, stops: ['PGP'] } } });
  const raw = db._db.prepare('SELECT json FROM profiles').get().json;
  assert.doesNotMatch(raw, /103\.78/);
  assert.deepEqual(JSON.parse(raw).home, { stops: ['PGP'] });
  const near = await call(env, '/me/nearby', { cookie });
  assert.equal(near.status, 200, 'nearby without a location starts from the home stop');
});

test('rate limits answer 429', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);
  const never = { limit: async () => ({ success: false }) };
  assert.equal((await call({ ...env, RL_ME: never }, '/me', { cookie })).status, 429);
  const pub = await call({ ...env, RL_PUBLIC: never }, '/next?lat=1.29&lon=103.78');
  assert.equal(pub.status, 429);
  assert.equal(pub.headers.get('retry-after'), '60');
});

test('signed in, the map and answers are limited per account, not per IP', async () => {
  const { env, email } = setup();
  delete env[Symbol.for('terminus.testOpen')]; // locked, as in production
  const cookie = await signIn(env, email);
  const never = { limit: async () => ({ success: false }) };
  // Everyone else on the same campus Wi-Fi has used up the IP's share: still answered.
  assert.equal((await call({ ...env, RL_PUBLIC: never }, '/campus', { cookie })).status, 200);
  // The account's own share used up: 429.
  const keys = [];
  const own = { limit: async ({ key }) => (keys.push(key), { success: !key.startsWith('acct:') }) };
  assert.equal((await call({ ...env, RL_ME: own }, '/campus', { cookie })).status, 429);
  assert.ok(keys.some((k) => /^acct:.+/.test(k)), 'keyed by account');
  // Not signed in: still by IP, then asked for a key.
  assert.equal((await call({ ...env, RL_PUBLIC: never }, '/campus')).status, 429);
  assert.equal((await call(env, '/campus')).status, 401);
});

/** A global fetch that answers NUSMods module requests, and delegates the rest. */
function withNusmods(modules, { down = [] } = {}) {
  const inner = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    const m = /api\.nusmods\.com\/v2\/[^/]+\/modules\/([^.]+)\.json/.exec(String(u));
    if (!m) return inner(u, init);
    if (down.includes(m[1])) return new Response('bad gateway', { status: 502 });
    const mod = modules[m[1]];
    return mod ? Response.json(mod) : new Response('not found', { status: 404 });
  };
}

const LAB = { semesterData: [{ semester: 1, timetable: [{ lessonType: 'Laboratory', classNo: 'B1', day: 'Monday', startTime: '1000', endTime: '1200', venue: 'COM3-0120', weeks: [3, 4, 5] }] }] };

test('import: limited per account, since each one fetches from NUSMods', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);
  withNusmods({ CS2030: LAB });
  const keys = [];
  const res = await call({ ...env, RL_AUTH: { limit: async ({ key }) => (keys.push(key), { success: !key.startsWith('import:') }) } }, '/me/import', {
    method: 'POST',
    cookie,
    body: { share: 'https://nusmods.com/timetable/sem-1/share?CS2030=LAB:B1' },
  });
  assert.equal(res.status, 429);
  assert.ok(keys.some((k) => /^import:.+/.test(k)), 'keyed by account');
});

test('import: a NUSMods failure changes nothing and names the module', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);
  withNusmods({ CS2030: LAB });
  const ok = await call(env, '/me/import', { method: 'POST', cookie, body: { share: 'https://nusmods.com/timetable/sem-1/share?CS2030=LAB:B1' } });
  assert.equal(ok.status, 200);
  const first = await ok.json();
  assert.equal(first.profile.trips.length, 1);
  assert.equal(first.term, 'Sem 1 2026/27');

  withNusmods({ CS2030: LAB }, { down: ['MA1521'] });
  const bad = await call(env, '/me/import', { method: 'POST', cookie, body: { share: 'https://nusmods.com/timetable/sem-1/share?CS2030=LAB:B1&MA1521=LEC:1' } });
  assert.equal(bad.status, 502);
  assert.match((await bad.json()).error, /MA1521/);
  const after = await (await call(env, '/me/profile', { cookie })).json();
  assert.equal(after.trips.length, 1, 'the working timetable survives');
});

test('import: nothing found is refused, not saved as an empty timetable', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);
  await call(env, '/me/profile', { method: 'PUT', cookie, body: { manual: [{ day: 1, arriveByMin: 600, to: 'COM3', label: 'Gym' }] } });
  withNusmods({});
  const r = await call(env, '/me/import', { method: 'POST', cookie, body: { share: 'https://nusmods.com/timetable/sem-1/share?CS9999=LEC:1' } });
  assert.equal(r.status, 422);
  assert.match((await r.json()).error, /CS9999/);
});

test('import: bad module codes and oversized links are rejected up front', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);
  withNusmods({});
  const odd = await call(env, '/me/import', { method: 'POST', cookie, body: { share: 'https://nusmods.com/timetable/sem-1/share?..%2Fx=LEC:1' } });
  assert.equal(odd.status, 400);
  const many = Array.from({ length: 16 }, (_, i) => `CS${1000 + i}=LEC:1`).join('&');
  const big = await call(env, '/me/import', { method: 'POST', cookie, body: { share: `https://nusmods.com/timetable/sem-1/share?${many}` } });
  assert.equal(big.status, 400);
  assert.match((await big.json()).error, /limit is 15/);
});

test('/me/next: a class but no home stop and no location asks for a home stop', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);
  await call(env, '/me/profile', { method: 'PUT', cookie, body: { manual: [{ day: 4, arriveByMin: 600, to: 'COM3', label: 'CS2030' }] } });
  const body = await (await call(env, '/me/next', { cookie })).json();
  assert.equal(body.label, 'Add a home stop');
  assert.notEqual(body.quality, 'ended', 'never "Services ended" at 9 am');
});

test('email: odd characters are refused; +tags and gmail dots share one cooldown and the blocklist', async () => {
  const { env, email } = setup();
  assert.equal((await call(env, '/auth/login', { method: 'POST', body: { email: 'x,spammer@example.com' } })).status, 400);
  assert.equal((await call(env, '/auth/login', { method: 'POST', body: { email: '<a>@example.com' } })).status, 400);
  await call(env, '/auth/login', { method: 'POST', body: { email: 'spammer+1@example.com' } });
  await call(env, '/auth/login', { method: 'POST', body: { email: 'Jo.Tan@gmail.com' } });
  await call(env, '/auth/login', { method: 'POST', body: { email: 'jotan+x@gmail.com' } });
  assert.deepEqual(email.sent.map((m) => m.to), ['jo.tan@gmail.com'], 'blocked via +tag; second gmail spelling cooled down');
});

test('a failed send does not hold the cooldown, and the log has no address', async () => {
  const { env, email } = setup();
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  const send = env.EMAIL.send;
  env.EMAIL.send = async () => { throw new Error(`could not deliver to ${INVITED}`); };
  const failed = await call(env, '/auth/login', { method: 'POST', body: { email: INVITED } });
  env.EMAIL.send = send;
  console.error = orig;
  assert.equal(failed.status, 502);
  assert.ok(!errors.join('\n').includes(INVITED));
  await call(env, '/auth/login', { method: 'POST', body: { email: INVITED } });
  assert.deepEqual(email.sent.map((m) => m.to), [INVITED], 'the retry goes out straight away');
});

test('an unexpected error is logged and answered with a bare 500', async () => {
  const { env } = setup();
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  env.DB.prepare = () => { throw new Error('D1_ERROR: secret internals'); };
  const r = await call(env, '/me?lat=1.29&lon=103.77', { cookie: '__Host-tm_s=whatever' });
  console.error = orig;
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { error: 'internal' });
  assert.ok(errors.some((e) => e.includes('/me') && !e.includes('103.77')));
});

test('Turnstile: a site key without its secret refuses sign-in instead of skipping the check', async () => {
  const { env, email } = setup();
  const orig = console.error;
  console.error = () => {};
  const r = await call({ ...env, TURNSTILE_SITE_KEY: 'site' }, '/auth/login', { method: 'POST', body: { email: INVITED } });
  console.error = orig;
  assert.equal(r.status, 400);
  assert.equal(email.sent.length, 0);
});

test('oversized JSON bodies are refused', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);
  const r = await call(env, '/me/profile', { method: 'PUT', cookie, body: { places: [], junk: 'x'.repeat(70_000) } });
  assert.equal(r.status, 400);
});

test('pair/check names the account (masked) without spending the code', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);
  const { code } = await (await call(env, '/me/pair-code', { method: 'POST', cookie })).json();
  const r = await call(env, '/pair/check', { method: 'POST', body: { code } });
  assert.deepEqual(await r.json(), { account: 'f•••@u.nus.edu' });
  assert.equal((await call(env, '/pair', { method: 'POST', body: { code, name: 'p' } })).status, 200, 'still usable');
  assert.equal((await call(env, '/pair/check', { method: 'POST', body: { code } })).status, 400, 'spent now');
});

test('/me/next carries refreshAt: the next class start while one is ahead', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);
  await call(env, '/me/profile', { method: 'PUT', cookie, body: { home: { stops: ['PGP'] }, manual: [{ day: 4, arriveByMin: 600, endMin: 720, to: 'COM3', label: 'CS2030' }] } });
  const body = await (await call(env, '/me/next', { cookie })).json();
  // Frozen clock: Thursday 09:00 SGT. The return-at mark for this class is 09:00 itself, so 10:00 is next.
  assert.equal(body.refreshAt, '2026-08-27T02:00:00Z');
  const place = await (await call(env, '/me/next?to=UTOWN', { cookie })).json();
  assert.equal(place.refreshAt, undefined);
});

test('the sign-in page names the account and refuses a dead link up front; the cookie is __Host-', async () => {
  const { env, email } = setup();
  await call(env, '/auth/login', { method: 'POST', body: { email: INVITED } });
  const page = await call(env, `/auth/verify?t=${email.lastToken()}`);
  const html = await page.text();
  assert.match(html, /f•••@u\.nus\.edu/);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await call(env, '/auth/verify?t=nonsense')).status, 400);
  const res = await call(env, '/auth/verify', { method: 'POST', form: { t: email.lastToken() } });
  assert.match(res.headers.get('set-cookie'), /^__Host-tm_s=.*Secure/);
});

test('only the __Host- session cookie is read', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);
  const old = cookie.replace('__Host-tm_s=', 'tm_s=');
  assert.equal((await call(env, '/me', { cookie: old })).status, 401);
});

test('/me/next: a class carries a leave-by time, moved by the walk from home', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);
  const put = (homeWalkMin) =>
    call(env, '/me/profile', { method: 'PUT', cookie, body: { home: { stops: ['PGP'] }, homeWalkMin, manual: [{ day: 4, arriveByMin: 660, endMin: 720, to: 'COM3', label: 'CS2030' }] } });
  await put(0);
  const a = await (await call(env, '/me/next', { cookie })).json();
  assert.equal(a.dest.why, 'class');
  assert.ok(a.leave, 'a class has a leave-by');
  // Before the 11:00 class, and no live times two hours out.
  assert.ok(Date.parse(a.leave.at) < Date.parse('2026-08-27T03:00:00Z'));
  await put(5);
  const b = await (await call(env, '/me/next', { cookie })).json();
  assert.equal(Date.parse(a.leave.at) - Date.parse(b.leave.at), 5 * 60_000);
  assert.equal(b.leave.estimated, a.leave.estimated);
});

test('/me/next between classes counts the walk from the last room to its stop', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);
  // Frozen clock: Thursday 09:00. An 08:00 class in the Arts building (a short
  // walk to AS5) just ended; the next is at 10:00.
  const put = (venue) =>
    call(env, '/me/profile', {
      method: 'PUT',
      cookie,
      body: {
        home: { stops: ['PGP'] },
        manual: [
          { day: 4, arriveByMin: 480, endMin: 530, to: 'AS5', label: 'EC1101E', venue },
          { day: 4, arriveByMin: 600, endMin: 660, to: 'COM3', label: 'CS2030' },
        ],
      },
    });
  await put('');
  const a = await (await call(env, '/me/next', { cookie })).json();
  await put('ARTSCTN');
  const b = await (await call(env, '/me/next', { cookie })).json();
  assert.equal(b.dest.label, 'CS2030');
  assert.equal(Date.parse(a.leave.at) - Date.parse(b.leave.at), Math.round(venuesJson.venues.ARTSCTN.m / 1.3) * 1000);
});

test('/me/next: a slower walking pace means leaving earlier', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);
  const m = venuesJson.venues.ARTSCTN.m;
  const put = (walkPace) =>
    call(env, '/me/profile', {
      method: 'PUT',
      cookie,
      body: {
        home: { stops: ['PGP'] },
        walkPace,
        manual: [
          { day: 4, arriveByMin: 480, endMin: 530, to: 'AS5', label: 'EC1101E', venue: 'ARTSCTN' },
          { day: 4, arriveByMin: 600, endMin: 660, to: 'COM3', label: 'CS2030' },
        ],
      },
    });
  await put('normal');
  const normal = await (await call(env, '/me/next', { cookie })).json();
  await put('slow');
  const slow = await (await call(env, '/me/next', { cookie })).json();
  // At least the extra time on the room's walk; more when the slower walk
  // changes which way wins.
  assert.ok(Date.parse(normal.leave.at) - Date.parse(slow.leave.at) >= (Math.round(m / 1.1) - Math.round(m / 1.3)) * 1000);
  // The speed comes with the answer, for walk times the apps show themselves (search).
  assert.equal(normal.walkSpeedMs, 1.3);
  assert.equal(slow.walkSpeedMs, 1.1);
});

test('/me: a new account gets the full setup, then never again', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);
  const me = async () => (await (await call(env, '/me', { cookie })).json()).onboarding;
  assert.equal(await me(), 'full');
  await call(env, '/me/profile', { method: 'PUT', cookie, body: { home: { stops: ['PGP'] } } });
  assert.equal(await me(), null, 'an account that has saved something is set up');
  await call(env, '/me/profile', { method: 'PUT', cookie, body: { seen: ['onboarding'] } });
  assert.equal(await me(), null);
});

test('a food court works as a saved place and a destination', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);
  const put = await call(env, '/me/profile', { method: 'PUT', cookie, body: { home: { stops: ['PGP'] }, places: [{ key: 'deck', label: 'Deck', to: 'THE-DECK' }] } });
  assert.equal(put.status, 200);
  const home = await call(env, '/me/profile', { method: 'PUT', cookie, body: { home: { stops: ['THE-DECK'] } } });
  assert.equal(home.status, 400, 'home is stops only');
  const next = await (await call(env, '/me/next?place=deck', { cookie })).json();
  assert.equal(next.dest.to, 'THE-DECK');
  assert.equal(next.dest.label, 'Deck');
  // Routed from home to one of its stops, not a setup or "no start" answer.
  assert.equal(next.stop.code, 'PGP');
  assert.doesNotMatch(next.label, /Set up|No start point/);
});

test('/me/next in your residence: "You\'re home" after the last class, leave-by in a long gap', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);
  const ring = residencesJson.residences.PGP.areas[0];
  const [lat, lon] = [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length].map((v) => v.toFixed(4));
  const put = (manual) => call(env, '/me/profile', { method: 'PUT', cookie, body: { home: { stops: ['PGP'] }, manual } });

  // Frozen clock: Thursday 09:00. The only class ended at 08:50.
  await put([{ day: 4, arriveByMin: 480, endMin: 530, to: 'COM3', label: 'CS2030' }]);
  const there = await (await call(env, `/me/next?lat=${lat}&lon=${lon}`, { cookie })).json();
  assert.equal(there.label, "You're home");
  assert.equal(there.arrived, true);
  const away = await (await call(env, '/me/next?lat=1.2966&lon=103.7764', { cookie })).json();
  assert.equal(away.dest.why, 'home', 'elsewhere on campus, still the way home');

  // A long gap: 08:00 class done, the next at 14:00.
  await put([
    { day: 4, arriveByMin: 480, endMin: 530, to: 'COM3', label: 'CS2030' },
    { day: 4, arriveByMin: 840, endMin: 900, to: 'LT27', label: 'MA1521' },
  ]);
  const gap = await (await call(env, `/me/next?lat=${lat}&lon=${lon}`, { cookie })).json();
  assert.equal(gap.dest.why, 'class');
  assert.equal(gap.dest.label, 'MA1521');
  assert.ok(gap.leave, 'says when to leave home for it');
});


test('/me/next from inside your residence counts your own walk to your stop', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);
  const ring = residencesJson.residences.PGP.areas[0];
  const [lat, lon] = [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length].map((v) => v.toFixed(4));
  const { PGPR, PGP } = residencesJson.residences.PGP.stops;
  // To PGP Foyer, the nearer: your own walk. To PGP, as much further as the paths say.
  const walkTo = async (homeWalkMin) => {
    await call(env, '/me/profile', { method: 'PUT', cookie, body: { home: { stops: ['PGPR', 'PGP'] }, homeWalkMin } });
    const { leave } = await (await call(env, `/me/next?to=UTOWN&lat=${lat}&lon=${lon}`, { cookie })).json();
    return leave.walkS - (leave.stopCode === 'PGP' ? Math.round((PGP - PGPR) / 1.3) : 0);
  };
  assert.equal(await walkTo(6), 360, 'six minutes, as set, not the hall\'s outline');
  assert.equal(await walkTo(9), 540);
});


test('the bus answers need a key or an account; downloads, health and docs stay open', async () => {
  const { env, email } = setup();
  delete env[Symbol.for('terminus.testOpen')]; // locked, as in production
  for (const path of ['/next?lat=1.2966&lon=103.7764', '/trip?to=UTOWN&from=PGP', '/arrivals?stop=COM3', '/campus', '/stops/pairs']) {
    const res = await call(env, path);
    assert.equal(res.status, 401, path);
    assert.match((await res.json()).error, /API key/);
  }
  for (const path of ['/health', '/docs', '/openapi.json']) assert.notEqual((await call(env, path)).status, 401, path);

  // A signed-in browser or a paired device gets through without a key.
  const cookie = await signIn(env, email);
  assert.equal((await call(env, '/campus', { cookie })).status, 200);
  assert.equal((await call(env, '/stops/pairs', { cookie })).status, 200);
  assert.equal((await call(env, '/arrivals?stop=COM3', { cookie })).status, 200);
});

test('/campus lists PGP and UTown Residence first, marked common, then the rest by name', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);
  const { residences } = await (await call(env, '/campus', { cookie })).json();
  const common = residences.filter((r) => r.common);
  assert.deepEqual(common.map((r) => r.code), ['PGP', 'UTR']);
  assert.deepEqual(residences.slice(0, 2), common, 'the common ones lead');
  const rest = residences.slice(2).map((r) => r.name);
  assert.deepEqual(rest, [...rest].sort((a, b) => a.localeCompare(b)));
  assert.ok(residences.slice(2).every((r) => r.common === false));
});

test('API keys: made on the account page, shown once, work anywhere, revocable', async () => {
  const { env, db, email } = setup();
  delete env[Symbol.for('terminus.testOpen')];
  const cookie = await signIn(env, email);
  const made = await (await call(env, '/me/keys', { method: 'POST', cookie, body: { name: 'My script' } })).json();
  assert.match(made.key, /^tk_/);
  assert.equal(made.hint, made.key.slice(-4));
  // Only a hash is stored.
  assert.equal(db._db.prepare('SELECT count(*) AS n FROM api_keys WHERE key_hash = ?').get(made.key).n, 0);

  assert.equal((await call(env, '/arrivals?stop=COM3', { key: made.key })).status, 200);
  assert.equal((await call(env, '/arrivals?stop=COM3', { token: made.key })).status, 200, 'as a bearer token too');
  assert.equal((await call(env, '/arrivals?stop=COM3', { key: 'tk_nonsense' })).status, 401);
  // A key is not an account: it can't read /me.
  assert.equal((await call(env, '/me', { key: made.key })).status, 401);

  const list = await (await call(env, '/me/keys', { cookie })).json();
  assert.deepEqual(list.keys.map((k) => k.name), ['My script']);
  assert.equal('key' in list.keys[0], false, 'never shown again');
  assert.ok(list.keys[0].lastUsed, 'last use is recorded');
  const exported = await (await call(env, '/me/export', { cookie })).json();
  assert.equal(exported.apiKeys[0].name, 'My script');

  assert.equal((await call(env, `/me/keys/${made.id}`, { method: 'DELETE', cookie })).status, 200);
  assert.equal((await call(env, '/arrivals?stop=COM3', { key: made.key })).status, 401, 'revoked');
});

test('a session token that happens to start tk_ is still a session, not a missing key', async () => {
  const { env, db } = setup();
  delete env[Symbol.for('terminus.testOpen')];
  const { token } = await (await call(env, '/auth/anon', { method: 'POST', body: { name: 'Pixel' } })).json();
  // Session tokens are random base64url: 1 in 262,144 starts this way.
  const unlucky = `tk_${token.slice(3)}`;
  db._db.prepare('UPDATE sessions SET token_hash = ? WHERE token_hash = ?').run(await hashToken(unlucky), await hashToken(token));
  assert.equal((await call(env, '/arrivals?stop=COM3', { token: unlucky })).status, 200);
  assert.equal((await call(env, '/arrivals?stop=COM3', { token: 'tk_nonsense' })).status, 401);
});

test('API keys: a name is required, five at most, and a phone cannot make them', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);
  assert.equal((await call(env, '/me/keys', { method: 'POST', cookie, body: {} })).status, 400);
  for (let i = 0; i < 5; i++) assert.equal((await call(env, '/me/keys', { method: 'POST', cookie, body: { name: `k${i}` } })).status, 201);
  assert.equal((await call(env, '/me/keys', { method: 'POST', cookie, body: { name: 'one too many' } })).status, 409);
  const { code } = await (await call(env, '/me/pair-code', { method: 'POST', cookie })).json();
  const { token } = await (await call(env, '/pair', { method: 'POST', body: { code, name: 'Phone' } })).json();
  assert.equal((await call(env, '/me/keys', { method: 'POST', token, body: { name: 'from phone' } })).status, 403);
});

test('/me without any token is a plain 401 and does not count as a guess', async () => {
  const { env } = setup();
  let calls = 0;
  env.RL_AUTH = { limit: async () => { calls++; return { success: false }; } };
  assert.equal((await call(env, '/me')).status, 401);
  assert.equal(calls, 0);
  assert.equal((await call(env, '/me', { token: 'nonsense' })).status, 429, 'a presented bad token still counts');
});

test('feedback: a wrong answer is kept with the account, emailed with the address, exported and deleted with it', async () => {
  const { env, email, db } = setup();
  env.ALERT_EMAIL = 'ops@example.test';
  const cookie = await signIn(env, email);
  const { code } = await (await call(env, '/me/pair-code', { method: 'POST', cookie })).json();
  const { token } = await (await call(env, '/pair', { method: 'POST', body: { code } })).json();
  assert.equal((await call(env, '/me/feedback', { method: 'POST', body: { platform: 'mac' } })).status, 401);

  const answer = { label: 'D2 · 4 min', stop: { code: 'PGP', name: 'Prince George\'s Park' }, quality: 'live' };
  const res = await call(env, '/me/feedback', { method: 'POST', token, body: { note: 'It never came', platform: 'mac', appVersion: '1.3.9', context: answer } });
  assert.equal(res.status, 201, 'from a paired device too');
  const sent = email.sent.at(-1);
  assert.equal(sent.to, 'ops@example.test');
  assert.match(sent.subject, /D2 · 4 min at Prince George's Park \(live\)/);
  assert.match(sent.text, new RegExp(INVITED));
  assert.match(sent.text, /It never came/);

  const row = db._db.prepare('SELECT kind, note, platform, app_version, context FROM feedback').get();
  assert.deepEqual({ ...row }, { kind: 'wrong', note: 'It never came', platform: 'mac', app_version: '1.3.9', context: JSON.stringify(answer) });
  const exported = await (await call(env, '/me/export', { cookie })).json();
  assert.deepEqual(exported.feedback.map((f) => [f.note, f.answer.label]), [['It never came', 'D2 · 4 min']]);

  await call(env, '/me', { method: 'DELETE', cookie });
  assert.equal(db._db.prepare('SELECT count(*) AS n FROM feedback').get().n, 0);
});

test('feedback: an account without an email can leave an address to reply to, without adding it', async () => {
  const { env, email, db } = setup();
  env.ALERT_EMAIL = 'ops@example.test';
  const { token } = await (await call(env, '/auth/anon', { method: 'POST', body: {} })).json();
  const post = (body) => call(env, '/me/feedback', { method: 'POST', token, body: { kind: 'other', note: 'Add Kent Vale', platform: 'android', ...body } });
  assert.equal((await post({ replyTo: 'not an address' })).status, 400);
  assert.equal((await post({ replyTo: 'x,blocked@example.com' })).status, 400, 'plain addresses only');
  assert.equal((await post({ replyTo: ' Me@Example.com ' })).status, 201);
  assert.match(email.sent.at(-1).text, /anonymous account \(reply to me@example\.com, not checked\)/);
  assert.equal(db._db.prepare('SELECT reply_to FROM feedback').get().reply_to, 'me@example.com');
  assert.equal(db._db.prepare('SELECT count(*) AS n FROM users WHERE email IS NOT NULL').get().n, 0, 'the account still has no email');
  assert.equal((await post({ replyTo: '' })).status, 201, 'an empty field is no address');
  assert.equal(db._db.prepare('SELECT count(*) AS n FROM feedback WHERE reply_to IS NULL').get().n, 1);
  assert.deepEqual((await (await call(env, '/me/export', { token })).json()).feedback.map((f) => f.replyTo), ['me@example.com', null]);
});

test('feedback: validated, and capped at ten a day per account', async () => {
  const { env, email } = setup();
  const cookie = await signIn(env, email);
  const post = (body) => call(env, '/me/feedback', { method: 'POST', cookie, body });
  assert.equal((await post({ platform: 'web' })).status, 400, 'a wrong answer needs the answer or a note');
  assert.equal((await post({ kind: 'other', platform: 'web' })).status, 400, "'other' needs a note");
  assert.equal((await post({ note: 'x', platform: 'ios' })).status, 400);
  assert.equal((await post({ note: 'x'.repeat(1001), platform: 'web' })).status, 400);
  assert.equal((await post({ platform: 'web', context: 'D2' })).status, 400, 'context is an object');
  assert.equal((await post({ platform: 'web', context: { pad: 'x'.repeat(17_000) } })).status, 400);
  for (let i = 0; i < 10; i++) assert.equal((await post({ note: `report ${i}`, platform: 'web' })).status, 201);
  assert.equal((await post({ note: 'one more', platform: 'web' })).status, 429);
});

test('/admin/stats: operator only; counts accounts, devices by platform and reports', async () => {
  const { env, email } = setup();
  env.HEALTH_TOKEN = 'operator-secret';
  const cookie = await signIn(env, email);
  await call(env, '/me/profile', { method: 'PUT', cookie, body: { home: { stops: ['PGP'] } } });
  // Pair a "Mac", by its User-Agent.
  const { code } = await (await call(env, '/me/pair-code', { method: 'POST', cookie })).json();
  const pairRes = await worker.fetch(
    new Request(BASE + '/pair', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Terminus/25 CFNetwork/3860 Darwin/25.0.0' }, body: JSON.stringify({ code, name: 'MacBook' }) }),
    env,
    makeCtx(),
  );
  const { token } = await pairRes.json();
  await call(env, '/me/feedback', { method: 'POST', token, body: { note: 'wrong stop', platform: 'mac', context: { label: 'A1 · 2 min' } } });

  assert.equal((await call(env, '/admin/stats')).status, 404, 'no token: looks like nothing is there');
  const wrong = await worker.fetch(new Request(BASE + '/admin/stats', { headers: { 'x-health-token': 'nope' } }), env, makeCtx());
  assert.equal(wrong.status, 404);
  const res = await worker.fetch(new Request(BASE + '/admin/stats', { headers: { 'x-health-token': 'operator-secret' } }), env, makeCtx());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const s = await res.json();
  assert.equal(s.accounts.total, 1);
  assert.equal(s.accounts.new7d, 1);
  assert.equal(s.accounts.withHome, 1);
  assert.equal(s.accounts.active1d, 1);
  assert.deepEqual(s.devices, [{ platform: 'mac', total: 1, active7: 1 }]);
  assert.equal(s.feedback.last7d, 1);
  assert.equal(s.feedback.latest[0].email, INVITED);
  assert.equal(s.feedback.latest[0].answer, 'A1 · 2 min');
  assert.equal(s.analytics, null, 'no Analytics Engine token: skipped');
});

test('a device paired before platforms were recorded gets one on its next request', async () => {
  const { env, email, db } = setup();
  const cookie = await signIn(env, email);
  const { code } = await (await call(env, '/me/pair-code', { method: 'POST', cookie })).json();
  const { token } = await (await call(env, '/pair', { method: 'POST', body: { code, name: 'Pixel' } })).json();
  assert.equal(db._db.prepare("SELECT platform FROM sessions WHERE kind = 'device'").get().platform, null);
  db._db.prepare("UPDATE sessions SET last_seen = ? WHERE kind = 'device'").run(Date.now() - 86_400_000);
  await worker.fetch(new Request(BASE + '/me/profile', { headers: { authorization: `Bearer ${token}`, 'user-agent': 'Dalvik/2.1.0 (Linux; U; Android 16; Pixel 8)' } }), env, makeCtx());
  assert.equal(db._db.prepare("SELECT platform FROM sessions WHERE kind = 'device'").get().platform, 'android');
});

test('a browser can use terminus without an email, and an email added later keeps its setup', async () => {
  const { env, email } = setup();
  const anon = await call(env, '/auth/anon/web', { method: 'POST', body: {} });
  assert.equal(anon.status, 201);
  const cookie = anon.headers.get('set-cookie').split(';')[0];
  const me = await (await call(env, '/me', { cookie })).json();
  assert.equal(me.anonymous, true);
  assert.equal(me.email, null);
  const put = await call(env, '/me/profile', { method: 'PUT', cookie, body: { home: { stops: ['PGP'] }, places: [], trips: [], manual: [] } });
  assert.equal(put.status, 200);

  // The emailed code, typed in the same browser: the email goes to this account.
  await call(env, '/auth/login', { method: 'POST', body: { email: INVITED } });
  const res = await call(env, '/auth/verify', { method: 'POST', form: { t: email.lastToken() }, cookie });
  assert.equal(res.status, 303);
  const signedIn = res.headers.get('set-cookie').split(';')[0];
  const after = await (await call(env, '/me', { cookie: signedIn })).json();
  assert.equal(after.email, INVITED);
  assert.deepEqual((await (await call(env, '/me/profile', { cookie: signedIn })).json()).home, { stops: ['PGP'] });
  // The browser's old session is gone with its anonymity.
  assert.equal((await call(env, '/me', { cookie })).status, 401);
});

test('an email that has an account already wins over a browser without one', async () => {
  const { env, email } = setup();
  const owner = await signIn(env, email);
  await call(env, '/me/profile', { method: 'PUT', cookie: owner, body: { home: { stops: ['KR-MRT'] }, places: [], trips: [], manual: [] } });
  const cookie = (await call(env, '/auth/anon/web', { method: 'POST', body: {} })).headers.get('set-cookie').split(';')[0];
  await call(env, '/me/profile', { method: 'PUT', cookie, body: { home: { stops: ['PGP'] }, places: [], trips: [], manual: [] } });
  // A minute later, as far as the one-email-a-minute rule goes.
  for (const k of env.KV._map.keys()) if (k.startsWith('mail:')) env.KV._map.delete(k);
  await call(env, '/auth/login', { method: 'POST', body: { email: INVITED } });
  const res = await call(env, '/auth/verify', { method: 'POST', form: { t: email.lastToken() }, cookie });
  const signedIn = res.headers.get('set-cookie').split(';')[0];
  assert.deepEqual((await (await call(env, '/me/profile', { cookie: signedIn })).json()).home, { stops: ['KR-MRT'] });
  assert.equal((await call(env, '/me', { cookie })).status, 401, 'the browser account is gone');
});

test('limits hold when requests arrive all at once: API keys and feedback', async () => {
  const { env, db, email } = setup();
  const cookie = await signIn(env, email);
  await Promise.all(Array.from({ length: 12 }, (_, i) => call(env, '/me/keys', { method: 'POST', cookie, body: { name: `k${i}` } })));
  assert.equal(db._db.prepare('SELECT count(*) AS n FROM api_keys').get().n, 5);
  await Promise.all(Array.from({ length: 25 }, () => call(env, '/me/feedback', { method: 'POST', cookie, body: { note: 'x', platform: 'web' } })));
  assert.equal(db._db.prepare('SELECT count(*) AS n FROM feedback').get().n, 10);
});

test('feedback emails to the operator stop at fifty a day; the reports are still kept', async () => {
  const { mailFeedback, OPERATOR_MAILS_PER_DAY } = await import('../src/feedback.ts');
  const { env, email } = setup();
  env.ALERT_EMAIL = 'ops@example.test';
  const f = { kind: 'other', note: 'x', platform: 'web', appVersion: null, context: null };
  const day = Date.UTC(2026, 9, 1, 2, 0, 0);
  for (let i = 0; i < OPERATOR_MAILS_PER_DAY + 5; i++) await mailFeedback(env, `f${i}`, 'a@u.nus.edu', f, day);
  assert.equal(email.sent.length, OPERATOR_MAILS_PER_DAY);
  await mailFeedback(env, 'next', 'a@u.nus.edu', f, day + 86_400_000);
  assert.equal(email.sent.length, OPERATOR_MAILS_PER_DAY + 1, 'a new day');
});

test('the pairing QR code opens the pair page in a browser, not an API error', async () => {
  const { env } = setup();
  env.ASSETS = { fetch: async (req) => new Response(`page for ${new URL(req.url).pathname}`, { headers: { 'content-type': 'text/html' } }) };
  const res = await call(env, '/pair?code=ABC234');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'page for /pair');
  // POST is still the API.
  assert.equal((await call(env, '/pair', { method: 'POST', body: { code: 'nope' } })).status, 400);
});

test('a page that isn\'t there is the not-found page for a browser, still a 404', async () => {
  const { env } = setup();
  const pages = { '/not-found/': 'no bus stops here' };
  env.ASSETS = { fetch: async (req) => {
    const page = pages[new URL(req.url).pathname];
    return page ? new Response(page, { headers: { 'content-type': 'text/html' } }) : new Response('not found', { status: 404 });
  } };
  const browser = await call(env, '/no-such-page', { accept: 'text/html,application/xhtml+xml' });
  assert.equal(browser.status, 404);
  assert.match(browser.headers.get('content-type'), /text\/html/);
  assert.equal(await browser.text(), 'no bus stops here');
  // A script or a client asking for something missing gets the plain 404.
  const script = await call(env, '/no-such-page.js', { accept: '*/*' });
  assert.equal(script.status, 404);
  assert.equal(await script.text(), 'not found');
});
