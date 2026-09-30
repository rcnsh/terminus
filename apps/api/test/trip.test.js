/**
 * The trip engine (phase 2): trip signals kept in a Durable Object per user,
 * the phase on the card, /me/day, and the planner fixes that go with them.
 * On the frozen clock (Thursday 2026-08-27, 09:00 SGT) and a fake feed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FROZEN_NOW, installGlobals, makeCtx, makeDurableObjects, makeEnv, makeFetch } from './_stubs.mjs';
import { makeD1, makeEmail } from './_d1.mjs';
import worker from '../src/index.ts';
import { Trip, endOfDayMs, phaseFor, sgtDate } from '../src/trip.ts';
import { GRAPH } from '../src/graph.ts';
import { serviceEndsAt } from '../src/resolve.ts';

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
const PROFILE = { home: { stops: ['PGP'] }, manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown'), cls(720, 'COM3', 'CS2030 @ COM1')] };
const FIRST = `${THU}:600:UTOWN`;
const SECOND = `${THU}:720:COM3`;

/** An account with two devices (a phone and a Mac), and the TRIPS namespace. */
async function setup(profile = PROFILE, { trips = true } = {}) {
  installGlobals(makeFetch({ byStop: FEED }));
  const TRIPS = makeDurableObjects(Trip);
  const env = { ...makeEnv(), DB: makeD1(), EMAIL: makeEmail(), EMAIL_FROM: 'x@example.test', ...(trips ? { TRIPS } : {}) };
  const call = async (path, { method = 'GET', token, cookie, body } = {}) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const ctx = makeCtx();
    const res = await worker.fetch(new Request(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
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
  assert.equal((await call('/me/profile', { method: 'PUT', cookie, body: profile })).status, 200);
  const pair = async (name) => {
    const { code } = await (await call('/me/pair-code', { method: 'POST', cookie })).json();
    return (await (await call('/pair', { method: 'POST', body: { code, name } })).json()).token;
  };
  const phone = await pair('Pixel');
  const mac = await pair('MacBook');
  const next = async (token, q = '') => (await call(`/me/next${q}`, { token })).json();
  const signal = async (token, body) => call('/me/signal', { method: 'POST', token, body });
  return { env, call, phone, mac, next, signal, TRIPS };
}

test('a class trip starts idle, with only "Not going" to offer', async () => {
  const { phone, next } = await setup();
  const a = await next(phone);
  assert.equal(a.card.phase, 'idle');
  assert.deepEqual(a.card.actions.map((x) => x.id), ['skipped']);
  assert.equal(a.card.actions[0].trip, FIRST);
});

test('"On the R2" on the phone puts the Mac on the bus too', async () => {
  const { phone, mac, next, signal } = await setup();
  const before = await next(phone);
  const res = await signal(phone, { kind: 'boarded' });
  assert.equal(res.status, 200);
  const onPhone = await res.json();
  assert.equal(onPhone.card.phase, 'riding');
  assert.equal(onPhone.label, `On the ${before.leave.svc}`);
  assert.match(onPhone.card.line, /^On the R2 · off at/);
  assert.deepEqual(onPhone.card.actions.map((x) => x.id), ['arrived']);

  const onMac = await next(mac);
  assert.equal(onMac.card.phase, 'riding');
  assert.equal(onMac.card.glance.startsWith('Off '), true);
  assert.equal(onMac.label, onPhone.label);
});

test('"Missed it" replans, and says which bus was missed', async () => {
  const { phone, next, signal } = await setup();
  const before = await next(phone);
  const after = await (await signal(phone, { kind: 'missed' })).json();
  assert.equal(after.card.phase, 'missed');
  assert.match(after.card.line, /^Missed the /);
  assert.ok(after.leave, 'there is a next way there');
  assert.equal(after.card.actions[0].id, 'boarded');
  assert.ok(before);
});

test('"Not going" drops the class for today on every device, and can be undone', async () => {
  const { phone, mac, next, signal } = await setup();
  const skipped = await (await signal(phone, { kind: 'skipped', trip: FIRST })).json();
  assert.equal(skipped.dest.label, 'CS2030 @ COM1', 'on to the next class');
  const undo = skipped.card.actions.find((x) => x.id === 'reset');
  assert.equal(undo.trip, FIRST);
  assert.equal(undo.label, 'Undo: going to GEA1000 @ UTown');
  assert.equal((await next(mac)).dest.label, 'CS2030 @ COM1');

  const back = await (await signal(mac, { kind: 'reset', trip: FIRST })).json();
  assert.equal(back.dest.label, 'GEA1000 @ UTown');
});

test('"I\'m there" moves the plan on to the next class', async () => {
  const { phone, signal } = await setup();
  const after = await (await signal(phone, { kind: 'arrived' })).json();
  assert.equal(after.dest.label, 'CS2030 @ COM1');
});

test('a location at the class counts as arrived; the location itself is not kept', async () => {
  const profile = { home: { stops: ['PGP'] }, manual: [cls(600, 'COM3', 'CS2030 @ COM1'), cls(720, 'UTOWN', 'GEA1000 @ UTown')] };
  const { phone, signal, TRIPS } = await setup(profile);
  const after = await (await signal(phone, { kind: 'location', lat: 1.294431, lon: 103.775217 })).json();
  assert.ok(after);
  const stored = JSON.stringify([...TRIPS.instances.values()].map((i) => [...i.storage._map.values()]));
  assert.match(stored, /"arrived"/);
  assert.doesNotMatch(stored, /103\.77|1\.294/, 'no coordinates in the trip state');
});

test('/me/signal: needs the Durable Object, a known kind, and a trip', async () => {
  const noTrips = await setup(PROFILE, { trips: false });
  assert.equal((await noTrips.signal(noTrips.phone, { kind: 'boarded' })).status, 503);
  const { phone, signal } = await setup();
  assert.equal((await signal(phone, { kind: 'teleported' })).status, 400);
  const free = await setup({ home: { stops: ['PGP'] } });
  assert.equal((await free.signal(free.phone, { kind: 'boarded' })).status, 409, 'nothing to be on today');
});

test('/me/next without any classes today never wakes a Durable Object', async () => {
  const { phone, next, TRIPS } = await setup({ home: { stops: ['PGP'] } });
  const a = await next(phone);
  assert.equal(a.mode, 'free');
  assert.equal(TRIPS.instances.size, 0);
});

test("the day's signals are deleted at the end of the day, and yesterday's never count", async () => {
  const { phone, next, signal, TRIPS } = await setup();
  await signal(phone, { kind: 'skipped', trip: FIRST });
  const [alarm] = [...TRIPS.alarms.values()];
  assert.equal(alarm, endOfDayMs(FROZEN_NOW));
  // A signal stored for yesterday (an alarm that hasn't run yet) is ignored.
  const inst = [...TRIPS.instances.values()][0];
  await inst.storage.put('day', { date: '2026-08-26', trips: { [FIRST]: { kind: 'skipped', at: 0 } } });
  assert.equal((await next(phone)).dest.label, 'GEA1000 @ UTown');
  await TRIPS.fireAlarms();
  assert.equal(inst.storage._map.size, 0);
});

test('/me/day: each class with where you set off, the leave-by, and the trip home', async () => {
  const { phone, call, signal } = await setup({ ...PROFILE, gapHours: 0.5 });
  let day = await (await call('/me/day', { token: phone })).json();
  assert.equal(day.date, sgtDate(FROZEN_NOW));
  assert.deepEqual(day.items.map((i) => [i.kind, i.status]), [['class', 'next'], ['home', 'later'], ['class', 'later'], ['home', 'later']]);
  const [first, gap, second] = day.items;
  assert.equal(first.from, 'PGP');
  assert.ok(first.leave?.at, 'a leave-by for the next class');
  assert.equal(gap.startsAt, '2026-08-27T03:00:00Z', 'home after the first class ends');
  assert.equal(second.from, 'PGP', 'back from home after a long gap');
  assert.ok(second.leave?.at, 'a leave-by hours ahead too');
  // By bus, hours ahead is an estimate; on foot it's exact.
  assert.equal(second.leave.estimated, second.leave.svc !== null);

  await signal(phone, { kind: 'skipped', trip: FIRST });
  day = await (await call('/me/day', { token: phone })).json();
  assert.equal(day.items[0].status, 'skipped');
});

test('/me/day on a free day says what is next', async () => {
  const { phone, call } = await setup({ home: { stops: ['PGP'] }, manual: [{ ...cls(600, 'COM3', 'CS2030 @ COM1'), day: 5 }] });
  const day = await (await call('/me/day', { token: phone })).json();
  assert.deepEqual(day.items, []);
  assert.equal(day.note, 'Next: CS2030 @ COM1, tomorrow 10:00');
});

test('phases follow the clock until a signal says otherwise', () => {
  const now = FROZEN_NOW;
  const leaveAt = (ms) => ({ asOf: new Date(now).toISOString(), stop: { code: 'PGP' }, leave: { at: new Date(ms).toISOString(), svc: 'D2' }, arrived: false });
  const nowhere = { lat: null, lon: null };
  assert.equal(phaseFor(leaveAt(now + 10 * 60_000), undefined, now, nowhere), 'idle');
  assert.equal(phaseFor(leaveAt(now + 4 * 60_000), undefined, now, nowhere), 'due');
  assert.equal(phaseFor(leaveAt(now - 60_000), undefined, now, nowhere), 'heading');
  const pgp = GRAPH.stops.find((s) => s.code === 'PGP');
  assert.equal(phaseFor(leaveAt(now + 10 * 60_000), undefined, now, { lat: pgp.lat, lon: pgp.lon }), 'waiting', 'at the stop');
  assert.equal(phaseFor(leaveAt(now - 60_000), { kind: 'boarded', at: now }, now, nowhere), 'riding');
  assert.equal(phaseFor(leaveAt(now - 60_000), { kind: 'missed', at: now }, now, nowhere), 'missed');
  assert.equal(phaseFor({ ...leaveAt(now), arrived: true }, undefined, now, nowhere), 'arrived');
});

test('a service with published hours ends at its window close, across midnight too', () => {
  const graph = { ...GRAPH, serviceHours: { D2: { weekday: ['07:00', '23:00'] }, N: { weekday: ['19:00', '01:00'] } } };
  // Thursday 22:30 SGT.
  const at2230 = Date.UTC(2026, 7, 27, 14, 30);
  assert.equal(serviceEndsAt(graph, 'D2', at2230), Date.UTC(2026, 7, 27, 15, 0));
  assert.equal(serviceEndsAt(graph, 'N', at2230), Date.UTC(2026, 7, 27, 17, 0), '01:00 tomorrow');
  assert.equal(serviceEndsAt(graph, 'D2', Date.UTC(2026, 7, 27, 15, 30)), null, 'not running');
  assert.equal(serviceEndsAt(graph, 'X', at2230), null, 'hours unknown');
});

test('with every class today skipped, the day is free and "next" is not a skipped class', async () => {
  const { phone, signal } = await setup();
  await signal(phone, { kind: 'skipped', trip: FIRST });
  const a = await (await signal(phone, { kind: 'skipped', trip: SECOND })).json();
  assert.equal(a.mode, 'free');
  assert.equal(a.label, 'No more classes today');
  // The same classes next week, not today's skipped ones.
  assert.doesNotMatch(a.detail, /today/);
  assert.match(a.detail, /Thu 3 Sep/);
  assert.equal(a.card.actions.at(-1).id, 'reset', 'the last skip can still be undone');
});
