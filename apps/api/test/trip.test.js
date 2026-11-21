import test from 'node:test';
import assert from 'node:assert/strict';

import { FROZEN_NOW, installGlobals, makeCtx, makeDurableObjects, makeEnv, makeFetch } from './_stubs.mjs';
import { makeD1, makeEmail } from './_d1.mjs';
import worker from '../src/index.ts';
import {
  HOME_GRACE_MS,
  TRIP_TIMEOUT_MS,
  clearTrip,
  endOfDayMs,
  loadDay,
  needsWatch,
  saveSignals,
  seenOnBus,
  sgtDate,
} from '../src/answer/trip.ts';
import { ASSUME_MS, DUE_MS, RIDE_GRACE_MS, WAIT_EARLY_MS } from '../src/answer/phase.ts';
import { Trip } from '../src/push/tripdo.ts';
import { answerWake } from '../src/answer/rider.ts';
import { answerFor, collectArrivals } from '../src/answer/answer.ts';
import { GRAPH } from '../src/answer/graph.ts';
import { indexGraph, rideStops } from '../src/answer/resolve.ts';
import { serviceEndsAt } from '../src/answer/hours.ts';
import { clockAt } from '../src/clock.ts';
import { onRide, onRideQuery, rideLength } from './_ride.mjs';
import { withoutMeasuredHeadways } from './_headways.mjs';

withoutMeasuredHeadways();

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

