import test from 'node:test';
import assert from 'node:assert/strict';

import { leaveBy } from '../src/leave.ts';
import { DEFAULT_PROFILE, parseProfile } from '../src/profile.ts';
import { WALK, RIDE } from '../src/config.ts';
import { footS } from '../src/format.ts';
import { venueStops } from '../src/nusmods.ts';

const NOW = Date.UTC(2026, 8, 29, 1, 0); // 09:00 SGT
const MIN = 60_000;
const GRAPH = { generated: '', stops: [], routes: {}, headwayS: { D2: 600 } };
const BUF = WALK.boardBufferS * 1000;
const SLACK = 180_000;

const best = (extra = {}) => ({
  stop: { code: 'COM3', name: 'COM3', lat: 0, lon: 0 },
  svc: 'D2',
  distM: 130,
  walkS: 100,
  hops: 4,
  boardS: 300,
  rideS: 4 * RIDE.secondsPerHop,
  totalS: 300 + 4 * RIDE.secondsPerHop,
  quality: 'live',
  arrival: null,
  fetchedAt: NOW,
  fromMs: NOW,
  ambiguousBerth: false,
  ...extra,
});
const arrivals = (...etaMin) => ({
  code: 'COM3',
  arrivals: etaMin.map((m) => ({ svc: 'D2', etaS: m * 60, crowd: null, plate: null, berth: null })),
  fetchedAt: NOW,
  stale: false,
  available: true,
});
const base = { candidates: [], graph: GRAPH, walkAllS: null, nowMs: NOW };
// One option (or none) with its stop's arrivals.
const one = (b, sa) => ({ options: b ? [b] : [], byStop: new Map(sa ? [['COM3', sa]] : []) });
const ms = (l) => Date.parse(l.at);

test('no class: the next bus minus the walk', () => {
  const l = leaveBy({ ...base, ...one(best(), arrivals(5)), arriveBy: null });
  assert.equal(ms(l), NOW + 300_000 - 100_000 - BUF);
  assert.equal(l.estimated, false);
});

test('no class: nothing to say when you must leave now', () => {
  assert.equal(leaveBy({ ...base, ...one(best({ boardS: 150 }), arrivals(2.5)), arriveBy: null }), null);
});

test('no class: untimed or no bus says nothing', () => {
  assert.equal(leaveBy({ ...base, ...one(best({ quality: 'unknown' }), undefined), arriveBy: null }), null);
  assert.equal(leaveBy({ ...base, ...one(undefined, undefined), arriveBy: null }), null);
});

test('class: the latest live bus that still makes it', () => {
  const b = best();
  // Class at 09:40, venue next to the stop.
  const arriveBy = { atMs: NOW + 40 * MIN, venueWalkS: 0 };
  // latestBoard = 09:40 - 3 min slack - ride 6m20s = 09:30:40. Buses at 5, 12, 25 min.
  const l = leaveBy({ ...base, ...one(b, arrivals(5, 12, 25)), arriveBy });
  assert.equal(ms(l), NOW + 25 * MIN - 100_000 - BUF);
  assert.equal(Date.parse(l.board), NOW + 25 * MIN);
  assert.equal(Date.parse(l.arrive), NOW + 25 * MIN + best().rideS * 1000);
  assert.equal(l.estimated, false);
});

test('class: past the live times, projected by headway and marked estimated', () => {
  const arriveBy = { atMs: NOW + 60 * MIN, venueWalkS: 60 };
  // latestBoard = 09:60 - 3 - 1 - 6:20 = 09:49:40. Live 5, 15; projected 25, 35, 45.
  const l = leaveBy({ ...base, ...one(best(), arrivals(5, 15)), arriveBy });
  assert.equal(ms(l), NOW + 45 * MIN - 100_000 - BUF);
  assert.equal(l.estimated, true);
});

test('class: a timetabled time (a public bus LTA does not see) is a time, but stays estimated', () => {
  const arriveBy = { atMs: NOW + 40 * MIN, venueWalkS: 0 };
  const sa = arrivals(5, 12, 25);
  sa.arrivals[2] = { ...sa.arrivals[2], scheduled: true };
  const l = leaveBy({ ...base, ...one(best(), sa), arriveBy });
  assert.equal(Date.parse(l.board), NOW + 25 * MIN, 'the bus it would take');
  assert.equal(l.estimated, true);
  // Live, the same bus is not estimated.
  assert.equal(leaveBy({ ...base, ...one(best(), arrivals(5, 12, 25)), arriveBy }).estimated, false);
});

