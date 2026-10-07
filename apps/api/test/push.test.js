/**
 * Push (phase 3): devices register a Firebase token, the Trip object wakes
 * when the card is due to change, and nudges the phones when the phase or
 * the question changed. On the frozen clock and a fake feed and Firebase.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FROZEN_NOW, installGlobals, makeCtx, makeDurableObjects, makeEnv, makeFetch } from './_stubs.mjs';
import { makeD1, makeEmail } from './_d1.mjs';
import worker from '../src/index.ts';
import { Trip } from '../src/tripdo.ts';
import { armTrips, remindTerm } from '../src/monitor.ts';

const BASE = 'https://bus.example.test';
const THU = 4;
/**
 * Buses that leave at fixed times (D2 every 10 min from 09:04, R2 every 12
 * from 09:06, at every stop), so the answers settle as the clock moves the
 * way real ones do, instead of every bus staying 4 minutes away.
 */
const at = (h, m) => FROZEN_NOW + ((h - 9) * 60 + m) * 60_000;
const times = (first, every) => Array.from({ length: 30 }, (_, i) => first + i * every * 60_000);
const RUNS = { D2: times(at(9, 4), 10), R2: times(at(9, 6), 12) };
const upcoming = (svc) => RUNS[svc].filter((t) => t >= Date.now()).map((t) => String(Math.round((t - Date.now()) / 60_000)));
const FEED = new Proxy(
  {},
  {
    get: () =>
      Object.keys(RUNS).map((svc) => {
        const [first, second] = upcoming(svc);
        return { name: svc, arrivalTime: first ?? '-', nextArrivalTime: second ?? '-', passengers: 'low' };
      }),
  },
);
const PROFILE = { home: { stops: ['PGP'] }, manual: [{ day: THU, arriveByMin: 600, endMin: 660, to: 'UTOWN', label: 'GEA1000 @ UTown', venue: '' }] };

/** A throwaway service account with a real RSA key, so the JWT really gets signed. */
async function serviceAccount() {
  const { privateKey } = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey)).toString('base64');
  const pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
  return JSON.stringify({ project_id: 'terminus-test', client_email: 'push@terminus-test.iam.gserviceaccount.com', private_key: pem });
}

