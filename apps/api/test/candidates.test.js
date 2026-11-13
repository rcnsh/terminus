/**
 * Which stops an answer asks the feed about (candidateStops), with a location
 * and a destination: the likeliest to get you there soonest, worked out from
 * the route data, not the nearest. On the real stop graph (data/stops.json),
 * with one headway for every shuttle.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { GRAPH, GRAPH_PUBLIC } from '../src/answer/graph.ts';
import { candidateStops, indexGraph, legRideS, likelyTripS, runsAt } from '../src/answer/resolve.ts';
import { DEFAULT_HEADWAY_S, RIDE, WALK } from '../src/config.ts';
import { withoutMeasuredHeadways } from './_headways.mjs';

// How a headway is used, not how long one is.
withoutMeasuredHeadways();

const idx = indexGraph(GRAPH);
const stop = (code) => idx.byCode.get(code);
/** An instant from a Singapore wall-clock time, "2026-08-27T09:00". */
const at = (sgt) => Date.parse(`${sgt}+08:00`);
const THU = at('2026-08-27T09:00'); // a Thursday in term: every shuttle runs
const SUN = at('2026-08-30T12:00'); // a Sunday: no K, P, R1 or R2
const codesOf = (cands) => cands.map((c) => c.stop.code);
const from = (lat, lon, to, more = {}) => ({ lat, lon, to, originCode: null, ...more });
/** Every stop in range with a bus there, past the limit on how many are asked about. */
function uncapped(input, opts) {
  const cap = WALK.maxCandidates;
  WALK.maxCandidates = 99;
  try {
    return candidateStops(GRAPH, input, opts);
  } finally {
    WALK.maxCandidates = cap;
  }
}

// Between YIH and University Hall, going to UTown. Nearest first: Opp
// University Hall (the D2 the long way round its loop), Opp UHC (the D2 and P,
// one and two stops), COM 3 (seven and eight), Opp YIH (the D1 and R2, two and one).
const NEAR_YIH = from(1.2966, 103.7764, 'UTOWN');
// In CELC, going to UTown: Ventus and IT have the D1 and R2 straight there;
// CLB and LT 13 have the D1 the long way round through its terminal.
const IN_CELC = from(1.29644, 103.77087, 'UTOWN');

test('the stops asked about are the likeliest to get you there soonest, not the nearest', () => {
  const all = uncapped(NEAR_YIH);
  assert.deepEqual(codesOf(all), ['UHALL-OPP', 'UHC-OPP', 'COM3', 'YIH-OPP'], 'nearest first');
  // The furthest is two stops from UTown, where COM 3 is seven: it takes the place.
  assert.deepEqual(codesOf(candidateStops(GRAPH, NEAR_YIH)), ['UHALL-OPP', 'UHC-OPP', 'YIH-OPP']);
});

test('the likely trip is the walk, half a headway, the ride and the walk on, each second on foot weighted', () => {
  const d2 = { svc: 'D2', hops: 2, to: stop('UTOWN') };
  const ride = 2 * RIDE.secondsPerHop;
  assert.equal(likelyTripS(GRAPH, NEAR_YIH, 200, [d2]), 200 * WALK.sunWeight + DEFAULT_HEADWAY_S / 2 + ride);
  // The walk on from the stop it gets you off at counts the same way; with walking unweighted, as it is.
  const on = likelyTripS(GRAPH, { ...NEAR_YIH, endWalkByStopS: { UTOWN: 100 }, walkWeight: 1 }, 200, [d2]);
  assert.equal(on, 300 + DEFAULT_HEADWAY_S / 2 + ride);
  // The best of the stop's buses; none, none.
  const d1 = { svc: 'D1', hops: 7, to: stop('UTOWN') };
  assert.equal(likelyTripS(GRAPH, NEAR_YIH, 0, [d1, d2]), DEFAULT_HEADWAY_S / 2 + ride);
  assert.equal(likelyTripS(GRAPH, NEAR_YIH, 0, []), Infinity);
});

test('a service has buses in its hours, and may have just outside them', () => {
  // The R2 runs 08:20 to 19:30 on a weekday, a run of a quarter of an hour.
  const r2 = (hhmm) => runsAt(GRAPH, 'R2', at(`2026-08-27T${hhmm}`));
  assert.equal(r2('08:20'), 'yes');
  assert.equal(r2('19:29'), 'yes');
  // About to start: the feed lists its first buses half an hour ahead.
  assert.equal(r2('08:18'), 'maybe');
  assert.equal(r2('07:40'), 'no');
  // Just stopped: its last bus may still be out, on a slow run at that.
  assert.equal(r2('19:33'), 'maybe');
  assert.equal(r2('19:50'), 'maybe');
  assert.equal(r2('20:00'), 'no');
  assert.equal(runsAt(GRAPH, 'R2', SUN), 'no');
});

