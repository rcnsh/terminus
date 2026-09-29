import test from 'node:test';
import assert from 'node:assert/strict';

import { installGlobals, makeCtx, makeEnv, makeFetch } from './_stubs.mjs';
import { makeD1, makeEmail } from './_d1.mjs';
import worker from '../src/index.ts';
import { newPairCode, normalizePairCode } from '../src/accounts.ts';
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

async function call(env, path, { method = 'GET', body, token, form, cookie, key } = {}) {
  const headers = {};
  if (key) headers['x-api-key'] = key;
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
  assert.deepEqual(me, { email: INVITED, kind: 'device', needsReimport: false, reimportReason: null, term: null, onboarding: 'full' });

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


test('the bus answers need a key or an account; downloads, health and docs stay open', async () => {
  const { env, email } = setup();
  delete env.PUBLIC_API_OPEN; // locked, as in production
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

test('API keys: made on the account page, shown once, work anywhere, revocable', async () => {
  const { env, db, email } = setup();
  delete env.PUBLIC_API_OPEN;
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
