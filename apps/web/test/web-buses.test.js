/**
 * The web app's Stops tab (apps/web/public/app/buses.js): where you are in
 * it, from the address (#buses/stop/YIH, #buses/line/D1/YIH), the pinned
 * stops' boards, the board across the road, and pinning stops.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { useLang, web } from './_web.mjs';
import { buildCampusMap, buildDestinations } from '../../api/src/map/campus.ts';
import { GRAPH } from '../../api/src/answer/graph.ts';
import { residenceList } from '../../api/src/answer/residences.ts';
import { indexGraph } from '../../api/src/answer/resolve.ts';
import { lineStops } from '../../api/src/map/buses.ts';

useLang('en');
const B = await web('app/buses.js');
const P = await web('account/profile.js');

const map = buildCampusMap(GRAPH);
P.campus.set(
  JSON.parse(
    JSON.stringify({
      viewBox: map.viewBox,
      stops: map.stops,
      routes: map.routes,
      destinations: buildDestinations(GRAPH),
      residences: residenceList(),
    }),
  ),
);

test("a line's address reads back as the line, whatever its names hold", () => {
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

test("a stop's address, and anything else is the home", () => {
  assert.deepEqual(B.parse('#buses/stop/YIH'), { kind: 'stop', code: 'YIH' });
  assert.deepEqual(B.parse(`#buses/stop/${encodeURIComponent('A/B')}`), { kind: 'stop', code: 'A/B' });
  assert.deepEqual(B.parse('#buses/line/D1/'), { kind: 'line', svc: 'D1', stop: null });
  // A stray % (an address edited by hand) is read as it is, not thrown over.
  assert.deepEqual(B.parse('#buses/stop/50%'), { kind: 'stop', code: '50%' });
  for (const hash of ['#buses', '#buses/', '#buses/stop/', '#buses/stop', '#buses/line/', '#buses/nope/YIH', '', '#map'])
    assert.deepEqual(B.parse(hash), { kind: 'home' }, hash);
});

test("a stop's page is its own address, whether it's pinned or not, and reads back as the stop", () => {
  P.profile.set({ pinnedStops: ['YIH'] });
  for (const code of ['YIH', 'UTOWN', 'KR-MRT-OPP', 'A/B']) assert.deepEqual(B.parse(B.stopHash(code)), { kind: 'stop', code });
  assert.equal(B.stopHash('YIH'), '#buses/stop/YIH');
});

/** A fetch answering /api/me/stops with an empty board for each stop asked, noting each ask's codes. */
function stopsFetch(asked, { fail = false } = {}) {
  return async (url) => {
    const u = new URL(url, 'http://x');
    assert.equal(u.pathname, '/api/me/stops');
    const codes = u.searchParams.get('codes').split(',');
    asked.push(codes);
    if (fail) return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
    const stops = codes
      .filter((c) => c !== 'NOPE')
      .map((code) => ({ stop: { code, name: code, longName: code }, walkS: null, available: true, via: [], viaText: null, board: [] }));
    return new Response(JSON.stringify({ stops, asOf: new Date().toISOString() }), { headers: { 'content-type': 'application/json' } });
  };
}

test('the home fetches the pinned stop on screen and the ones either side of it, and the last page the last stop', () => {
  const pinned = ['COM3', 'YIH', 'UTOWN', 'KR-MRT'];
  assert.deepEqual(B.signWindow(pinned, null), ['COM3', 'YIH']);
  assert.deepEqual(B.signWindow(pinned, 'COM3'), ['COM3', 'YIH']);
  assert.deepEqual(B.signWindow(pinned, 'UTOWN'), ['YIH', 'UTOWN', 'KR-MRT']);
  assert.deepEqual(B.signWindow(pinned, 'KR-MRT'), ['UTOWN', 'KR-MRT']);
  assert.deepEqual(B.signWindow(pinned, B.ADD), ['KR-MRT']);
  // A pick no longer pinned is the first page until the home settles it.
  assert.deepEqual(B.signWindow(pinned, 'PGP'), ['COM3', 'YIH']);
  assert.deepEqual(B.signWindow([], null), []);
  assert.equal(B.pageOf(pinned, B.ADD), 4);
});

