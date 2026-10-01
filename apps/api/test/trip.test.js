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
import { endOfDayMs, phaseFor, sgtDate } from '../src/trip.ts';
import { Trip } from '../src/tripdo.ts';
import { GRAPH } from '../src/graph.ts';
import { indexGraph, rideStops, serviceEndsAt } from '../src/resolve.ts';
import { clockAt } from '../src/clock.ts';

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
async function setup(profile = PROFILE, { trips = true, feed = FEED } = {}) {
  const fetchImpl = makeFetch({ byStop: feed });
  installGlobals(fetchImpl);
  /** Moves the frozen clock; the fake feed's times are relative to it. */
  const clock = (ms) => installGlobals(fetchImpl, ms);
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
  return { env, call, cookie, phone, mac, next, signal, TRIPS, clock };
}

test('a class trip starts idle, with only "Not going" and "Not on campus today" to offer', async () => {
  const { phone, next } = await setup();
  const a = await next(phone);
  assert.equal(a.card.phase, 'idle');
  assert.deepEqual(a.card.actions.map((x) => x.id), ['skipped', 'away']);
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
  assert.match(onPhone.card.line, /^On the R2 · off at UTown /, 'the stop, not the class');
  assert.match(onPhone.detail, /^Off at UTown · /);
  // The stops ridden, for a progress bar: from where the bus was boarded to where you get off.
  const ride = onPhone.card.ride;
  assert.equal(ride.svc, 'R2');
  assert.equal(ride.stops[0].code, before.leave.stopCode);
  assert.equal(ride.stops.at(-1).code, 'UTOWN');
  assert.ok(ride.stops.length >= 2 && ride.stops.every((x) => x.name));
  assert.ok(Date.parse(ride.board) < Date.parse(ride.arrive));
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
  const { phone, next, signal, TRIPS, clock } = await setup();
  await signal(phone, { kind: 'skipped', trip: FIRST });
  const [alarm] = [...TRIPS.alarms.values()];
  assert.equal(alarm, endOfDayMs(FROZEN_NOW));
  // A signal stored for yesterday (an alarm that hasn't run yet) is ignored.
  const inst = [...TRIPS.instances.values()][0];
  await inst.storage.put('day', { date: '2026-08-26', trips: { [FIRST]: { kind: 'skipped', at: 0 } } });
  assert.equal((await next(phone)).dest.label, 'GEA1000 @ UTown');
  clock(endOfDayMs(FROZEN_NOW));
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

  // On the bus: the bus and where to get off, not a leave-by that has passed.
  await signal(phone, { kind: 'boarded', trip: FIRST });
  day = await (await call('/me/day', { token: phone })).json();
  assert.equal(day.items[0].leave, undefined);
  assert.equal(day.items[0].onBus.svc, first.leave.svc);
  assert.ok(day.items[0].onBus.off, 'where to get off');
  assert.equal(day.items[2].onBus, undefined, 'only the trip you are on');

  await signal(phone, { kind: 'skipped', trip: FIRST });
  day = await (await call('/me/day', { token: phone })).json();
  assert.equal(day.items.some((i) => i.key === FIRST), false, 'taken off today: not listed');
});

test('/me/day: anything not done yet can be taken off today, the trip home too, and put back', async () => {
  const t = await setup({ ...PROFILE, gapHours: 0.5 });
  const list = async () => (await (await t.call('/me/day', { token: t.phone })).json()).items;
  let items = await list();
  assert.deepEqual(items.map((i) => i.removable), [true, true, true, true]);
  const gap = items.find((i) => i.key.startsWith('gap-home:'));
  const home = items.find((i) => i.key.startsWith('home:'));

  // The gap's trip home off: you stay, and the next class goes from where you are.
  await t.signal(t.phone, { kind: 'skipped', trip: gap.key });
  items = await list();
  assert.deepEqual(items.map((i) => i.kind), ['class', 'class', 'home']);
  assert.equal(items[1].from, 'UTOWN', 'from the first class, not home');
  assert.deepEqual(outcomesToday(t.env), [], 'a trip home is not an outcome');
  t.clock(FROZEN_NOW + 90 * 60_000); // 10:30, in the gap
  assert.equal((await t.next(t.phone)).dest.label, 'CS2030 @ COM1', 'the next class, not home');

  // The last trip home off: nothing after the last class.
  await t.signal(t.phone, { kind: 'skipped', trip: home.key });
  assert.deepEqual((await list()).map((i) => i.kind), ['class', 'class']);
  t.clock(FROZEN_NOW + 5 * 60 * 60_000); // 14:00, after the last class
  assert.notEqual((await t.next(t.phone)).dest?.label, 'Home');

  // Undo puts it back.
  await t.signal(t.phone, { kind: 'reset', trip: home.key });
  assert.equal((await list()).at(-1).kind, 'home');
});