// Beside AS 5 for Kent Vale: the R2 from Opp NUSS and Ventus, the K from CLB.
const BY_AS5 = from(stop('AS5').lat + 0.0002, stop('AS5').lon, 'KV');
// North of IT for Kent Vale: the R2 from IT, Opp YIH and Raffles Hall, the K from CLB and Opp UHC.
const BY_IT = from(1.297744, 103.773769, 'KV');
const nowAt = (hhmm) => ({ nowMs: at(`2026-08-27T${hhmm}`) });

test('a stop whose shuttle is running comes before one whose shuttle is not', () => {
  // With the R2 running, two of its stops and the K's nearest.
  assert.deepEqual(codesOf(candidateStops(GRAPH, BY_IT, nowAt('19:20'))), ['IT', 'CLB', 'YIH-OPP']);
  // Five minutes after it stops, when its last bus may still be out, and an
  // hour and a half after: the nearest stop still, then both of the K's.
  assert.deepEqual(codesOf(candidateStops(GRAPH, BY_IT, nowAt('19:35'))), ['IT', 'CLB', 'UHC-OPP']);
  assert.deepEqual(codesOf(candidateStops(GRAPH, BY_IT, nowAt('21:00'))), ['IT', 'CLB', 'UHC-OPP']);
});

test('a stop is never left out for its shuttles’ hours: with a place spare, the feed is still asked', () => {
  // The hours are a table kept by hand, and the feed may list a bus outside them.
  for (const hhmm of ['03:00', '07:40', '08:18', '19:33', '21:00']) {
    assert.deepEqual(codesOf(candidateStops(GRAPH, BY_AS5, nowAt(hhmm))), ['NUSS-OPP', 'LT13-OPP', 'CLB'], hhmm);
  }
  // With nothing running, the likeliest all the same: the answer says when each starts.
  assert.deepEqual(codesOf(candidateStops(GRAPH, NEAR_YIH, nowAt('03:00'))), codesOf(candidateStops(GRAPH, NEAR_YIH)));
});

test('for a class, the stops whose shuttle runs in time for it come first', () => {
  const cls = (input, atMs) => ({ ...input, arriveBy: { atMs, venueWalkS: 0 } });
  // At 19:00 for 20:30 at Kent Vale: the R2 will have stopped an hour
  // before. Its nearest stop is one to go by now; the K's two are the ones
  // to leave by.
  assert.deepEqual(codesOf(candidateStops(GRAPH, cls(BY_IT, at('2026-08-27T20:30')), nowAt('19:00'))), ['IT', 'CLB', 'UHC-OPP']);
  // In time is by the latest board the leave-by counts, the minutes in hand
  // included: a class the R2's first bus at 08:20 gets you to a minute late
  // for those is one for the K.
  const r2 = candidateStops(GRAPH, BY_IT)[0].legs.find((l) => l.svc === 'R2');
  const opens = at('2026-08-27T08:20');
  const tight = opens + (legRideS(r2) + 60) * 1000;
  assert.deepEqual(codesOf(candidateStops(GRAPH, cls(BY_IT, tight), nowAt('07:30'))), ['IT', 'CLB', 'UHC-OPP']);
  assert.deepEqual(codesOf(candidateStops(GRAPH, cls(BY_IT, tight + 600_000), nowAt('07:30'))), ['IT', 'CLB', 'YIH-OPP']);
});

test('the stop of a bus you chose keeps its place', () => {
  // Between YIH and University Hall, COM 3 is the fourth likeliest.
  assert.ok(!codesOf(candidateStops(GRAPH, NEAR_YIH)).includes('COM3'));
  const step = (stopCode) => ({ step: { trip: 't', target: { svc: 'D1', stop: stopCode, board: '2026-08-27T01:10:00Z' } } });
  const chosen = candidateStops(GRAPH, { ...NEAR_YIH, ...step('COM3') });
  assert.deepEqual(codesOf(chosen), ['UHALL-OPP', 'UHC-OPP', 'COM3']);
  // One whose buses another stop has, too: in CELC, the D1 from LT 13.
  assert.ok(!codesOf(candidateStops(GRAPH, IN_CELC)).includes('LT13'));
  assert.ok(codesOf(candidateStops(GRAPH, { ...IN_CELC, ...step('LT13') })).includes('LT13'));
});

