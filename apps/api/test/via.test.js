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
  assert.deepEqual(viaFrom(idx, 'A2', 'YIH-OPP'), ['S 17', 'Opp KR MRT', 'PGP Foyer']);
  assert.deepEqual(viaFrom(idx, 'K', 'UHC', 10), ['S 17', 'Opp KR MRT', 'PGP Foyer']);
  for (const svc of Object.keys(GRAPH.routes))
    for (const code of GRAPH.routes[svc]) assert.ok(viaFrom(idx, svc, code).length <= VIA_MAX, `${svc} at ${code}`);
});

test('never the place you are standing at, and nothing past the end of the line', () => {
  assert.ok(!viaFrom(idx, 'D2', 'KR-MRT', 10).includes('Opp KR MRT'));
  assert.deepEqual(viaFrom(idx, 'R1', 'PGP'), []);
  assert.deepEqual(viaFrom(idx, 'D1', 'NOWHERE'), []);
});

test("a stop's heading is the places most of its buses pass first", () => {
  const rows = ['A1', 'D1', 'K', 'R1'].map((svc) => ({ via: viaFrom(idx, svc, 'YIH') }));
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
  assert.deepEqual(lineVia(idx, 'P'), ['BG MRT', 'KR MRT', 'UTown']);
  assert.deepEqual(lineVia(idx, 'A1'), ['AS 5', 'PGP', 'KR MRT']);
  assert.deepEqual(lineVia(idx, 'R2'), ['UTown']);
  assert.ok(!lineVia(idx, 'K').some((s) => s.startsWith('PGP')));
  for (const svc of Object.keys(GRAPH.routes)) assert.ok(lineVia(idx, svc).length <= VIA_MAX, svc);
  assert.deepEqual(lineVia(idx, 'NOWHERE'), []);
});