test('/me/day: what is done cannot be taken off', async () => {
  const t = await setup();
  await t.signal(t.phone, { kind: 'arrived', trip: FIRST });
  const items = (await (await t.call('/me/day', { token: t.phone })).json()).items;
  assert.equal(items.find((i) => i.key === FIRST).removable, false);
  assert.equal(items.find((i) => i.key === SECOND).removable, true);
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

/* Phase 3: the question at departure, and what silence means. */

test('"On the 9:41 R2?" is asked at the departure, about the planned bus, and goes once answered', async () => {
  const { phone, mac, next, signal, clock } = await setup();
  const first = await next(phone);
  assert.equal(first.card.ask, null, 'nothing to ask before the trip is due');
  const leaveAt = Date.parse(first.leave.at);

  // Due: the plan is remembered from here on.
  clock(leaveAt - 60_000);
  const due = await next(phone);
  assert.equal(due.card.phase, 'due');
  assert.equal(due.card.ask, null, 'not before the bus leaves');
  const board = Date.parse(due.leave.board);
  const svc = due.leave.svc;

  // Just after it left: asked, on every device, about that bus.
  clock(board + 30_000);
  const asked = await next(mac);
  assert.equal(asked.card.ask.question, `On the ${clockAt(board)} ${svc}?`);
  assert.deepEqual(asked.card.ask.actions.map((x) => x.id), ['boarded', 'missed', 'skipped']);
  assert.deepEqual(asked.card.ask.actions.map((x) => x.label), ['On it', 'Missed it', 'Not going']);
  assert.equal(asked.card.askMuted, false);

  // "On it" is about the bus that left, not the next one.
  const answered = await (await signal(phone, { kind: 'boarded', trip: FIRST })).json();
  assert.equal(answered.card.phase, 'riding');
  assert.equal(answered.card.ask, null, 'asked once');
  assert.equal(answered.label, `On the ${svc}`);
  assert.equal((await next(mac)).card.ask, null);
});

test('polls between the leave time and the departure keep the question about the bus you were told to catch', async () => {
  const { phone, mac, next, clock } = await setup();
  const first = await next(phone);
  const leaveAt = Date.parse(first.leave.at);
  clock(leaveAt - 60_000);
  const due = await next(phone);
  const board = Date.parse(due.leave.board);
  const svc = due.leave.svc;

  // Past the leave time, the answer moves on to a later bus (you might not
  // have left), and the phones and the widget keep polling, with and without
  // a location. None of that changes which bus the trip was for.
  clock(leaveAt + 60_000);
  const later = await next(phone);
  assert.notEqual(later.leave.board, due.leave.board, 'the answer has moved on to a later bus');
  await next(mac, '?lat=1.3048&lon=103.7735');
  clock(board - 10_000);
  await next(phone);

  clock(board + 30_000);
  const asked = await next(mac);
  assert.equal(asked.card.ask?.question, `On the ${clockAt(board)} ${svc}?`);
});

test('the widget, planning without a location, does not replace the bus the phone planned from where you are', async () => {
  const { phone, next, clock } = await setup();
  const AT_STOP = '?lat=1.2966&lon=103.7764'; // next to the stop the plan boards at
  const first = await next(phone, AT_STOP);
  clock(Date.parse(first.leave.at) - 60_000);
  const due = await next(phone, AT_STOP);
  const board = Date.parse(due.leave.board);
  const svc = due.leave.svc;
  const blind = await next(phone);
  assert.notEqual(blind.leave.board, due.leave.board, 'without a location it plans another bus');

  clock(board + 30_000);
  const asked = await next(phone);
  assert.equal(asked.card.ask?.question, `On the ${clockAt(board)} ${svc}?`);
});

test('no answer means "on it": the planned bus, a few minutes after it left', async () => {
  const { phone, next, clock } = await setup();
  const first = await next(phone);
  clock(Date.parse(first.leave.at) - 60_000);
  const due = await next(phone);
  const board = Date.parse(due.leave.board);

  clock(board + 2 * 60_000);
  assert.notEqual((await next(phone)).card.phase, 'riding', 'not straight away');

  clock(board + 4 * 60_000);
  const quiet = await next(phone);
  assert.equal(quiet.card.phase, 'riding');
  assert.equal(quiet.label, `On the ${due.leave.svc}`);
  assert.match(quiet.card.line, new RegExp(`^On the ${due.leave.svc}`));
  assert.ok(quiet.card.ask, 'the question stays until it is answered or the class starts');
});

test('still at the stop a few minutes after the bus left: missed, without being asked', async () => {
  const { phone, next, clock } = await setup();
  const first = await next(phone);
  clock(Date.parse(first.leave.at) - 60_000);
  const due = await next(phone);
  clock(Date.parse(due.leave.board) + 4 * 60_000);
  const pgp = indexGraph(GRAPH).byCode.get('PGP');
  const still = await next(phone, `?lat=${pgp.lat}&lon=${pgp.lon}`);
  assert.equal(still.card.phase, 'missed');
  assert.ok(still.leave, 'with the next way there');
});

test('"On it" reads the arrival from the feed: the same plate at your stop', async () => {
  // Only the R2 runs, and the bus at PGP (plate PX1) reaches UTown in 9 minutes.
  const feed = {};
  for (const code of Object.keys(FEED)) feed[code] = [{ name: 'R2', arrivalTime: '15', nextArrivalTime: '25', passengers: 'low', arrivalTime_veh_plate: 'PZ9' }];
  feed.PGP = [{ name: 'R2', arrivalTime: '1', nextArrivalTime: '11', passengers: 'low', arrivalTime_veh_plate: 'PX1', nextArrivalTime_veh_plate: 'PX2' }];
  feed.UTOWN = [{ name: 'R2', arrivalTime: '9', nextArrivalTime: '19', passengers: 'low', arrivalTime_veh_plate: 'PX1', nextArrivalTime_veh_plate: 'PX2' }];
  const { phone, next, signal } = await setup(PROFILE, { feed });
  const before = await next(phone);
  assert.equal(before.leave.svc, 'R2');
  const riding = await (await signal(phone, { kind: 'boarded', trip: FIRST })).json();
  assert.equal(riding.card.phase, 'riding');
  assert.equal(riding.quality, 'live');
  assert.equal(riding.arriveAt, new Date(FROZEN_NOW + 9 * 60_000).toISOString().replace('.000Z', 'Z'));
  assert.match(riding.detail, new RegExp(`arrive ${clockAt(FROZEN_NOW + 9 * 60_000)}`));
  assert.doesNotMatch(riding.detail, /~/);
});

test('"On it" without a plate in the feed keeps the estimate, marked as one', async () => {
  const { phone, signal } = await setup();
  const riding = await (await signal(phone, { kind: 'boarded', trip: FIRST })).json();
  assert.equal(riding.quality, 'scheduled');
  assert.match(riding.detail, /arrive ~/);
});

/* Phase 3: what terminus learns from the answers (outcomes.ts). */

const DAY = 86_400_000;
const userOf = (env) => env.DB._db.prepare('SELECT id FROM users WHERE email IS NOT NULL').get().id;
/** A past outcome, `daysAgo` days before the frozen clock. */
function seed(env, key, daysAgo, outcome) {
  const at = FROZEN_NOW - daysAgo * DAY;
  env.DB._db
    .prepare('INSERT INTO trip_outcomes (user_id, trip_key, day, outcome, at) VALUES (?, ?, ?, ?, ?)')
    .run(userOf(env), key, sgtDate(at), outcome, at);
}
const outcomesToday = (env) => env.DB._db.prepare('SELECT trip_key AS trip, outcome FROM trip_outcomes WHERE day = ?').all(sgtDate(FROZEN_NOW));

test('each answer is kept as the trip\'s outcome for today, and "Undo" forgets it', async () => {
  const { env, phone, signal } = await setup();
  await signal(phone, { kind: 'skipped', trip: FIRST });
  assert.deepEqual(outcomesToday(env).map((r) => ({ ...r })), [{ trip: FIRST, outcome: 'skipped' }]);
  await signal(phone, { kind: 'reset', trip: FIRST });
  assert.equal(outcomesToday(env).length, 0);
  await signal(phone, { kind: 'missed' });
  assert.deepEqual(outcomesToday(env).map((r) => ({ ...r })), [{ trip: FIRST, outcome: 'missed' }]);
});

test('an unanswered question is noted once as "no answer"', async () => {
  const { env, phone, next, clock } = await setup();
  const first = await next(phone);
  clock(Date.parse(first.leave.at) - 60_000);
  const due = await next(phone);
  clock(Date.parse(due.leave.board) + 4 * 60_000);
  assert.equal((await next(phone)).card.phase, 'riding');
  await next(phone);
  assert.deepEqual(outcomesToday(env).map((r) => ({ ...r })), [{ trip: FIRST, outcome: 'none' }]);
});

test('five trips in a row without an answer and the question stops; turning it back on asks again', async () => {
  const { env, call, phone, next, clock } = await setup();
  for (let d = 1; d <= 5; d++) seed(env, `${d}:600:UTOWN`, d, 'none');
  const first = await next(phone);
  assert.equal(first.card.askMuted, true);
  clock(Date.parse(first.leave.at) - 60_000);
  const due = await next(phone);
  clock(Date.parse(due.leave.board) + 30_000);
  assert.equal((await next(phone)).card.ask, null, 'not asked any more');
  assert.equal((await (await call('/me/choices', { token: phone })).json()).askMuted, true);

  assert.equal((await call('/me/ask', { method: 'POST', token: phone })).status, 200);
  const again = await next(phone);
  assert.equal(again.card.askMuted, false);
  assert.ok(again.card.ask, 'asked again');
});

test('clearing the trip history forgets the outcomes, unmutes the question and drops the suggestion, but keeps choices', async () => {
  const { env, call, phone, next } = await setup();
  for (let d = 1; d <= 5; d++) seed(env, `${d}:600:UTOWN`, d, 'none');
  for (const d of [7, 14, 21]) seed(env, FIRST, d, 'missed');
  await call('/me/choice', { method: 'POST', token: phone, body: { trip: 'x', pref: 'quiet', choice: 'accept' } });
  let r = await (await call('/me/choices', { token: phone })).json();
  assert.equal(r.history, 8);
  assert.equal(r.askMuted, true);

  const res = await call('/me/history', { method: 'DELETE', token: phone });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, cleared: 8 });
  r = await (await call('/me/choices', { token: phone })).json();
  assert.equal(r.history, 0);
  assert.equal(r.askMuted, false);
  assert.deepEqual(r.choices.map((c) => [c.trip, c.pref]), [['x', 'quiet']], 'choices stay');
  const a = await next(phone);
  assert.equal(a.card.askMuted, false);
  assert.equal(a.card.suggestion, null);
  assert.equal((await call('/me/history', { method: 'DELETE' })).status, 401);
});

