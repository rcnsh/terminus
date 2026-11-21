import test from 'node:test';
import assert from 'node:assert/strict';

import { GRAPH, GRAPH_PUBLIC } from '../src/answer/graph.ts';
import { candidateStops, indexGraph, legRideS, likelyTripS, runsAt } from '../src/answer/resolve.ts';
import { DEFAULT_HEADWAY_S, RIDE, WALK } from '../src/config.ts';
import { withoutMeasuredHeadways } from './_headways.mjs';

withoutMeasuredHeadways();

const idx = indexGraph(GRAPH);
const stop = (code) => idx.byCode.get(code);
const at = (sgt) => Date.parse(`${sgt}+08:00`);
const TERM_THURSDAY = at('2026-08-27T09:00');
const SUNDAY_NOON = at('2026-08-30T12:00');
const codesOf = (cands) => cands.map((c) => c.stop.code);
const from = (lat, lon, to, more = {}) => ({ lat, lon, to, originCode: null, ...more });
function uncapped(input, opts) {
  const cap = WALK.maxCandidates;
  WALK.maxCandidates = 99;
  try {
    return candidateStops(GRAPH, input, opts);
  } finally {
    WALK.maxCandidates = cap;
  }
}

const NEAR_YIH = from(1.2966, 103.7764, 'UTOWN');
const IN_CELC = from(1.29644, 103.77087, 'UTOWN');

test('the stops asked about are the likeliest to get you there soonest, not the nearest', () => {
  const all = uncapped(NEAR_YIH);
  assert.deepEqual(codesOf(all), ['UHALL-OPP', 'UHC-OPP', 'COM3', 'YIH-OPP'], 'nearest first');
  assert.deepEqual(
    codesOf(candidateStops(GRAPH, NEAR_YIH)),
    ['UHALL-OPP', 'UHC-OPP', 'YIH-OPP'],
    'Opp YIH is two stops from UTown, COM 3 seven: Opp YIH takes the place',
  );
});

test('the likely trip is the walk, half a headway, the ride and the walk on, each second on foot weighted', () => {
  const d2 = { svc: 'D2', hops: 2, to: stop('UTOWN') };
  const ride = 2 * RIDE.secondsPerHop;
  assert.equal(likelyTripS(GRAPH, NEAR_YIH, 200, [d2]), 200 * WALK.sunWeight + DEFAULT_HEADWAY_S / 2 + ride);
  const on = likelyTripS(GRAPH, { ...NEAR_YIH, endWalkByStopS: { UTOWN: 100 }, walkWeight: 1 }, 200, [d2]);
  assert.equal(on, 300 + DEFAULT_HEADWAY_S / 2 + ride, 'the walk on from the stop it drops you at counts the same way');
  const d1 = { svc: 'D1', hops: 7, to: stop('UTOWN') };
  assert.equal(likelyTripS(GRAPH, NEAR_YIH, 0, [d1, d2]), DEFAULT_HEADWAY_S / 2 + ride, "the best of the stop's buses");
  assert.equal(likelyTripS(GRAPH, NEAR_YIH, 0, []), Infinity, 'no buses, no trip');
});

test('a service has buses in its hours, and may have just outside them', () => {
  const r2 = (hhmm) => runsAt(GRAPH, 'R2', at(`2026-08-27T${hhmm}`));
  assert.equal(r2('08:20'), 'yes');
  assert.equal(r2('19:29'), 'yes');
  assert.equal(r2('08:18'), 'maybe', 'the feed lists its first buses half an hour ahead');
  assert.equal(r2('07:40'), 'no');
  assert.equal(r2('19:33'), 'maybe', 'its last bus may still be out, on a slow run');
  assert.equal(r2('19:50'), 'maybe');
  assert.equal(r2('20:00'), 'no');
  assert.equal(runsAt(GRAPH, 'R2', SUNDAY_NOON), 'no');
});

const BY_AS5 = from(stop('AS5').lat + 0.0002, stop('AS5').lon, 'KV');
const BY_IT = from(1.297744, 103.773769, 'KV');
const nowAt = (hhmm) => ({ nowMs: at(`2026-08-27T${hhmm}`) });