test('class hours ahead with no live times: a full headway early', () => {
  const arriveBy = { atMs: NOW + 180 * MIN, venueWalkS: 0 };
  const b = best({ quality: 'scheduled' });
  const l = leaveBy({ ...base, ...one(b, arrivals()), arriveBy });
  const latestBoard = arriveBy.atMs - SLACK - b.rideS * 1000;
  assert.equal(ms(l), latestBoard - 600_000 - 100_000 - BUF);
  assert.equal(l.estimated, true);
});

test('class before buses run: falls back to the candidate legs', () => {
  const arriveBy = { atMs: NOW + 120 * MIN, venueWalkS: 0 };
  const candidates = [{ stop: { code: 'PGP', name: 'PGP' }, distM: 0, walkS: 300, legs: [{ svc: 'D2', hops: 2 }] }];
  const l = leaveBy({ ...base, candidates, ...one(undefined, undefined), arriveBy });
  const latestBoard = arriveBy.atMs - SLACK - 2 * RIDE.secondsPerHop * 1000;
  assert.equal(ms(l), latestBoard - 600_000 - 300_000 - BUF);
});

test('class you cannot make: leave now, for the first bus you can catch', () => {
  const arriveBy = { atMs: NOW + 8 * MIN, venueWalkS: 0 };
  const l = leaveBy({ ...base, ...one(best(), arrivals(1, 5, 12)), arriveBy });
  assert.equal(ms(l), NOW);
  assert.equal(l.svc, 'D2');
  assert.equal(l.estimated, false);
});

test('walking: only a class gives a leave time', () => {
  assert.equal(leaveBy({ ...base, walkAllS: 400, ...one(best(), arrivals(5)), arriveBy: null }), null);
  const arriveBy = { atMs: NOW + 30 * MIN, venueWalkS: 60 };
  const l = leaveBy({ ...base, walkAllS: 400, ...one(best(), arrivals(5)), arriveBy });
  assert.equal(ms(l), arriveBy.atMs - (180 + 60 + 400) * 1000);
  assert.equal(l.estimated, false);
});

test('homeWalkMin: defaults to 5, 0 to 30 whole minutes', () => {
  const ok = () => true;
  assert.equal(DEFAULT_PROFILE.homeWalkMin, 5);
  assert.equal(parseProfile({}, ok).profile.homeWalkMin, 5);
  assert.equal(parseProfile({ homeWalkMin: 0 }, ok).profile.homeWalkMin, 0);
  assert.equal(parseProfile({ homeWalkMin: 12 }, ok).profile.homeWalkMin, 12);
  for (const bad of [-1, 31, 2.5, '5']) assert.equal(parseProfile({ homeWalkMin: bad }, ok).ok, false);
});

test('class: the latest leave across services, naming the bus and stop', () => {
  const arriveBy = { atMs: NOW + 40 * MIN, venueWalkS: 0 };
  // D2 leaves in 5 then every 10 (headway); A1 at 28 min with a short ride.
  const d2 = best();
  const a1 = best({ svc: 'A1', hops: 1, rideS: RIDE.secondsPerHop, stop: { code: 'KR', name: 'Kent Ridge Terminal', lat: 0, lon: 0 } });
  const byStop = new Map([
    ['COM3', arrivals(5, 15)],
    ['KR', { ...arrivals(28), code: 'KR', arrivals: [{ svc: 'A1', etaS: 28 * 60, crowd: null, plate: null, berth: null }] }],
  ]);
  const l = leaveBy({ ...base, options: [d2, a1], byStop, arriveBy });
  assert.equal(l.svc, 'A1');
  assert.equal(l.stop, 'KR Term');
  assert.equal(ms(l), NOW + 28 * MIN - 100_000 - BUF);
  assert.equal(l.estimated, false);
});