test('one answer among the last five keeps the question', async () => {
  const { env, phone, next } = await setup();
  for (let d = 1; d <= 5; d++) seed(env, `${d}:600:UTOWN`, d, d === 3 ? 'boarded' : 'none');
  assert.equal((await next(phone)).card.askMuted, false);
});

test('three misses of a class in a month suggest a bus earlier; accepting it moves the leave-by, undoing it moves it back', async () => {
  const { env, call, phone, next } = await setup();
  for (const d of [7, 14, 21]) seed(env, FIRST, d, 'missed');
  const before = await next(phone);
  assert.equal(before.card.suggestion.id, `earlier:${FIRST}`);
  assert.match(before.card.suggestion.text, /missed the bus to GEA1000 @ UTown 3 times this month/);

  const res = await call('/me/choice', { method: 'POST', token: phone, body: { id: before.card.suggestion.id, choice: 'accept' } });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).choices.map((c) => [c.trip, c.pref, c.label]), [[FIRST, 'earlier', 'GEA1000 @ UTown']]);
  const after = await next(phone);
  assert.equal(after.card.suggestion, null);
  assert.ok(Date.parse(after.leave.at) < Date.parse(before.leave.at), 'a bus earlier');
  assert.equal(after.leave.note, 'One bus earlier, as you chose for this class');

  await call('/me/choice', { method: 'POST', token: phone, body: { trip: FIRST, pref: 'earlier', choice: 'undo' } });
  assert.equal((await next(phone)).leave.at, before.leave.at);
});