test('pulled down on the home: the pinned stop on screen fetched again, and with nothing pinned or on the last page, nothing asked', async () => {
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = stopsFetch(asked);
  try {
    B.route.set({ kind: 'home' });
    B.signs.set(new Map());
    B.chosen.set(null);
    P.profile.set({ pinnedStops: [] });
    assert.equal((await B.pullRefresh()).state, 'fresh');
    assert.deepEqual(asked, []);
    P.profile.set({ pinnedStops: ['YIH', 'UTOWN', 'COM3'] });
    B.chosen.set('UTOWN');
    assert.equal(await B.pullRefresh(), 'updated');
    // One ask, for it and its neighbours.
    assert.deepEqual(asked, [['YIH', 'UTOWN', 'COM3']]);
    // Just fetched: not asked again.
    assert.equal((await B.pullRefresh()).state, 'fresh');
    assert.equal(asked.length, 1);
    B.chosen.set(B.ADD);
    B.signs.set(new Map());
    assert.equal((await B.pullRefresh()).state, 'fresh');
    assert.equal(asked.length, 1);
  } finally {
    globalThis.fetch = realFetch;
    B.signs.set(new Map());
    B.chosen.set(null);
  }
});

test("a pinned stop's sign that couldn't update keeps its times and says so; a stop the server doesn't know has none", async () => {
  const realFetch = globalThis.fetch;
  const asked = [];
  try {
    B.signs.set(new Map());
    globalThis.fetch = stopsFetch(asked);
    await B.loadSigns(['YIH', 'NOPE']);
    const was = B.signs.get().get('YIH');
    assert.equal(was.s.stop.code, 'YIH');
    assert.equal(was.error, undefined);
    assert.equal(B.signs.get().get('NOPE').gone, true);
    globalThis.fetch = stopsFetch(asked, { fail: true });
    await B.loadSigns(['YIH', 'UTOWN']);
    assert.equal(B.signs.get().get('YIH').s, was.s, 'the last times stay');
    assert.equal(B.signs.get().get('YIH').error, B.failedWords(true));
    assert.equal(B.signs.get().get('UTOWN').error, B.failedWords(false));
  } finally {
    globalThis.fetch = realFetch;
    B.signs.set(new Map());
  }
});