test('turning public buses on never takes a shuttle stop out of the answer', () => {
  // At the Central Library for College Green: the P from Opp UHC, and with
  // public buses the 151 from three stops nearer.
  const clb = stop('CLB');
  const off = candidateStops(GRAPH, from(clb.lat, clb.lon, 'CG'), { nowMs: THU });
  const on = candidateStops(GRAPH_PUBLIC, from(clb.lat, clb.lon, 'CG', { publicBuses: true }), { nowMs: THU });
  assert.deepEqual(codesOf(off), ['UHC-OPP']);
  assert.deepEqual(codesOf(on), ['IT', 'YIH-OPP', 'UHC-OPP', '16199']);
  for (const origin of GRAPH.stops) {
    for (const dest of GRAPH.stops) {
      if (dest.code === origin.code) continue;
      const free = candidateStops(GRAPH, from(origin.lat + 0.0008, origin.lon, dest.code), { nowMs: THU }).filter((c) => c.legs.length);
      const paid = candidateStops(GRAPH_PUBLIC, from(origin.lat + 0.0008, origin.lon, dest.code, { publicBuses: true }), { nowMs: THU });
      for (const c of free) assert.ok(codesOf(paid).includes(c.stop.code), `${origin.code} to ${dest.code}: ${c.stop.code}`);
    }
  }
});

test('a stop up to WALK.tripRadiusM away is one, when its bus makes up the walk', () => {
  // At COM 3 for Kent Vale: Opp UHC, over 450 m off, has the K and the P.
  const com3 = stop('COM3');
  const toKv = from(com3.lat, com3.lon, 'KV');
  const cands = candidateStops(GRAPH, toKv, { nowMs: THU });
  const far = cands.find((c) => c.stop.code === 'UHC-OPP');
  assert.ok(far, codesOf(cands).join());
  assert.ok(far.distM > WALK.maxRadiusM && far.distM <= WALK.tripRadiusM, `${far.distM} m`);
  // With no destination, the next buses are at the stops near you.
  for (const c of candidateStops(GRAPH, from(com3.lat, com3.lon, null))) assert.ok(c.distM <= WALK.maxRadiusM, c.stop.code);
});

test('the stops not picked by their likely trip stay within WALK.maxRadiusM', () => {
  // Where a change of bus can start, north of Botanic Gardens MRT: not Oei Tiong Ham, 452 m off.
  const bg = stop('BG-MRT');
  assert.deepEqual(codesOf(candidateStops(GRAPH, from(bg.lat + 0.0008, bg.lon, 'BIZ2'), { any: true })), ['CG', 'BG-MRT']);
  // A usual stop, east of AS 5 for BIZ 2: not TCOMS, 469 m off.
  const as5 = stop('AS5');
  const toBiz2 = from(as5.lat, as5.lon + 0.0012, 'BIZ2');
  const cands = candidateStops(GRAPH, toBiz2, { nowMs: THU });
  assert.deepEqual(codesOf(candidateStops(GRAPH, { ...toBiz2, preferStops: ['TCOMS'] }, { nowMs: THU })), codesOf(cands));
  // One in range joins them.
  const near = candidateStops(GRAPH, { ...toBiz2, preferStops: ['BIZ2-OPP', 'LT13'] }, { nowMs: THU });
  assert.ok(near.length > cands.length, codesOf(near).join());
});

test('a stop where you would only catch the same buses, a longer walk away, is not asked about', () => {
  // On Opp KR MRT for the Central Library: the A1 and K go from KR MRT across
  // the road, then LT 27. Walking on to LT 27 only catches them later.
  const kr = stop('KR-MRT-OPP');
  const toClb = uncapped(from(kr.lat, kr.lon, 'CLB'));
  assert.ok(toClb.some((c) => c.stop.code === 'KR-MRT'));
  assert.ok(!toClb.some((c) => c.stop.code === 'LT27'), codesOf(toClb).join());
  // In CELC for UTown: Opp NUSS is the stop before Ventus on the D1 and R2, and further to walk.
  const toUtown = uncapped(IN_CELC);
  assert.ok(!toUtown.some((c) => c.stop.code === 'NUSS-OPP'), codesOf(toUtown).join());
  // So are CLB and LT 13, the D1's stops before its terminal: a D1 from
  // there is one you'd be at Ventus for, on its next run.
  assert.ok(!toUtown.some((c) => c.stop.code === 'CLB' || c.stop.code === 'LT13'), codesOf(toUtown).join());
  // IT is the stop after Ventus, and not so far on that the bus is sure to
  // get there first: a bus just missed at Ventus may be caught there.
  assert.ok(toUtown.some((c) => c.stop.code === 'LT13-OPP') && toUtown.some((c) => c.stop.code === 'IT'), codesOf(toUtown).join());
  // North of AS 5 for Kent Vale, the same of Opp SDE 3, the stop after CLB
  // on the K: further by more than the bus's usual ride, but not by twice it.
  const as5 = stop('AS5');
  const toKv = candidateStops(GRAPH, from(as5.lat + 0.0008, as5.lon, 'KV'), { nowMs: THU });
  assert.deepEqual(codesOf(toKv), ['LT13-OPP', 'CLB', 'SDE3-OPP']);
});