test('"Not going" three weeks running offers to stop reminders; accepting turns them off for that class only', async () => {
  const { env, call, phone, next, signal } = await setup();
  for (const d of [7, 14, 21]) seed(env, FIRST, d, 'skipped');
  const before = await next(phone);
  assert.equal(before.card.suggestion.id, `quiet:${FIRST}`);
  assert.equal(before.card.remind, true);
  await call('/me/choice', { method: 'POST', token: phone, body: { id: before.card.suggestion.id, choice: 'accept' } });
  const after = await next(phone);
  assert.equal(after.card.remind, false);
  assert.equal(after.dest.label, 'GEA1000 @ UTown', 'the class is still planned');
  // The next class still reminds.
  const second = await (await signal(phone, { kind: 'skipped', trip: FIRST })).json();
  assert.equal(second.dest.label, 'CS2030 @ COM1');
  assert.equal(second.card.remind, true);
});

test('a suggestion turned down is not offered again, and never during a trip', async () => {
  const { env, call, phone, next, clock } = await setup();
  for (const d of [7, 14, 21]) seed(env, FIRST, d, 'missed');
  const first = await next(phone);
  clock(Date.parse(first.leave.at) - 60_000);
  assert.equal((await next(phone)).card.suggestion, null, 'not while the trip is due');
  clock(FROZEN_NOW);
  await call('/me/choice', { method: 'POST', token: phone, body: { id: `earlier:${FIRST}`, choice: 'dismiss' } });
  assert.equal((await next(phone)).card.suggestion, null);
});

