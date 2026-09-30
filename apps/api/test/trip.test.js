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
import { indexGraph, serviceEndsAt } from '../src/resolve.ts';
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
