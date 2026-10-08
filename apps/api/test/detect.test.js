/**
 * Detection putting a wrong guess right (detect.ts): taken to be on the D2,
 * but standing still well away from its road, is a miss. On its road, or
 * after a tapped "On it", the guess stands.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { GRAPH } from '../src/graph.ts';
import { CORRIDOR_M, detect, onRoute } from '../src/detect.ts';
import { indexGraph } from '../src/resolve.ts';

const NOW = Date.parse('2026-08-27T01:10:00Z');
const BUS = { svc: 'D2', stop: 'PGP', stopCode: 'PGP', alightCode: 'UTOWN', board: '2026-08-27T01:05:00Z', arrive: '2026-08-27T01:15:00Z' };
const stop = (code) => indexGraph(GRAPH).byCode.get(code);

// Halfway along the D2 between PGP and Kent Ridge MRT: on its road.
const ON = { lat: (stop('PGP').lat + stop('KR-MRT').lat) / 2, lon: (stop('PGP').lon + stop('KR-MRT').lon) / 2 };
// About 200 m north of PGP, nowhere near the ride to UTown.
const OFF = { lat: stop('PGP').lat + 0.0018, lon: stop('PGP').lon };

const still = (p) => ({ ...p, speedMs: 0, accM: 10 });
const run = (rec, fix) => detect({ phase: 'riding', rec, bus: BUS, arrivedHere: false, fix, homeStops: [], graph: GRAPH, nowMs: NOW });

test('the places used really are on and off the D2 ride', () => {
  assert.equal(onRoute(GRAPH, BUS, still(ON), 2 * CORRIDOR_M), true);
  assert.equal(onRoute(GRAPH, BUS, still(OFF), 2 * CORRIDOR_M + 10), false);
  assert.equal(onRoute(GRAPH, BUS, still(OFF), 250), true, 'within 250 m, so about 200 m off');
});

test('a detected "boarded" standing still 200 m off the road is corrected to missed', () => {
  assert.equal(run({ kind: 'boarded', at: NOW - 5 * 60_000, detected: true, boarded: BUS }, still(OFF)), 'missed');
  // Nobody said anything: the plan assumed the bus. Same correction.
  assert.equal(run(undefined, still(OFF)), 'missed');
});

test('standing still on the road (traffic, a stop) is not a miss', () => {
  assert.equal(run({ kind: 'boarded', at: NOW - 5 * 60_000, detected: true, boarded: BUS }, still(ON)), null);
});

test('moving off the road is not a miss either: it may be a detour or a bad fix', () => {
  assert.equal(run({ kind: 'boarded', at: NOW - 5 * 60_000, detected: true, boarded: BUS }, { ...OFF, speedMs: 8, accM: 10 }), null);
});

test('a tapped "On it" is left alone', () => {
  assert.equal(run({ kind: 'boarded', at: NOW - 5 * 60_000, boarded: BUS }, still(OFF)), null);
});
