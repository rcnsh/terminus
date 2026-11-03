import test from 'node:test';
import assert from 'node:assert/strict';

import { GRAPH } from '../src/answer/graph.ts';
import { etaText, indexGraph, nearbyDest, withWalk } from '../src/answer/resolve.ts';
import { viaFrom } from '../src/answer/via.ts';

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

test('withWalk: a shuttle with two buses from the feed gets a third, a headway on, as an estimate', () => {
  const r = withWalk(row(4 * 60, [16 * 60]), 180, NOW, 12 * 60);
  assert.deepEqual(
    r.later.map((b) => [b.etaS, b.quality]),
    [
      [16 * 60, 'live'],
      [28 * 60, 'scheduled'],
    ],
  );
  assert.match(r.later[1].eta, /^~/);
});

test('withWalk: one bus from the feed gets two guessed after it', () => {
  const r = withWalk(row(4 * 60), 180, NOW, 10 * 60);
  assert.deepEqual(
    r.later.map((b) => b.etaS),
    [14 * 60, 24 * 60],
  );
});

test('withWalk: no bus is guessed past the last one, or for a public bus, or with no time', () => {
  const ends = { ...row(4 * 60, [16 * 60]), endsAt: new Date(NOW + 20 * 60_000).toISOString() };
  assert.equal(withWalk(ends, 180, NOW, 12 * 60).later.length, 1);
  assert.equal(withWalk({ ...row(4 * 60, [16 * 60]), paid: true }, 180, NOW, 12 * 60).later.length, 1);
  assert.equal(withWalk(row(null), 180, NOW, 12 * 60).later.length, 0);
});

const IDX = indexGraph(GRAPH);
const dest = (svc, code) => nearbyDest(IDX, svc, code, viaFrom(IDX, svc, code)).dest.replaceAll('\u00a0', ' ');

test('nearbyDest: the two loops from COM 3 are told apart at COM 3, by the place each goes first', () => {
  assert.equal(dest('D1', 'COM3'), 'via UTown');
  assert.equal(dest('D2', 'COM3'), 'via PGP');
});

test('nearbyDest: a line says its end by the short name on that stop’s plate; at its end, Ends here', () => {
  assert.equal(dest('K', 'CLB'), 'to PGP Foyer');
  assert.equal(dest('R1', 'KV'), 'to PGP');
  assert.equal(dest('R1', 'PGP'), 'Ends here');
});

test('nearbyDest: destPlace is the place alone, null where there is none', () => {
  assert.deepEqual(nearbyDest(IDX, 'D1', 'COM3', viaFrom(IDX, 'D1', 'COM3')), { dest: 'via UTown', destPlace: 'UTown' });
  assert.equal(nearbyDest(IDX, 'R1', 'PGP', viaFrom(IDX, 'R1', 'PGP')).destPlace, null);
});

test('nearbyDest: a loop with no well-known place ahead says where it ends, not that it goes through it', () => {
  assert.equal(dest('A1', 'CLB'), 'to KR Bus Ter');
});

test('nearbyDest: a short place stays on one line; a long one may wrap', () => {
  const { destPlace } = nearbyDest(IDX, 'A1', 'CLB', viaFrom(IDX, 'A1', 'CLB'));
  assert.equal(destPlace, 'KR\u00a0Bus\u00a0Ter');
});

test('etaText: an estimate under a minute is ~1 min, never now, which would pass for a bus at the stop', () => {
  assert.equal(etaText(20, 'scheduled'), '~1 min');
  assert.equal(etaText(20, 'stale'), '~1 min');
  assert.equal(etaText(20, 'live'), 'now');
});
