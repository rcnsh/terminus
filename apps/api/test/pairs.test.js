import test from 'node:test';
import assert from 'node:assert/strict';

import { stopPairs } from '../src/pairs.ts';
import { GRAPH } from '../src/graph.ts';

const stop = (code, name, lat, lon, opposite = null) => ({ code, name, longName: name, lat, lon, opposite });

// Two directions of one road: X and Opp X, 0.0002° of latitude (~22 m) apart.
const TINY = {
  generated: '2026-01-01T00:00:00Z',
  stops: [
    stop('A', 'A', 1.3, 103.77),
    stop('X-OPP', 'Opp X', 1.3002, 103.78, 'X'),
    stop('X', 'X', 1.3, 103.78, 'X-OPP'),
    stop('B', 'B', 1.3, 103.79, 'NOPE'),
    stop('C', 'C', 1.3, 103.8),
  ],
  routes: {
    // A loop: its last entry repeats the first and is one call, not two.
    L: ['A', 'X', 'B', 'X-OPP', 'A'],
    // A line: it terminates at C.
    T: ['A', 'X', 'C'],
  },
  loops: { L: true, T: false },
};

test('twins are grouped, the non-Opp side first, with a straight-line crossing', () => {
  const { places, version } = stopPairs(TINY);
  assert.equal(version, TINY.generated);
  const x = places.find((p) => p.id === 'X');
  assert.deepEqual(x.sides.map((s) => s.code), ['X', 'X-OPP']);
  assert.equal(x.crossingM, 22);
  assert.ok(!places.some((p) => p.id === 'X-OPP'), 'each stop appears once');
  assert.equal(places.flatMap((p) => p.sides).length, TINY.stops.length);
});

test("each side says which buses call and where they go next; null where one terminates", () => {
  const x = stopPairs(TINY).places.find((p) => p.id === 'X');
  assert.deepEqual(x.sides[0].services, [{ svc: 'L', next: 'B' }, { svc: 'T', next: 'C' }]);
  assert.deepEqual(x.sides[1].services, [{ svc: 'L', next: 'A' }]);
  const a = stopPairs(TINY).places.find((p) => p.id === 'A');
  assert.deepEqual(a.sides[0].services, [{ svc: 'L', next: 'X' }, { svc: 'T', next: 'X' }], 'the loop calls at A once');
  const c = stopPairs(TINY).places.find((p) => p.id === 'C');
  assert.deepEqual(c.sides[0].services, [{ svc: 'T', next: null }]);
});

test('a twin that does not exist, or does not point back, leaves a one-sided place', () => {
  const b = stopPairs(TINY).places.find((p) => p.id === 'B');
  assert.equal(b.sides.length, 1);
  assert.equal(b.crossingM, null);
});

test('on the real graph: every stop once, pairs across real roads', () => {
  const { places } = stopPairs(GRAPH);
  const codes = places.flatMap((p) => p.sides.map((s) => s.code)).sort();
  assert.deepEqual(codes, GRAPH.stops.map((s) => s.code).sort());
  for (const p of places.filter((p) => p.sides.length === 2)) {
    assert.ok(p.crossingM > 0 && p.crossingM < 200, `${p.id} crossing ${p.crossingM} m`);
    assert.equal(p.sides[0].code, p.id);
  }
  // The case the answers say "cross the road" for: D2 calls on both sides of
  // KR MRT, heading opposite ways.
  const kr = places.find((p) => p.id === 'KR-MRT');
  assert.equal(kr.sides[1].code, 'KR-MRT-OPP');
  const d2 = kr.sides.map((s) => s.services.find((c) => c.svc === 'D2')?.next);
  assert.equal(d2.length, 2);
  assert.notEqual(d2[0], d2[1]);
});