async function setup(profile = PROFILE, { trips = true, feed = FEED } = {}) {
  const fetchImpl = makeFetch({ byStop: feed });
  installGlobals(fetchImpl);
  const clock = (ms) => installGlobals(fetchImpl, ms);
  const TRIPS = makeDurableObjects(Trip);
  const env = { ...makeEnv(), DB: makeD1(), EMAIL: makeEmail(), EMAIL_FROM: 'x@example.test', ...(trips ? { TRIPS } : {}) };
  const call = async (path, { method = 'GET', token, cookie, body, headers: extra = {} } = {}) => {
    const headers = { ...extra };
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
  const signal = async (token, body) => call('/api/me/signal', { method: 'POST', token, body });
  return { env, call, cookie, phone, mac, next, signal, TRIPS, clock };
}

test('a class trip starts idle, with only "Not going" and "Not on campus today" to offer', async () => {
  const { phone, next } = await setup();
  const a = await next(phone);
  assert.equal(a.card.phase, 'idle');
  assert.deepEqual(
    a.card.actions.map((x) => x.id),
    ['skipped', 'away'],
  );
  assert.equal(a.card.actions[0].trip, FIRST);
});

test("times follow the account's 12- or 24-hour choice on every device, else each request's", async () => {
  const { call, cookie, phone, next } = await setup();
  const auto24 = await next(phone);
  const auto12 = await next(phone, '?h12=1');
  assert.equal(auto24.card.h12, false);
  assert.match(auto24.card.leaveBy, /\b\d{2}:\d{2}$/);
  assert.equal(auto12.card.h12, true);
  assert.match(auto12.card.leaveBy, /\d:\d{2}\s[AP]M$/);
  assert.equal((await call('/api/me/profile', { method: 'PUT', cookie, body: { ...PROFILE, clock: '12' } })).status, 200);
  const chose12 = await next(phone);
  assert.equal(chose12.card.h12, true);
  assert.equal(chose12.card.leaveBy, auto12.card.leaveBy);
  assert.equal((await call('/api/me/profile', { method: 'PUT', cookie, body: { ...PROFILE, clock: '24' } })).status, 200);
  const chose24 = await next(phone, '?h12=1');
  assert.equal(chose24.card.h12, false);
  assert.equal(chose24.card.leaveBy, auto24.card.leaveBy);
  assert.equal((await call('/api/me/profile', { method: 'PUT', cookie, body: { ...PROFILE, clock: 'am/pm' } })).status, 400);
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
  const ride = onPhone.card.ride;
  assert.equal(ride.svc, 'R2');
  assert.equal(ride.stops[0].code, before.leave.stopCode, 'the stops ridden, from where the bus was boarded');
  assert.equal(ride.stops.at(-1).code, 'UTOWN', 'to where you get off');
  assert.ok(ride.stops.length >= 2 && ride.stops.every((x) => x.name));
  assert.ok(Date.parse(ride.board) < Date.parse(ride.arrive));
  assert.deepEqual(onPhone.card.actions, [], 'nothing asks what happened next');

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
  assert.equal(
    after.card.actions.some((x) => ['boarded', 'missed', 'arrived'].includes(x.id)),
    false,
    'no buttons asking what happened',
  );
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

test('"I\'m there" before the class: you\'re there until it starts, then the plan moves on to the next one', async () => {
  const { phone, next, signal, clock } = await setup();
  const after = await (await signal(phone, { kind: 'arrived' })).json();
  assert.equal(after.label, "You're there");
  assert.equal(after.dest.label, 'GEA1000 @ UTown');
  clock(FROZEN_NOW + 65 * 60_000);
  assert.equal((await next(phone)).dest.label, 'CS2030 @ COM1');
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

const IN_LT11_88M_FROM_VENTUS = 'lat=1.29546&lon=103.7714';

test('sitting in the lecture theatre counts as there, though its stop is 90 m away, further than at the stop reaches', async () => {
  const profile = { home: { stops: ['PGP'] }, manual: [{ ...cls(600, 'LT13-OPP', 'EC1101E @ LT11'), venue: 'LT11' }] };
  const { phone, next, clock } = await setup(profile);
  clock(FROZEN_NOW + 50 * 60_000);
  const rough = await next(phone, `?${IN_LT11_88M_FROM_VENTUS}&acc=600`);
  assert.notEqual(rough.arrived, true, 'a fix 600 m out is no location');
  assert.notEqual(rough.card.phase, 'arrived');
  const there = await next(phone, `?${IN_LT11_88M_FROM_VENTUS}`);
  assert.equal(there.arrived, true);
  assert.equal(there.card.phase, 'arrived');
  assert.equal(there.dest.label, 'EC1101E @ LT11');
  assert.equal((await next(phone)).card.phase, 'arrived', 'seen there once, every device says so');
  assert.equal((await next(phone, `?to=LT11&${IN_LT11_88M_FROM_VENTUS}`)).arrived, true, 'the same place asked for by code');
});

test('/api/me/signal: needs the Durable Object, a known kind, and a trip', async () => {
  const noTrips = await setup(PROFILE, { trips: false });
  assert.equal((await noTrips.signal(noTrips.phone, { kind: 'boarded' })).status, 503);
  const { phone, signal } = await setup();
  assert.equal((await signal(phone, { kind: 'teleported' })).status, 400);
  const free = await setup({ home: { stops: ['PGP'] } });
  assert.equal((await free.signal(free.phone, { kind: 'boarded' })).status, 409, 'nothing to be on today');
});

test('/api/me/next without any classes today never wakes a Durable Object', async () => {
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
  const inst = [...TRIPS.instances.values()][0];
  await inst.storage.put('day', { date: '2026-08-26', trips: { [FIRST]: { kind: 'skipped', at: 0 } } });
  assert.equal((await next(phone)).dest.label, 'GEA1000 @ UTown', 'a signal stored for yesterday is ignored');
  clock(endOfDayMs(FROZEN_NOW));
  await TRIPS.fireAlarms();
  assert.equal(inst.storage._map.size, 0);
});

test('/api/me/day: each class with where you set off, the leave-by, and the trip home', async () => {
  const { phone, call, signal } = await setup({ ...PROFILE, gapHours: 0.5 });
  let day = await (await call('/api/me/day', { token: phone })).json();
  assert.equal(day.date, sgtDate(FROZEN_NOW));
  assert.deepEqual(
    day.items.map((i) => [i.kind, i.status]),
    [
      ['class', 'next'],
      ['home', 'later'],
      ['class', 'later'],
      ['home', 'later'],
    ],
  );
  const [first, gap, second] = day.items;
  assert.equal(first.from, 'PGP');
  assert.ok(first.leave?.at, 'a leave-by for the next class');
  assert.equal(gap.startsAt, '2026-08-27T03:00:00Z', 'home after the first class ends');
  assert.equal(second.from, 'PGP', 'back from home after a long gap');
  assert.ok(second.leave?.at, 'a leave-by hours ahead too');
  assert.equal(second.leave.estimated, second.leave.svc !== null, 'by bus hours ahead is an estimate; on foot it is exact');

  await signal(phone, { kind: 'boarded', trip: FIRST });
  day = await (await call('/api/me/day', { token: phone })).json();
  assert.equal(day.items[0].leave, undefined, 'on the bus, no leave-by that has passed');
  assert.equal(day.items[0].onBus.svc, first.leave.svc);
  assert.ok(day.items[0].onBus.off, 'where to get off');
  assert.equal(day.items[2].onBus, undefined, 'only the trip you are on');

  await signal(phone, { kind: 'skipped', trip: FIRST });
  day = await (await call('/api/me/day', { token: phone })).json();
  assert.equal(
    day.items.some((i) => i.key === FIRST),
    false,
    'taken off today: not listed',
  );
});

test('/api/me/day: says the language it is written in, which the account chooses over the device, even before an app’s switch is saved', async () => {
  const { phone, call } = await setup({ ...PROFILE, lang: 'zh' });
  const zh = await call('/api/me/day', { token: phone, headers: { 'accept-language': 'en' } });
  assert.equal(zh.headers.get('content-language'), 'zh-Hans', 'asked in English, the account says Chinese');
  assert.match((await zh.json()).items.find((i) => i.kind === 'home').title, /回家/);

  const { phone: other, call: ask } = await setup();
  const en = await ask('/api/me/day', { token: other, headers: { 'accept-language': 'zh-CN' } });
  assert.equal(en.headers.get('content-language'), 'zh-Hans', 'auto: the device decides');
  const plain = await ask('/api/me/day', { token: other });
  assert.equal(plain.headers.get('content-language'), 'en');
});

test('/api/me/day: the next class planned from where the device is, as the card plans it', async () => {
  const { phone, call, next } = await setup();
  const nearKrMrt = '?lat=1.2950&lon=103.7846';
  const located = await (await call(`/api/me/day${nearKrMrt}`, { token: phone })).json();
  const unlocated = await (await call('/api/me/day', { token: phone })).json();
  const card = await next(phone, nearKrMrt);
  assert.equal(card.leave.stop, located.items[0].leave.stop);
  assert.equal(card.leave.at, located.items[0].leave.at, 'Today says the leave-by the card does');
  assert.notEqual(unlocated.items[0].leave.stop, located.items[0].leave.stop, 'without a location, from the home stop');
  assert.deepEqual(
    located.items.at(-2).leave,
    unlocated.items.at(-2).leave,
    'only the next class: a later one is from wherever you will be',
  );
});

test('/api/me/day: anything not done yet can be taken off today, the trip home too, and put back', async () => {
  const t = await setup({ ...PROFILE, gapHours: 0.5 });
  const list = async () => (await (await t.call('/api/me/day', { token: t.phone })).json()).items;
  let items = await list();
  assert.deepEqual(
    items.map((i) => i.removable),
    [true, true, true, true],
  );
  const gap = items.find((i) => i.key.startsWith('gap-home:'));
  const home = items.find((i) => i.key.startsWith('home:'));

  await t.signal(t.phone, { kind: 'skipped', trip: gap.key });
  items = await list();
  assert.deepEqual(
    items.map((i) => i.kind),
    ['class', 'class', 'home'],
  );
  assert.equal(items[1].from, 'UTOWN', 'the gap’s trip home off: from the first class, not home');
  assert.deepEqual(outcomesToday(t.env), [], 'a trip home is not an outcome');
  t.clock(FROZEN_NOW + 90 * 60_000);
  assert.equal((await t.next(t.phone)).dest.label, 'CS2030 @ COM1', 'the next class, not home');

  await t.signal(t.phone, { kind: 'skipped', trip: home.key });
  assert.deepEqual(
    (await list()).map((i) => i.kind),
    ['class', 'class'],
  );
  t.clock(FROZEN_NOW + 5 * 60 * 60_000);
  assert.notEqual((await t.next(t.phone)).dest?.label, 'Home', 'the last trip home off: nothing after the last class');

  await t.signal(t.phone, { kind: 'reset', trip: home.key });
  assert.equal((await list()).at(-1).kind, 'home', 'undo puts it back');
});

test('/api/me/day: a one-off trip later today can be taken off before it is the next trip, and put back', async () => {
  const t = await setup();
  assert.equal(
    (await t.call('/api/me/once', { method: 'POST', token: t.phone, body: { to: 'UTOWN', atMin: 1080, label: 'Dinner' } })).status,
    200,
  );
  const list = async () => (await (await t.call('/api/me/day', { token: t.phone })).json()).items;
  const once = (await list()).find((i) => i.label === 'Dinner');
  assert.equal(once.removable, true);
  assert.notEqual((await t.next(t.phone)).dest.label, 'Dinner', 'at 18:00 after both classes, the card is about the first class');

  assert.equal((await t.signal(t.phone, { kind: 'skipped', trip: once.key })).status, 200);
  assert.equal(
    (await list()).some((i) => i.key === once.key),
    false,
    'taken off today',
  );
  assert.equal((await t.signal(t.phone, { kind: 'reset', trip: once.key })).status, 200);
  assert.equal(
    (await list()).some((i) => i.key === once.key),
    true,
    'put back',
  );
});

test('/api/me/day: what is done cannot be taken off', async () => {
  const t = await setup();
  await t.signal(t.phone, { kind: 'arrived', trip: FIRST });
  const items = (await (await t.call('/api/me/day', { token: t.phone })).json()).items;
  assert.equal(items.find((i) => i.key === FIRST).removable, false);
  assert.equal(items.find((i) => i.key === SECOND).removable, true);
});

test('/api/me/day on a free day says what is next', async () => {
  const { phone, call } = await setup({ home: { stops: ['PGP'] }, manual: [{ ...cls(600, 'COM3', 'CS2030 @ COM1'), day: 5 }] });
  const day = await (await call('/api/me/day', { token: phone })).json();
  assert.deepEqual(day.items, []);
  assert.equal(day.note, 'Next: CS2030 @ COM1, tomorrow 10:00');
});

test('on the bus only where a location shows it: on its road, further on than a walk since it left (the A2, PGP Foyer to Opp HSSML)', () => {
  const board = FROZEN_NOW;
  const a2 = {
    svc: 'A2',
    stop: 'PGP Foyer',
    stopCode: 'PGPR',
    alightCode: 'HSSML-OPP',
    board: new Date(board).toISOString(),
    arrive: new Date(board + 5 * 60_000).toISOString(),
  };
  const len = rideLength('A2', 'PGPR', 'HSSML-OPP');
  assert.ok(len > 800, 'a ride long enough to test');
  const at = (m) => onRide('A2', 'PGPR', 'HSSML-OPP', m);
  const seen = (p, ms) => seenOnBus(a2, p.lat, p.lon, board + ms);
  const pgpr = stopAt('PGPR');
  assert.equal(seen(pgpr, 3 * 60_000), false, 'still at the stop');
  assert.equal(seen(at(250), 3 * 60_000), false, 'on the road, but a walk away: may have missed it and set off on foot');
  assert.equal(seen(at(len - 100), 3 * 60_000), true, 'further on than anyone walks in 3 min');
  assert.equal(seen(at(len - 100), 8 * 60_000), false, 'but in 8 min a walk gets there too');
  const off = at(len - 100);
  assert.equal(seen({ lat: off.lat + 0.002, lon: off.lon }, 3 * 60_000), false, '200 m off the road');
  assert.equal(seenOnBus({ ...a2, paid: true }, off.lat, off.lon, board + 3 * 60_000), false, 'no road line for a public bus');
  assert.equal(seenOnBus({ ...a2, board: null }, off.lat, off.lon, board + 3 * 60_000), false);
});

test('a service with published hours ends at its window close, across midnight too', () => {
  assert.deepEqual(
    [GRAPH.serviceHours.K.weekday, GRAPH.serviceHours.K.saturday],
    [
      ['07:04', '23:04'],
      ['07:04', '19:04'],
    ],
    'the real K: later on weekdays than on Saturdays',
  );
  const thu2230 = Date.UTC(2026, 7, 27, 14, 30);
  assert.equal(serviceEndsAt(GRAPH, 'K', thu2230), Date.UTC(2026, 7, 27, 15, 4));
  assert.equal(serviceEndsAt(GRAPH, 'K', Date.UTC(2026, 7, 27, 15, 30)), null, 'not running');
  assert.equal(serviceEndsAt(GRAPH, 'K', Date.UTC(2026, 7, 29, 10, 30)), Date.UTC(2026, 7, 29, 11, 4));
  assert.equal(serviceEndsAt(GRAPH, 'K', Date.UTC(2026, 7, 29, 11, 30)), null, 'Saturday: ended at 19:04');
  const late = { ...GRAPH, serviceHours: { D2: { weekday: ['19:00', '01:00'] } } };
  assert.equal(
    serviceEndsAt(late, 'D2', thu2230),
    Date.UTC(2026, 7, 27, 17, 0),
    'no real service runs past midnight; one that did ends at 01:00 tomorrow',
  );
  assert.equal(serviceEndsAt(late, 'X', thu2230), null, 'hours unknown');
});

test('with every class today skipped, the day is free and "next" is not a skipped class', async () => {
  const { phone, signal } = await setup();
  await signal(phone, { kind: 'skipped', trip: FIRST });
  const a = await (await signal(phone, { kind: 'skipped', trip: SECOND })).json();
  assert.equal(a.mode, 'free');
  assert.equal(a.label, 'No more classes today');
  assert.doesNotMatch(a.detail, /today/, 'the same classes next week, not today’s skipped ones');
  assert.match(a.detail, /Thu 3 Sep/);
  assert.equal(a.card.actions.at(-1).id, 'reset', 'the last skip can still be undone');
});

test('nothing is asked about the bus, before or after it leaves, and with no location the card says only that it has left', async () => {
  const { phone, mac, next, signal, clock } = await setup();
  const first = await next(phone);
  const leaveAt = Date.parse(first.leave.at);

  clock(leaveAt - 60_000);
  const due = await next(phone);
  assert.equal(due.card.phase, 'due', 'due: the plan is remembered from here on');
  const board = Date.parse(due.leave.board);
  const svc = due.leave.svc;

  clock(board + 30_000);
  const left = await next(mac);
  assert.equal(
    left.card.actions.some((x) => ['boarded', 'missed', 'arrived'].includes(x.id)),
    false,
    'just after it left: nothing asked, on any device',
  );

  clock(board + 4 * 60_000);
  const unknown = await next(mac);
  assert.equal(unknown.card.phase, 'heading', 'no one said and no location: neither on it nor missed, the next way there');
  assert.match(unknown.card.line, new RegExp(`^The ${clockAt(board, false)} has left · next `));
  assert.equal(unknown.card.ride, null);
  assert.equal(
    unknown.card.actions.some((x) => ['boarded', 'missed', 'arrived'].includes(x.id)),
    false,
    'still nothing asked',
  );
  const answered = await (await signal(phone, { kind: 'boarded', trip: FIRST })).json();
  assert.equal(answered.label, `On the ${svc}`, 'an older app’s On it still works, about the bus that left');
  assert.ok(Date.parse(answered.card.ride.board) === board);
});

test('polls between the leave time and the departure keep the trip about the bus you were told to catch', async () => {
  const { phone, mac, next, clock } = await setup();
  const first = await next(phone);
  const leaveAt = Date.parse(first.leave.at);
  clock(leaveAt - 60_000);
  const due = await next(phone);
  const board = Date.parse(due.leave.board);
  const svc = due.leave.svc;

  clock(leaveAt + 60_000);
  const later = await next(phone);
  assert.equal(later.leave.board, due.leave.board, 'still the bus you were told to catch');
  assert.equal(later.leave.svc, svc);
  const blind = await next(mac);
  assert.equal(blind.leave.board, due.leave.board, 'without a location, the same bus');
  clock(board - 10_000);
  await next(phone);

  clock(board + 4 * 60_000);
  await next(phone, onRideQuery(svc, due.leave.stopCode, 'UTOWN', rideLength(svc, due.leave.stopCode, 'UTOWN') - 300));
  const assumed = await next(mac);
  assert.equal(assumed.label, `On the ${svc}`, 'the phone seen on its road: on that bus, on the Mac too');
  assert.equal(Date.parse(assumed.card.ride.board), board);
});

test('the widget, planning without a location, says the bus the phone planned from where you are', async () => {
  const { phone, next, clock } = await setup(PROFILE, { feed: { ...FEED, 'UHC-OPP': FEED.PGP } });
  const NEAR_UHC_OPP = '?lat=1.2966&lon=103.7764';
  const first = await next(phone, NEAR_UHC_OPP);
  clock(Date.parse(first.leave.at) - 60_000);
  const due = await next(phone, NEAR_UHC_OPP);
  const board = Date.parse(due.leave.board);
  const svc = due.leave.svc;
  const blind = await next(phone);
  assert.equal(blind.leave.board, due.leave.board, "the phone's bus");
  assert.equal(blind.leave.svc, svc);
  assert.equal(blind.card.catch, due.card.catch);

  clock(board + 4 * 60_000);
  const gone = await next(phone);
  assert.match(
    gone.card.line,
    new RegExp(`^The ${clockAt(board, false)} has left · next `),
    'once it left, the widget still goes by the phone’s bus',
  );
});

test('on the bus only when a location sees it: on its road, further on than a walk', async () => {
  const { env, phone, mac, next, clock } = await setup();
  const first = await next(phone);
  clock(Date.parse(first.leave.at) - 60_000);
  const due = await next(phone);
  const board = Date.parse(due.leave.board);
  const svc = due.leave.svc;
  const from = due.leave.stopCode;

  clock(board + 2 * 60_000);
  assert.notEqual((await next(phone)).card.phase, 'riding', 'not straight away');

  clock(board + 4 * 60_000);
  assert.equal((await next(phone)).card.phase, 'heading', 'no location: not known');
  assert.equal((await next(phone, onRideQuery(svc, from, 'UTOWN', 250))).card.phase, 'heading', 'a walk along the road: not known');
  assert.equal((await next(mac)).card.phase, 'heading', 'and nothing noted for the Mac');
  const seen = await next(phone, onRideQuery(svc, from, 'UTOWN', rideLength(svc, from, 'UTOWN') - 300));
  assert.equal(seen.card.phase, 'riding');
  assert.equal(seen.label, `On the ${svc}`);
  assert.match(seen.card.line, new RegExp(`^On the ${svc}`));
  const onMac = await next(mac);
  assert.equal(onMac.card.phase, 'riding', 'noted on the plan: the Mac, with no location, follows');
  assert.equal(Date.parse(onMac.card.ride.board), board);
  assert.deepEqual(outcomesToday(env), [], 'seen, not said: no outcome');
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

test('"On it" reads the arrival from the feed: the same plate (PX1) at PGP and, 9 minutes later, UTown', async () => {
  const feed = {};
  for (const code of Object.keys(FEED))
    feed[code] = [{ name: 'R2', arrivalTime: '15', nextArrivalTime: '25', passengers: 'low', arrivalTime_veh_plate: 'PZ9' }];
  feed.PGP = [
    {
      name: 'R2',
      arrivalTime: '1',
      nextArrivalTime: '11',
      passengers: 'low',
      arrivalTime_veh_plate: 'PX1',
      nextArrivalTime_veh_plate: 'PX2',
    },
  ];
  feed.UTOWN = [
    {
      name: 'R2',
      arrivalTime: '9',
      nextArrivalTime: '19',
      passengers: 'low',
      arrivalTime_veh_plate: 'PX1',
      nextArrivalTime_veh_plate: 'PX2',
    },
  ];
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

test('once the arrival has passed, the card never says you arrive in the past: the next bus of the service is the guess', async () => {
  const { phone, next, signal, clock } = await setup();
  const riding = await (await signal(phone, { kind: 'boarded', trip: FIRST })).json();
  const arrive = Date.parse(riding.arriveAt);
  clock(arrive + 60_000);
  const later = await next(phone);
  assert.equal(later.card.phase, 'riding');
  assert.equal(later.label, riding.label);
  assert.ok(Date.parse(later.arriveAt) > arrive + 60_000, `${later.arriveAt} is after now`);
  assert.equal(later.quality, 'scheduled');
  assert.match(later.detail, /arrive ~/);
  assert.doesNotMatch(later.detail, new RegExp(clockAt(arrive)));
  assert.ok(later.timing && Date.parse(later.timing.reachAt) > arrive, 'the timing follows the new estimate');
  clock(arrive + RIDE_GRACE_MS);
  assert.equal((await next(phone)).card.phase, 'arrived', 'RIDE_GRACE_MS on with nothing from the phone: there');
});

test('once the arrival has passed and no bus is due, the card says only where to get off', async () => {
  const feed = {};
  for (const code of Object.keys(FEED)) feed[code] = [{ name: 'D2', arrivalTime: '4', nextArrivalTime: '14', passengers: 'low' }];
  feed.PGP = [{ name: 'R2', arrivalTime: '2', nextArrivalTime: '-', passengers: 'low' }];
  const { phone, next, signal, clock } = await setup(PROFILE, { feed });
  const riding = await (await signal(phone, { kind: 'boarded', trip: FIRST })).json();
  assert.equal(riding.label, 'On the R2');
  clock(Date.parse(riding.arriveAt) + 60_000);
  const later = await next(phone);
  assert.equal(later.card.phase, 'riding');
  assert.equal(later.label, 'On the R2');
  assert.equal(later.arriveAt, undefined);
  assert.equal(later.timing, null);
  assert.match(later.detail, /^Off at UTown$/);
});

test('a trip home taken to be riding wakes the Trip object when its bus arrives, with no later bus due', async () => {
  const feed = { UTOWN: [{ name: 'D2', arrivalTime: '4', nextArrivalTime: '14', passengers: 'low' }] };
  feed.PGP = [{ name: 'R2', arrivalTime: '2', nextArrivalTime: '12', passengers: 'low' }];
  const profile = { home: { stops: ['PGP'] }, manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown')] };
  const { env, phone, next, TRIPS, clock } = await setup(profile, { feed });
  clock(FROZEN_NOW + 125 * 60_000);
  const due = await next(phone);
  assert.equal(due.card.phase, 'due');
  const key = 'home:660';
  const trip = TRIPS.get([...TRIPS.instances.keys()][0]);
  const dayOf = async () => (await trip.fetch(`https://trip/day?date=${sgtDate(Date.now())}`)).json();
  const before = await dayOf();
  const plan = before.plans?.[key];
  assert.equal(plan?.svc, 'D2');
  const seen = { ...plan, seen: true };
  await trip.fetch('https://trip/update', {
    method: 'POST',
    body: JSON.stringify({
      date: sgtDate(Date.now()),
      plans: { [key]: seen },
      basis: { [key]: before.revs?.[key] ?? 0 },
      deleteAt: endOfDayMs(Date.now()),
    }),
  });
  const arrive = Date.parse(plan.arrive);
  clock(arrive + 60_000);

  const card = await answerWake(env, makeCtx(), { answerFor, collectArrivals }, userOf(env), await dayOf(), Date.now(), {
    savePlan: async () => {},
  });
  assert.equal(card.key, key);
  assert.equal(card.answer.card.phase, 'riding');
  assert.equal(card.answer.arriveAt, undefined, 'no later bus to guess with');
  assert.equal(card.wakeAt, arrive + RIDE_GRACE_MS, 'the ride is over RIDE_GRACE_MS after the arrival it passed');
});

async function wakeCard(env, TRIPS) {
  const trip = TRIPS.get([...TRIPS.instances.keys()][0]);
  const day = await (await trip.fetch(`https://trip/day?date=${sgtDate(Date.now())}`)).json();
  return answerWake(env, makeCtx(), { answerFor, collectArrivals }, userOf(env), day, Date.now(), { savePlan: async () => {} });
}

test('heading for the bus, the Trip object next wakes when the bus is taken to have gone, not as it leaves', async () => {
  const { env, phone, next, TRIPS, clock } = await setup();
  const first = await next(phone);
  clock(Date.parse(first.leave.at) - 60_000);
  const due = await next(phone);
  const board = Date.parse(due.leave.board);
  clock(Date.parse(due.leave.at) + 30_000);
  assert.ok(Date.now() < board);
  const card = await wakeCard(env, TRIPS);
  assert.equal(card.answer.card.phase, 'heading');
  assert.equal(card.wakeAt, board + ASSUME_MS, 'ASSUME_MS after the bus leaves the card says it has gone');
});

test('after "Missed it", the Trip object next wakes when the class\'s trip is over, not at each later bus', async () => {
  const { env, phone, next, signal, TRIPS } = await setup();
  await next(phone);
  const missed = await (await signal(phone, { kind: 'missed', trip: FIRST })).json();
  assert.equal(missed.card.phase, 'missed');
  const card = await wakeCard(env, TRIPS);
  assert.equal(card.answer.card.phase, 'missed');
  assert.equal(card.wakeAt, Date.parse('2026-08-27T10:15:00+08:00'), 'LATE_GRACE_MIN after the 10:00 start, the trip moves on');
});

test('there early for a class, the Trip object still wakes when the plan moves on, for the trip after it', async () => {
  const { env, phone, next, signal, TRIPS, clock } = await setup();
  await next(phone);
  await signal(phone, { kind: 'arrived', trip: FIRST });
  const there = await wakeCard(env, TRIPS);
  assert.equal(there.key, FIRST);
  assert.equal(there.answer.card.phase, 'arrived');
  assert.equal(there.wakeAt, Date.parse('2026-08-27T10:00:00+08:00'), 'when GEA1000 starts');
  clock(there.wakeAt);
  assert.equal((await wakeCard(env, TRIPS)).key, SECOND);
});

test('at the stop well before the leave-by, the card says when it turns to waiting there; the Trip object, with no location, does not', async () => {
  const { env, phone, next, TRIPS, clock } = await setup();
  const first = await next(phone);
  clock(Date.parse(first.leave.at) - 18 * 60_000);
  const s = stopAt(first.leave.stopCode);
  const there = await next(phone, `?lat=${s.lat}&lon=${s.lon}`);
  const leaveAt = Date.parse(there.leave.at);
  assert.equal(there.card.phase, 'idle');
  assert.ok(leaveAt - WAIT_EARLY_MS > Date.now());
  assert.equal(Date.parse(there.card.nextChangeAt), leaveAt - WAIT_EARLY_MS);
  const card = await wakeCard(env, TRIPS);
  assert.equal(card.wakeAt, Date.parse(card.answer.leave.at) - DUE_MS, 'without a location: when it is due');
});

const DAY = 86_400_000;
const userOf = (env) => env.DB._db.prepare('SELECT id FROM users WHERE email IS NOT NULL').get().id;
function seed(env, key, daysAgo, outcome) {
  const at = FROZEN_NOW - daysAgo * DAY;
  env.DB._db
    .prepare('INSERT INTO trip_outcomes (user_id, trip_key, day, outcome, at) VALUES (?, ?, ?, ?, ?)')
    .run(userOf(env), key, sgtDate(at), outcome, at);
}
const outcomesToday = (env) =>
  env.DB._db.prepare('SELECT trip_key AS trip, outcome FROM trip_outcomes WHERE day = ?').all(sgtDate(FROZEN_NOW));

test('each answer is kept as the trip\'s outcome for today, and "Undo" forgets it', async () => {
  const { env, phone, signal } = await setup();
  await signal(phone, { kind: 'skipped', trip: FIRST });
  assert.deepEqual(
    outcomesToday(env).map((r) => ({ ...r })),
    [{ trip: FIRST, outcome: 'skipped' }],
  );
  await signal(phone, { kind: 'reset', trip: FIRST });
  assert.equal(outcomesToday(env).length, 0);
  await signal(phone, { kind: 'missed' });
  assert.deepEqual(
    outcomesToday(env).map((r) => ({ ...r })),
    [{ trip: FIRST, outcome: 'missed' }],
  );
});

test('silence is not an outcome: nothing was asked, so nothing is noted', async () => {
  const { env, phone, next, clock } = await setup();
  const first = await next(phone);
  clock(Date.parse(first.leave.at) - 60_000);
  const due = await next(phone);
  clock(Date.parse(due.leave.board) + 4 * 60_000);
  assert.equal((await next(phone)).card.phase, 'heading');
  await next(phone);
  assert.deepEqual(outcomesToday(env), []);
});

test('old "no answer" rows change nothing, and the old question routes are gone', async () => {
  const { env, call, phone, next } = await setup();
  for (let d = 1; d <= 5; d++) seed(env, `${d}:600:UTOWN`, d, 'none');
  const a = await next(phone);
  assert.equal('ask' in a.card || 'askMuted' in a.card, false);
  assert.equal('askMuted' in (await (await call('/api/me/choices', { token: phone })).json()), false);
  assert.equal((await call('/api/me/ask', { method: 'POST', token: phone })).status, 404);
});

test('clearing the trip history forgets the outcomes and drops the suggestion, but keeps choices', async () => {
  const { env, call, phone, next } = await setup();
  for (let d = 1; d <= 5; d++) seed(env, `${d}:600:UTOWN`, d, 'none');
  for (const d of [7, 14, 21]) seed(env, FIRST, d, 'missed');
  await call('/api/me/choice', { method: 'POST', token: phone, body: { trip: SECOND, pref: 'quiet', choice: 'accept' } });
  let r = await (await call('/api/me/choices', { token: phone })).json();
  assert.equal(r.history, 8);

  const res = await call('/api/me/history', { method: 'DELETE', token: phone });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, cleared: 8 });
  r = await (await call('/api/me/choices', { token: phone })).json();
  assert.equal(r.history, 0);
  assert.deepEqual(
    r.choices.map((c) => [c.trip, c.pref]),
    [[SECOND, 'quiet']],
    'choices stay',
  );
  const a = await next(phone);
  assert.equal(a.card.suggestion, null);
  assert.equal((await call('/api/me/history', { method: 'DELETE' })).status, 401);
});

test('three misses of a class in a month suggest a bus earlier; accepting it moves the leave-by, undoing it moves it back', async () => {
  const { env, call, phone, next } = await setup();
  for (const d of [7, 14, 21]) seed(env, FIRST, d, 'missed');
  const before = await next(phone);
  assert.equal(before.card.suggestion.id, `earlier:${FIRST}`);
  assert.match(before.card.suggestion.text, /missed the bus to GEA1000 @ UTown 3 times this month/);

  const res = await call('/api/me/choice', { method: 'POST', token: phone, body: { id: before.card.suggestion.id, choice: 'accept' } });
  assert.equal(res.status, 200);
  assert.deepEqual(
    (await res.json()).choices.map((c) => [c.trip, c.pref, c.label]),
    [[FIRST, 'earlier', 'GEA1000 @ UTown']],
  );
  const after = await next(phone);
  assert.equal(after.card.suggestion, null);
  assert.ok(Date.parse(after.leave.at) < Date.parse(before.leave.at), 'a bus earlier');
  assert.equal(after.leave.note, 'One bus earlier, as you chose for this class');

  await call('/api/me/choice', { method: 'POST', token: phone, body: { trip: FIRST, pref: 'earlier', choice: 'undo' } });
  assert.equal((await next(phone)).leave.at, before.leave.at);
});

test('"Not going" three weeks running offers to stop reminders; accepting turns them off for that class only', async () => {
  const { env, call, phone, next, signal } = await setup();
  for (const d of [7, 14, 21]) seed(env, FIRST, d, 'skipped');
  const before = await next(phone);
  assert.equal(before.card.suggestion.id, `quiet:${FIRST}`);
  assert.equal(before.card.remind, true);
  await call('/api/me/choice', { method: 'POST', token: phone, body: { id: before.card.suggestion.id, choice: 'accept' } });
  const after = await next(phone);
  assert.equal(after.card.remind, false);
  assert.equal(after.dest.label, 'GEA1000 @ UTown', 'the class is still planned');
  const second = await (await signal(phone, { kind: 'skipped', trip: FIRST })).json();
  assert.equal(second.dest.label, 'CS2030 @ COM1');
  assert.equal(second.card.remind, true, 'the next class still reminds');
});

test('a suggestion turned down is not offered again, and never during a trip', async () => {
  const { env, call, phone, next, clock } = await setup();
  for (const d of [7, 14, 21]) seed(env, FIRST, d, 'missed');
  const first = await next(phone);
  clock(Date.parse(first.leave.at) - 60_000);
  assert.equal((await next(phone)).card.suggestion, null, 'not while the trip is due');
  clock(FROZEN_NOW);
  await call('/api/me/choice', { method: 'POST', token: phone, body: { id: `earlier:${FIRST}`, choice: 'dismiss' } });
  assert.equal((await next(phone)).card.suggestion, null);
});

test('how a trip went keeps the day it happened, never the time', async () => {
  const { env, phone, signal } = await setup();
  await signal(phone, { kind: 'missed' });
  const { at, day } = env.DB._db.prepare('SELECT at, day FROM trip_outcomes').get();
  assert.equal(day, sgtDate(FROZEN_NOW));
  assert.equal(at, endOfDayMs(FROZEN_NOW) - 86_400_000, 'the start of that day in Singapore');
  assert.equal(sgtDate(at), day);
});

test('migration 0012 rounds the trip history already kept to the start of its day', async () => {
  const { readFileSync } = await import('node:fs');
  const db = makeD1();
  db.exec(`INSERT INTO users (id, email, created, last_seen) VALUES ('u', NULL, 0, 0)`);
  const sgt235959 = Date.parse('2026-10-01T15:59:59Z');
  const sgt000001 = Date.parse('2026-10-01T16:00:01Z');
  db.exec(
    `INSERT INTO trip_outcomes (user_id, trip_key, day, outcome, at) VALUES ('u', 'a', '2026-10-01', 'missed', ${sgt235959}), ('u', 'b', '2026-10-02', 'missed', ${sgt000001})`,
  );
  db.exec(readFileSync(new URL('../migrations/0012_trip_outcome_days.sql', import.meta.url), 'utf8'));
  const rows = db._db.prepare('SELECT trip_key, day, at FROM trip_outcomes ORDER BY trip_key').all();
  assert.deepEqual(
    rows.map((r) => [r.trip_key, r.at]),
    [
      ['a', Date.parse('2026-09-30T16:00:00Z')],
      ['b', Date.parse('2026-10-01T16:00:00Z')],
    ],
  );
  assert.ok(
    rows.every((r) => sgtDate(r.at) === r.day),
    'each still on its own day',
  );
});

test('trip outcomes are in the export and go with the account', async () => {
  const { env, call, cookie, phone, signal } = await setup();
  await signal(phone, { kind: 'missed' });
  const exported = await (await call('/api/me/export', { cookie })).json();
  assert.deepEqual(
    exported.tripOutcomes.map((o) => [o.trip, o.outcome]),
    [[FIRST, 'missed']],
  );
  assert.equal(exported.today.trips[FIRST].kind, 'missed', "today's trip, from the Trip object");
  assert.equal((await call('/api/me', { method: 'DELETE', cookie })).status, 200);
  assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM trip_outcomes').get().n, 0);
});

test("a deleted account's trip state goes at once, and a request still under way can't store it again", async () => {
  const { env, call, cookie, phone, signal, TRIPS, clock } = await setup();
  await signal(phone, { kind: 'missed' });
  const userId = env.DB._db.prepare('SELECT id FROM users').get().id;
  const inst = TRIPS.instances.get(userId);
  assert.ok(inst.storage._map.has('day'));

  assert.equal((await call('/api/me', { method: 'DELETE', cookie })).status, 200);
  const obj = TRIPS.get(TRIPS.idFromName(userId));
  const post = (path, body) =>
    obj.fetch(`https://trip/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const date = sgtDate(FROZEN_NOW);
  const deleteAt = endOfDayMs(FROZEN_NOW);
  assert.ok(
    (await post('update', { date, items: [{ key: FIRST, rec: { kind: 'skipped', at: FROZEN_NOW } }], deleteAt })).ok,
    'what a /api/me/next that read the account just before it went would still send',
  );
  assert.ok(
    (
      await post('update', {
        date,
        plans: { [FIRST]: { svc: 'D2', stop: 'PGP', board: null, arrive: null } },
        basis: { [FIRST]: 0 },
        deleteAt,
      })
    ).ok,
  );
  assert.ok((await post('update', { date, watch: { userId, at: FROZEN_NOW + 60_000 }, deleteAt })).ok);
  assert.equal(await (await obj.fetch(`https://trip/day?date=${date}`)).json(), null);
  assert.deepEqual([...inst.storage._map.keys()].sort(), ['deleteAt', 'gone'], 'only the mark is kept');
  assert.equal(TRIPS.alarms.get(userId), deleteAt, 'until midnight');

  clock(deleteAt);
  await TRIPS.fireAlarms();
  assert.equal(inst.storage._map.size, 0, 'and the mark goes then too');
});

test("the cron's deletion of an idle anonymous account takes its trip state too", async () => {
  const { housekeeping } = await import('../src/ops/monitor.ts');
  const { ACCOUNT_TTL } = await import('../src/accounts/accounts.ts');
  const { env, TRIPS } = await setup();
  const post = (id, path, body) =>
    TRIPS.get(TRIPS.idFromName(id)).fetch(`https://trip/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  env.DB._db.exec(`INSERT INTO users (id, email, created, last_seen) VALUES ('idle', NULL, 0, 0), ('used', NULL, 0, ${FROZEN_NOW})`);
  for (const id of ['idle', 'used'])
    await post(id, 'update', {
      date: sgtDate(FROZEN_NOW),
      watch: { userId: id, at: FROZEN_NOW + 60_000 },
      deleteAt: endOfDayMs(FROZEN_NOW),
    });
  await housekeeping(env.DB, FROZEN_NOW + ACCOUNT_TTL.anonIdleMs - 1000, true, env);
  assert.deepEqual(
    env.DB._db
      .prepare("SELECT id FROM users WHERE id IN ('idle', 'used')")
      .all()
      .map((r) => r.id),
    ['used'],
  );
  assert.equal(TRIPS.instances.get('idle').storage._map.has('userId'), false, 'the idle account’s is emptied');
  assert.equal(TRIPS.instances.get('used').storage._map.get('userId'), 'used', 'the other is untouched');
});

const stopAt = (code) => indexGraph(GRAPH).byCode.get(code);
async function waitingAtStop(t) {
  const first = await t.next(t.phone);
  t.clock(Date.parse(first.leave.at) - 60_000);
  const due = await t.next(t.phone);
  const plan = due.leave;
  t.clock(Date.parse(plan.board) - 60_000);
  const s = stopAt(plan.stopCode);
  const waiting = await t.next(t.phone, `?lat=${s.lat}&lon=${s.lon}`);
  return { plan, waiting, board: Date.parse(plan.board) };
}
const tripRec = async (t, key = FIRST) => {
  const res = await t.TRIPS.get(t.TRIPS.idFromName(userOf(t.env))).fetch(`https://trip/day?date=${sgtDate(FROZEN_NOW)}`);
  return (await res.json())?.trips?.[key];
};

test('a location from an older app records nothing: it is answered like /me/next from there', async () => {
  const t = await setup();
  const { plan, waiting } = await waitingAtStop(t);
  assert.equal(waiting.card.phase, 'waiting');
  const s = stopAt(plan.stopCode);
  const res = await t.signal(t.phone, { kind: 'location', lat: s.lat, lon: s.lon, speed: 0, acc: 10 });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).card.phase, 'waiting', 'from where it said');
  t.clock(Date.parse(plan.board) + 30_000);
  await t.signal(t.phone, { kind: 'location', lat: s.lat + 0.001, lon: s.lon, speed: 8, acc: 10 });
  assert.equal(await tripRec(t), undefined, 'moving fast along the road: still nothing recorded');
});

test('there for the last class: the way home to PGPR is shown, but not "Time to get going" until the class ends', async () => {
  const t = await setup({ home: { stops: ['PGPR'] }, manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown')] });
  await t.signal(t.phone, { kind: 'arrived', trip: FIRST });
  t.clock(FROZEN_NOW + 70 * 60_000);
  const inClass = await t.next(t.phone);
  assert.equal(inClass.dest.label, 'Home');
  assert.equal(inClass.card.phase, 'idle');
  assert.equal(inClass.card.phaseText, null);
  t.clock(FROZEN_NOW + 121 * 60_000);
  assert.notEqual((await t.next(t.phone)).card.phase, 'idle');
});

test('after the last class, with no location, the trip home is over once its bus has had time to get you home, and the Trip object wakes then', async () => {
  const t = await setup({ home: { stops: ['PGPR'] }, manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown')] });
  await t.signal(t.phone, { kind: 'arrived', trip: FIRST });
  t.clock(FROZEN_NOW + 121 * 60_000);
  const first = await t.next(t.phone);
  t.clock(Date.parse(first.leave.at) - 60_000);
  const due = await t.next(t.phone);
  assert.equal(due.card.phase, 'due');
  t.clock(Date.parse(due.leave.board) + ASSUME_MS + 60_000);
  const gone = await wakeCard(t.env, t.TRIPS);
  assert.equal(gone.key, 'home:660');
  assert.equal(gone.answer.card.gone, true, 'its bus gone, and nothing says whether you are on it');
  const trip = t.TRIPS.get([...t.TRIPS.instances.keys()][0]);
  const plan = (await (await trip.fetch(`https://trip/day?date=${sgtDate(Date.now())}`)).json()).plans['home:660'];
  const home = Date.parse(plan.arrive) + HOME_GRACE_MS;
  assert.equal(gone.wakeAt, home);
  t.clock(home);
  assert.equal((await wakeCard(t.env, t.TRIPS)).key, null, 'home by now');
});

test('a trip home whose bus has gone: the Trip object wakes when the day rests (18:45), if that comes before it would be home', async () => {
  const t = await setup({ home: { stops: ['PGPR'] }, manual: [cls(1020, 'UTOWN', 'GEA1000 @ UTown')] });
  await t.signal(t.phone, { kind: 'arrived', trip: `${THU}:1020:UTOWN` });
  t.clock(FROZEN_NOW + 9.5 * 3_600_000);
  const due = await t.next(t.phone);
  assert.equal(due.card.phase, 'due');
  t.clock(Date.parse(due.leave.board) + ASSUME_MS + 60_000);
  const gone = await wakeCard(t.env, t.TRIPS);
  assert.equal(gone.key, 'home:1080');
  assert.equal(gone.answer.card.gone, true);
  const rests = Date.parse(gone.answer.refreshAt);
  assert.equal(gone.wakeAt, rests, 'the trip ends as the day rests: the wake pushes it then');
  t.clock(rests);
  assert.equal((await wakeCard(t.env, t.TRIPS)).key, null, 'resting: no trip');
});

test('in the last class, the Trip object wakes as it ends, to say it is time to go home', async () => {
  const t = await setup({ home: { stops: ['PGPR'] }, manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown')] });
  await t.signal(t.phone, { kind: 'arrived', trip: FIRST });
  t.clock(FROZEN_NOW + 70 * 60_000);
  const card = await wakeCard(t.env, t.TRIPS);
  assert.equal(card.key, 'home:660');
  assert.equal(card.answer.card.phase, 'idle');
  assert.equal(card.wakeAt, FROZEN_NOW + 120 * 60_000, '11:00, when the class ends');
});

test('"Not on campus today" skips every trip left today on every device; "Back on campus" brings them back', async () => {
  const t = await setup();
  const first = await t.next(t.phone);
  const away = first.card.actions.find((a) => a.id === 'away');
  assert.equal(away.label, 'Not on campus today');
  const saves = [];
  const get = t.TRIPS.get.bind(t.TRIPS);
  t.TRIPS.get = (id) => {
    const stub = get(id);
    return { ...stub, fetch: (url, init) => (String(url).endsWith('/update') && saves.push(url), stub.fetch(url, init)) };
  };
  const off = await (await t.signal(t.phone, { kind: 'away' })).json();
  assert.equal(saves.length, 1, 'both classes skipped in one call to the Trip object');
  assert.equal(off.label, 'Not on campus today');
  assert.equal(off.card.phase, 'idle');
  assert.deepEqual(
    off.card.actions.map((a) => [a.id, a.label]),
    [['back', 'Back on campus']],
  );
  assert.equal((await t.next(t.mac)).label, 'Not on campus today');
  assert.deepEqual(outcomesToday(t.env), [], 'a day away is not an outcome for any class');
  const back = await (await t.signal(t.mac, { kind: 'back' })).json();
  assert.equal(back.dest.label, 'GEA1000 @ UTown');
  assert.equal(
    back.card.actions.some((a) => a.id === 'back'),
    false,
  );
});

test('"Not on campus today" leaves a trip already answered alone', async () => {
  const t = await setup();
  await t.signal(t.phone, { kind: 'arrived', trip: FIRST });
  await t.signal(t.phone, { kind: 'away' });
  assert.equal((await tripRec(t, FIRST)).kind, 'arrived');
  assert.equal((await tripRec(t, SECOND)).away, true);
});

test('a favourite with a usual time is a trip on that day, like a class', async () => {
  const t = await setup({
    home: { stops: ['PGP'] },
    places: [{ key: 'gym', label: 'Gym', to: 'UHALL' }],
    usual: [
      { place: 'gym', day: THU, atMin: 600 },
      { place: 'gone', day: THU, atMin: 660 },
    ],
  });
  const a = await t.next(t.phone);
  assert.equal(a.dest.label, 'Gym');
  assert.equal(a.dest.why, 'class');
  assert.ok(a.leave, 'with a leave-by');
  assert.equal(a.card.actions[0].trip, `${THU}:600:UHALL`);
  t.clock(FROZEN_NOW + DAY);
  assert.notEqual((await t.next(t.phone)).dest?.label, 'Gym', 'another day: nothing');
});

test('a one-off trip today is planned like a class, and past ones are dropped', async () => {
  const t = await setup({ home: { stops: ['PGP'] } });
  const bad = await t.call('/api/me/once', { method: 'POST', token: t.phone, body: { to: 'COM3', atMin: 8 * 60 } });
  assert.equal(bad.status, 400, '08:00 has passed at 09:00');
  const res = await t.call('/api/me/once', {
    method: 'POST',
    token: t.phone,
    body: { to: 'COM3', atMin: 14 * 60, label: 'Project meeting' },
  });
  assert.equal(res.status, 200);
  const a = await res.json();
  assert.equal(a.dest.label, 'Project meeting');
  assert.equal(a.card.actions[0].id, 'skipped');
  const profile = await (await t.call('/api/me/profile', { cookie: t.cookie })).json();
  assert.deepEqual(profile.once, [{ date: sgtDate(FROZEN_NOW), arriveByMin: 840, to: 'COM3', label: 'Project meeting' }]);
  t.clock(FROZEN_NOW + DAY);
  assert.notEqual((await t.next(t.phone)).dest?.label, 'Project meeting', 'tomorrow it is gone from the plan');
  const saved = await (await t.call('/api/me/profile', { method: 'PUT', cookie: t.cookie, body: profile })).json();
  assert.deepEqual(saved.once, [], 'and a save drops it');
});

test('usual times and one-offs are checked like the rest of the profile', async () => {
  const t = await setup();
  const put = (body) => t.call('/api/me/profile', { method: 'PUT', cookie: t.cookie, body: { ...PROFILE, ...body } });
  assert.equal((await put({ usual: [{ place: 'Gym!', day: 1, atMin: 60 }] })).status, 400);
  assert.equal((await put({ usual: [{ place: 'gym', day: 9, atMin: 60 }] })).status, 400);
  assert.equal((await put({ once: [{ date: 'tomorrow', arriveByMin: 60, to: 'COM3', label: 'x' }] })).status, 400);
  assert.equal((await put({ once: [{ date: '2026-08-28', arriveByMin: 60, to: 'NOWHERE', label: 'x' }] })).status, 400);
  assert.equal((await t.call('/api/me/once', { method: 'POST', token: t.phone, body: { to: 'NOWHERE', atMin: 900 } })).status, 400);
  assert.equal(
    (await t.call('/api/me/once', { method: 'POST', token: t.phone, body: { to: 'COM3', atMin: 900, date: '2026-12-01' } })).status,
    400,
    'more than a week ahead',
  );
});

test('a one-off trip to a favourite, by its key', async () => {
  const t = await setup({ home: { stops: ['PGP'] }, places: [{ key: 'gym', label: 'Gym', to: 'UHALL' }] });
  const a = await (await t.call('/api/me/once', { method: 'POST', token: t.phone, body: { place: 'gym', atMin: 11 * 60 } })).json();
  assert.equal(a.dest.label, 'Gym');
  assert.equal(a.dest.to, 'UHALL');
});

test('nothing asks what happened: no question, no buttons for it', async () => {
  const t = await setup();
  const { board } = await waitingAtStop(t);
  const at = await t.next(t.mac);
  assert.equal(
    at.card.actions.some((a) => ['boarded', 'missed', 'arrived'].includes(a.id)),
    false,
  );
  assert.ok(
    at.card.actions.some((a) => a.id === 'skipped'),
    '"Not going" is a plan, not a status: it stays',
  );
  t.clock(board + 3 * 60_000);
  const quiet = await t.next(t.mac);
  assert.equal(
    quiet.card.actions.some((a) => ['boarded', 'missed', 'arrived'].includes(a.id)),
    false,
  );
});

test('having been at the stop is not an answer: after the bus leaves, the Mac without a location is neither stuck at the stop nor on the bus', async () => {
  const t = await setup();
  const { board } = await waitingAtStop(t);
  t.clock(board + 4 * 60_000);
  const later = await t.next(t.mac);
  assert.equal(later.card.phase, 'heading');
  assert.match(later.card.line, / has left · next /);
});

test('a NUSMods class ends half an hour before its timetable end: the day, "till", and the trip home go by that', async () => {
  const t = await setup({
    home: { stops: ['PGPR'] },
    trips: [{ day: THU, arriveByMin: 600, endMin: 720, to: 'UTOWN', label: 'GEA1000 @ UTown', venue: '' }],
  });
  const day = await (await t.call('/api/me/day', { token: t.phone })).json();
  const cls = day.items.find((i) => i.kind === 'class');
  assert.equal(Date.parse(cls.endsAt), FROZEN_NOW + 150 * 60_000, 'ends 11:30');
  await t.signal(t.phone, { kind: 'arrived', trip: FIRST });
  t.clock(FROZEN_NOW + 140 * 60_000);
  const inClass = await t.next(t.phone);
  assert.equal(inClass.card.phase, 'idle', 'the way home, but not yet time to go');
  t.clock(FROZEN_NOW + 151 * 60_000);
  assert.notEqual((await t.next(t.phone)).card.phase, 'idle', 'out of class: the trip home is on');
});

test('a class entered by hand ends when it says', async () => {
  const t = await setup({ home: { stops: ['PGP'] }, manual: [{ ...cls(600, 'UTOWN', 'GEA1000 @ UTown'), endMin: 720 }] });
  const day = await (await t.call('/api/me/day', { token: t.phone })).json();
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

const MIDDAY = {
  home: { stops: ['PGP'] },
  trips: [
    { day: THU, arriveByMin: 480, endMin: 600, to: 'LT27', label: 'MA1100 @ LT21', venue: '' },
    { day: THU, arriveByMin: 720, endMin: 840, to: 'COM3', label: 'HS1502 @ NAK', venue: '' },
    { day: THU, arriveByMin: 960, endMin: 1080, to: 'BIZ2', label: 'GEX1015 @ LT17', venue: '' },
  ],
};
const MIDDAY_KEY = `${THU}:720:COM3`;

test('a middle class taken off today leaves one trip home in the gap, not one for each side of it', async () => {
  const t = await setup(MIDDAY);
  t.clock(FROZEN_NOW + 30 * 60_000);
  await t.signal(t.phone, { kind: 'skipped', trip: MIDDAY_KEY });
  const items = (await (await t.call('/api/me/day', { token: t.phone })).json()).items;
  const keys = items.map((i) => i.key);
  assert.equal(new Set(keys).size, keys.length, `no entry twice: ${keys.join(', ')}`);
  assert.deepEqual(
    items.map((i) => i.kind),
    ['class', 'home', 'class', 'home'],
  );
});

test('at home in a gap, the next class is one still on today, not one taken off', async () => {
  const t = await setup(MIDDAY);
  t.clock(FROZEN_NOW + 30 * 60_000);
  await t.signal(t.phone, { kind: 'skipped', trip: MIDDAY_KEY });
  const walkingThroughPgp = await t.next(t.phone, '?lat=1.29130&lon=103.78140');
  assert.notEqual(walkingThroughPgp.dest?.label, 'HS1502 @ NAK');
  assert.equal(walkingThroughPgp.dest?.label, 'GEX1015 @ LT17');
});

test('the phone seeing you home ends the trip home for every device, so none still has you on the bus', async () => {
  const t = await setup(MIDDAY);
  await t.signal(t.phone, { kind: 'skipped', trip: MIDDAY_KEY });
  t.clock(FROZEN_NOW + 40 * 60_000);
  const widget = await t.next(t.mac);
  assert.equal(widget.dest.label, 'Home', 'the gap’s trip home, nobody said a thing');
  const phoneInPgp = await t.next(t.phone, '?lat=1.29130&lon=103.78140');
  assert.equal(phoneInPgp.dest.label, 'GEX1015 @ LT17');
  const after = await t.next(t.mac);
  assert.equal(after.dest.label, 'GEX1015 @ LT17', 'a device without a location now agrees');
  assert.notEqual(after.card.phase, 'riding');
  assert.deepEqual(
    outcomesToday(t.env).filter((o) => o.trip.startsWith('gap-home')),
    [],
    'not an outcome',
  );
});

const atStop = (code) => {
  const s = stopAt(code);
  return `?lat=${s.lat}&lon=${s.lon}&acc=5`;
};

test('at the stop you live by, hours before the trip, you are not "at the stop"; when it is due, the headline is the bus', async () => {
  const { phone, next, clock } = await setup();
  const first = await next(phone, atStop('PGP'));
  const here = atStop(first.leave.stopCode);
  assert.ok(Date.parse(first.leave.at) - Date.now() > 15 * 60_000, 'the leave-by is a while off');
  assert.equal((await next(phone, here)).card.phase, 'idle', 'standing by your home stop is not waiting for a bus');

  clock(Date.parse(first.leave.board) - 7 * 60_000);
  const due = await next(phone, here);
  assert.equal(due.card.phase, 'waiting', 'a few minutes before the bus, the feed’s time about it');
  assert.equal(due.card.leaveBy, `${due.leave.svc} at ${clockAt(Date.parse(due.leave.board))}`, 'no "Leave by" at the stop');
});

test('riding past another stop after the bus left is the bus, not "at the stop" there', async () => {
  const { phone, next, clock } = await setup();
  const first = await next(phone, atStop('PGP'));
  const here = atStop(first.leave.stopCode);
  clock(Date.parse(first.leave.at) - 60_000);
  const due = await next(phone, here);
  const board = Date.parse(due.leave.board);
  const stops = rideStops(indexGraph(GRAPH), due.leave.svc, due.leave.stopCode, due.leave.offCode ?? 'UTOWN');
  assert.ok(stops.length >= 3, 'a stop between boarding and getting off');

  clock(board + 4 * 60_000);
  const passing = await next(phone, atStop(stops.at(-2)));
  assert.equal(passing.card.phase, 'riding', 'far enough on that nobody walks there in the time');
  assert.equal(passing.label, `On the ${due.leave.svc}`);
});

test('a class whose bus was missed is not where the next one is planned from', async () => {
  const { phone, call, next, signal, clock } = await setup();
  await next(phone);
  await signal(phone, { kind: 'missed', trip: FIRST });
  clock(FROZEN_NOW + (11 * 60 + 15 - 9 * 60) * 60_000);
  const a = await next(phone);
  assert.equal(a.dest.label, 'CS2030 @ COM1');
  assert.notEqual(a.leave?.stopCode, 'UTOWN', 'after that class, without a location: from home, not UTown');
  const day = await (await call('/api/me/day', { token: phone })).json();
  assert.equal(day.items.find((x) => x.key === SECOND).from, 'PGP');
});

test("Today's next class says the bus the card says", async () => {
  const { phone, call, next, clock } = await setup();
  const first = await next(phone, atStop('PGP'));
  clock(Date.parse(first.leave.at) - 60_000);
  const due = await next(phone, atStop(first.leave.stopCode));
  const day = await (await call('/api/me/day', { token: phone })).json();
  const item = day.items.find((x) => x.key === FIRST);
  assert.equal(item.leave.board, due.leave.board);
  assert.equal(item.leave.svc, due.leave.svc);
  assert.equal((await next(phone)).leave.board, due.leave.board, 'and so does a device without a location');
});

test('taking the trip home off today offers "Undo: going home"', async () => {
  const t = await setup(MIDDAY);
  t.clock(FROZEN_NOW + 30 * 60_000);
  const res = await (await t.signal(t.phone, { kind: 'skipped', trip: 'gap-home:LT27' })).json();
  const undo = res.card.actions.find((x) => x.id === 'reset');
  assert.equal(undo?.label, 'Undo: going home');
  assert.equal(undo.trip, 'gap-home:LT27');
});

test('seen at the destination, the trip is over for every device, without anyone saying so', async () => {
  const { phone, mac, next, clock } = await setup();
  clock(FROZEN_NOW + 50 * 60_000);
  const there = await next(phone, atStop('UTOWN'));
  assert.equal(there.card.phase, 'arrived');
  const onMac = await next(mac);
  assert.equal(onMac.card.phase, 'arrived', 'the Mac has no location and knows anyway');
  assert.equal(onMac.label, "You're there");
  assert.match(onMac.detail, /^GEA1000 @ UTown starts /);
  assert.equal(onMac.leave, null, 'no trip home or next class while early for this one');
});

test('arriving early at the class, the phone says "You\'re there" straight away, not "You\'re here" first', async () => {
  const { phone, next, clock } = await setup();
  clock(FROZEN_NOW + 50 * 60_000);
  const first = await next(phone, atStop('UTOWN'));
  assert.equal(first.label, "You're there");
  assert.match(first.detail, /^GEA1000 @ UTown starts /);
  const again = await next(phone, atStop('UTOWN'));
  assert.equal(again.label, first.label);
  assert.equal(again.detail, first.detail);
  assert.equal(again.card.phase, 'arrived');
});

test("polling at the stop while the bus's time moves a little keeps the plan on that bus, and the ride is on it", async () => {
  const { phone, next, clock } = await setup();
  const first = await next(phone, atStop('PGP'));
  const here = atStop(first.leave.stopCode);
  clock(Date.parse(first.leave.at) - 60_000);
  const due = await next(phone, here);
  const board = Date.parse(due.leave.board);
  for (let i = 1; i <= 6; i++) {
    clock(Date.parse(first.leave.at) - 60_000 + i * 20_000);
    await next(phone, here);
  }
  const stops = rideStops(indexGraph(GRAPH), due.leave.svc, due.leave.stopCode, due.leave.offCode ?? 'UTOWN');
  clock(board + 4 * 60_000);
  const riding = await next(phone, atStop(stops.at(-2)));
  assert.equal(riding.card.phase, 'riding');
  assert.equal(riding.card.ride.svc, due.leave.svc, 'polled every 20 s with the bus a little later each time: still the bus it waited for');
  assert.equal(Date.parse(riding.card.ride.board), board);
});

test('at the stop and from the heads-up, the bus you were told stays the plan while it still gets you there in time', async () => {
  const feed = Object.fromEntries(Object.entries(FEED).map(([k, v]) => [k, v.map((x) => ({ ...x }))]));
  const { phone, mac, next, clock } = await setup(PROFILE, { feed });
  const first = await next(phone, atStop('PGP'));
  const here = atStop(first.leave.stopCode);
  clock(Date.parse(first.leave.at) - 10 * 60_000);
  const told = await next(phone, here);
  assert.equal(told.card.phase, 'waiting', 'at the stop ten minutes early, before the heads-up');
  for (const code of Object.keys(feed)) feed[code] = feed[code].filter((x) => x.name !== told.leave.svc);
  clock(Date.parse(first.leave.at) - 9 * 60_000);
  const after = await next(phone, here);
  assert.equal(after.leave.svc, told.leave.svc, 'still the bus you were told, though the feed dropped it there');
  assert.equal(after.leave.board, told.leave.board);
  assert.equal((await next(mac)).leave.svc, told.leave.svc, 'and on every device');
});

test('a plan and a watch sent at once by two devices both stick (the Trip object reads the day after the body)', async () => {
  installGlobals(makeFetch({}));
  const trips = makeDurableObjects(Trip);
  const s = trips.get('u1');
  const date = sgtDate(FROZEN_NOW);
  const deleteAt = endOfDayMs(FROZEN_NOW);
  const post = (path, body) =>
    s.fetch(`https://trip${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await Promise.all([
    post('/update', {
      date,
      plans: { k: { svc: 'D2', stop: 'PGP', board: new Date(FROZEN_NOW + 600_000).toISOString() } },
      basis: { k: 0 },
      deleteAt,
    }),
    post('/update', { date, watch: { userId: 'u1', at: FROZEN_NOW + 60_000 }, deleteAt }),
  ]);
  const day = await (await s.fetch(`https://trip/day?date=${date}`)).json();
  assert.equal(day.plans?.k?.svc, 'D2', 'the plan survives the watch');
  assert.equal(day.watch, FROZEN_NOW + 60_000);
});

test('/api/me/day follows the plan once its bus has left: the same leave-by, then the next way there, or on the bus once seen on it', async () => {
  const { phone, call, next, clock } = await setup();
  const planned = await next(phone, '?lat=1.291765&lon=103.780419');
  const board = Date.parse(planned.leave.board);
  assert.ok(planned.leave.svc, 'a bus to catch');

  clock(board + 60_000);
  let day = await (await call('/api/me/day', { token: phone })).json();
  assert.equal(day.items[0].leave?.board, planned.leave.board, 'just after it left: still the plan’s leave-by');

  clock(board + ASSUME_MS + 60_000);
  assert.equal((await next(phone)).card.phase, 'heading');
  day = await (await call('/api/me/day', { token: phone })).json();
  assert.equal(day.items[0].onBus, undefined, 'a few minutes on, nothing seen: not on it');
  assert.notEqual(day.items[0].leave?.board, planned.leave.board);

  const { svc, stopCode } = planned.leave;
  assert.equal((await next(phone, onRideQuery(svc, stopCode, 'UTOWN', rideLength(svc, stopCode, 'UTOWN') - 300))).card.phase, 'riding');
  day = await (await call('/api/me/day', { token: phone })).json();
  assert.equal(day.items[0].onBus?.svc, svc, 'seen on its road: Today says that bus too');
  assert.equal(day.items[0].leave, undefined);
});

test('choices are capped per account, the oldest dropped first', async () => {
  const { MAX_PREFS } = await import('../src/accounts/outcomes.ts');
  const { env, call, phone } = await setup();
  for (let i = 0; i < MAX_PREFS + 5; i++) {
    env.DB._db
      .prepare("INSERT INTO trip_prefs (user_id, trip_key, pref, label, set_at) SELECT user_id, ?, 'quiet', NULL, ? FROM sessions LIMIT 1")
      .run(`k${i}`, i);
  }
  await call('/api/me/choice', { method: 'POST', token: phone, body: { trip: FIRST, pref: 'quiet', choice: 'accept' } });
  const rows = env.DB._db
    .prepare('SELECT trip_key FROM trip_prefs ORDER BY set_at')
    .all()
    .map((r) => r.trip_key);
  assert.equal(rows.length, MAX_PREFS);
  assert.equal(rows.at(-1), FIRST);
  assert.ok(!rows.includes('k5'), 'the oldest are gone');
});

test('a trip key that is no class of yours and no trip home is refused', async () => {
  const { call, phone } = await setup();
  for (const trip of ['x', '9:9:NOWHERE', `${'a'.repeat(70)}`]) {
    assert.equal(
      (await call('/api/me/choice', { method: 'POST', token: phone, body: { trip, pref: 'quiet', choice: 'accept' } })).status,
      400,
      trip,
    );
    assert.equal((await call('/api/me/signal', { method: 'POST', token: phone, body: { kind: 'skipped', trip } })).status, 400, trip);
  }
  assert.equal(
    (await call('/api/me/choice', { method: 'POST', token: phone, body: { trip: FIRST, pref: 'quiet', choice: 'accept' } })).status,
    200,
  );
  assert.equal((await call('/api/me/signal', { method: 'POST', token: phone, body: { kind: 'skipped', trip: 'home:660' } })).status, 200);
});

test('a day keeps at most so many trip records', async () => {
  const { MAX_DAY_TRIPS } = await import('../src/push/tripdo.ts');
  const { phone, signal, TRIPS } = await setup();
  await signal(phone, { kind: 'skipped', trip: FIRST });
  const inst = [...TRIPS.instances.values()][0];
  const day = await inst.storage.get('day');
  for (let i = 0; i < MAX_DAY_TRIPS; i++) day.trips[`home:${i}`] = { kind: 'skipped', at: 0 };
  await inst.storage.put('day', day);
  await signal(phone, { kind: 'skipped', trip: SECOND });
  const after = await inst.storage.get('day');
  assert.equal(Object.keys(after.trips).length, MAX_DAY_TRIPS + 1, 'nothing new past the cap');
  assert.equal(after.trips[SECOND], undefined);
});

test('a Trip object that never answers costs the card its trip state, not the card', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stuck = { idFromName: (n) => n, get: () => ({ fetch: () => new Promise(() => {}) }) };
  const env = { TRIPS: stuck };
  const error = console.error;
  console.error = () => {};
  t.after(() => (console.error = error));
  const day = loadDay(env, 'u1', FROZEN_NOW);
  const save = saveSignals(env, 'u1', [{ key: 'k', rec: null }], FROZEN_NOW);
  const clear = clearTrip(env, 'u1');
  t.mock.timers.tick(TRIP_TIMEOUT_MS);
  assert.equal(await day, null, 'no state, as when the object fails');
  await assert.rejects(save, /timed out/, 'a change says it failed, as it does on an error');
  await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(TRIP_TIMEOUT_MS);
  assert.equal(await clear, undefined, 'clearing, tried twice, goes on without it');
});

test('a change to the Trip object that changes nothing writes nothing, and the alarm is set only when it moves', async () => {
  installGlobals(makeFetch({}));
  const trips = makeDurableObjects(Trip);
  const s = trips.get('u1');
  const date = sgtDate(FROZEN_NOW);
  const deleteAt = endOfDayMs(FROZEN_NOW);
  const update = async (u) =>
    (
      await s.fetch('https://trip/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ date, deleteAt, ...u }),
      })
    ).json();
  await update({ watch: { userId: 'u1', at: FROZEN_NOW + 600_000 } });
  assert.equal(trips.alarms.get('u1'), FROZEN_NOW + 600_000);
  const storage = trips.instances.get('u1').storage;
  const writes = [];
  for (const op of ['put', 'delete', 'setAlarm']) {
    const real = storage[op].bind(storage);
    storage[op] = (...args) => (writes.push([op, args[0]]), real(...args));
  }
  await update({ watch: { userId: 'u1', at: FROZEN_NOW + 600_000 } });
  const day = await update({ watch: { userId: 'u1', at: FROZEN_NOW + 900_000 } });
  assert.deepEqual(writes, [], 'the same again, and a later watch: the pending wake stands');
  assert.equal(day.watch, FROZEN_NOW + 600_000, 'the wake actually pending');
  await update({ watch: { userId: 'u1', at: FROZEN_NOW + 300_000 } });
  assert.deepEqual(writes.map(([op]) => op).sort(), ['put', 'put', 'setAlarm']);
  assert.equal(trips.alarms.get('u1'), FROZEN_NOW + 300_000, 'a sooner one moves it');
});

test("a watch never brings the Trip object's wake within 30 s of its last one", async () => {
  installGlobals(makeFetch({}));
  const trips = makeDurableObjects(Trip);
  const s = trips.get('u1');
  const base = { date: sgtDate(FROZEN_NOW), deleteAt: endOfDayMs(FROZEN_NOW) };
  const watch = (at) =>
    s.fetch('https://trip/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, watch: { userId: 'u1', at } }),
    });
  await watch(FROZEN_NOW + 30_000);
  const storage = trips.instances.get('u1').storage;
  await storage.put('lastWake', { at: FROZEN_NOW, leaveAt: null });
  await watch(FROZEN_NOW + 7_000);
  assert.equal(trips.alarms.get('u1'), FROZEN_NOW + 30_000, 'another phone 2 s after a wake, its leave-by 5 s on: held to 30 s');
  await storage.put('lastWake', { at: FROZEN_NOW - 60_000, leaveAt: null });
  await watch(FROZEN_NOW + 7_000);
  assert.equal(trips.alarms.get('u1'), FROZEN_NOW + 7_000, 'past the gap, a watch moves it sooner');
});

test('needsWatch: any sooner wake is booked, however little sooner; a later or equal one needs nothing', () => {
  const now = 1_000_000;
  const day = { date: '2026-10-08', trips: {}, watch: now + 60_000 };
  assert.equal(needsWatch(day, now + 55_000, now), true, 'five seconds sooner: the leave-by push has only 20 s to spare');
  assert.equal(needsWatch(day, now + 59_999, now), true);
  assert.equal(needsWatch(day, now + 60_000, now), false, 'the same wake');
  assert.equal(needsWatch(day, now + 90_000, now), false, 'later: the object plans afresh when it wakes');
  assert.equal(needsWatch({ ...day, watch: undefined }, now + 90_000, now), true, 'nothing pending');
  assert.equal(needsWatch({ ...day, watch: now - 1 }, now + 90_000, now), true, 'the pending wake has passed');
  assert.equal(needsWatch(null, now + 90_000, now), true);
});

test('"On it" with no bus in the plan (a class a short walk from home) means you have set off', async () => {
  const t = await setup({ home: { stops: ['PGP'] }, manual: [cls(600, 'PGPR', 'Gym @ PGPR')] });
  const a = await t.next(t.phone);
  assert.equal(a.leave?.svc ?? null, null, 'walking, no bus');
  assert.equal((await t.signal(t.phone, { kind: 'boarded' })).status, 200);
  const rec = Object.values((await loadDay(t.env, userOf(t.env), FROZEN_NOW)).trips)[0];
  assert.equal(rec.kind, 'left');
  assert.equal(rec.boarded, undefined);
});

test('/api/me/choice refuses what is not a choice, and a trip that is not today', async () => {
  const { call, phone } = await setup();
  const choose = async (body) => call('/api/me/choice', { method: 'POST', token: phone, body });
  for (const body of [
    {},
    { id: `earlier:${FIRST}` },
    { id: `earlier:${FIRST}`, choice: 'maybe' },
    { id: `louder:${FIRST}`, choice: 'accept' },
    { trip: FIRST, choice: 'accept' },
    { pref: 'quiet', choice: 'accept' },
    { trip: 'x'.repeat(81), pref: 'quiet', choice: 'accept' },
  ]) {
    const r = await choose(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match((await r.json()).error, /send id/);
  }
  const r = await choose({ trip: '1:600:UTOWN', pref: 'quiet', choice: 'accept' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'no such trip today');
});

test('a profile change that keeps losing to another device saving between every read and write gives up with 409 after three tries', async () => {
  const { env, call, phone } = await setup();
  const prepare = env.DB.prepare;
  let tries = 0;
  env.DB.prepare = (sql) => {
    if (sql.startsWith('UPDATE profiles SET json = ?, updated = ? WHERE user_id = ? AND updated = ?')) {
      tries++;
      env.DB._db.prepare('UPDATE profiles SET updated = updated + 1').run();
    }
    return prepare(sql);
  };
  const r = await call('/api/me/once', { method: 'POST', token: phone, body: { to: 'COM3', atMin: 14 * 60 } });
  env.DB.prepare = prepare;
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /changed on another device/);
  assert.equal(tries, 3);
});

test('the Trip object answers 404 to a path it does not know', async () => {
  installGlobals(makeFetch({}));
  const trips = makeDurableObjects(Trip);
  assert.equal((await trips.get('u1').fetch('https://trip/nope')).status, 404);
  assert.equal((await trips.get('u1').fetch('https://trip/day', { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await trips.get('u1').fetch('https://trip/nope', { method: 'POST', body: '{}' })).status, 404);
});

test('home is every home stop: from BIZ 2 the A1 to PGP, not a walk because it skips PGP Foyer', async () => {
  const feed = { BIZ2: [{ name: 'A1', arrivalTime: '3', nextArrivalTime: '9', passengers: 'low' }] };
  const t = await setup({ home: { stops: ['PGPR', 'PGP'] }, manual: [{ ...cls(540, 'BIZ2', 'GEX1015 @ LT17'), endMin: 600 }] }, { feed });
  t.clock(FROZEN_NOW + 61 * 60_000);
  const a = await t.next(t.phone);
  assert.equal(a.dest.label, 'Home');
  assert.equal(a.leave?.svc, 'A1', 'the A1 calls at PGP, two stops on');
  assert.equal(a.leave.toCode, 'PGP');
  assert.equal(a.leave.offCode, undefined, 'no crossing');
  const on = await (await t.signal(t.phone, { kind: 'boarded' })).json();
  assert.equal(on.card.phase, 'riding');
  assert.equal(on.card.ride.stops.at(-1).code, 'PGP', 'the ride is followed to PGP, where it stops, not PGP Foyer');
});

test('the spare time before a class is the same once you are on the bus: the walk from the stop it drops you at', async () => {
  const room = { ...cls(600, 'CLB', 'GEA1000 @ AS1-0201'), venue: 'AS1-0201' };
  const { phone, next, signal } = await setup({ home: { stops: ['PGP'] }, manual: [room] });
  const before = await next(phone);
  const walk = (a) => (Date.parse(a.timing.reachAt) - Date.parse(a.arriveAt)) / 1000;
  const riding = await (await signal(phone, { kind: 'boarded', trip: FIRST.replace('UTOWN', 'CLB') })).json();
  assert.equal(riding.card.phase, 'riding');
  assert.equal(before.leave.toCode, 'LT13-OPP', 'the bus gets you off at the nearer stop (183 m, not CLB at 277 m)');
  assert.equal(walk(riding), walk(before));
});

test('a one-off added once home: Today keeps the trip home, done, and plans the one-off from home', async () => {
  const at = (hhmm) => Date.parse(`2026-08-27T${hhmm}:00+08:00`);
  const t = await setup({ home: { stops: ['PGP'] }, manual: [{ ...cls(600, 'LT13', 'GEX1015 @ AS3'), endMin: 630 }] });
  t.clock(at('10:40'));
  const insidePgp = '?lat=1.2915&lon=103.7828';
  await t.next(t.phone, insidePgp);
  t.clock(at('11:45'));
  const added = await t.call('/api/me/once', { method: 'POST', token: t.phone, body: { to: 'COM3', label: 'COM 3', atMin: 720 } });
  assert.equal(added.status, 200);
  const day = await (await t.call('/api/me/day', { token: t.phone })).json();
  assert.deepEqual(
    day.items.map((i) => [i.kind, i.status, i.from]),
    [
      ['class', 'done', 'PGP'],
      ['home', 'done', 'LT13'],
      ['class', 'next', 'PGP'],
      ['home', 'later', 'COM3'],
    ],
  );
});

test("a one-off planned from home while you're already by its stop: the phone's walk replaces that plan, on Today too", async () => {
  const at = (hhmm) => Date.parse(`2026-08-27T${hhmm}:00+08:00`);
  const t = await setup(
    { home: { stops: ['PGPR'] }, manual: [{ ...cls(600, 'LT13', 'GEX1015 @ AS3'), endMin: 630 }] },
    { feed: { PGPR: [{ name: 'D2', arrivalTime: '1', nextArrivalTime: '11' }] } },
  );
  t.clock(at('12:45'));
  const added = await (
    await t.call('/api/me/once', { method: 'POST', token: t.phone, body: { to: 'COM3', label: 'COM 3', atMin: 766 } })
  ).json();
  assert.equal(added.leave.svc, 'D2', 'sent with no location: planned from home');
  t.clock(at('12:46'));
  const insideCom3 = '?lat=1.29474&lon=103.77395';
  const here = await t.next(t.phone, insideCom3);
  assert.equal(here.leave.svc, null);
  assert.equal(here.card.walkTo.name, 'COM 3');
  const day = await (await t.call(`/api/me/day${insideCom3}`, { token: t.phone })).json();
  const row = day.items.find((i) => i.key === '4:766:COM3');
  assert.ok(!row.leave?.svc, `no bus from home on Today: ${row.line}`);
});
