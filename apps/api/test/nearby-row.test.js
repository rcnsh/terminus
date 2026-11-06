import test from 'node:test';
import assert from 'node:assert/strict';

import { GRAPH, GRAPH_PUBLIC } from '../src/answer/graph.ts';
import { etaText, indexGraph, nearbyDest, nearbyRow, thenText, towardsFrom } from '../src/answer/resolve.ts';
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
  endsAt: new Date(NOW + 6 * 3600_000).toISOString(),
  running: true,
  eta: etaS == null ? null : `${Math.round(etaS / 60)} min`,
  laterText: null,
  toText: 'to LT 27, Kent Ridge MRT',
});

test('nearbyRow: each bus gets its clock time, to the nearest minute', () => {
  const r = nearbyRow(row(4 * 60 + 20, [16 * 60 + 40]), NOW);
  assert.equal(r.at, '2026-08-27T08:25:00Z');
  assert.equal(r.later[0].at, '2026-08-27T08:38:00Z');
});

test('nearbyRow: a row with no time has no clock time', () => {
  const r = nearbyRow(row(null), NOW);
  assert.equal(r.at, null);
});

test('nearbyRow: a bus due in a minute is shown as it comes, whatever the walk to the stop', () => {
  const r = nearbyRow(row(60, [840]), NOW);
  assert.equal(r.etaS, 60);
  assert.equal('tooSoon' in r, false);
  assert.equal('tooSoon' in r.later[0], false);
});

/** Estimated departures every `gapS` after `etaS` from now, as departures.ts gives them. */
const guesses = (etaS, gapS, n = 3) =>
  Array.from({ length: n }, (_, i) => {
    const t = NOW + (etaS + (i + 1) * gapS) * 1000;
    return { id: `x+${i + 1}`, kind: 'estimate', earliest: t, latest: t };
  });

test('nearbyRow: a shuttle with two buses from the feed gets a third, its next estimate', () => {
  const r = nearbyRow(row(4 * 60, [16 * 60]), NOW, guesses(16 * 60, 12 * 60));
  assert.deepEqual(
    r.later.map((b) => [b.etaS, b.quality]),
    [
      [16 * 60, 'live'],
      [28 * 60, 'scheduled'],
    ],
  );
  assert.match(r.later[1].eta, /^~/);
});

test('nearbyRow: one bus from the feed gets two estimates after it', () => {
  const r = nearbyRow(row(4 * 60), NOW, guesses(4 * 60, 10 * 60));
  assert.deepEqual(
    r.later.map((b) => b.etaS),
    [14 * 60, 24 * 60],
  );
});

test('nearbyRow: no bus is guessed for a public bus, or with no time', () => {
  assert.equal(nearbyRow({ ...row(4 * 60, [16 * 60]), paid: true }, NOW, guesses(16 * 60, 12 * 60)).later.length, 1);
  assert.equal(nearbyRow(row(null), NOW, guesses(0, 12 * 60)).later.length, 0);
});

test('nearbyRow: laterText names the buses the row now has, guessed ones too', () => {
  const r = nearbyRow(row(4 * 60), NOW, guesses(4 * 60, 10 * 60));
  assert.equal(r.laterText, thenText(r.later));
  assert.match(r.laterText, /14/);
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

test('nearbyDest: a two-way public bus, named on its row as one service, says where the direction calling here goes', () => {
  const pub = indexGraph(GRAPH_PUBLIC);
  const code = pub.routes.get('151/1').seq[2];
  assert.deepEqual(nearbyDest(pub, '151', code, viaFrom(pub, '151/1', code)), nearbyDest(pub, '151/1', code, viaFrom(pub, '151/1', code)));
  assert.notEqual(nearbyDest(pub, '151', code, []).dest, 'Ends here');
});

test('nearbyDest: at a stop both ways of a public bus call at, each row says where its own way goes', () => {
  const pub = indexGraph(GRAPH_PUBLIC);
  const [one, two] = ['151/1', '151/2'].map(
    (k) => nearbyDest(pub, '151', '16009', viaFrom(pub, k, '16009'), towardsFrom(pub, k, '16009')).dest,
  );
  assert.equal(one, nearbyDest(pub, '151/1', '16009', []).dest);
  assert.equal(two, nearbyDest(pub, '151/2', '16009', []).dest);
  assert.notEqual(one, two);
});