test("the lines' counts are asked for at most once a minute, however often the home asks", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const realFetch = globalThis.fetch;
  let asked = 0;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), '/api/lines');
    asked++;
    const lines = { D1: { out: 3, outText: '3 out', stale: false }, A1: null };
    return new Response(JSON.stringify({ lines, asOf: new Date().toISOString() }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    await B.loadOuts();
    assert.equal(asked, 1);
    assert.deepEqual(B.outs.get().D1, { out: 3, outText: '3 out', stale: false });
    assert.equal(B.outs.get().A1, null);
    await B.loadOuts();
    t.mock.timers.tick(59_000);
    await B.loadOuts();
    assert.equal(asked, 1);
    t.mock.timers.tick(1_000);
    await B.loadOuts();
    assert.equal(asked, 2);
    // Counts that can't be brought up to date go, as for a feed that didn't answer.
    globalThis.fetch = async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
    t.mock.timers.tick(60_000);
    await B.loadOuts();
    assert.equal(B.outs.get(), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a service's page brings the list its newer count, and an older list doesn't put the old one back", async (t) => {
  // Well after the last test's asks, which set when the list may ask again.
  const start = Date.now() + 3_600_000;
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const realFetch = globalThis.fetch;
  const at = (s) => new Date(start + s * 1000).toISOString();
  const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const one = { out: 1, outText: '1 out', stale: false };
  const none = { out: 0, outText: 'None out', stale: false };
  try {
    // The list counted K's last bus a moment before it left the feed.
    globalThis.fetch = async () => json({ lines: { K: one, D1: one }, asOf: at(0) });
    await B.loadOuts();
    assert.deepEqual(B.outs.get().K, one);
    // K's page, opened later, has none out: the list says so too, even when the page's asOf is pulled back by an old stop row.
    t.mock.timers.tick(30_000);
    globalThis.fetch = async () => json({ svc: 'K', stops: [], buses: [], out: none, asOf: at(-120) });
    await B.loadLine('K', null);
    assert.deepEqual(B.outs.get(), { K: none, D1: one });
    // A list counted before the page (a kept copy) keeps the page's count; a newer one wins.
    globalThis.fetch = async () => json({ lines: { K: one, D1: one }, asOf: at(10) });
    t.mock.timers.tick(60_000);
    await B.loadOuts();
    assert.deepEqual(B.outs.get(), { K: none, D1: one });
    globalThis.fetch = async () => json({ lines: { K: one, D1: none }, asOf: at(50) });
    t.mock.timers.tick(60_000);
    await B.loadOuts();
    assert.deepEqual(B.outs.get(), { K: one, D1: none });
    // An older server's page, with no count, leaves the list as it is.
    globalThis.fetch = async () => json({ svc: 'D1', stops: [], buses: [{ id: 'x' }], asOf: at(55) });
    await B.loadLine('D1', null);
    assert.deepEqual(B.outs.get().D1, none);
  } finally {
    globalThis.fetch = realFetch;
    B.line.set(null);
  }
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
  const eight = ['COM3', 'YIH', 'UTOWN', 'KR-MRT', 'CLB', 'IT', 'LT13', 'UHC'];
  globalThis.fetch = async (url, init) => {
    // The save is made on the server's copy, read first.
    if (init?.method !== 'PUT') return new Response(JSON.stringify({ pinnedStops: eight.slice(0, 7) }), { headers: { etag: '"1"' } });
    saved.push(JSON.parse(init.body));
    return new Response(init.body, { headers: { 'content-type': 'application/json', etag: '"2"' } });
  };
  try {
    await P.loadProfile();
    P.toastText.set(null);
    await P.togglePin('UHC');
    assert.deepEqual(P.profile.get().pinnedStops, eight);
    assert.equal(P.toastText.get(), null);
    // The save goes once the edits settle.
    mock.timers.tick(400);
    for (let i = 0; i < 50 && P.toastText.get()?.text !== 'Saved'; i++) await new Promise((ok) => setImmediate(ok));
    assert.deepEqual(saved.at(-1).pinnedStops, eight);
    assert.deepEqual(P.toastText.get(), { text: 'Saved', error: false });

    await P.togglePin('PGP');
    assert.deepEqual(P.profile.get().pinnedStops, eight);
    assert.deepEqual(P.toastText.get(), { text: 'You can pin up to 8 stops.', error: true });

    // Unpinning is always allowed.
    await P.togglePin('YIH');
    assert.deepEqual(
      P.profile.get().pinnedStops,
      eight.filter((c) => c !== 'YIH'),
    );

    // The profile's own limit, when it sends one.
    P.profile.set({ pinnedStops: ['COM3', 'YIH', 'UTOWN'], limits: { pinnedStops: 3 } });
    await P.togglePin('PGP');
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
    new Response(JSON.stringify({ asOf, stop: { code: 'YIH', name: 'YIH' }, available: true, board: [row] }), {
      headers: { 'content-type': 'application/json' },
    });
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
    // The later buses' words are from then: worded again from their seconds.
    assert.deepEqual(old.later, [{ etaS: 860, eta: null }]);
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

test("a line's refresh that hung (the phone asleep) cannot put back older times over newer ones", async () => {
  const realFetch = globalThis.fetch;
  const reply = (n) =>
    new Response(JSON.stringify({ svc: 'D1', asOf: new Date().toISOString(), stops: [], buses: [], n }), {
      headers: { 'content-type': 'application/json' },
    });
  let release;
  const hung = new Promise((ok) => {
    release = ok;
  });
  let calls = 0;
  globalThis.fetch = () => (++calls === 1 ? hung : Promise.resolve(reply(2)));
  try {
    B.line.set(null);
    B.route.set({ kind: 'line', svc: 'D1', stop: 'YIH' });
    const first = B.loadLine('D1', 'YIH');
    // The refresh comes a while later (the phone woke up).
    await new Promise((ok) => setTimeout(ok, 5));
    await B.loadLine('D1', 'YIH');
    assert.equal(B.line.get().data.n, 2);
    // The older answer lands last: the newer stays.
    release(reply(1));
    await first;
    assert.equal(B.line.get().data.n, 2);
    // An error landing late doesn't cover fresh times either.
    globalThis.fetch = () => Promise.resolve(new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }));
    const failing = B.loadLine('D1', 'YIH');
    globalThis.fetch = () => Promise.resolve(reply(3));
    await new Promise((ok) => setTimeout(ok, 5));
    await B.loadLine('D1', 'YIH');
    await failing;
    assert.equal(B.line.get().data.n, 3);
    assert.equal(B.line.get().error, undefined);
  } finally {
    globalThis.fetch = realFetch;
    B.line.set(null);
    B.route.set({ kind: 'home' });
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
  const sched = B.aged(
    {
      svc: 'A1',
      etaS: 400,
      eta: '~7 min',
      quality: 'scheduled',
      later: [
        { etaS: 1_000, quality: 'scheduled' },
        { etaS: 1_500, quality: 'live' },
      ],
      laterText: 'then ~17, 25 min',
    },
    got,
    got + 40_000,
  );
  assert.equal(sched.eta, null);
  assert.equal(Board.etaText(sched.etaS, sched.quality), '~6 min');
  assert.equal(Board.thenText(sched), 'then ~16, ~24 min');
  // No more of them than the server names.
  const { THEN_MAX } = await import('../../api/src/answer/resolve.ts');
  assert.equal(Board.THEN_MAX, THEN_MAX);
  const many = B.aged(
    { svc: 'A1', etaS: 400, quality: 'live', later: [600, 900, 1_200, 1_500].map((etaS) => ({ etaS, quality: 'live' })) },
    got,
    got,
  );
  assert.equal(Board.thenText(many), 'then 10, 15 min');
  const live = B.aged({ svc: 'D1', etaS: 400, eta: '7 min', quality: 'live', later: [] }, got, got + 40_000);
  assert.equal(Board.etaText(live.etaS, live.quality), '~6 min');
  assert.equal(Board.etaText(400, 'live'), '7 min');
});

test('an estimate under a minute is ~1 min, never Arriving, which would pass for a bus at the stop', async () => {
  const Board = await web('app/board.js');
  const text = (v) =>
    v == null || typeof v === 'boolean' ? '' : typeof v !== 'object' ? String(v) : [v.props?.children].flat(Infinity).map(text).join('');
  const got = 1_000_000;
  const aged = (quality) => B.aged({ svc: 'A1', etaS: 60, eta: '1 min', quality, later: [] }, got, got + 40_000);
  assert.equal(text(Board.Big({ r: aged('scheduled') })), '~1 min');
  assert.equal(text(Board.Big({ r: aged('live') })), '~1 min');
  assert.equal(text(Board.Big({ r: { svc: 'A1', etaS: 20, quality: 'live', later: [] } })), 'Arriving');
});

test("a Nearby row is said as the apps say it: the line, where it's going, each bus, never a tilde", async () => {
  const Board = await web('app/board.js');
  const row = {
    svc: 'D2',
    dest: 'via PGP',
    etaS: 120,
    quality: 'live',
    later: [
      { etaS: 840, quality: 'live' },
      { etaS: 1560, quality: 'scheduled' },
    ],
  };
  assert.equal(Board.saidRow(row), 'Bus D2, via PGP, 2 minutes, live, then 14 minutes, then about 26 minutes');
  assert.equal(Board.saidRow({ ...row, etaS: 20, quality: 'scheduled', later: [] }), 'Bus D2, via PGP, about 1 minute, estimated');
  assert.equal(Board.saidRow({ ...row, etaS: 20, later: [] }), 'Bus D2, via PGP, Arriving');
  assert.equal(
    Board.saidRow({ svc: '151', paid: true, dest: 'to Kent Ridge Ter', etaS: 360, quality: 'live', later: [] }),
    'Public bus 151, fare applies, to Kent Ridge Ter, 6 minutes, live',
  );
});

test("before /api/line comes, every service's line drawn from the campus data is the one it brings: stops, names and services", () => {
  const routes = P.campus.get().routes;
  const idx = indexGraph(GRAPH);
  assert.ok(Object.keys(routes).length >= 6, 'found the routes');
  for (const [svc, r] of Object.entries(routes)) {
    assert.deepEqual(JSON.parse(JSON.stringify(B.campusLine(svc, r))), JSON.parse(JSON.stringify(lineStops(idx, svc))), svc);
  }
});