/** `wrap` puts a fetch of the test's own in front of the fake feed and Firebase. */
async function setup({ push = true, wrap = (f) => f } = {}) {
  const fcm = { sent: [], dead: new Set() };
  const fetchImpl = wrap(makeFetch({ byStop: FEED, fcm }));
  installGlobals(fetchImpl);
  const clock = (ms) => installGlobals(fetchImpl, ms);
  let env;
  const TRIPS = makeDurableObjects(Trip, () => env);
  env = { ...makeEnv(), DB: makeD1(), EMAIL: makeEmail(), EMAIL_FROM: 'x@example.test', TRIPS, ...(push ? { FCM_SERVICE_ACCOUNT: await serviceAccount() } : {}) };
  const call = async (path, { method = 'GET', token, cookie, body } = {}) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const ctx = makeCtx();
    const res = await worker.fetch(new Request(BASE + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, ctx);
    await ctx.settle();
    return res;
  };
  await call('/auth/login', { method: 'POST', body: { email: 'you@u.nus.edu' } });
  const verify = await worker.fetch(
    new Request(`${BASE}/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `t=${env.EMAIL.lastToken()}` }),
    env,
    makeCtx(),
  );
  const cookie = verify.headers.get('set-cookie').split(';')[0];
  await call('/me/profile', { method: 'PUT', cookie, body: PROFILE });
  const pair = async (name) => {
    const { code } = await (await call('/me/pair-code', { method: 'POST', cookie })).json();
    return (await (await call('/pair', { method: 'POST', body: { code, name } })).json()).token;
  };
  const phone = await pair('Pixel');
  const mac = await pair('MacBook');
  const tablet = await pair('Galaxy Tab');
  const next = async (token) => (await call('/me/next', { token })).json();
  const pushTokens = () => env.DB._db.prepare('SELECT name, push_token FROM sessions WHERE push_token IS NOT NULL ORDER BY name').all().map((r) => ({ ...r }));
  const alarm = () => [...TRIPS.alarms.values()][0];
  /** Lets the Trip object wake at each alarm until `done`; how many wakes it took. */
  const wakeUntil = async (done, max = 5) => {
    let n = 0;
    while (!done() && n < max && alarm() !== undefined) {
      clock(alarm());
      await TRIPS.fireAlarms();
      n++;
    }
    assert.ok(done(), `not done after ${n} wakes`);
    return n;
  };
  return { env, call, cookie, phone, mac, tablet, next, fcm, TRIPS, clock, pushTokens, alarm, wakeUntil };
}

test('a device registers its push token; the same token moves with the device', async () => {
  const { call, phone, mac, pushTokens } = await setup();
  assert.equal((await call('/me/push', { method: 'POST', token: phone, body: {} })).status, 400);
  assert.equal((await call('/me/push', { method: 'POST', token: phone, body: { token: 'fcm-1' } })).status, 200);
  assert.deepEqual(pushTokens(), [{ name: 'Pixel', push_token: 'fcm-1' }]);
  // A reinstall signed in as another device reports the same token: one session only.
  await call('/me/push', { method: 'POST', token: mac, body: { token: 'fcm-1' } });
  assert.deepEqual(pushTokens(), [{ name: 'MacBook', push_token: 'fcm-1' }]);
  await call('/me/push', { method: 'DELETE', token: mac });
  assert.deepEqual(pushTokens(), []);
});

test('the Trip object wakes when the phase changes and nudges the phone, once per change', async () => {
  const { call, phone, next, fcm, TRIPS, alarm, wakeUntil } = await setup();
  await call('/me/push', { method: 'POST', token: phone, body: { token: 'fcm-phone' } });
  const first = await next(phone);
  assert.equal(first.card.phase, 'idle');
  // Asked to wake when the phase next changes: five minutes before the
  // leave-by (not when the card merely goes stale).
  assert.equal(alarm(), Date.parse(first.leave.at) - 5 * 60_000);

  // The phone already shows "idle": that is never pushed. (The 9:00 leave-by
  // was a timetable estimate; live times firm it up, so it may take a wake or two.)
  const woke = await wakeUntil(() => fcm.sent.length > 0);
  assert.ok(woke <= 3);
  assert.equal(fcm.sent.length, 1);
  assert.deepEqual(fcm.sent[0].data, { kind: 'card', phase: 'due' });
  assert.equal(fcm.sent[0].android.priority, 'HIGH', 'time to go is worth waking the phone for');
  assert.equal(fcm.sent[0].token, 'fcm-phone');
  assert.equal(fcm.oauth, 1);

  // Still due at the next wake: nothing to say.
  const before = fcm.sent.length;
  const [wake] = [...TRIPS.alarms.values()];
  assert.ok(wake > Date.now(), 'it keeps waking');
  assert.equal(fcm.sent.length, before);
  assert.equal(fcm.oauth, 1, 'the access token is reused');
});

test('nothing is pushed to ask about the bus: after the departure the trip moves on by itself, quietly', async () => {
  const { call, phone, tablet, next, fcm, TRIPS, clock, wakeUntil } = await setup();
  await call('/me/push', { method: 'POST', token: phone, body: { token: 'fcm-phone' } });
  await next(phone);
  // Due: the object remembers which bus the trip is for.
  await wakeUntil(() => fcm.sent.some((m) => m.data.phase === 'due'));
  const plan = Object.values([...TRIPS.instances.values()][0].storage._map.get('day').plans)[0];
  clock(Date.parse(plan.board) + 30_000);
  await TRIPS.fireAlarms();
  assert.ok(fcm.sent.every((m) => !('ask' in m.data)), 'never a question');
  // No answer means on it: the ride, pushed without waking anyone.
  clock(Date.parse(plan.board) + 4 * 60_000);
  await wakeUntil(() => fcm.sent.at(-1).data.phase === 'riding');
  assert.equal(fcm.sent.at(-1).android.priority, 'NORMAL');
  // An older app's tap still reaches the user's other phones (quietly); this one doesn't need telling.
  await call('/me/push', { method: 'POST', token: tablet, body: { token: 'fcm-tablet' } });
  const before = fcm.sent.length;
  await call('/me/signal', { method: 'POST', token: phone, body: { kind: 'boarded' } });
  const told = fcm.sent.slice(before);
  assert.deepEqual(told.map((m) => [m.token, m.data.phase, m.android.priority]), [['fcm-tablet', 'riding', 'NORMAL']]);
});

test('the morning cron starts the day for push users, so the push comes without any app asking', async () => {
  const { call, phone, fcm, env, alarm, wakeUntil } = await setup();
  await call('/me/push', { method: 'POST', token: phone, body: { token: 'fcm-phone' } });
  assert.equal(alarm(), undefined, 'registering asks for nothing by itself');
  assert.equal(await armTrips(env, Date.now()), 1);
  assert.ok(alarm() !== undefined, 'the Trip object is watching');
  await wakeUntil(() => fcm.sent.length > 0);
  assert.deepEqual(fcm.sent[0].data, { kind: 'card', phase: 'due' });
  assert.equal(await armTrips(env, Date.now()), 0, 'once a day');
});

test('the morning cron arms push users in batches, each run carrying on from the last', async () => {
  const { call, phone, env } = await setup();
  await call('/me/push', { method: 'POST', token: phone, body: { token: 'fcm-phone' } });
  // A batch of one: the first run arms the one user and isn't sure it's done.
  assert.equal(await armTrips(env, Date.now(), 1), 1);
  assert.match(await env.KV.get('trips:armed'), / /, 'under way, after that user');
  // The next run finds nobody after them: the day is done.
  assert.equal(await armTrips(env, Date.now(), 1), 0);
  assert.doesNotMatch(await env.KV.get('trips:armed'), / /);
  assert.equal(await armTrips(env, Date.now(), 1), 0, 'once a day');
});

test('a Trip object that does not take the morning request is asked again on a later run, alone', async () => {
  const { call, phone, env, TRIPS, alarm } = await setup();
  await call('/me/push', { method: 'POST', token: phone, body: { token: 'fcm-phone' } });
  let asked = 0;
  let broken = true;
  env.TRIPS = Object.assign(Object.create(TRIPS), {
    get: (id) => {
      const real = TRIPS.get(id);
      return { fetch: async (...a) => (asked++, broken ? new Response('overloaded', { status: 503 }) : real.fetch(...a)) };
    },
  });
  const quiet = console.error;
  console.error = () => {};
  assert.equal(await armTrips(env, Date.now()), 0, 'asked, not taken');
  console.error = quiet;
  assert.equal(await env.KV.get('trips:armed'), (await env.KV.get('trips:retry')).split(' ')[0], 'the day is done, bar the retry');
  assert.equal(alarm(), undefined);
  broken = false;
  assert.equal(await armTrips(env, Date.now()), 1, 'asked again');
  assert.ok(alarm() !== undefined, 'the Trip object is watching');
  assert.equal(await env.KV.get('trips:retry'), null);
  assert.equal(asked, 2);
  assert.equal(await armTrips(env, Date.now()), 0, 'once a day');
  assert.equal(asked, 2);
});

test('the week before a semester, push users with an older timetable are reminded to import the new one, once', async () => {
  const { call, phone, fcm, env, clock } = await setup();
  await call('/me/push', { method: 'POST', token: phone, body: { token: 'fcm-phone' } });
  const setProfile = (extra) => {
    const p = { ...JSON.parse(env.DB._db.prepare('SELECT json FROM profiles').get().json), trips: [{ day: THU, arriveByMin: 600, to: 'UTOWN', label: 'GEA1000' }], ...extra };
    env.DB._db.prepare('UPDATE profiles SET json = ?').run(JSON.stringify(p));
  };
  setProfile({ term: { acadYear: '2025/2026', semester: 2 } });
  // Semester 1 of 2026/27 starts on Monday 10 August.
  clock(Date.parse('2026-08-01T10:30:00+08:00'));
  assert.equal(await remindTerm(env, Date.now()), 0, 'not yet: nine days before');
  clock(Date.parse('2026-08-04T09:30:00+08:00'));
  assert.equal(await remindTerm(env, Date.now()), 0, 'not before 10 in the morning');
  clock(Date.parse('2026-08-04T10:30:00+08:00'));
  const before = fcm.sent.length;
  assert.equal(await remindTerm(env, Date.now()), 1);
  const [sent] = fcm.sent.slice(before);
  assert.equal(sent.data.kind, 'term');
  assert.equal(sent.data.title, 'Sem 1 2026/27 starts Mon 10 Aug');
  assert.equal(sent.data.zhTitle, '2026/27 第 1 学期将于 8月10日（周一）开始');
  assert.match(sent.data.body, /NUSMods/);
  assert.equal(await remindTerm(env, Date.now()), 0, 'once a semester');

  // Already imported for the new semester, or no timetable: nothing.
  await env.KV.delete('term:reminded');
  setProfile({ term: { acadYear: '2026/2027', semester: 1 } });
  assert.equal(await remindTerm(env, Date.now()), 0, 'already imported');
  await env.KV.delete('term:reminded');
  setProfile({ trips: [], term: { acadYear: '2025/2026', semester: 2 } });
  assert.equal(await remindTerm(env, Date.now()), 0, 'no timetable to bring up to date');
});

test('a semester reminder for someone with no device left to reach is not tried again', async () => {
  const { call, phone, env, clock } = await setup();
  await call('/me/push', { method: 'POST', token: phone, body: { token: 'fcm-phone' } });
  const p = { ...JSON.parse(env.DB._db.prepare('SELECT json FROM profiles').get().json), trips: [{ day: THU, arriveByMin: 600, to: 'UTOWN', label: 'GEA1000' }], term: { acadYear: '2025/2026', semester: 2 } };
  env.DB._db.prepare('UPDATE profiles SET json = ?').run(JSON.stringify(p));
  clock(Date.parse('2026-08-04T10:30:00+08:00'));
  // The app was uninstalled: Firebase says the token is gone, so it's dropped
  // and there is nobody left to send to, which no retry would change.
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    String(url).startsWith('https://fcm.googleapis.com/') ? Response.json({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }, { status: 404 }) : real(url, init);
  try {
    assert.equal(await remindTerm(env, Date.now()), 0);
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(await env.KV.get('term:retry'), null);
});

test('a semester reminder that reaches nobody is tried again; one whose mark cannot be saved is not sent', async () => {
  const { call, phone, fcm, env, clock } = await setup();
  await call('/me/push', { method: 'POST', token: phone, body: { token: 'fcm-phone' } });
  const p = { ...JSON.parse(env.DB._db.prepare('SELECT json FROM profiles').get().json), trips: [{ day: THU, arriveByMin: 600, to: 'UTOWN', label: 'GEA1000' }], term: { acadYear: '2025/2026', semester: 2 } };
  env.DB._db.prepare('UPDATE profiles SET json = ?').run(JSON.stringify(p));
  clock(Date.parse('2026-08-04T10:30:00+08:00'));
  const quiet = console.error;
  console.error = () => {};
  // The mark can't be saved: nothing goes, rather than the batch every run.
  const put = env.KV.put;
  env.KV.put = async (k, ...rest) => {
    if (k === 'term:reminded') throw new Error('KV write quota');
    return put.call(env.KV, k, ...rest);
  };
  const before = fcm.sent.length;
  await assert.rejects(remindTerm(env, Date.now()));
  env.KV.put = put;
  assert.equal(fcm.sent.length, before);
  // Firebase failing: nothing reached, so the user is kept to try again.
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).startsWith('https://fcm.googleapis.com/') ? new Response('unavailable', { status: 503 }) : real(url, init));
  assert.equal(await remindTerm(env, Date.now()), 0);
  globalThis.fetch = real;
  console.error = quiet;
  assert.equal(JSON.parse(await env.KV.get('term:retry')).users.length, 1);
  assert.equal(await remindTerm(env, Date.now()), 1, 'sent once it works');
  assert.equal(await env.KV.get('term:retry'), null);
  assert.equal(fcm.sent.length, before + 1);
  assert.equal(await remindTerm(env, Date.now()), 0, 'once a semester');
});

test('a semester reminder that never gets through holds up no one after it, and stops after a few tries', async () => {
  const { call, phone, fcm, env, clock } = await setup();
  await call('/me/push', { method: 'POST', token: phone, body: { token: 'fcm-broken' } });
  const db = env.DB._db;
  const p = { ...JSON.parse(db.prepare('SELECT json FROM profiles').get().json), trips: [{ day: THU, arriveByMin: 600, to: 'UTOWN', label: 'GEA1000' }], term: { acadYear: '2025/2026', semester: 2 } };
  db.prepare('UPDATE profiles SET json = ?').run(JSON.stringify(p));
  // A second user, after the first in id order, whose phone works.
  const later = 'zzzz-later';
  db.prepare("INSERT INTO users (id, email, created, last_seen, via) VALUES (?, 'later@u.nus.edu', 0, 0, 'web')").run(later);
  db.prepare('INSERT INTO profiles (user_id, json, updated) VALUES (?, ?, 0)').run(later, JSON.stringify(p));
  db.prepare("INSERT INTO sessions (token_hash, user_id, kind, name, created, last_seen, push_token) VALUES ('later-hash', ?, 'device', 'Later', 0, 0, 'fcm-later')").run(later);
  clock(Date.parse('2026-08-04T10:30:00+08:00'));
  // Firebase fails for the first user's token every time, without saying it's gone.
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    String(url).startsWith('https://fcm.googleapis.com/') && String(init?.body).includes('fcm-broken') ? new Response('internal', { status: 500 }) : real(url, init);
  // KV as Cloudflare runs it: one write a second to a key, so one per run here.
  const put = env.KV.put.bind(env.KV);
  let written = new Set();
  env.KV.put = async (k, ...rest) => {
    if (written.has(k)) throw new Error('KV PUT failed: 429 Too Many Requests');
    written.add(k);
    return put(k, ...rest);
  };
  const run = () => ((written = new Set()), remindTerm(env, Date.now(), 1));
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal(await run(), 0, 'the first user, not reached');
    assert.equal(await run(), 1, 'the next batch goes all the same');
    assert.deepEqual(fcm.sent.map((m) => m.token), ['fcm-later']);
    let runs = 2;
    while ((await env.KV.get('term:retry')) !== null && runs < 20) {
      await run();
      runs++;
    }
    assert.equal(runs, 8, 'tried on eight runs, then left');
    assert.equal(await run(), 0, 'once a semester');
  } finally {
    globalThis.fetch = real;
    console.error = quiet;
  }
});

test('a retried semester reminder is not sent twice when the retry list cannot be saved', async () => {
  const { call, phone, fcm, env, clock } = await setup();
  await call('/me/push', { method: 'POST', token: phone, body: { token: 'fcm-phone' } });
  const p = { ...JSON.parse(env.DB._db.prepare('SELECT json FROM profiles').get().json), trips: [{ day: THU, arriveByMin: 600, to: 'UTOWN', label: 'GEA1000' }], term: { acadYear: '2025/2026', semester: 2 } };
  env.DB._db.prepare('UPDATE profiles SET json = ?').run(JSON.stringify(p));
  const start = Date.parse('2026-08-04T10:30:00+08:00');
  clock(start);
  const quiet = console.error;
  console.error = () => {};
  const real = globalThis.fetch;
  const del = env.KV.delete;
  try {
    // Firebase failing: the user goes on the retry list.
    globalThis.fetch = async (url, init) => (String(url).startsWith('https://fcm.googleapis.com/') ? new Response('unavailable', { status: 503 }) : real(url, init));
    assert.equal(await remindTerm(env, Date.now()), 0);
    globalThis.fetch = real;
    // The retry reaches them, but the list can't be cleared.
    env.KV.delete = async () => {
      throw new Error('KV write failed');
    };
    const before = fcm.sent.length;
    clock(start + 15 * 60_000);
    assert.equal(await remindTerm(env, Date.now()), 1);
    clock(start + 30 * 60_000);
    assert.equal(await remindTerm(env, Date.now()), 0, 'not again');
    assert.equal(fcm.sent.length, before + 1);
  } finally {
    globalThis.fetch = real;
    env.KV.delete = del;
    console.error = quiet;
  }
});

test('a retried semester reminder reads the profile again: imported since, nothing; a new language, in that one', async () => {
  const { call, phone, fcm, env, clock } = await setup();
  await call('/me/push', { method: 'POST', token: phone, body: { token: 'fcm-phone' } });
  const p = { ...JSON.parse(env.DB._db.prepare('SELECT json FROM profiles').get().json), trips: [{ day: THU, arriveByMin: 600, to: 'UTOWN', label: 'GEA1000' }], term: { acadYear: '2025/2026', semester: 2 } };
  const setProfile = (extra) => env.DB._db.prepare('UPDATE profiles SET json = ?').run(JSON.stringify({ ...p, ...extra }));
  setProfile({});
  const start = Date.parse('2026-08-04T10:30:00+08:00');
  const quiet = console.error;
  console.error = () => {};
  const real = globalThis.fetch;
  const failing = async (url, init) => (String(url).startsWith('https://fcm.googleapis.com/') ? new Response('unavailable', { status: 503 }) : real(url, init));
  try {
    clock(start);
    globalThis.fetch = failing;
    assert.equal(await remindTerm(env, Date.now()), 0);
    globalThis.fetch = real;
    // They change to Chinese, then the retry goes: in Chinese.
    setProfile({ lang: 'zh' });
    const before = fcm.sent.length;
    clock(start + 15 * 60_000);
    assert.equal(await remindTerm(env, Date.now()), 1);
    assert.equal(fcm.sent[before].data.title, fcm.sent[before].data.zhTitle);
    assert.match(fcm.sent[before].data.title, /学期/);

    // Another semester's reminder fails, then they import the new timetable.
    await env.KV.delete('term:reminded');
    setProfile({});
    clock(start + 30 * 60_000);
    globalThis.fetch = failing;
    assert.equal(await remindTerm(env, Date.now()), 0);
    globalThis.fetch = real;
    assert.equal(JSON.parse(await env.KV.get('term:retry')).users.length, 1);
    setProfile({ term: { acadYear: '2026/2027', semester: 1 } });
    const now = fcm.sent.length;
    clock(start + 45 * 60_000);
    assert.equal(await remindTerm(env, Date.now()), 0, 'already imported');
    assert.equal(fcm.sent.length, now);
  } finally {
    globalThis.fetch = real;
    console.error = quiet;
  }
});

test('an access token that went stale is replaced, and the push still goes', async () => {
  const { call, phone, next, fcm, wakeUntil } = await setup();
  await call('/me/push', { method: 'POST', token: phone, body: { token: 'fcm-phone' } });
  fcm.expire = 1;
  await next(phone);
  await wakeUntil(() => fcm.sent.length > 0);
  assert.equal(fcm.sent[0].data.phase, 'due');
  assert.equal(fcm.oauth, 2, 'a new access token for the retry');
});

test('a token Firebase no longer knows is dropped', async () => {
  const { phone, call, next, fcm, pushTokens, wakeUntil } = await setup();
  await call('/me/push', { method: 'POST', token: phone, body: { token: 'fcm-gone' } });
  fcm.dead.add('fcm-gone');
  await next(phone);
  await wakeUntil(() => pushTokens().length === 0);
  assert.deepEqual(pushTokens(), []);
});

test('without push set up, or with no device registered, the object only wakes at midnight', async () => {
  for (const push of [false, true]) {
    const { phone, next, alarm } = await setup({ push });
    await next(phone);
    if (!push) assert.equal(alarm(), undefined, 'not even created for nothing');
  }
  // Registered nobody: it wakes once, finds no one to tell, and stops.
  const { phone, next, TRIPS, clock, alarm, fcm } = await setup();
  await next(phone);
  clock(alarm());
  await TRIPS.fireAlarms();
  assert.equal(fcm.sent.length, 0);
  assert.equal(new Date(alarm() + 8 * 3_600_000).toISOString().slice(11, 16), '00:00', 'only midnight is left');
});

test("another device fetching the card doesn't stop the phone being told", async () => {
  const { call, phone, mac, next, fcm, TRIPS, clock, alarm } = await setup();
  await call('/me/push', { method: 'POST', token: phone, body: { token: 'fcm-phone' } });
  await next(phone);
  // The trip becomes due; the Mac (no push) happens to refresh first.
  for (let i = 0; i < 5 && !fcm.sent.length; i++) {
    clock(alarm());
    await next(mac);
    await TRIPS.fireAlarms();
  }
  assert.equal(fcm.sent[0]?.data.phase, 'due', 'the phone still hears it');
});

const FCM_SEND = 'https://fcm.googleapis.com/v1/projects/';
/** What FCM says to a message it can't take, by the field that's wrong (none: as FCM words a token that isn't valid). */
const fcmRefusal = (field) =>
  Response.json(
    {
      error: {
        code: 400,
        status: 'INVALID_ARGUMENT',
        message: field ? 'Request contains an invalid argument.' : 'The registration token is not a valid FCM registration token',
        details: [
          { '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'INVALID_ARGUMENT' },
          ...(field ? [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field, description: 'Invalid value' }] }] : []),
        ],
      },
    },
    { status: 400 },
  );
/** The Trip object's storage, for the one user in these tests. */
const stored = (TRIPS) => [...TRIPS.instances.values()][0].storage._map;
/** Captures console.error while `fn` runs. */
async function errorsOf(fn) {
  const logged = [];
  const error = console.error;
  console.error = (...args) => logged.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.error = error;
  }
  return logged;
}

test('a message FCM refuses keeps the token; a token FCM says is bad is dropped', async () => {
  let refuse = null;
  const wrap = (f) => async (url, init) => (refuse && String(url).startsWith(FCM_SEND) ? fcmRefusal(refuse) : f(url, init));
  const { call, phone, next, pushTokens, TRIPS, clock, alarm } = await setup({ wrap });
  await call('/me/push', { method: 'POST', token: phone, body: { token: 'fcm-phone' } });
  await next(phone);
  // A bug in our message: every phone would lose its token, so none does.
  refuse = 'message.data';
  const logged = await errorsOf(async () => {
    for (let i = 0; i < 5 && !stored(TRIPS).has('pushed'); i++) {
      clock(alarm());
      await TRIPS.fireAlarms();
      if (pushTokens().length === 0) break;
    }
  });
  assert.deepEqual(pushTokens(), [{ name: 'Pixel', push_token: 'fcm-phone' }]);
  assert.ok(logged.some((l) => l.includes('fcm send 400 INVALID_ARGUMENT')), 'logged with its status and code');
  assert.ok(logged.every((l) => !l.includes('fcm-phone')), 'never the token');
  // The token itself named as the bad value: that one goes.
  refuse = 'message.token';
  clock(alarm());
  await TRIPS.fireAlarms();
  assert.deepEqual(pushTokens(), []);
});

test('a token FCM says is not valid, without naming the field, is dropped', async () => {
  let refuse = false;
  const wrap = (f) => async (url, init) => (refuse && String(url).startsWith(FCM_SEND) ? fcmRefusal(null) : f(url, init));
  const { call, phone, next, pushTokens, TRIPS, clock, alarm } = await setup({ wrap });
  await call('/me/push', { method: 'POST', token: phone, body: { token: 'fcm-phone' } });
  await next(phone);
  refuse = true;
  for (let i = 0; i < 5 && pushTokens().length; i++) {
    clock(alarm());
    await TRIPS.fireAlarms();
  }
  assert.deepEqual(pushTokens(), []);
});

test("one device's failure doesn't keep the push from the user's other devices", async () => {
  const wrap = (f) => async (url, init) => {
    if (String(url).startsWith(FCM_SEND) && JSON.parse(init.body).message.token === 'fcm-phone') throw new Error('connection reset');
    return f(url, init);
  };
  const { call, phone, tablet, next, fcm, wakeUntil } = await setup({ wrap });
  await call('/me/push', { method: 'POST', token: phone, body: { token: 'fcm-phone' } });
  await call('/me/push', { method: 'POST', token: tablet, body: { token: 'fcm-tablet' } });
  await next(phone);
  await errorsOf(() => wakeUntil(() => fcm.sent.length > 0));
  assert.deepEqual(fcm.sent.map((m) => [m.token, m.data.phase]), [['fcm-tablet', 'due']]);
});

test('every call to Firebase has a time limit', async () => {
  const signals = [];
  const wrap = (f) => async (url, init) => {
    if (String(url).startsWith(FCM_SEND) || url === 'https://oauth2.googleapis.com/token') signals.push(init?.signal);
    return f(url, init);
  };
  const { call, phone, next, fcm, wakeUntil } = await setup({ wrap });
  fcm.expire = 1;
  await call('/me/push', { method: 'POST', token: phone, body: { token: 'fcm-phone' } });
  await next(phone);
  await wakeUntil(() => fcm.sent.length > 0);
  // The token, the send, the new token after a 401 and the send again.
  assert.equal(signals.length, 4);
  assert.ok(signals.every((s) => s instanceof AbortSignal));
});

test('a push no device got is tried again at the next wake', async () => {
  let down = true;
  const wrap = (f) => async (url, init) => (down && String(url).startsWith(FCM_SEND) ? new Response('unavailable', { status: 503 }) : f(url, init));
  const { call, phone, next, fcm, TRIPS, clock, alarm } = await setup({ wrap });
  await call('/me/push', { method: 'POST', token: phone, body: { token: 'fcm-phone' } });
  await next(phone);
  await errorsOf(async () => {
    for (let i = 0; i < 5 && stored(TRIPS).get('day')?.plans === undefined; i++) {
      clock(alarm());
      await TRIPS.fireAlarms();
    }
  });
  assert.equal(stored(TRIPS).get('pushed'), undefined, 'not marked as pushed');
  down = false;
  clock(alarm());
  await TRIPS.fireAlarms();
  assert.ok(fcm.sent.length > 0, 'sent once Firebase is back');
});

test('a wake that fails is tried again soon, and pushes then', async () => {
  const { env, call, phone, next, fcm, TRIPS, clock, alarm } = await setup();
  await call('/me/push', { method: 'POST', token: phone, body: { token: 'fcm-phone' } });
  await next(phone);
  const prepare = env.DB.prepare.bind(env.DB);
  let broken = true;
  env.DB.prepare = (sql) => {
    if (broken && sql.includes('COUNT(*)')) throw new Error('D1 unavailable');
    return prepare(sql);
  };
  const first = alarm();
  clock(first);
  const logged = await errorsOf(() => TRIPS.fireAlarms());
  assert.ok(logged.some((l) => l.includes('trip wake failed')));
  assert.equal(alarm(), first + 30_000, 'again in 30 s, not at midnight');
  // Failing again waits twice as long.
  clock(alarm());
  await errorsOf(() => TRIPS.fireAlarms());
  assert.equal(alarm(), first + 30_000 + 60_000);
  broken = false;
  for (let i = 0; i < 5 && !fcm.sent.length; i++) {
    clock(alarm());
    await TRIPS.fireAlarms();
  }
  assert.equal(fcm.sent[0]?.data.phase, 'due');
  assert.equal(stored(TRIPS).get('wakeFails'), undefined, 'the count starts again');
});

test('an alarm run again after the object restarted mid-wake still wakes', async () => {
  const { call, phone, next, fcm, TRIPS, clock, alarm } = await setup();
  await call('/me/push', { method: 'POST', token: phone, body: { token: 'fcm-phone' } });
  await next(phone);
  for (let i = 0; i < 5 && !fcm.sent.length; i++) {
    const at = alarm();
    clock(at);
    // As the alarm leaves it just before the wake: the wake owed moved aside.
    const m = stored(TRIPS);
    m.set('waking', m.get('wakeAt'));
    m.delete('wakeAt');
    await TRIPS.fireAlarms();
  }
  assert.equal(fcm.sent[0]?.data.phase, 'due');
  assert.equal(stored(TRIPS).get('waking'), undefined);
});

test('an alarm run again after it failed past the push does not push the same thing twice', async () => {
  const { call, phone, next, fcm, TRIPS, clock, alarm } = await setup();
  await call('/me/push', { method: 'POST', token: phone, body: { token: 'fcm-phone' } });
  await next(phone);
  const { storage } = [...TRIPS.instances.values()][0];
  const del = storage.delete.bind(storage);
  // The alarm's last step fails once the push is out, as a storage error would.
  storage.delete = async (k) => {
    if (k === 'waking' && fcm.sent.length && !storage.failed) {
      storage.failed = true;
      throw new Error('storage reset');
    }
    return del(k);
  };
  for (let i = 0; i < 5 && !storage.failed; i++) {
    const at = alarm();
    clock(at);
    await TRIPS.fireAlarms().catch(() => {});
  }
  assert.equal(fcm.sent.length, 1);
  // The platform runs the alarm again within seconds.
  await [...TRIPS.instances.values()][0].alarm();
  assert.equal(fcm.sent.length, 1, 'not pushed again');
  assert.equal(stored(TRIPS).get('waking'), undefined);
});

test('a /clear or a sooner /watch while the object wakes is not undone by it', async () => {
  // While `gate` is set, a send to Firebase waits for it to open.
  let gate = null;
  const wrap = (f) => async (url, init) => {
    if (gate && String(url).startsWith(FCM_SEND)) {
      gate.hit = true;
      await gate.wait;
    }
    return f(url, init);
  };
  const shut = () => {
    let open;
    gate = { hit: false, wait: new Promise((r) => (open = r)) };
    gate.open = () => {
      gate = null;
      open();
    };
    return gate;
  };
  const { call, phone, next, fcm, TRIPS, clock, alarm } = await setup({ wrap });
  await call('/me/push', { method: 'POST', token: phone, body: { token: 'fcm-phone' } });
  await next(phone);
  const [userId] = TRIPS.instances.keys();
  const trip = TRIPS.get(userId);
  const date = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
  const deleteAt = stored(TRIPS).get('deleteAt');
  /** Wakes the object until it's held sending a push; the wake still running. */
  const untilSending = async () => {
    const g = shut();
    for (let i = 0; i < 5; i++) {
      clock(alarm());
      const run = TRIPS.fireAlarms();
      await new Promise((r) => setTimeout(r, 20));
      if (g.hit) return { g, run };
      await run;
    }
    assert.fail('never pushed');
  };

  // A /watch for sooner than the wake would pick, while it's pushing.
  let { g, run } = await untilSending();
  const soon = Date.now() + 5_000;
  await trip.fetch('https://trip/watch', { method: 'POST', body: JSON.stringify({ userId, date, at: soon, deleteAt }) });
  g.open();
  await run;
  assert.equal(fcm.sent.length, 1);
  assert.equal(stored(TRIPS).get('wakeAt'), soon, 'the sooner wake stays');
  assert.equal(alarm(), soon);

  // A /clear (the account deleted) while it's pushing: nothing comes back.
  stored(TRIPS).set('pushed', { key: 'other', phase: 'idle' });
  ({ g, run } = await untilSending());
  await trip.fetch('https://trip/clear', { method: 'POST' });
  g.open();
  await run;
  assert.deepEqual([...stored(TRIPS).keys()], [], 'still empty');
  assert.equal(alarm(), undefined, 'and no alarm left');
});

test('deleting the account clears its Trip object, alarm and all', async () => {
  const { call, cookie, phone, next, TRIPS, alarm } = await setup();
  await call('/me/push', { method: 'POST', token: phone, body: { token: 'fcm-phone' } });
  await next(phone);
  assert.ok(alarm() !== undefined);
  assert.equal((await call('/me', { method: 'DELETE', cookie })).status, 200);
  assert.deepEqual([...stored(TRIPS).keys()], []);
  assert.equal(alarm(), undefined, 'the alarm goes too, which deleteAll alone leaves');
});

test('/health says which push is set up; a key that will not parse is push off, said once', async () => {
  const { env, call } = await setup();
  const config = async () => (await (await call('/health')).json()).config;
  assert.deepEqual([(await config()).pushAndroid, (await config()).pushWeb], [true, false]);
  env.FCM_SERVICE_ACCOUNT = '{"project_id": "terminus-test", "private_key": "not a secret"';
  const logged = await errorsOf(async () => {
    assert.equal((await config()).pushAndroid, false);
    assert.equal((await config()).pushAndroid, false);
  });
  const said = logged.filter((l) => l.includes('FCM_SERVICE_ACCOUNT'));
  assert.equal(said.length, 1, 'once per isolate');
  assert.ok(!said[0].includes('not a secret'), 'never the value');
});
