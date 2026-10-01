import test from 'node:test';
import assert from 'node:assert/strict';

import { makeD1 } from './_d1.mjs';
import { MIN_SAMPLES, dayType, loadCrowdRisk, pruneCrowdSeen, recordCrowds } from '../src/crowd.ts';
import { leaveBy } from '../src/leave.ts';
import { RIDE, WALK } from '../src/config.ts';

// Thursday 27 Aug 2026, 09:00 SGT: a teaching day.
const THU = Date.UTC(2026, 7, 27, 1, 0);
const MIN = 60_000;

const sighting = (plate, crowd, etaS = 60) => ({ svc: 'D2', etaS, crowd, plate, berth: null });
const at = (stop, arrivals, fetchedAt = THU) => new Map([[stop, { code: stop, arrivals, fetchedAt, stale: false, available: true }]]);

test('a bus is counted once per stop and half hour, however often it is looked at', async () => {
  const db = makeD1();
  await recordCrowds(db, at('COM3', [sighting('PD1A', 'high')]), THU);
  await recordCrowds(db, at('COM3', [sighting('PD1A', 'high')]), THU + 20_000);
  await recordCrowds(db, at('COM3', [sighting('PD2B', 'low'), sighting('PD3C', 'high', 600)]), THU);
  const row = db._db.prepare('SELECT n, packed, daytype FROM crowd_stats').get();
  // PD3C was ten minutes out: its crowd is not what you'd board into.
  assert.deepEqual({ ...row }, { n: 2, packed: 1, daytype: 'term' });
});

test('risk says nothing until a slot has enough sightings', async () => {
  const db = makeD1();
  for (let i = 0; i < MIN_SAMPLES - 1; i++) await recordCrowds(db, at('COM3', [sighting(`P${i}`, 'high')]), THU);
  assert.equal((await loadCrowdRisk(db, ['COM3'], THU))('D2', 'COM3', THU + MIN), null);
  await recordCrowds(db, at('COM3', [sighting('PLAST', 'low')]), THU);
  const risk = (await loadCrowdRisk(db, ['COM3'], THU))('D2', 'COM3', THU + MIN);
  assert.equal(risk, (MIN_SAMPLES - 1) / MIN_SAMPLES);
});

test('old sightings are pruned; the counts stay', async () => {
  const db = makeD1();
  await recordCrowds(db, at('COM3', [sighting('PD1A', 'high')]), THU);
  await pruneCrowdSeen(db, THU + 3 * 86_400_000);
  assert.equal(db._db.prepare('SELECT count(*) AS c FROM crowd_seen').get().c, 0);
  assert.equal(db._db.prepare('SELECT n FROM crowd_stats').get().n, 1);
});

test('day types: teaching weekday, Saturday, Sunday', () => {
  assert.equal(dayType(THU), 'term');
  assert.equal(dayType(THU + 2 * 86_400_000), 'sat');
  assert.equal(dayType(THU + 3 * 86_400_000), 'sun');
});

test('often packed: leave-by aims one bus earlier and says why; off, it only warns', () => {
  const option = {
    stop: { code: 'COM3', name: 'COM 3', lat: 0, lon: 0 }, svc: 'D2', distM: 130, walkS: 100, hops: 4,
    boardS: 300, rideS: 4 * RIDE.secondsPerHop, totalS: 300 + 4 * RIDE.secondsPerHop, quality: 'live',
    arrival: null, fetchedAt: THU, ambiguousBerth: false,
  };
  const base = {
    options: [option], candidates: [], graph: { stops: [], routes: {}, headwayS: { D2: 600 } },
    byStop: at('COM3', [5, 12, 25].map((m) => sighting(`P${m}`, null, m * 60))), walkAllS: null, nowMs: THU,
  };
  // Packed only for the 25-minute bus.
  const risk = (svc, stop, ms) => (ms === THU + 25 * MIN ? 0.8 : 0.1);
  const arriveBy = { atMs: THU + 40 * MIN, venueWalkS: 0 };
  const walk = 100_000 + WALK.boardBufferS * 1000;

  const plain = leaveBy({ ...base, arriveBy });
  assert.equal(Date.parse(plain.at), THU + 25 * MIN - walk);

  const careful = leaveBy({ ...base, arriveBy, crowdRisk: risk });
  assert.equal(Date.parse(careful.at), THU + 12 * MIN - walk);
  assert.match(careful.note, /D2 is often packed at COM 3 around then, so this is one bus earlier/);

  const warned = leaveBy({ ...base, arriveBy: { ...arriveBy, fullBusMargin: false }, crowdRisk: risk });
  assert.equal(Date.parse(warned.at), THU + 25 * MIN - walk);
  assert.equal(warned.note, 'D2 is often packed at COM 3 around then, and may be full');
});
