import test from 'node:test';
import assert from 'node:assert/strict';

import { stopPairs } from '../src/pairs.ts';
import { GRAPH, mergeOpposites } from '../src/graph.ts';
import { candidateStops, legRideS } from '../src/resolve.ts';
import { RIDE } from '../src/config.ts';
import oppositesJson from '../data/opposites.json' with { type: 'json' };

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

test('hand-listed pairs join the scraped ones and stay mutual', () => {
  const stops = [stop('A', 'A', 1, 1, 'A-OPP'), stop('A-OPP', 'Opp A', 1, 1, 'A'), stop('B', 'B', 1, 1), stop('C', 'C', 1, 1)];
  const merged = mergeOpposites(stops, [['A', 'B'], ['C', 'NOPE']]);
  const by = Object.fromEntries(merged.map((s) => [s.code, s.opposite]));
  assert.deepEqual(by, { A: 'B', B: 'A', 'A-OPP': null, C: null }, "A's old twin is let go; an unknown code is ignored");
  assert.equal(stops[0].opposite, 'A-OPP', 'the input is not mutated');
});

test('the hand-listed pairs: BIZ 2 and Opp HSSML, AS 5 and Opp NUSS', () => {
  const by = new Map(GRAPH.stops.map((s) => [s.code, s]));
  for (const [a, b] of oppositesJson.pairs) {
    assert.ok(by.has(a) && by.has(b), `${a} and ${b} are real stops`);
    assert.equal(by.get(a).opposite, b);
    assert.equal(by.get(b).opposite, a);
  }
  for (const s of GRAPH.stops) if (s.opposite) assert.equal(by.get(s.opposite)?.opposite, s.code, `${s.code} pairs both ways`);
  assert.equal(by.get('SDE3-OPP').opposite ?? null, null, 'SDE3-OPP has no twin');
  const ids = stopPairs(GRAPH).places.filter((p) => p.sides.length === 2).map((p) => p.sides.map((s) => s.code).join('+'));
  assert.ok(ids.includes('AS5+NUSS-OPP') && ids.includes('BIZ2+HSSML-OPP'), ids.join(' '));
});

test('a bus that stops on the far side counts, with the walk back across in its ride time', () => {
  // PGP to AS 5: R2 calls at Opp NUSS two stops on; A1 goes the long way round.
  const [c] = candidateStops(GRAPH, { to: 'AS5', originCode: 'PGP', lat: null, lon: null });
  const r2 = c.legs.find((l) => l.svc === 'R2');
  const a1 = c.legs.find((l) => l.svc === 'A1');
  assert.ok(r2 && r2.crossS > 60 && r2.crossS < 240, `R2 crosses in ${r2?.crossS}s`);
  assert.equal(legRideS(r2), r2.hops * RIDE.secondsPerHop + r2.crossS);
  assert.ok(a1 && !a1.crossS, 'the bus to the stop itself has no crossing');
  // Both sides reachable: the cheaper one wins, crossing counted.
  const [it] = candidateStops(GRAPH, { to: 'AS5', originCode: 'IT', lat: null, lon: null });
  for (const l of it.legs) assert.ok(legRideS(l) > 0);
});

test('the class card names the stop to get off at, only when there is one', async () => {
  const { cardFor } = await import('../src/card.ts');
  const { default: fixture } = await import('./fixtures/answers/class-from-dorm.json', { with: { type: 'json' } });
  const { card: _card, refreshAt: _r, ...answer } = fixture;
  const plain = cardFor(answer);
  assert.equal(plain.catch, 'Catch the ~09:42 R2 at PGP');
  const off = cardFor({ ...answer, leave: { ...answer.leave, off: 'Opp NUSS' } });
  assert.equal(off.catch, 'Catch the ~09:42 R2 at PGP, off at Opp NUSS');
  assert.match(off.catchLine, /^Catch the ~09:42 R2 at PGP, off at Opp NUSS · arrive /);
  assert.match(off.leaveVia, /R2 at PGP, off at Opp NUSS$/);
});
