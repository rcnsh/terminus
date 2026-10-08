/**
 * The web app's Buses tab (apps/web/public/app/buses.js): where you are in
 * it, from the address (#buses/stop/YIH, #buses/line/D1/YIH), the home's
 * pages, the board across the road, and pinning stops.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { useLang, web } from './_web.mjs';
import { buildCampusMap, buildDestinations } from '../src/campus.ts';
import { GRAPH } from '../src/graph.ts';
import { residenceList } from '../src/residences.ts';

useLang('en');
const B = await web('app/buses.js');
const P = await web('account/profile.js');

const map = buildCampusMap(GRAPH);
P.campus.set(JSON.parse(JSON.stringify({ viewBox: map.viewBox, stops: map.stops, routes: map.routes, destinations: buildDestinations(GRAPH), residences: residenceList() })));

test('a line\'s address reads back as the line, whatever its names hold', () => {
  for (const [svc, stop] of [
    ['D1', 'YIH'],
    ['A1', null],
    ['151/1', '16151'],
    ['95', 'KR-MRT-OPP'],
    ['A 1?#', 'S%17'],
  ]) {
    const hash = B.lineHash(svc, stop);
    assert.match(hash, /^#buses\/line\//);
    assert.deepEqual(B.parse(hash), { kind: 'line', svc, stop }, hash);
  }
  assert.equal(B.lineHash('D1', 'YIH'), '#buses/line/D1/YIH');
  assert.equal(B.lineHash('D1', null), '#buses/line/D1');
});

test('a stop\'s address, and anything else is the home', () => {
  assert.deepEqual(B.parse('#buses/stop/YIH'), { kind: 'stop', code: 'YIH' });
  assert.deepEqual(B.parse(`#buses/stop/${encodeURIComponent('A/B')}`), { kind: 'stop', code: 'A/B' });
  assert.deepEqual(B.parse('#buses/line/D1/'), { kind: 'line', svc: 'D1', stop: null });
  for (const hash of ['#buses', '#buses/', '#buses/stop/', '#buses/stop', '#buses/line/', '#buses/nope/YIH', '', '#map']) assert.deepEqual(B.parse(hash), { kind: 'home' }, hash);
});

test('the home: the nearest stop (or finding it), then each pinned stop not already there', () => {
  assert.deepEqual(B.pagesOf({ status: 'loading' }, []), [{ kind: 'loading' }]);
  assert.deepEqual(B.pagesOf({ status: 'none' }, ['YIH']), [{ kind: 'find' }, { kind: 'pinned', code: 'YIH' }]);
  assert.deepEqual(B.pagesOf({ status: 'ready', code: 'COM3' }, ['YIH', 'COM3', 'UTOWN']), [
    { kind: 'nearest', code: 'COM3' },
    { kind: 'pinned', code: 'YIH' },
    { kind: 'pinned', code: 'UTOWN' },
  ]);
});

test("Back from a line goes to the stop's page on the home if it has one, else to the stop's own", () => {
  B.nearest.set({ status: 'ready', code: 'COM3' });
  P.profile.set({ pinnedStops: ['YIH'] });
  assert.equal(B.stopParent('COM3'), '#buses');
  assert.equal(B.stopParent('YIH'), '#buses');
  assert.equal(B.stopParent('UTOWN'), '#buses/stop/UTOWN');
  assert.deepEqual(B.parse(B.stopParent('KR-MRT-OPP')), { kind: 'stop', code: 'KR-MRT-OPP' });
  assert.deepEqual(B.parse(B.stopParent('COM3')), { kind: 'home' });
});

test('the stop across the road: from its board, else the campus map; the board shown is that one when asked', () => {
  B.boards.set(new Map());
  B.across.set(new Set());
  assert.equal(B.oppositeOf('YIH'), 'YIH-OPP');
  assert.equal(B.oppositeOf('KR-MRT'), 'KR-MRT-OPP');
  assert.equal(B.oppositeOf('COM3'), null);
  assert.equal(B.oppositeOf('NOT-A-STOP'), null);
  // The board knows better (a public stop with its own code).
  B.boards.set(new Map([['COM3', { stop: { code: 'COM3', opposite: '16189' } }]]));
  assert.equal(B.oppositeOf('COM3'), '16189');
  assert.equal(B.shownCode('YIH'), 'YIH');
  B.across.set(new Set(['YIH', 'UTOWN']));
  assert.equal(B.shownCode('YIH'), 'YIH-OPP');
  // Nothing across the road: its own board.
  assert.equal(B.shownCode('UTOWN'), 'UTOWN');
  B.boards.set(new Map());
  B.across.set(new Set());
});

test('up to 8 stops pinned (or as many as the profile allows), then a message and nothing pinned', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const realFetch = globalThis.fetch;
  const saved = [];
  globalThis.fetch = async (url, init) => {
    saved.push(JSON.parse(init.body));
    return new Response(init.body, { headers: { 'content-type': 'application/json' } });
  };
  try {
    const eight = ['COM3', 'YIH', 'UTOWN', 'KR-MRT', 'CLB', 'IT', 'LT13', 'UHC'];
    P.profile.set({ pinnedStops: eight.slice(0, 7) });
    P.toastText.set(null);
    await B.togglePin('UHC');
    assert.deepEqual(P.profile.get().pinnedStops, eight);
    assert.equal(P.toastText.get(), null);
    // The save goes once the edits settle.
    mock.timers.tick(400);
    for (let i = 0; i < 50 && P.toastText.get()?.text !== 'Saved'; i++) await new Promise((ok) => setImmediate(ok));
    assert.deepEqual(saved.at(-1).pinnedStops, eight);
    assert.deepEqual(P.toastText.get(), { text: 'Saved', error: false });

    await B.togglePin('PGP');
    assert.deepEqual(P.profile.get().pinnedStops, eight);
    assert.deepEqual(P.toastText.get(), { text: 'You can pin up to 8 stops.', error: true });

    // Unpinning is always allowed.
    await B.togglePin('YIH');
    assert.deepEqual(P.profile.get().pinnedStops, eight.filter((c) => c !== 'YIH'));

    // The profile's own limit, when it sends one.
    P.profile.set({ pinnedStops: ['COM3', 'YIH', 'UTOWN'], limits: { pinnedStops: 3 } });
    await B.togglePin('PGP');
    assert.deepEqual(P.profile.get().pinnedStops, ['COM3', 'YIH', 'UTOWN']);
    assert.deepEqual(P.toastText.get(), { text: 'You can pin up to 3 stops.', error: true });
  } finally {
    globalThis.fetch = realFetch;
    mock.timers.reset();
  }
});