test('a stop whose shuttle is running comes before one whose shuttle is not', () => {
  assert.deepEqual(
    codesOf(candidateStops(GRAPH, BY_IT, nowAt('19:20'))),
    ['IT', 'CLB', 'YIH-OPP'],
    "the R2 running: two of its stops and the K's nearest",
  );
  assert.deepEqual(
    codesOf(candidateStops(GRAPH, BY_IT, nowAt('19:35'))),
    ['IT', 'CLB', 'UHC-OPP'],
    "just after the R2 stops: the nearest stop, then both of the K's",
  );
  assert.deepEqual(codesOf(candidateStops(GRAPH, BY_IT, nowAt('21:00'))), ['IT', 'CLB', 'UHC-OPP'], 'and long after');
});

test('a stop is never left out for its shuttles’ hours: with a place spare, the feed is still asked', () => {
  for (const hhmm of ['03:00', '07:40', '08:18', '19:33', '21:00']) {
    assert.deepEqual(codesOf(candidateStops(GRAPH, BY_AS5, nowAt(hhmm))), ['NUSS-OPP', 'LT13-OPP', 'CLB'], hhmm);
  }
  assert.deepEqual(
    codesOf(candidateStops(GRAPH, NEAR_YIH, nowAt('03:00'))),
    codesOf(candidateStops(GRAPH, NEAR_YIH)),
    'with nothing running, the likeliest all the same: the answer says when each starts',
  );
});

test('for a class, the stops whose shuttle runs in time for it come first', () => {
  const cls = (input, atMs) => ({ ...input, arriveBy: { atMs, venueWalkS: 0 } });
  assert.deepEqual(
    codesOf(candidateStops(GRAPH, cls(BY_IT, at('2026-08-27T20:30')), nowAt('19:00'))),
    ['IT', 'CLB', 'UHC-OPP'],
    "the R2 stops before a 20:30 class: its nearest stop, then the K's two",
  );
  const r2 = candidateStops(GRAPH, BY_IT)[0].legs.find((l) => l.svc === 'R2');
  const opens = at('2026-08-27T08:20');
  const tight = opens + (legRideS(r2) + 60) * 1000;
  assert.deepEqual(
    codesOf(candidateStops(GRAPH, cls(BY_IT, tight), nowAt('07:30'))),
    ['IT', 'CLB', 'UHC-OPP'],
    "the R2's first bus a minute late by the leave-by's latest board: one for the K",
  );
  assert.deepEqual(codesOf(candidateStops(GRAPH, cls(BY_IT, tight + 600_000), nowAt('07:30'))), ['IT', 'CLB', 'YIH-OPP']);
});

test('the stop of a bus you chose keeps its place', () => {
  assert.ok(!codesOf(candidateStops(GRAPH, NEAR_YIH)).includes('COM3'), 'COM 3 is only the fourth likeliest');
  const step = (stopCode) => ({ step: { trip: 't', target: { svc: 'D1', stop: stopCode, board: '2026-08-27T01:10:00Z' } } });
  const chosen = candidateStops(GRAPH, { ...NEAR_YIH, ...step('COM3') });
  assert.deepEqual(codesOf(chosen), ['UHALL-OPP', 'UHC-OPP', 'COM3']);
  assert.ok(!codesOf(candidateStops(GRAPH, IN_CELC)).includes('LT13'), 'its D1 is at another stop too');
  assert.ok(codesOf(candidateStops(GRAPH, { ...IN_CELC, ...step('LT13') })).includes('LT13'));
});

