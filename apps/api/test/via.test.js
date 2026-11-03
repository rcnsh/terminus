/**
 * The stops worth naming on a bus's way (src/answer/via.ts), on the real stop
 * graph: what a board row's `via`, a nearby stop's heading and a line's row on
 * the Stops tab say, by the names on the stops' plates.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { GRAPH } from '../src/answer/graph.ts';
import { indexGraph } from '../src/answer/resolve.ts';
import { VIA_MAX, VIA_PLACES, lineVia, stopVia, viaFrom, viaText } from '../src/answer/via.ts';
import { withLang } from '../src/i18n.ts';

const idx = indexGraph(GRAPH);

test('every place is a real stop', () => {
  for (const code of Object.keys(VIA_PLACES)) assert.ok(idx.byCode.has(code), code);
});

test('a bus lists the stops ahead of it, in order, each place once, by their plates', () => {
  // A2 from opposite YIH: past S17, then the MRT's far side, then PGP Foyer.
  assert.deepEqual(viaFrom(idx, 'A2', 'YIH-OPP'), ['S 17', 'Opp KR MRT', 'PGP Foyer']);
  // K passes both sides of the MRT and both PGP stops; each place is named once, by the first it reaches.
  assert.deepEqual(viaFrom(idx, 'K', 'UHC', 10), ['S 17', 'Opp KR MRT', 'PGP Foyer']);
  for (const svc of Object.keys(GRAPH.routes))
    for (const code of GRAPH.routes[svc]) assert.ok(viaFrom(idx, svc, code).length <= VIA_MAX, `${svc} at ${code}`);
});

test('never the place you are standing at, and nothing past the end of the line', () => {
  // D2 from the MRT goes round past the MRT's far side: not the MRT again.
  assert.ok(!viaFrom(idx, 'D2', 'KR-MRT', 10).includes('Opp KR MRT'));
  // R1 ends at PGP.
  assert.deepEqual(viaFrom(idx, 'R1', 'PGP'), []);
  assert.deepEqual(viaFrom(idx, 'D1', 'NOWHERE'), []);
});

test("a stop's heading is the places most of its buses pass first", () => {
  const rows = ['A1', 'D1', 'K', 'R1'].map((svc) => ({ via: viaFrom(idx, svc, 'YIH') }));
  // All four go past the library next.
  assert.equal(stopVia(rows)[0], 'CLB');
  assert.deepEqual(stopVia([]), []);
  assert.deepEqual(stopVia([{ via: ['UTown'] }, { via: ['PGP', 'UTown'] }]), ['UTown', 'PGP']);
});

test('in words, in both languages; a stop keeps its plate name in Chinese', () => {
  assert.equal(viaText(['UTown', 'KR MRT']), 'to UTown, KR MRT');
  assert.equal(viaText([]), null);
  withLang('zh', () => {
    assert.deepEqual(viaFrom(idx, 'A2', 'YIH-OPP'), ['S 17', 'Opp KR MRT', 'PGP Foyer']);
    assert.equal(viaText(['UTown', 'KR MRT']), '往 UTown、KR MRT 方向');
  });
});

test("a whole line's stops: up to three, an MRT first, in the order it reaches them, never its ends", () => {
  // P passes both MRTs and UTown, and starts and ends at Kent Vale.
  assert.deepEqual(lineVia(idx, 'P'), ['BG MRT', 'KR MRT', 'UTown']);
  // A1 passes four; the MRT and PGP are kept over BIZ 2 and CLB, Arts as the first of the rest.
  assert.deepEqual(lineVia(idx, 'A1'), ['AS 5', 'PGP', 'KR MRT']);
  // R2 ends at Kent Vale, which its name already says.
  assert.deepEqual(lineVia(idx, 'R2'), ['UTown']);
  // K runs PGP to PGP Foyer, one place: neither end is named.
  assert.ok(!lineVia(idx, 'K').some((s) => s.startsWith('PGP')));
  for (const svc of Object.keys(GRAPH.routes)) assert.ok(lineVia(idx, svc).length <= VIA_MAX, svc);
  assert.deepEqual(lineVia(idx, 'NOWHERE'), []);
});