test('for a class, a stop further off must buy back more than its walk: walking counts sunWeight times', () => {
  // Thursday 27 Aug 2026, 09:00 SGT; the class at 09:40.
  const now = Date.UTC(2026, 7, 27, 1, 0);
  const stop = (code) => ({ code, name: code, lat: 0, lon: 0 });
  const opt = (code, walkS, boardS) => ({
    stop: stop(code),
    svc: 'D2',
    distM: walkS,
    walkS,
    hops: 4,
    boardS,
    rideS: 4 * RIDE.secondsPerHop,
    totalS: boardS + 4 * RIDE.secondsPerHop,
    quality: 'live',
    arrival: null,
    fetchedAt: now,
    fromMs: now,
    ambiguousBerth: false,
  });
  const arrivals = (code, etaS) => [
    code,
    { code, arrivals: [{ svc: 'D2', etaS, crowd: null, plate: null, berth: null }], fetchedAt: now, stale: false, available: true },
  ];
  // Near: a 1 min walk, the bus in 20 min. Far: a 7 min walk, the bus in
  // 27:20, so you leave 100 s later for it, for 340 s more in the sun.
  const near = opt('NEAR', 60, 1200);
  const far = opt('FAR', 400, 1640);
  const f = {
    options: [near, far],
    candidates: [],
    graph: { stops: [], routes: {}, headwayS: { D2: 3600 } },
    byStop: new Map([arrivals('NEAR', 1200), arrivals('FAR', 1640)]),
    walkAllS: null,
    nowMs: now,
    arriveBy: { atMs: now + 40 * 60_000, venueWalkS: 0, fullBusMargin: false },
  };
  assert.equal(leaveBy({ ...f, walkWeight: 1 }).stopCode, 'FAR', 'minutes as they are: the later leave');
  assert.equal(leaveBy(f).stopCode, 'NEAR', 'in the heat: 100 s at home is not worth 340 s more walking');
  assert.equal(WALK.sunWeight, 1.5);
});

test('for a class in a room two stops serve, the walk on from each stop counts sunWeight times, as in the ranking', () => {
  // COM1, served by COM3 and CLB: the real walks from each to the room.
  const room = venueStops('COM1');
  const walkByStopS = Object.fromEntries(Object.entries(room.walkM).map(([code, m]) => [code, Math.round(m / 1.3)]));
  const extraS = walkByStopS.CLB - walkByStopS.COM3;
  assert.ok(extraS > 20, `CLB is further from COM1: ${extraS} s`);
  const now = Date.UTC(2026, 7, 27, 1, 0);
  const stop = (code) => ({ code, name: code, lat: 0, lon: 0 });
  const rideS = 4 * RIDE.secondsPerHop;
  const opt = (svc, to, boardS) => ({
    stop: stop('HOME'),
    svc,
    distM: 100,
    walkS: 100,
    hops: 4,
    boardS,
    rideS,
    totalS: boardS + rideS,
    quality: 'live',
    arrival: null,
    fetchedAt: now,
    fromMs: now,
    ambiguousBerth: false,
    to: stop(to),
  });
  // To COM3, the bus at 26:40; to CLB, 10 s later, for extraS more on foot at the other end.
  const toCom3 = opt('D1', 'COM3', 1600);
  const toClb = opt('D2', 'CLB', 1610);
  const endWalk = (o) => walkByStopS[o.to.code];
  const sa = {
    code: 'HOME',
    arrivals: [
      { svc: 'D1', etaS: 1600, crowd: null, plate: null, berth: null },
      { svc: 'D2', etaS: 1610, crowd: null, plate: null, berth: null },
    ],
    fetchedAt: now,
    stale: false,
    available: true,
  };
  const f = {
    options: [toCom3, toClb],
    candidates: [],
    graph: { stops: [], routes: {}, headwayS: { D1: 3600, D2: 3600 } },
    byStop: new Map([['HOME', sa]]),
    walkAllS: null,
    nowMs: now,
    endWalk,
    arriveBy: { atMs: now + 40 * 60_000, venueWalkS: walkByStopS.COM3, walkByStopS, fullBusMargin: false },
  };
  assert.equal(leaveBy({ ...f, walkWeight: 1 }).toCode, 'CLB', 'minutes as they are: the later leave');
  // The ranking's cost, with the walk from the stop to the room weighed too.
  const cost = (o) => o.totalS + endWalk(o) + (WALK.sunWeight - 1) * footS(o, endWalk(o));
  assert.ok(cost(toCom3) < cost(toClb), 'the ranking prefers COM3');
  assert.equal(leaveBy(f).toCode, 'COM3', 'in the heat: 10 s at home is not worth the longer walk from CLB');
});
