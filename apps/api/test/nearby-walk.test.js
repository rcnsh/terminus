import test from 'node:test';
import assert from 'node:assert/strict';

import { withWalk } from '../src/answer/resolve.ts';

const NOW = Date.parse('2026-08-27T08:21:00Z');
const row = (etaS, later = []) => ({
  svc: 'A1',
  etaS,
  quality: 'live',
  ambiguousBerth: false,
  later: later.map((s) => ({ etaS: s, quality: 'live', eta: `${Math.round(s / 60)} min` })),
  color: '#d32f2f',
  towards: ['LT 27', 'Kent Ridge MRT'],
  via: [],
  crowd: null,
  endsAt: null,
  running: true,
  eta: etaS == null ? null : `${Math.round(etaS / 60)} min`,
  laterText: null,
  toText: 'to LT 27, Kent Ridge MRT',
});

test('withWalk: a bus due before the walk is over is too soon to catch; the next one is not', () => {
  const r = withWalk(row(120, [840]), 180, NOW);
  assert.equal(r.tooSoon, true);
  assert.equal(r.later[0].tooSoon, undefined);
});

test('withWalk: a bus due as the walk ends can be caught', () => {
  const r = withWalk(row(180), 180, NOW);
  assert.equal('tooSoon' in r, false);
});

test('withWalk: each bus gets its clock time, to the nearest minute', () => {
  const r = withWalk(row(4 * 60 + 20, [16 * 60 + 40]), 180, NOW);
  assert.equal(r.at, '2026-08-27T08:25:00Z');
  assert.equal(r.later[0].at, '2026-08-27T08:38:00Z');
});

test('withWalk: a row with no time has no clock time and is never too soon', () => {
  const r = withWalk(row(null), 180, NOW);
  assert.equal(r.at, null);
  assert.equal('tooSoon' in r, false);
});
