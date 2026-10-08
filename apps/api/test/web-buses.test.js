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

test('a board kept by the server (asOf minutes old) is counted down from when it came, not from asOf again', async () => {
  const D = await web('account/dom.js');
  const realFetch = globalThis.fetch;
  const asOf = new Date(D.serverNow() - 5 * 60_000).toISOString();
  // The server has already counted its times down to its own now.
  const row = { svc: 'D1', etaS: 300, eta: '5 min', quality: 'live', later: [{ etaS: 900 }] };
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ asOf, stop: { code: 'YIH', name: 'YIH' }, available: true, board: [row] }), { headers: { 'content-type': 'application/json' } });
  try {
    B.boards.set(new Map());
    await B.loadBoard('YIH');
    const b = B.boards.get().get('YIH');
    assert.equal(b.asOf, Date.parse(asOf), 'asOf is kept for "Updated 5 min ago"');
    // Just fetched: the server's times as they are, live.
    assert.deepEqual(B.aged(b.board[0], b.got, b.got + 1_000), row);
    // Refreshes failing for 40 s: 40 s off, once, and no longer live.
    const old = B.aged(b.board[0], b.got, b.got + 40_000);
    assert.equal(old.etaS, 260);
    assert.equal(old.quality, 'stale');
    assert.equal(old.old, true);
    assert.deepEqual(old.later, [{ etaS: 860 }]);
    // A failed refresh keeps when the board last came.
    globalThis.fetch = async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
    await B.loadBoard('YIH');
    assert.equal(B.boards.get().get('YIH').got, b.got);
    assert.ok(B.boards.get().get('YIH').error);
  } finally {
    globalThis.fetch = realFetch;
    B.boards.set(new Map());
  }
});

test('a failed refresh under times already shown says they could not be updated, not that there are none', () => {
  assert.equal(B.failedWords(true, true), "Couldn't update. Trying again soon.");
  assert.equal(B.failedWords(false, true), 'No times right now');
  assert.equal(B.failedWords(true, false), 'Live times need a connection.');
});

test('an aged timetabled or live time keeps its "~", as the server words a guess', async () => {
  const Board = await web('app/board.js');
  const got = 1_000_000;
  const sched = B.aged({ svc: 'A1', etaS: 400, eta: '~7 min', quality: 'scheduled', later: [{ etaS: 1_000, quality: 'scheduled' }, { etaS: 1_500, quality: 'live' }], laterText: 'then ~17, 25 min' }, got, got + 40_000);
  assert.equal(sched.eta, null);
  assert.equal(Board.etaText(sched.etaS, sched.quality), '~6 min');
  assert.equal(Board.thenText(sched), 'then ~16, ~24 min');
  const live = B.aged({ svc: 'D1', etaS: 400, eta: '7 min', quality: 'live', later: [] }, got, got + 40_000);
  assert.equal(Board.etaText(live.etaS, live.quality), '~6 min');
  assert.equal(Board.etaText(400, 'live'), '7 min');
});
