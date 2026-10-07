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
import { remindUser } from '../src/push.ts';

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

async function setup({ push = true } = {}) {
  const fcm = { sent: [], dead: new Set() };
  const fetchImpl = makeFetch({ byStop: FEED, fcm });
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
  return { env, call, phone, mac, tablet, next, fcm, TRIPS, clock, pushTokens, alarm, wakeUntil };
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

test('an access token that went stale is replaced, and the push still goes', async () => {
  const { call, phone, next, fcm, wakeUntil } = await setup();
  await call('/me/push', { method: 'POST', token: phone, body: { token: 'fcm-phone' } });
  fcm.expire = 1;
  await next(phone);
  await wakeUntil(() => fcm.sent.length > 0);
  assert.equal(fcm.sent[0].data.phase, 'due');
  assert.equal(fcm.oauth, 2, 'a new access token for the retry');
});

test('the access token is kept in the isolate: one KV read, not one per push batch', async () => {
  const { call, phone, env, fcm } = await setup();
  await call('/me/push', { method: 'POST', token: phone, body: { token: 'fcm-phone' } });
  const userId = env.DB._db.prepare('SELECT id FROM users').get().id;
  const get = env.KV.get.bind(env.KV);
  let reads = 0;
  env.KV.get = (k, ...rest) => {
    if (k === 'fcm:access') reads++;
    return get(k, ...rest);
  };
  const notice = { title: 't', body: 'b', zhTitle: 't', zhBody: 'b' };
  const t0 = Date.now();
  assert.equal(await remindUser(env, userId, notice, t0), 1);
  assert.equal(reads, 1, 'nothing kept yet: KV, then a new token');
  assert.equal(fcm.oauth, 1);
  assert.equal(await remindUser(env, userId, notice, t0 + 60_000), 1);
  assert.equal(await remindUser(env, userId, notice, t0 + 49 * 60_000), 1);
  assert.equal(reads, 1, 'the same token, without asking KV');
  assert.equal(fcm.oauth, 1);
  await remindUser(env, userId, notice, t0 + 51 * 60_000);
  assert.equal(reads, 2, 'past when its KV entry would have gone, asked again');
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