test('trip outcomes are in the export and go with the account', async () => {
  const { env, call, cookie, phone, signal } = await setup();
  await signal(phone, { kind: 'missed' });
  const exported = await (await call('/me/export', { cookie })).json();
  assert.deepEqual(exported.tripOutcomes.map((o) => [o.trip, o.outcome]), [[FIRST, 'missed']]);
  assert.equal((await call('/me', { method: 'DELETE', cookie })).status, 200);
  assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM trip_outcomes').get().n, 0);
});

/* Phase 8.1: the trip from the phone's location (detect.ts). */

const stopAt = (code) => indexGraph(GRAPH).byCode.get(code);
/** Halfway between the boarding stop and the next one on the ride: on the bus's road. */
function onTheWay(plan) {
  const stops = rideStops(indexGraph(GRAPH), plan.svc, plan.stopCode, plan.offCode ?? 'UTOWN');
  const a = stopAt(stops[0]);
  const b = stopAt(stops[1]);
  return { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
}
/** Due, then at the boarding stop just before the bus: what detection starts from. */
async function waitingAtStop(t) {
  const first = await t.next(t.phone);
  t.clock(Date.parse(first.leave.at) - 60_000);
  const due = await t.next(t.phone);
  const plan = due.leave;
  t.clock(Date.parse(plan.board) - 60_000);
  const s = stopAt(plan.stopCode);
  const waiting = await (await t.signal(t.phone, { kind: 'location', lat: s.lat, lon: s.lon, speed: 0, acc: 10 })).json();
  return { plan, waiting, board: Date.parse(plan.board) };
}
const tripRec = async (t, key = FIRST) => {
  const res = await t.TRIPS.get(t.TRIPS.idFromName(userOf(t.env))).fetch(`https://trip/day?date=${sgtDate(FROZEN_NOW)}`);
  return (await res.json())?.trips?.[key];
};

test('waiting at the stop, then moving at bus speed along its road: on the bus, without a tap', async () => {
  const t = await setup();
  const { plan, waiting, board } = await waitingAtStop(t);
  assert.equal(waiting.card.phase, 'waiting');
  t.clock(board + 40_000);
  const riding = await (await t.signal(t.phone, { kind: 'location', ...onTheWay(plan), speed: 8, acc: 15 })).json();
  assert.equal(riding.card.phase, 'riding');
  assert.equal(riding.card.detected, true);
  assert.equal(riding.card.phaseText, "Looks like you're on the bus");
  // Followed: nothing asks what happened, only a quiet way to say it's wrong.
  assert.deepEqual(riding.card.actions.map((a) => [a.id, a.label]), [['undetected', 'Not right?']]);
  assert.equal(riding.card.ask, null, 'nothing to ask: it is known');
  // Every device, even one without a location.
  const mac = await t.next(t.mac);
  assert.equal(mac.card.phase, 'riding');
  const rec = await tripRec(t);
  assert.equal(rec.detected, true);
  assert.ok(Date.parse(rec.boarded.departed) <= board + 40_000 && Date.parse(rec.boarded.departed) >= board - 3 * 60_000);
  assert.equal(JSON.stringify(rec).includes(String(onTheWay(plan).lat)), false, 'the location itself is not kept');
});

test('moving fast without having been at the stop, or off the bus route, is not a ride', async () => {
  const t = await setup();
  const first = await t.next(t.phone);
  t.clock(Date.parse(first.leave.board) + 40_000);
  const fast = await (await t.signal(t.phone, { kind: 'location', ...onTheWay(first.leave), speed: 8 })).json();
  assert.notEqual(fast.card.detected, true, 'never waited at the stop');

  const u = await setup();
  const { board } = await waitingAtStop(u);
  u.clock(board + 40_000);
  const clb = stopAt('CLB');
  const elsewhere = await (await u.signal(u.phone, { kind: 'location', lat: clb.lat + 0.004, lon: clb.lon - 0.004, speed: 9 })).json();
  assert.notEqual(elsewhere.card.detected, true, 'a car on another road');
  const walking = await (await u.signal(u.phone, { kind: 'location', ...onTheWay(elsewhere.leave ?? { svc: 'D2', stopCode: 'PGP', offCode: 'UTOWN' }), speed: 1.4 })).json();
  assert.notEqual(walking.card.detected, true, 'walking pace');
});

test('still at the stop three minutes after the bus left: missed, recorded for every device; "Not right?" undoes it', async () => {
  const t = await setup();
  const { plan, board } = await waitingAtStop(t);
  t.clock(board + 4 * 60_000);
  const s = stopAt(plan.stopCode);
  const missed = await (await t.signal(t.phone, { kind: 'location', lat: s.lat, lon: s.lon, speed: 0 })).json();
  assert.equal(missed.card.phase, 'missed');
  assert.equal(missed.card.detected, true);
  assert.match(missed.card.phaseText, /^Looks like you missed it/);
  assert.equal((await t.next(t.mac)).card.phase, 'missed', 'the Mac too, without a location');
  assert.deepEqual(outcomesToday(t.env).map((o) => [o.trip, o.outcome]), [[FIRST, 'missed']]);

  const wrong = missed.card.actions.find((a) => a.id === 'undetected');
  assert.equal(wrong.label, 'Not right?');
  const back = await (await t.signal(t.mac, { kind: 'undetected', trip: wrong.trip })).json();
  assert.notEqual(back.card.phase, 'missed');
  assert.equal(back.card.detected, false);
  assert.deepEqual(outcomesToday(t.env), [], 'the outcome goes with it');
  assert.equal(back.card.ask, null, 'still followed: nothing asked');
  t.clock(board + 6 * 60_000);
  assert.ok((await t.next(t.mac)).card.ask, 'no fixes for a while: the question is asked instead');
  t.clock(board + 4 * 60_000);
  // Detection leaves the trip alone now, and nothing is assumed either.
  const again = await (await t.signal(t.phone, { kind: 'location', lat: s.lat, lon: s.lon, speed: 0 })).json();
  assert.notEqual(again.card.phase, 'missed');
  assert.equal((await tripRec(t)).kind, 'undetected');
});

test('a miss then the next bus: detected on that one', async () => {
  const t = await setup();
  const { plan, board } = await waitingAtStop(t);
  t.clock(board + 4 * 60_000);
  const s = stopAt(plan.stopCode);
  const missed = await (await t.signal(t.phone, { kind: 'location', lat: s.lat, lon: s.lon, speed: 0 })).json();
  assert.equal(missed.card.phase, 'missed');
  const nextBus = missed.leave;
  t.clock(Date.parse(nextBus.board) + 30_000);
  const riding = await (await t.signal(t.phone, { kind: 'location', ...onTheWay(nextBus), speed: 7 })).json();
  assert.equal(riding.card.phase, 'riding');
  assert.equal(riding.label, `On the ${nextBus.svc}`);
});

test('a tap wins: after "Missed it" a fast fix is not taken as the bus', async () => {
  const t = await setup();
  const { plan, board } = await waitingAtStop(t);
  await t.signal(t.phone, { kind: 'missed', trip: FIRST });
  t.clock(board + 40_000);
  const fast = await (await t.signal(t.phone, { kind: 'location', ...onTheWay(plan), speed: 8 })).json();
  assert.equal(fast.card.phase, 'missed');
  assert.equal(fast.card.detected, false);
});

test('on the bus you said you were on, reaching your stop: there; "Not right?" puts you back on it', async () => {
  const t = await setup();
  const before = await t.next(t.phone);
  const riding = await (await t.signal(t.phone, { kind: 'boarded', trip: FIRST })).json();
  assert.equal(riding.card.phase, 'riding');
  t.clock(Date.parse(riding.arriveAt));
  const off = stopAt(before.leave.offCode ?? before.dest.to);
  const there = await (await t.signal(t.phone, { kind: 'location', lat: off.lat, lon: off.lon, speed: 0, acc: 20 })).json();
  assert.equal(there.dest.label, 'CS2030 @ COM1', 'on to the next class');
  const undo = there.card.actions.find((a) => a.id === 'undetected');
  assert.equal(undo?.label, 'Not right?');
  assert.equal(t.env.DB._db.prepare('SELECT COUNT(*) AS n FROM ride_times').get().n, 0, 'a tapped boarding is not measured');

  const back = await (await t.signal(t.phone, { kind: 'undetected', trip: undo.trip })).json();
  assert.equal(back.card.phase, 'riding');
  assert.equal(back.dest.label, 'GEA1000 @ UTown');
  const still = await (await t.signal(t.phone, { kind: 'location', lat: off.lat, lon: off.lon, speed: 0 })).json();
  assert.equal(still.card.phase, 'riding', 'not taken as there again');
});

test('a ride seen from start to end is measured, with no user or location in it', async () => {
  const t = await setup();
  const { plan, board } = await waitingAtStop(t);
  t.clock(board + 30_000);
  const riding = await (await t.signal(t.phone, { kind: 'location', ...onTheWay(plan), speed: 8 })).json();
  assert.equal(riding.card.phase, 'riding');
  t.clock(board + 9 * 60_000);
  const off = stopAt(plan.offCode ?? 'UTOWN');
  await t.signal(t.phone, { kind: 'location', lat: off.lat, lon: off.lon, speed: 0 });
  const rows = t.env.DB._db.prepare('SELECT * FROM ride_times').all();
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.svc, plan.svc);
  assert.equal(r.from_code, plan.stopCode);
  assert.equal(r.to_code, plan.offCode ?? 'UTOWN');
  assert.ok(r.seconds > 8 * 60 && r.seconds < 10 * 60, `${r.seconds} s`);
  assert.equal(r.hour, 9);
  assert.deepEqual(Object.keys(r).sort(), ['day', 'daytype', 'from_code', 'hops', 'hour', 'plate', 'seconds', 'svc', 'to_code']);
});

