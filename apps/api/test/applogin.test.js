import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

import { installGlobals, makeCtx, makeDurableObjects, makeEnv, makeFetch } from './_stubs.mjs';
import { makeD1, makeEmail } from './_d1.mjs';
import worker from '../src/index.ts';
import { clientFrom } from '../src/accounts.ts';
import { choicesFor, hasSetup } from '../src/applogin.ts';
import { housekeeping } from '../src/monitor.ts';
import { endOfDayMs, sgtDate } from '../src/trip.ts';
import { Trip } from '../src/tripdo.ts';

const BASE = 'https://bus.example.test';
const ME = 'student@u.nus.edu';
const HOME = { home: { stops: ['PGP'] } };

function setup() {
  installGlobals(makeFetch());
  const db = makeD1();
  const email = makeEmail();
  const env = { ...makeEnv(), DB: db, EMAIL: email, EMAIL_FROM: 'terminus@example.test', TRIPS: makeDurableObjects(Trip) };
  return { db, email, env };
}

async function call(env, path, { method = 'GET', body, token, form, cookie, headers: extra = {} } = {}) {
  const headers = { ...extra };
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

async function anon(env, name = 'Pixel 8') {
  const res = await call(env, '/auth/anon', { method: 'POST', body: { name, platform: 'android' }, headers: { 'x-terminus-client': 'android/1.4.0' } });
  assert.equal(res.status, 201);
  return (await res.json()).token;
}

/** The anonymous account's id (there is at most one in these tests). */
function anonId(db) {
  return db._db.prepare('SELECT id FROM users WHERE email IS NULL').get()?.id;
}

/** Gives a user some trip state today, as a "Not going" would. */
async function seedTrip(env, userId) {
  const now = Date.now();
  const res = await env.TRIPS.get(userId).fetch('https://trip/signal', {
    method: 'POST',
    body: JSON.stringify({ date: sgtDate(now), key: '4:600:UTOWN', rec: { kind: 'skipped', at: now }, deleteAt: endOfDayMs(now) }),
  });
  assert.equal(res.status, 200);
}

/** Whether a user still has trip state today (signals or a pending alarm). */
async function hasTrip(env, userId) {
  const day = await (await env.TRIPS.get(userId).fetch(`https://trip/day?date=${sgtDate(Date.now())}`)).json();
  return day !== null || env.TRIPS.alarms.has(userId);
}

/** The approval link's secret from the latest email. */
function lastLink(email) {
  const m = /\/auth\/approve\?r=([A-Za-z0-9_-]+)/.exec(email.sent.at(-1)?.text ?? '');
  return m ? m[1] : null;
}

/** The code from the latest email. */
function lastCode(email) {
  return /code is ([2-9A-Z]{6})/.exec(email.sent.at(-1)?.text ?? '')?.[1] ?? null;
}

/** Starts a sign-in, approves it with the right number, and polls once. */
async function signInApp(env, email, { token, address = ME, name = 'Pixel 8' } = {}) {
  const started = await call(env, '/auth/app/start', { method: 'POST', token, body: { email: address, name } });
  assert.equal(started.status, 201);
  const s = await started.json();
  const approved = await call(env, '/auth/approve', { method: 'POST', form: { r: lastLink(email), n: String(s.match) } });
  assert.equal(approved.status, 200);
  const polled = await (await call(env, '/auth/app/poll', { method: 'POST', body: { request: s.request, poll: s.poll } })).json();
  assert.equal(polled.status, 'approved');
  return polled;
}

async function signInWeb(env, email, address = ME) {
  await call(env, '/auth/login', { method: 'POST', body: { email: address } });
  const m = /\/auth\/verify\?t=([A-Za-z0-9_-]+)/.exec(email.sent.at(-1).text);
  const res = await call(env, '/auth/verify', { method: 'POST', form: { t: m[1] } });
  return res.headers.get('set-cookie').split(';')[0];
}

test('an app starts with an anonymous account that works like any device', async () => {
  const { env, db } = setup();
  const token = await anon(env);
  const me = await (await call(env, '/me', { token })).json();
  assert.equal(me.email, null);
  assert.equal(me.anonymous, true);
  assert.equal(me.onboarding, 'full');

  assert.equal((await call(env, '/me/profile', { method: 'PUT', token, body: HOME })).status, 200);
  const next = await call(env, '/me/next', { token });
  assert.equal(next.status, 200);

  const row = db._db.prepare('SELECT u.email, u.via, s.platform, s.client, s.name FROM users u JOIN sessions s ON s.user_id = u.id').get();
  assert.deepEqual({ ...row }, { email: null, via: 'app', platform: 'android', client: 'android/1.4.0', name: 'Pixel 8' });
});

test('an anonymous account cannot add devices, but its app can delete it', async () => {
  const { env, db } = setup();
  const token = await anon(env);
  assert.equal((await call(env, '/me/pair-code', { method: 'POST', token })).status, 403);
  assert.equal((await call(env, '/me/keys', { method: 'POST', token, body: { name: 'x' } })).status, 403);
  const id = anonId(db);
  await seedTrip(env, id);
  assert.equal((await call(env, '/me', { method: 'DELETE', token })).status, 200);
  assert.equal(db._db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  // Today's trip signals go with the account, not at midnight.
  assert.equal(await hasTrip(env, id), false);
});

test('a signed-in device still cannot delete the account; the account page can', async () => {
  const { env, email } = setup();
  const { token } = await signInApp(env, email);
  assert.equal((await call(env, '/me', { method: 'DELETE', token })).status, 403);
});

test('anonymous accounts: a per-IP limit and one global ceiling', async () => {
  const { env } = setup();
  let n = 0;
  const e = { ...env, RL_ANON: { limit: async () => ({ success: ++n <= 2 }) } };
  assert.equal((await call(e, '/auth/anon', { method: 'POST', body: {} })).status, 201);
  assert.equal((await call(e, '/auth/anon', { method: 'POST', body: {} })).status, 201);
  assert.equal((await call(e, '/auth/anon', { method: 'POST', body: {} })).status, 429);
  const perIp = { ...env, RL_AUTH: { limit: async ({ key }) => ({ success: !key.startsWith('anon:') }) } };
  assert.equal((await call(perIp, '/auth/anon', { method: 'POST', body: {} })).status, 429);
});

test('app sign-in: the email carries a link, never the number; the page offers three numbers', async () => {
  const { env, email } = setup();
  const s = await (await call(env, '/auth/app/start', { method: 'POST', body: { email: ME, name: 'MacBook Air' } })).json();
  assert.ok(s.request && s.poll && s.match >= 10 && s.match <= 99);
  const mail = email.sent.at(-1);
  assert.equal(mail.to, ME);
  assert.match(mail.subject, /^Your terminus code: [2-9A-HJ-NP-TV-Z]{6}$/);
  assert.match(mail.text, /in terminus on MacBook Air/);
  const words = mail.text.replace(/https?:\/\/\S+/g, '').replace('15 minutes', '');
  assert.doesNotMatch(words, new RegExp(`\\b${s.match}\\b`), 'the number is only on the device');

  const page = await (await call(env, `/auth/approve?r=${lastLink(email)}`)).text();
  assert.match(page, /Sign in terminus on MacBook Air\?/);
  const shown = [...page.matchAll(/name="n" value="(\d+)"/g)].map((m) => Number(m[1]));
  assert.equal(shown.length, 3);
  assert.ok(shown.includes(s.match));
  // Opening the page twice (a mail scanner, then the user) changes nothing.
  const again = await (await call(env, `/auth/approve?r=${lastLink(email)}`)).text();
  assert.deepEqual([...again.matchAll(/name="n" value="(\d+)"/g)].map((m) => Number(m[1])), shown);
  assert.equal((await (await call(env, '/auth/app/poll', { method: 'POST', body: s })).json()).status, 'pending');
});

test('app sign-in: a wrong number kills the request', async () => {
  const { env, email } = setup();
  const s = await (await call(env, '/auth/app/start', { method: 'POST', body: { email: ME, name: 'Pixel' } })).json();
  const wrong = s.match === 99 ? 98 : s.match + 1;
  const res = await call(env, '/auth/approve', { method: 'POST', form: { r: lastLink(email), n: String(wrong) } });
  assert.equal(res.status, 400);
  assert.equal((await (await call(env, '/auth/app/poll', { method: 'POST', body: s })).json()).status, 'denied');
  // And the right number afterwards doesn't bring it back.
  assert.equal((await call(env, '/auth/approve', { method: 'POST', form: { r: lastLink(email), n: String(s.match) } })).status, 400);
});

test('app sign-in: "this wasn\'t me" cancels it', async () => {
  const { env, email } = setup();
  const s = await (await call(env, '/auth/app/start', { method: 'POST', body: { email: ME, name: 'Pixel' } })).json();
  assert.equal((await call(env, '/auth/approve', { method: 'POST', form: { r: lastLink(email), n: 'none' } })).status, 200);
  assert.equal((await (await call(env, '/auth/app/poll', { method: 'POST', body: s })).json()).status, 'denied');
});

test('app sign-in: the token is handed out once, and only for the right poll secret', async () => {
  const { env, email } = setup();
  const s = await (await call(env, '/auth/app/start', { method: 'POST', body: { email: ME, name: 'Pixel' } })).json();
  await call(env, '/auth/approve', { method: 'POST', form: { r: lastLink(email), n: String(s.match) } });
  const bad = await (await call(env, '/auth/app/poll', { method: 'POST', body: { request: s.request, poll: 'nope' } })).json();
  assert.equal(bad.status, 'expired');
  const ok = await (await call(env, '/auth/app/poll', { method: 'POST', body: s })).json();
  assert.equal(ok.status, 'approved');
  assert.equal(ok.outcome, 'created');
  const again = await (await call(env, '/auth/app/poll', { method: 'POST', body: s })).json();
  assert.deepEqual(again, { status: 'expired' });
  assert.equal((await (await call(env, '/me', { token: ok.token })).json()).email, ME);
});

test('app sign-in: one email a minute per address; a blocked address looks the same and never completes', async () => {
  const { env, email, db } = setup();
  db.exec(`INSERT INTO blocklist VALUES ('bad@example.com', 0)`);
  assert.equal((await call(env, '/auth/app/start', { method: 'POST', body: { email: ME, name: 'x' } })).status, 201);
  assert.equal((await call(env, '/auth/app/start', { method: 'POST', body: { email: ME, name: 'x' } })).status, 429);
  const before = email.sent.length;
  const res = await call(env, '/auth/app/start', { method: 'POST', body: { email: 'bad@example.com', name: 'x' } });
  assert.equal(res.status, 201);
  assert.equal(email.sent.length, before, 'no email to a blocked address');
  const s = await res.json();
  assert.equal((await (await call(env, '/auth/app/poll', { method: 'POST', body: s })).json()).status, 'pending');
});

test('adding an email to an anonymous account keeps everything; the old token is replaced', async () => {
  const { env, email, db } = setup();
  const old = await anon(env);
  await call(env, '/me/profile', { method: 'PUT', token: old, body: HOME });
  const r = await signInApp(env, email, { token: old });
  assert.equal(r.outcome, 'added-email');
  assert.equal((await call(env, '/me', { token: old })).status, 401, 'the anonymous token is gone');
  const profile = await (await call(env, '/me/profile', { token: r.token })).json();
  assert.deepEqual(profile.home, HOME.home);
  const u = db._db.prepare('SELECT email, email_added FROM users').get();
  assert.equal(u.email, ME);
  assert.ok(u.email_added > 0);
  // No "device added" email: it's the same device.
  assert.equal(email.sent.length, 1);
});

test('signing in to an existing account from a fresh install drops the empty anonymous account', async () => {
  const { env, email, db } = setup();
  const cookie = await signInWeb(env, email);
  await call(env, '/me/profile', { method: 'PUT', cookie, body: HOME });
  const old = await anon(env);
  const id = anonId(db);
  await seedTrip(env, id);
  // Wait out the cooldown the web sign-in started.
  await env.KV.delete([...env.KV._map.keys()].find((k) => k.startsWith('mail:')));
  db.exec('UPDATE magic_links SET created = 0');
  const r = await signInApp(env, email, { token: old });
  assert.equal(r.outcome, 'signed-in');
  assert.equal(db._db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  assert.equal(await hasTrip(env, id), false);
  assert.equal(email.sent.at(-1).subject, 'terminus was added to Pixel 8');
  assert.deepEqual((await (await call(env, '/me/profile', { token: r.token })).json()).home, HOME.home);
});

test("the device's setup moves to an account that has none", async () => {
  const { env, email, db } = setup();
  await signInWeb(env, email);
  env.KV._map.clear();
  db.exec('UPDATE magic_links SET created = 0');
  const old = await anon(env);
  await call(env, '/me/profile', { method: 'PUT', token: old, body: HOME });
  const r = await signInApp(env, email, { token: old });
  assert.equal(r.outcome, 'moved-setup');
  assert.deepEqual((await (await call(env, '/me/profile', { token: r.token })).json()).home, HOME.home);
  assert.equal(db._db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
});

test('both have a setup: the app chooses, and merge applies it', async () => {
  const { env, email, db } = setup();
  const cookie = await signInWeb(env, email);
  await call(env, '/me/profile', { method: 'PUT', cookie, body: { home: { stops: ['UTOWN'] } } });
  env.KV._map.clear();
  db.exec('UPDATE magic_links SET created = 0');
  const old = await anon(env);
  await call(env, '/me/profile', { method: 'PUT', token: old, body: HOME });
  const id = anonId(db);
  await seedTrip(env, id);
  const r = await signInApp(env, email, { token: old });
  assert.equal(r.outcome, 'choose');
  // Still an account until the app chooses, so its trip state stays too.
  assert.equal(await hasTrip(env, id), true);
  // The account's own setup until the app says otherwise.
  assert.deepEqual((await (await call(env, '/me/profile', { token: r.token })).json()).home.stops, ['UTOWN']);

  assert.equal((await call(env, '/auth/app/merge', { method: 'POST', token: r.token, body: { anon: 'nope', keep: 'device' } })).status, 400);
  const merged = await call(env, '/auth/app/merge', { method: 'POST', token: r.token, body: { anon: old, keep: 'device' } });
  assert.equal(merged.status, 200);
  assert.deepEqual((await merged.json()).profile.home.stops, ['PGP']);
  assert.equal(db._db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  assert.equal((await call(env, '/me', { token: old })).status, 401);
  assert.equal(await hasTrip(env, id), false);
});

test('a signed-in device can start another sign-in only for a different device', async () => {
  const { env, email } = setup();
  const { token } = await signInApp(env, email);
  env.KV._map.clear();
  const res = await call(env, '/auth/app/start', { method: 'POST', token, body: { email: ME, name: 'x' } });
  assert.equal(res.status, 409);
});

test('housekeeping deletes anonymous accounts unused for 60 days, never ones with an email', async () => {
  const db = makeD1();
  const day = 86_400_000;
  const now = 100 * day;
  db.exec(`INSERT INTO users (id, email, created, last_seen) VALUES
    ('idle', NULL, 0, ${now - 61 * day}), ('used', NULL, 0, ${now - 59 * day}), ('mail', 'a@b.c', 0, ${now - 61 * day})`);
  await housekeeping(db, now);
  assert.deepEqual(db._db.prepare('SELECT id FROM users ORDER BY id').all().map((r) => r.id), ['mail', 'used']);
});

test('the client header names the platform and version; the User-Agent is only a fallback', () => {
  const req = (h) => new Request(BASE, { headers: h });
  assert.deepEqual(clientFrom(req({ 'x-terminus-client': 'android/1.4.0' })), { platform: 'android', client: 'android/1.4.0' });
  assert.deepEqual(clientFrom(req({ 'x-terminus-client': 'Android-Play/1.5.0' })), { platform: 'android', client: 'android-play/1.5.0' });
  assert.deepEqual(clientFrom(req({ 'x-terminus-client': 'ios/0.1', 'user-agent': 'CFNetwork' })), { platform: 'ios', client: 'ios/0.1' });
  assert.deepEqual(clientFrom(req({ 'x-terminus-client': 'toaster/1', 'user-agent': 'Dalvik/2.1' })), { platform: 'android', client: null });
  assert.deepEqual(clientFrom(req({ 'user-agent': 'terminus/1 CFNetwork/1' })), { platform: 'mac', client: null });
});

test('the approval page keeps its three numbers distinct, with the right one among them', () => {
  for (let i = 0; i < 200; i++) {
    const seed = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const match = 10 + (i % 90);
    const c = choicesFor(match, seed);
    assert.equal(new Set(c).size, 3);
    assert.ok(c.includes(match));
    assert.ok(c.every((n) => n >= 10 && n <= 99));
    assert.deepEqual(choicesFor(match, seed), c);
  }
});

test('a setup worth keeping has somewhere to go or somewhere to start', () => {
  assert.equal(hasSetup(null), false);
  assert.equal(hasSetup({ home: null, trips: [], manual: [], places: [], seen: ['onboarding'] }), false);
  assert.equal(hasSetup({ home: { stops: ['PGP'] } }), true);
  assert.equal(hasSetup({ places: [{ key: 'a' }] }), true);
});

test('migration 0006 keeps every row when it rebuilds users (D1 cascades on DROP TABLE)', () => {
  const dir = new URL('../migrations/', import.meta.url);
  const files = readdirSync(dir).filter((n) => n.endsWith('.sql')).sort();
  const at = files.indexOf('0006_anonymous.sql');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of files.slice(0, at)) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  db.exec(`INSERT INTO users VALUES ('u1', 'a@b.com', 1);
    INSERT INTO sessions VALUES ('h1', 'u1', 'device', 'Pixel', 1, 500, NULL, 'android');
    INSERT INTO profiles VALUES ('u1', '{}', 1);
    INSERT INTO api_keys VALUES ('k1', 'u1', 'kh', 'n', 'abcd', 1, NULL);
    INSERT INTO feedback VALUES ('f1', 'u1', 1, 'wrong', '', 'web', NULL, NULL);
    INSERT INTO pair_codes VALUES ('ABCDEF', 'u1', 9);`);
  db.exec(readFileSync(new URL(files[at], dir), 'utf8'));
  for (const t of ['users', 'sessions', 'profiles', 'api_keys', 'feedback', 'pair_codes']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 1, t);
  }
  // last_seen comes from the account's most recent session.
  assert.equal(db.prepare('SELECT last_seen FROM users').get().last_seen, 500);
  // The rebuilt children still cascade from users.
  db.exec("DELETE FROM users WHERE id = 'u1'");
  for (const t of ['sessions', 'profiles', 'api_keys', 'feedback', 'pair_codes']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, t);
  }
});

test('app sign-in: the code from the email, typed in the app, signs it in straight away', async () => {
  const { env, email } = setup();
  const s = await (await call(env, '/auth/app/start', { method: 'POST', body: { email: ME, name: 'Pixel' } })).json();
  const code = lastCode(email);
  assert.ok(code);
  const res = await call(env, '/auth/app/code', { method: 'POST', body: { ...s, code: code.toLowerCase().replace(/(...)/, '$1 ') } });
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.equal(r.status, 'approved');
  assert.equal(r.outcome, 'created');
  assert.equal((await (await call(env, '/me', { token: r.token })).json()).email, ME);
  // Spent: neither the code, a poll nor the link works again.
  assert.equal((await call(env, '/auth/app/code', { method: 'POST', body: { ...s, code } })).status, 400);
  assert.deepEqual(await (await call(env, '/auth/app/poll', { method: 'POST', body: s })).json(), { status: 'expired' });
  assert.equal((await call(env, `/auth/approve?r=${lastLink(email)}`)).status, 400);
});

test('app sign-in: five wrong codes kill the request; the code needs the poll secret', async () => {
  const { env, email } = setup();
  const s = await (await call(env, '/auth/app/start', { method: 'POST', body: { email: ME, name: 'Pixel' } })).json();
  const code = lastCode(email);
  assert.equal((await (await call(env, '/auth/app/code', { method: 'POST', body: { ...s, poll: 'nope', code } })).json()).status, 'expired');
  const wrong = code === '222222' ? '333333' : '222222';
  for (let i = 0; i < 4; i++) {
    const r = await call(env, '/auth/app/code', { method: 'POST', body: { ...s, code: wrong } });
    assert.equal((await r.json()).status, 'pending');
  }
  assert.equal((await (await call(env, '/auth/app/code', { method: 'POST', body: { ...s, code: wrong } })).json()).status, 'denied');
  assert.equal((await (await call(env, '/auth/app/code', { method: 'POST', body: { ...s, code } })).json()).status, 'denied');
  assert.equal((await (await call(env, '/auth/app/poll', { method: 'POST', body: s })).json()).status, 'denied');
});

test('app sign-in: the code keeps a device\'s setup just like the link', async () => {
  const { env, email } = setup();
  const old = await anon(env);
  await call(env, '/me/profile', { method: 'PUT', token: old, body: HOME });
  const s = await (await call(env, '/auth/app/start', { method: 'POST', token: old, body: { email: ME, name: 'Pixel' } })).json();
  const r = await (await call(env, '/auth/app/code', { method: 'POST', body: { ...s, code: lastCode(email) } })).json();
  assert.equal(r.outcome, 'added-email');
  assert.deepEqual((await (await call(env, '/me/profile', { token: r.token })).json()).home, HOME.home);
});

test('app sign-in: wrong codes sent all at once still only get five tries', async () => {
  const { env, email } = setup();
  const s = await (await call(env, '/auth/app/start', { method: 'POST', body: { email: ME, name: 'Pixel' } })).json();
  const code = lastCode(email);
  const wrong = code === '222222' ? '333333' : '222222';
  await Promise.all(Array.from({ length: 20 }, () => call(env, '/auth/app/code', { method: 'POST', body: { ...s, code: wrong } })));
  assert.equal((await (await call(env, '/auth/app/code', { method: 'POST', body: { ...s, code } })).json()).status, 'denied');
});

test('app sign-in: the device name in the email is a name, not a message', async () => {
  const { env, email } = setup();
  await call(env, '/auth/app/start', { method: 'POST', body: { email: ME, name: 'Pixel\nVisit https://evil.example/x now' } });
  const text = email.sent.at(-1).text;
  assert.doesNotMatch(text, /evil\.example|https:\/\/evil/);
  assert.match(text, /Pixel Visit https evil example x/);
});

test('one inbox is sent at most ten sign-in emails an hour', async () => {
  const { takeMailBudget, MAILS_PER_HOUR } = await import('../src/accounts.ts');
  const { env } = setup();
  const hour = Date.UTC(2026, 9, 1, 3, 0, 0);
  for (let i = 0; i < MAILS_PER_HOUR; i++) assert.equal(await takeMailBudget(env, 'a@u.nus.edu', hour + i * 60_000), true);
  assert.equal(await takeMailBudget(env, 'a@u.nus.edu', hour + 30 * 60_000), false);
  assert.equal(await takeMailBudget(env, 'b@u.nus.edu', hour), true, 'per inbox');
  assert.equal(await takeMailBudget(env, 'a@u.nus.edu', hour + 3_600_000), true, 'the next hour');
});
