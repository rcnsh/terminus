/**
 * "Earlier bus" and "Later bus" (step.ts): stepping from the server's bus
 * to the one before or after it, kept for the trip on every device. On the
 * frozen clock (Thursday 2026-08-27, 09:00 SGT) and a fake feed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FROZEN_NOW, installGlobals, makeCtx, makeDurableObjects, makeEnv, makeFetch } from './_stubs.mjs';
import { makeD1, makeEmail } from './_d1.mjs';
import worker from '../src/index.ts';
import { Trip } from '../src/push/tripdo.ts';
import { loadDay, updateTrip } from '../src/answer/trip.ts';
import { GRAPH } from '../src/answer/graph.ts';
import { departures } from '../src/answer/leave.ts';
import { findTarget, stepFrom, targetOf } from '../src/answer/step.ts';
import { STEP } from '../src/config.ts';

const BASE = 'https://bus.example.test';
const THU = 4;
const FEED = {};
for (const code of ['PGP', 'PGPR', 'COM3', 'UTOWN', 'KR-MRT', 'CLB']) {
  FEED[code] = [
    { name: 'D2', arrivalTime: '4', nextArrivalTime: '14', passengers: 'low' },
    { name: 'R2', arrivalTime: '6', nextArrivalTime: '18', passengers: 'medium' },
  ];
}
const cls = (arriveByMin, to, label) => ({ day: THU, arriveByMin, endMin: arriveByMin + 60, to, label, venue: '' });
const PROFILE = {
  home: { stops: ['PGP'] },
  manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown')],
  places: [{ key: 'clb', label: 'Library', to: 'CLB' }],
};
const FIRST = `${THU}:600:UTOWN`;
const CLASS_AT = Date.parse('2026-08-27T02:00:00Z');

async function setup(profile = PROFILE) {
  const fetchImpl = makeFetch({ byStop: FEED });
  installGlobals(fetchImpl);
  const clock = (ms) => installGlobals(fetchImpl, ms);
  const env = { ...makeEnv(), DB: makeD1(), EMAIL: makeEmail(), EMAIL_FROM: 'x@example.test', TRIPS: makeDurableObjects(Trip) };
  const call = async (path, { method = 'GET', token, cookie, body } = {}) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const ctx = makeCtx();
    const res = await worker.fetch(
      new Request(BASE + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
      env,
      ctx,
    );
    await ctx.settle();
    return res;
  };
  await call('/api/auth/login', { method: 'POST', body: { email: 'you@u.nus.edu' } });
  const verify = await worker.fetch(
    new Request(`${BASE}/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `t=${env.EMAIL.lastToken()}`,
    }),
    env,
    makeCtx(),
  );
  const cookie = verify.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/api/me/profile', { method: 'PUT', cookie, body: profile })).status, 200);
  const pair = async (name) => {
    const { code } = await (await call('/api/me/pair-code', { method: 'POST', cookie })).json();
    return (await (await call('/api/pair', { method: 'POST', body: { code, name } })).json()).token;
  };
  const phone = await pair('Pixel');
  const mac = await pair('MacBook');
  const next = async (token, q = '') => (await call(`/api/me/next${q}`, { token })).json();
  const signal = async (token, body) => await call('/api/me/signal', { method: 'POST', token, body });
  const step = async (token, trip, to, dir, q = '') =>
    call(`/api/me/step${q}`, { method: 'POST', token, body: { trip, to, ...(dir ? { dir } : {}) } });
  return { env, call, phone, mac, next, step, signal, clock };
}

const ms = (iso) => Date.parse(iso);

test('a class card offers both steps, and "Later bus" moves every device to the bus after', async () => {
  const { phone, mac, next, step } = await setup();
  const a = await next(phone);
  assert.equal(a.card.phase, 'idle');
  assert.ok(a.card.step, 'steps on an idle class trip');
  assert.equal(a.card.step.trip, FIRST);
  assert.equal(a.card.step.moved, false);
  assert.equal(a.card.step.laterLabel, 'Later bus');
  assert.ok(a.card.step.earlier && a.card.step.later);

  const res = await step(phone, FIRST, a.card.step.later, 'later');
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.card.step.moved, true);
  assert.equal(b.leave.board, a.card.step.later.board);
  assert.ok(ms(b.leave.at) > ms(a.leave.at), 'leave later');
  assert.ok(ms(b.leave.arrive) >= ms(a.leave.arrive), 'never there sooner');
  // Past the start: the card says so.
  assert.equal(b.card.late, ms(b.leave.arrive) > CLASS_AT);

  // The Mac, with no location, shows the same bus.
  const m = await next(mac);
  assert.equal(m.leave.board, b.leave.board);
  assert.equal(m.card.step.moved, true);

  // "Best bus" puts the server's own back.
  const c = await (await step(phone, FIRST, null)).json();
  assert.equal(c.card.step.moved, false);
  assert.equal(c.leave.board, a.leave.board);
});

test('"Later bus" stops at 20 minutes late for a class, "Earlier bus" at the first bus you can catch', async () => {
  const { phone, next, step } = await setup();
  let a = await next(phone);
  for (let n = 0; a.card.step.later && n < 50; n++) a = await (await step(phone, FIRST, a.card.step.later)).json();
  assert.equal(a.card.step.later, null);
  assert.ok(ms(a.leave.arrive) <= CLASS_AT + STEP.lateMaxS * 1000, 'within the cap');
  assert.ok(ms(a.leave.arrive) > CLASS_AT, 'the last ones are late');

  for (let n = 0; a.card.step.earlier && n < 80; n++) a = await (await step(phone, FIRST, a.card.step.earlier)).json();
  assert.equal(a.card.step.earlier, null);
  assert.ok(ms(a.leave.at) >= FROZEN_NOW, 'no bus you have already missed');
  // The first live D2 or R2 from PGP, four or six minutes away.
  assert.ok(ms(a.leave.board) <= FROZEN_NOW + 6 * 60_000);
});

test("a chosen bus you didn't set off for lapses, and the steps go once you're on your way", async () => {
  const { phone, next, step, signal, clock } = await setup();
  const a = await next(phone);
  const b = await (await step(phone, FIRST, a.card.step.later)).json();
  // Past its leave-by with nothing said: no catching it now, and no sliding on to the one after.
  clock(ms(b.leave.at) + 60_000);
  const c = await next(phone);
  assert.ok(!c.card.step?.moved, 'the best bus again');
  assert.ok(ms(c.leave.board) < ms(b.leave.board) + 9 * 60_000, 'not the D2 after it');
  // Set off: the trip follows its plan, with nothing to step.
  const d = await (await signal(phone, { kind: 'left', trip: FIRST })).json();
  assert.equal(d.card.phase, 'heading');
  assert.equal(d.card.step, null);
});

test('a favourite can be stepped too, and an unknown trip is refused', async () => {
  const { phone, next, step } = await setup();
  const a = await next(phone, '?place=clb');
  assert.ok(a.card.step, 'steps on a favourite');
  assert.equal(a.card.step.trip, 'place:clb');
  assert.equal(a.card.step.earlier, null, 'the next bus is the first');
  const b = await (await step(phone, 'place:clb', a.card.step.later, 'later')).json();
  assert.equal(b.card.step.trip, 'place:clb');
  const again = await next(phone, '?place=clb');
  assert.equal(again.card.step.moved, true);
  assert.equal(again.leave.board, a.card.step.later.board);
  assert.ok(ms(again.leave.at) <= ms(a.bus.board) + STEP.laterMaxS * 1000);

  assert.equal((await step(phone, 'place:gym', null)).status, 400);
  assert.equal((await step(phone, '4:1:NOPE', null)).status, 400);
  assert.equal((await step(phone, FIRST, { svc: 'D2', stop: 'PGP' })).status, 400);
});

// The planner's parts, on their own.

const leave = (svc, stop, at, board, arrive) => ({
  at: new Date(at).toISOString(),
  estimated: false,
  svc,
  stop,
  stopCode: stop,
  board: new Date(board).toISOString(),
  arrive: new Date(arrive).toISOString(),
  note: null,
});
const T = Date.parse('2026-08-27T01:00:00Z');
const MIN = 60_000;

test('a chosen bus the feed has moved a little is the same bus; one it no longer lists, the next of that service', () => {
  const all = [leave('D2', 'PGP', T, T + 4 * MIN, T + 20 * MIN), leave('D2', 'PGP', T + 10 * MIN, T + 14 * MIN, T + 30 * MIN)];
  const moved = { svc: 'D2', stop: 'PGP', board: new Date(T + 5 * MIN).toISOString() };
  assert.equal(findTarget(all, moved), all[0]);
  const gone = { svc: 'D2', stop: 'PGP', board: new Date(T + 9 * MIN).toISOString() };
  assert.equal(findTarget(all, gone), all[1]);
  assert.equal(findTarget(all, { ...gone, board: new Date(T + 20 * MIN).toISOString() }), null, 'never an earlier one');
  // Leaving before any bus you can still catch: you didn't go for it.
  assert.equal(findTarget(all, { ...gone, board: new Date(T - 10 * MIN).toISOString() }), null);
});

test('a step never gets you there sooner going later, or later going earlier', () => {
  const own = leave('D2', 'PGP', T + 10 * MIN, T + 14 * MIN, T + 30 * MIN);
  const all = [
    leave('D2', 'PGP', T, T + 4 * MIN, T + 20 * MIN),
    // Leaves earlier but gets there after: not "earlier".
    leave('A1', 'PGP', T + 5 * MIN, T + 9 * MIN, T + 40 * MIN),
    own,
    // Leaves later and gets there sooner: not "later" from here either.
    leave('R2', 'PGPR', T + 12 * MIN, T + 15 * MIN, T + 25 * MIN),
    leave('D2', 'PGP', T + 20 * MIN, T + 24 * MIN, T + 40 * MIN),
  ];
  const s = stepFrom({ trip: 'k', own, all, target: null, lastArriveMs: null, nowMs: T - MIN });
  assert.deepEqual(s.steps.earlier, targetOf(all[0]));
  assert.deepEqual(s.steps.later, targetOf(all[4]));
  assert.equal(s.steps.moved, false);
  // Past the hour after the server's bus, no "Later".
  const far = stepFrom({
    trip: 'k',
    own,
    all: [own, leave('D2', 'PGP', T + 80 * MIN, T + 84 * MIN, T + 100 * MIN)],
    target: null,
    lastArriveMs: null,
    nowMs: T,
  });
  assert.equal(far.steps.later, null);
});

test('with no live times the buses fall a headway apart from the chosen one, however the clock moves', () => {
  const pgp = GRAPH.stops.find((s) => s.code === 'PGP');
  const opt = (nowMs) => ({
    svc: 'D2',
    stop: pgp,
    walkS: 60,
    rideS: 600,
    boardS: 300,
    totalS: 900,
    fromMs: nowMs,
    quality: 'scheduled',
    hops: 5,
  });
  const input = (nowMs) => ({
    options: [opt(nowMs)],
    candidates: [],
    byStop: new Map(),
    graph: GRAPH,
    arriveBy: null,
    walkAllS: null,
    nowMs,
  });
  const anchor = { svc: 'D2', stop: 'PGP', board: new Date(T + 40 * MIN).toISOString() };
  const boards = (nowMs) => departures(input(nowMs), T + 120 * MIN, anchor).map((l) => ms(l.board));
  assert.ok(boards(T).includes(T + 40 * MIN));
  assert.ok(boards(T + 3 * MIN).includes(T + 40 * MIN), 'the chosen bus stays put');
});

test("a step drops the trip's plan, so the bus chosen becomes it on every device", async () => {
  const { env } = await setup();
  const plan = { svc: 'R2', stop: 'PGP', board: '2026-08-27T01:42:00Z', arrive: '2026-08-27T01:51:30Z', located: true };
  await updateTrip(env, 'u1', { plans: { [FIRST]: plan, other: plan } }, FROZEN_NOW);
  const to = { svc: 'D2', stop: 'PGP', board: '2026-08-27T01:50:00Z' };
  const day = await updateTrip(env, 'u1', { steps: { [FIRST]: to } }, FROZEN_NOW);
  assert.deepEqual(day.steps, { [FIRST]: to });
  assert.deepEqual(Object.keys(day.plans), ['other']);
  // Only steps today is still a day to load.
  await updateTrip(env, 'u2', { steps: { [FIRST]: to } }, FROZEN_NOW);
  assert.deepEqual((await loadDay(env, 'u2', FROZEN_NOW)).steps, { [FIRST]: to });
  // "Best bus": no step kept.
  assert.deepEqual((await updateTrip(env, 'u1', { steps: { [FIRST]: null } }, FROZEN_NOW)).steps, {});
});

test("Today's leave-by for the class follows the bus stepped to", async () => {
  const { phone, call, next, step } = await setup();
  const a = await next(phone);
  const b = await (await step(phone, FIRST, a.card.step.later)).json();
  const day = await (await call('/api/me/day', { token: phone })).json();
  const row = day.items.find((x) => x.key === FIRST);
  assert.equal(row.leave.board, b.leave.board);
});