test('a stop past the terminal is asked about: a run starts there whatever has pulled in', () => {
  // West of Ventus for YIH: IT is down the line from Ventus on both its
  // buses, and a long walk on. But the A2 from Ventus ends its run at the
  // terminal between them, and the A2 at IT is another.
  const ventus = stop('LT13-OPP');
  const cands = candidateStops(GRAPH, from(ventus.lat, ventus.lon - 0.002, 'YIH'), { nowMs: THU });
  assert.deepEqual(codesOf(cands), ['KRB', 'LT13-OPP', 'IT']);
});

test('the stop you are at, or else the nearest, keeps its place, however likely the others look', () => {
  // At the Central Library for Opp TCOMS: the A1 here goes round through its
  // terminal, and more stops than are asked about look likelier.
  const clb = stop('CLB');
  const toTcoms = from(clb.lat, clb.lon, 'TCOMS-OPP');
  const likely = (input) => (c) => likelyTripS(GRAPH, input, c.walkS, c.legs);
  const all = uncapped(toTcoms);
  const here = all.find((c) => c.here);
  assert.equal(here.stop.code, 'CLB');
  assert.ok(all.filter((c) => likely(toTcoms)(c) < likely(toTcoms)(here)).length >= WALK.maxCandidates, codesOf(all).join());
  assert.equal(candidateStops(GRAPH, toTcoms, { nowMs: THU })[0].stop.code, 'CLB');
  // On Opp KR MRT for the Central Library, the A2 here only gets there on
  // its next run from the terminal, but it may be the one pulling in while
  // the A1 across the road is a long wait.
  const kr = stop('KR-MRT-OPP');
  assert.deepEqual(codesOf(candidateStops(GRAPH, from(kr.lat, kr.lon, 'CLB'), { nowMs: THU })), ['KR-MRT-OPP', 'KR-MRT']);
  // Between YIH and University Hall, Opp University Hall is the nearest, and
  // the least likely of the four: walking to it, it mustn't drop out of the
  // answer on the way. It takes the place of the third likeliest.
  const [nearest, ...others] = uncapped(NEAR_YIH);
  assert.equal(nearest.stop.code, 'UHALL-OPP');
  for (const c of others) assert.ok(likely(NEAR_YIH)(c) < likely(NEAR_YIH)(nearest), c.stop.code);
  assert.equal(candidateStops(GRAPH, NEAR_YIH, { nowMs: THU })[0].stop.code, 'UHALL-OPP');
});

test('a stop whose bus calls at the destination is not one that only goes near it, wherever it says to get off', () => {
  // North of BIZ 2 for PGP Foyer, a minute and a half's walk on from PGP: the
  // D2 from COM 3 and Opp TCOMS calls at the Foyer at the end of its loop,
  // and PGP is where to get off it. The A1 and R1 from BIZ 2 only go to PGP.
  const biz2 = stop('BIZ2');
  const input = from(biz2.lat + 0.0008, biz2.lon, 'PGPR', { endWalkByStopS: { PGP: 97 } });
  const cands = candidateStops(GRAPH, input, { nowMs: THU });
  assert.deepEqual(codesOf(cands), ['COM3', 'BIZ2', 'TCOMS-OPP']);
  for (const c of cands) for (const leg of c.legs) assert.equal(leg.to.code, 'PGP', `${c.stop.code} ${leg.svc}`);
});

test('an answer never asks about more shuttle stops than WALK.maxCandidates, wherever you stand', () => {
  const cls = { arriveBy: { atMs: THU + 3_600_000, venueWalkS: 0 } };
  for (const origin of GRAPH.stops) {
    for (const dest of GRAPH.stops) {
      if (dest.code === origin.code) continue;
      // Beside the stop and a street away from it, now, on a Sunday and for a class.
      for (const [dLat, more, opts] of [
        [0, {}, {}],
        [0.0008, {}, { nowMs: THU }],
        [-0.0008, {}, { nowMs: SUN }],
        [0.0008, cls, { nowMs: THU }],
      ]) {
        const cands = candidateStops(GRAPH, from(origin.lat + dLat, origin.lon, dest.code, more), opts);
        const shuttle = cands.filter((c) => !c.stop.public);
        assert.ok(shuttle.length <= WALK.maxCandidates, `${origin.code} to ${dest.code}: ${codesOf(cands).join()}`);
      }
    }
  }
});
