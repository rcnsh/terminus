/**
 * The places a bus passes (src/via.ts), on the real stop graph: what a
 * board row's `via` and a nearby stop's heading say.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { GRAPH } from '../src/graph.ts';
import { indexGraph } from '../src/resolve.ts';
import { VIA_MAX, VIA_PLACES, stopVia, viaFrom, viaText } from '../src/via.ts';
import { withLang } from '../src/i18n.ts';

const idx = indexGraph(GRAPH);

test('every place is a real stop', () => {
  for (const code of Object.keys(VIA_PLACES)) assert.ok(idx.byCode.has(code), code);
});

test('a bus lists the places ahead of it, in order, each once', () => {
  // A2 from opposite YIH: past S17, then the MRT's far side, then PGP Foyer.
  assert.deepEqual(viaFrom(idx, 'A2', 'YIH-OPP'), ['Science', 'Kent Ridge MRT', 'PGP']);
  // K passes both sides of the MRT and both PGP stops; each place is named once.
  assert.deepEqual(viaFrom(idx, 'K', 'UHC', 10), ['Science', 'Kent Ridge MRT', 'PGP']);
  for (const svc of Object.keys(GRAPH.routes))
    for (const code of GRAPH.routes[svc]) assert.ok(viaFrom(idx, svc, code).length <= VIA_MAX, `${svc} at ${code}`);
});

test('never the place you are standing at, and nothing past the end of the line', () => {
  // D2 from the MRT goes round past the MRT's far side: not "Kent Ridge MRT".
  assert.ok(!viaFrom(idx, 'D2', 'KR-MRT', 10).includes('Kent Ridge MRT'));
  // R1 ends at PGP.
  assert.deepEqual(viaFrom(idx, 'R1', 'PGP'), []);
  assert.deepEqual(viaFrom(idx, 'D1', 'NOWHERE'), []);
});

test("a stop's heading is the places most of its buses pass first", () => {
  const rows = ['A1', 'D1', 'K', 'R1'].map((svc) => ({ via: viaFrom(idx, svc, 'YIH') }));
  // All four go past the library next.
  assert.equal(stopVia(rows)[0], 'Central Library');
  assert.deepEqual(stopVia([]), []);
  assert.deepEqual(stopVia([{ via: ['UTown'] }, { via: ['PGP', 'UTown'] }]), ['UTown', 'PGP']);
});

test('in words, in both languages; a faculty has its Chinese, a place keeps its name', () => {
  assert.equal(viaText(['UTown', 'Kent Ridge MRT']), 'to UTown, Kent Ridge MRT');
  assert.equal(viaText([]), null);
  withLang('zh', () => {
    assert.deepEqual(viaFrom(idx, 'A2', 'YIH-OPP'), ['理学院', 'Kent Ridge MRT', 'PGP']);
    assert.equal(viaText(['UTown', 'Kent Ridge MRT']), '往 UTown、Kent Ridge MRT 方向');
  });
});
