import test from 'node:test';
import assert from 'node:assert/strict';

import { leaveBy } from '../src/leave.ts';
import { DEFAULT_PROFILE, parseProfile } from '../src/profile.ts';
import { WALK, RIDE } from '../src/config.ts';

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
  assert.equal(l.estimated, false);
});

test('class: past the live times, projected by headway and marked estimated', () => {
  const arriveBy = { atMs: NOW + 60 * MIN, venueWalkS: 60 };
  // latestBoard = 09:60 - 3 - 1 - 6:20 = 09:49:40. Live 5, 15; projected 25, 35, 45.
  const l = leaveBy({ ...base, ...one(best(), arrivals(5, 15)), arriveBy });
  assert.equal(ms(l), NOW + 45 * MIN - 100_000 - BUF);
  assert.equal(l.estimated, true);
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
  const ok = (c) => true;
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