test('turning public buses on never takes a shuttle stop out of the answer', () => {
  const clb = stop('CLB');
  const off = candidateStops(GRAPH, from(clb.lat, clb.lon, 'CG'), { nowMs: TERM_THURSDAY });
  const on = candidateStops(GRAPH_PUBLIC, from(clb.lat, clb.lon, 'CG', { publicBuses: true }), { nowMs: TERM_THURSDAY });
  assert.deepEqual(codesOf(off), ['UHC-OPP']);
  assert.deepEqual(codesOf(on), ['IT', 'YIH-OPP', 'UHC-OPP', '16199'], 'with public buses, the 151 from nearer stops too');
  for (const origin of GRAPH.stops) {
    for (const dest of GRAPH.stops) {
      if (dest.code === origin.code) continue;
      const free = candidateStops(GRAPH, from(origin.lat + 0.0008, origin.lon, dest.code), { nowMs: TERM_THURSDAY }).filter(
        (c) => c.legs.length,
      );
      const paid = candidateStops(GRAPH_PUBLIC, from(origin.lat + 0.0008, origin.lon, dest.code, { publicBuses: true }), {
        nowMs: TERM_THURSDAY,
      });
      for (const c of free) assert.ok(codesOf(paid).includes(c.stop.code), `${origin.code} to ${dest.code}: ${c.stop.code}`);
    }
  }
});

test('a stop up to WALK.tripRadiusM away is one, when its bus makes up the walk', () => {
  const com3 = stop('COM3');
  const toKv = from(com3.lat, com3.lon, 'KV');
  const cands = candidateStops(GRAPH, toKv, { nowMs: TERM_THURSDAY });
  const far = cands.find((c) => c.stop.code === 'UHC-OPP');
  assert.ok(far, `Opp UHC has the K and the P to Kent Vale: ${codesOf(cands).join()}`);
  assert.ok(far.distM > WALK.maxRadiusM && far.distM <= WALK.tripRadiusM, `${far.distM} m`);
  for (const c of candidateStops(GRAPH, from(com3.lat, com3.lon, null)))
    assert.ok(c.distM <= WALK.maxRadiusM, `with no destination, only the stops near you: ${c.stop.code}`);
});

test('the stops not picked by their likely trip stay within WALK.maxRadiusM', () => {
  const bg = stop('BG-MRT');
  assert.deepEqual(
    codesOf(candidateStops(GRAPH, from(bg.lat + 0.0008, bg.lon, 'BIZ2'), { any: true })),
    ['CG', 'BG-MRT'],
    'where a change of bus can start: not Oei Tiong Ham, 452 m off',
  );
  const as5 = stop('AS5');
  const toBiz2 = from(as5.lat, as5.lon + 0.0012, 'BIZ2');
  const cands = candidateStops(GRAPH, toBiz2, { nowMs: TERM_THURSDAY });
  assert.deepEqual(
    codesOf(candidateStops(GRAPH, { ...toBiz2, preferStops: ['TCOMS'] }, { nowMs: TERM_THURSDAY })),
    codesOf(cands),
    'a usual stop 469 m off is not added',
  );
  const near = candidateStops(GRAPH, { ...toBiz2, preferStops: ['BIZ2-OPP', 'LT13'] }, { nowMs: TERM_THURSDAY });
  assert.ok(near.length > cands.length, `a usual stop in range joins them: ${codesOf(near).join()}`);
});

test('a stop where you would only catch the same buses, a longer walk away, is not asked about', () => {
  const kr = stop('KR-MRT-OPP');
  const toClb = uncapped(from(kr.lat, kr.lon, 'CLB'));
  assert.ok(toClb.some((c) => c.stop.code === 'KR-MRT'));
  assert.ok(!toClb.some((c) => c.stop.code === 'LT27'), `LT 27 only catches the A1 and K from KR MRT later: ${codesOf(toClb).join()}`);
  const toUtown = uncapped(IN_CELC);
  assert.ok(!toUtown.some((c) => c.stop.code === 'NUSS-OPP'), `Opp NUSS is before Ventus and further: ${codesOf(toUtown).join()}`);
  assert.ok(
    !toUtown.some((c) => c.stop.code === 'CLB' || c.stop.code === 'LT13'),
    `a D1 from before its terminal is one you would be at Ventus for: ${codesOf(toUtown).join()}`,
  );
  assert.ok(
    toUtown.some((c) => c.stop.code === 'LT13-OPP') && toUtown.some((c) => c.stop.code === 'IT'),
    `IT, just after Ventus, may catch a bus missed there: ${codesOf(toUtown).join()}`,
  );
  const as5 = stop('AS5');
  const toKv = candidateStops(GRAPH, from(as5.lat + 0.0008, as5.lon, 'KV'), { nowMs: TERM_THURSDAY });
  assert.deepEqual(
    codesOf(toKv),
    ['LT13-OPP', 'CLB', 'SDE3-OPP'],
    "Opp SDE 3, after CLB on the K, is further by less than twice the bus's ride",
  );
});