test('there for the last class: the way home is shown, but not "Time to get going" until the class ends', async () => {
  const t = await setup({ home: { stops: ['PGP'] }, manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown')] });
  await t.signal(t.phone, { kind: 'arrived', trip: FIRST });
  t.clock(FROZEN_NOW + 70 * 60_000); // 10:10, in class
  const inClass = await t.next(t.phone);
  assert.equal(inClass.dest.label, 'Home');
  assert.equal(inClass.card.phase, 'idle');
  assert.equal(inClass.card.phaseText, null);
  t.clock(FROZEN_NOW + 121 * 60_000); // 11:01, the class is over
  assert.notEqual((await t.next(t.phone)).card.phase, 'idle');
});

/* Phase 8.3: more than class trips. */

test('"Not on campus today" skips every trip left today on every device; "Back on campus" brings them back', async () => {
  const t = await setup();
  const first = await t.next(t.phone);
  const away = first.card.actions.find((a) => a.id === 'away');
  assert.equal(away.label, 'Not on campus today');
  const off = await (await t.signal(t.phone, { kind: 'away' })).json();
  assert.equal(off.label, 'Not on campus today');
  assert.equal(off.card.phase, 'idle');
  assert.deepEqual(off.card.actions.map((a) => [a.id, a.label]), [['back', 'Back on campus']]);
  assert.equal((await t.next(t.mac)).label, 'Not on campus today');
  assert.deepEqual(outcomesToday(t.env), [], 'a day away is not an outcome for any class');
  const back = await (await t.signal(t.mac, { kind: 'back' })).json();
  assert.equal(back.dest.label, 'GEA1000 @ UTown');
  assert.equal(back.card.actions.some((a) => a.id === 'back'), false);
});

test('"Not on campus today" leaves a trip already answered alone', async () => {
  const t = await setup();
  await t.signal(t.phone, { kind: 'arrived', trip: FIRST });
  await t.signal(t.phone, { kind: 'away' });
  assert.equal((await tripRec(t, FIRST)).kind, 'arrived');
  assert.equal((await tripRec(t, SECOND)).away, true);
});

test('a saved place with a usual time is a trip on that day, like a class', async () => {
  const t = await setup({
    home: { stops: ['PGP'] },
    places: [{ key: 'gym', label: 'Gym', to: 'UHALL' }],
    usual: [{ place: 'gym', day: THU, atMin: 600 }, { place: 'gone', day: THU, atMin: 660 }],
  });
  const a = await t.next(t.phone);
  assert.equal(a.dest.label, 'Gym');
  assert.equal(a.dest.why, 'class');
  assert.ok(a.leave, 'with a leave-by');
  assert.equal(a.card.actions[0].trip, `${THU}:600:UHALL`);
  // Another day: nothing.
  t.clock(FROZEN_NOW + DAY);
  assert.notEqual((await t.next(t.phone)).dest?.label, 'Gym');
});

test('a one-off trip today is planned like a class, and past ones are dropped', async () => {
  const t = await setup({ home: { stops: ['PGP'] } });
  const bad = await t.call('/me/once', { method: 'POST', token: t.phone, body: { to: 'COM3', atMin: 8 * 60 } });
  assert.equal(bad.status, 400, '08:00 has passed at 09:00');
  const res = await t.call('/me/once', { method: 'POST', token: t.phone, body: { to: 'COM3', atMin: 14 * 60, label: 'Project meeting' } });
  assert.equal(res.status, 200);
  const a = await res.json();
  assert.equal(a.dest.label, 'Project meeting');
  assert.equal(a.card.actions[0].id, 'skipped');
  const profile = await (await t.call('/me/profile', { cookie: t.cookie })).json();
  assert.deepEqual(profile.once, [{ date: sgtDate(FROZEN_NOW), arriveByMin: 840, to: 'COM3', label: 'Project meeting' }]);
  // Tomorrow it's gone from the plan, and a save drops it.
  t.clock(FROZEN_NOW + DAY);
  assert.notEqual((await t.next(t.phone)).dest?.label, 'Project meeting');
  const saved = await (await t.call('/me/profile', { method: 'PUT', cookie: t.cookie, body: profile })).json();
  assert.deepEqual(saved.once, []);
});

test('usual times and one-offs are checked like the rest of the profile', async () => {
  const t = await setup();
  const put = (body) => t.call('/me/profile', { method: 'PUT', cookie: t.cookie, body: { ...PROFILE, ...body } });
  assert.equal((await put({ usual: [{ place: 'Gym!', day: 1, atMin: 60 }] })).status, 400);
  assert.equal((await put({ usual: [{ place: 'gym', day: 9, atMin: 60 }] })).status, 400);
  assert.equal((await put({ once: [{ date: 'tomorrow', arriveByMin: 60, to: 'COM3', label: 'x' }] })).status, 400);
  assert.equal((await put({ once: [{ date: '2026-08-28', arriveByMin: 60, to: 'NOWHERE', label: 'x' }] })).status, 400);
  assert.equal((await t.call('/me/once', { method: 'POST', token: t.phone, body: { to: 'NOWHERE', atMin: 900 } })).status, 400);
  assert.equal((await t.call('/me/once', { method: 'POST', token: t.phone, body: { to: 'COM3', atMin: 900, date: '2026-12-01' } })).status, 400, 'more than a week ahead');
});

test('a one-off trip to a saved place, by its key', async () => {
  const t = await setup({ home: { stops: ['PGP'] }, places: [{ key: 'gym', label: 'Gym', to: 'UHALL' }] });
  const a = await (await t.call('/me/once', { method: 'POST', token: t.phone, body: { place: 'gym', atMin: 11 * 60 } })).json();
  assert.equal(a.dest.label, 'Gym');
  assert.equal(a.dest.to, 'UHALL');
});

test('while the phone follows the trip, nothing asks what happened; when the fixes stop, the buttons and the question come back', async () => {
  const t = await setup();
  const { board } = await waitingAtStop(t);
  const followed = await t.next(t.mac);
  assert.equal(followed.card.actions.some((a) => ['boarded', 'missed', 'arrived'].includes(a.id)), false);
  assert.ok(followed.card.actions.some((a) => a.id === 'skipped'), '"Not going" is a plan, not a status: it stays');
  t.clock(board + 20_000);
  assert.equal((await t.next(t.mac)).card.ask, null, 'the departure passes without the question (the last fix 80 s ago)');
  t.clock(board + 3 * 60_000);
  const quiet = await t.next(t.mac);
  assert.ok(quiet.card.ask, 'no fix for over a minute and a half: asked after all');
  assert.ok(quiet.card.actions.some((a) => a.id === 'boarded' || a.id === 'arrived'));
});

test('having been at the stop is not an answer: after the bus leaves, the phone without a location is assumed on it, not stuck at the stop', async () => {
  const t = await setup();
  const { board } = await waitingAtStop(t);
  t.clock(board + 4 * 60_000);
  const later = await t.next(t.mac);
  assert.equal(later.card.phase, 'riding');
  assert.ok(later.card.ask, 'and asked, since nothing followed it');
});

test('a NUSMods class ends half an hour before its timetable end: the day, "till", and the trip home go by that', async () => {
  // 10:00-12:00 from NUSMods: really out by about 11:30.
  const t = await setup({ home: { stops: ['PGP'] }, trips: [{ day: THU, arriveByMin: 600, endMin: 720, to: 'UTOWN', label: 'GEA1000 @ UTown', venue: '' }] });
  const day = await (await t.call('/me/day', { token: t.phone })).json();
  const cls = day.items.find((i) => i.kind === 'class');
  assert.equal(Date.parse(cls.endsAt), FROZEN_NOW + 150 * 60_000, 'ends 11:30');
  await t.signal(t.phone, { kind: 'arrived', trip: FIRST });
  t.clock(FROZEN_NOW + 140 * 60_000); // 11:20
  const inClass = await t.next(t.phone);
  assert.equal(inClass.card.phase, 'idle', 'the way home, but not yet time to go');
  t.clock(FROZEN_NOW + 151 * 60_000); // 11:31
  assert.notEqual((await t.next(t.phone)).card.phase, 'idle', 'out of class: the trip home is on');
});

test('a class entered by hand ends when it says', async () => {
  const t = await setup({ home: { stops: ['PGP'] }, manual: [{ ...cls(600, 'UTOWN', 'GEA1000 @ UTown'), endMin: 720 }] });
  const day = await (await t.call('/me/day', { token: t.phone })).json();
  assert.equal(Date.parse(day.items.find((i) => i.kind === 'class').endsAt), FROZEN_NOW + 180 * 60_000, 'ends 12:00');
});

test('the card says where to walk to for directions: the stop to catch the bus at, and nothing once on it', async () => {
  const t = await setup();
  const a = await t.next(t.phone);
  const stop = stopAt(a.leave.stopCode);
  assert.deepEqual(a.card.walkTo, { name: a.leave.stop, lat: stop.lat, lon: stop.lon });
  const riding = await (await t.signal(t.phone, { kind: 'boarded', trip: FIRST })).json();
  assert.equal(riding.card.walkTo, null);
});