test('a stop past the terminal is asked about: a run starts there whatever has pulled in', () => {
  const ventus = stop('LT13-OPP');
  const cands = candidateStops(GRAPH, from(ventus.lat, ventus.lon - 0.002, 'YIH'), { nowMs: TERM_THURSDAY });
  assert.deepEqual(
    codesOf(cands),
    ['KRB', 'LT13-OPP', 'IT'],
    'the A2 from Ventus ends at the terminal between them; the A2 at IT is another',
  );
});

test('the stop you are at, or else the nearest, keeps its place, however likely the others look', () => {
  const clb = stop('CLB');
  const toTcoms = from(clb.lat, clb.lon, 'TCOMS-OPP');
  const likely = (input) => (c) => likelyTripS(GRAPH, input, c.walkS, c.legs);
  const all = uncapped(toTcoms);
  const here = all.find((c) => c.here);
  assert.equal(here.stop.code, 'CLB');
  assert.ok(all.filter((c) => likely(toTcoms)(c) < likely(toTcoms)(here)).length >= WALK.maxCandidates, codesOf(all).join());
  assert.equal(candidateStops(GRAPH, toTcoms, { nowMs: TERM_THURSDAY })[0].stop.code, 'CLB');
  const kr = stop('KR-MRT-OPP');
  assert.deepEqual(
    codesOf(candidateStops(GRAPH, from(kr.lat, kr.lon, 'CLB'), { nowMs: TERM_THURSDAY })),
    ['KR-MRT-OPP', 'KR-MRT'],
    'the A2 here may be pulling in while the A1 across the road is a long wait',
  );
  const [nearest, ...others] = uncapped(NEAR_YIH);
  assert.equal(nearest.stop.code, 'UHALL-OPP');
  for (const c of others) assert.ok(likely(NEAR_YIH)(c) < likely(NEAR_YIH)(nearest), c.stop.code);
  assert.equal(
    candidateStops(GRAPH, NEAR_YIH, { nowMs: TERM_THURSDAY })[0].stop.code,
    'UHALL-OPP',
    'the nearest, least likely, stays: walking to it, it must not drop out',
  );
});

test('a stop whose bus calls at the destination is not one that only goes near it, wherever it says to get off', () => {
  const biz2 = stop('BIZ2');
  const input = from(biz2.lat + 0.0008, biz2.lon, 'PGPR', { endWalkByStopS: { PGP: 97 } });
  const cands = candidateStops(GRAPH, input, { nowMs: TERM_THURSDAY });
  assert.deepEqual(
    codesOf(cands),
    ['COM3', 'BIZ2', 'TCOMS-OPP'],
    'the D2 from COM 3 and Opp TCOMS calls at the Foyer; the A1 and R1 from BIZ 2 only go to PGP',
  );
  for (const c of cands) for (const leg of c.legs) assert.equal(leg.to.code, 'PGP', `${c.stop.code} ${leg.svc}`);
});

test('an answer never asks about more shuttle stops than WALK.maxCandidates, wherever you stand', () => {
  const cls = { arriveBy: { atMs: TERM_THURSDAY + 3_600_000, venueWalkS: 0 } };
  for (const origin of GRAPH.stops) {
    for (const dest of GRAPH.stops) {
      if (dest.code === origin.code) continue;
      for (const [dLat, more, opts] of [
        [0, {}, {}],
        [0.0008, {}, { nowMs: TERM_THURSDAY }],
        [-0.0008, {}, { nowMs: SUNDAY_NOON }],
        [0.0008, cls, { nowMs: TERM_THURSDAY }],
      ]) {
        const cands = candidateStops(GRAPH, from(origin.lat + dLat, origin.lon, dest.code, more), opts);
        const shuttle = cands.filter((c) => !c.stop.public);
        assert.ok(shuttle.length <= WALK.maxCandidates, `${origin.code} to ${dest.code}: ${codesOf(cands).join()}`);
      }
    }
  }
});
