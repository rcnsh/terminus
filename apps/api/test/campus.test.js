import test from 'node:test';
import assert from 'node:assert/strict';

import graphJson from './fixtures/graph.json' with { type: 'json' };
import realGraph from '../data/stops.json' with { type: 'json' };
import venuesJson from '../data/venues.json' with { type: 'json' };

import { buildCampusMap, buildDestinations, friendlyLabel, ROUTE_COLORS, shapeFor } from '../src/map/campus.ts';
import { boardAsOf, boardAt, indexGraph, towardsFrom } from '../src/answer/resolve.ts';
import { serviceResumesAt, stoppedReason } from '../src/answer/hours.ts';
import { beforeOpening, FIRST_BUS_LEAD_S } from '../src/answer/departures.ts';
import { GRAPH as REAL, GRAPH_PUBLIC } from '../src/answer/graph.ts';
import { haversineM } from '../src/geo.ts';
import { withLang } from '../src/i18n.ts';

const GRAPH = graphJson;

test('buildCampusMap projects every core stop inside its own viewBox', () => {
  const map = buildCampusMap(realGraph);
  const [, , w, h] = map.viewBox.split(' ').map(Number);
  assert.equal(map.stops.length, realGraph.stops.length);
  for (const s of map.stops) {
    if (!s.core) continue;
    assert.ok(s.x >= 0 && s.x <= w, `${s.code} x=${s.x} outside [0,${w}]`);
    assert.ok(s.y >= 0 && s.y <= h, `${s.code} y=${s.y} outside [0,${h}]`);
  }
});

test('buildCampusMap flags the real off-campus outliers, not the dense cluster', () => {
  const map = buildCampusMap(realGraph);
  const byCode = new Map(map.stops.map((s) => [s.code, s]));
  for (const code of ['BG-MRT', 'OTH', 'CG']) {
    assert.equal(
      byCode.get(code)?.core,
      false,
      `${code}, ~5 km out on P's excursion to Botanic Gardens MRT, is an off-campus outlier the map does not shrink to fit`,
    );
  }
  const mid = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const centre = { lat: mid(realGraph.stops.map((s) => s.lat)), lon: mid(realGraph.stops.map((s) => s.lon)) };
  const near = map.stops.filter((s) => haversineM(centre.lat, centre.lon, s.lat, s.lon) < 2_000);
  assert.ok(near.length >= 20, `only ${near.length} stops within 2 km of ${centre.lat}, ${centre.lon}`);
  for (const s of near) assert.equal(s.core, true, `${s.code} is on campus and stays on the map`);
});

test('buildCampusMap keeps real relative geography: two stops far apart in lat/lon project far apart', () => {
  const map = buildCampusMap(realGraph);
  const byCode = new Map(map.stops.map((s) => [s.code, s]));
  const com3 = byCode.get('COM3');
  const pgp = byCode.get('PGP');
  assert.ok(com3 && pgp, 'COM3 and PGP, at opposite ends of the D2 loop');
  const d = Math.hypot(com3.x - pgp.x, com3.y - pgp.y);
  assert.ok(d > 50, `COM3/PGP projected only ${d}px apart -- projection collapsed`);
});

test('buildCampusMap drops the closing repeat of a loop route so the polyline has no zero-length segment', () => {
  const map = buildCampusMap(realGraph);
  assert.ok(
    Object.values(map.routes).some((r) => r.loop),
    'no loop to check',
  );
  for (const [svc, seq] of Object.entries(realGraph.routes)) {
    if (map.routes[svc].loop) {
      assert.notEqual(seq[0], map.routes[svc].seq.at(-1), `${svc}: loop-closing repeat was not dropped`);
    }
  }
});

test("each line is worded once, by its stops' plate names, each name kept on one line, in both languages", () => {
  const nb = (t) => t.replaceAll('\u00a0', ' ');
  const { routes } = buildCampusMap(REAL);
  assert.equal(nb(routes.A1.name), 'Loop from KR Bus Ter');
  assert.equal(nb(routes.A1.via), 'via AS 5, PGP, KR MRT');
  assert.equal(nb(routes.R1.name), 'Kent Vale to PGP');
  assert.equal(nb(routes.P.via), 'via BG MRT, KR MRT, UTown');
  assert.ok(!routes.P.via.includes('BG MRT'), 'no ordinary space inside a stop name');
  withLang('zh', () => {
    const zh = buildCampusMap(REAL).routes;
    assert.equal(nb(zh.A1.name), 'KR Bus Ter 环线');
    assert.equal(nb(zh.A1.via), '经 AS 5、PGP、KR MRT');
  });
});

test('every route gets a distinct, defined color', () => {
  const map = buildCampusMap(realGraph);
  const colors = new Set();
  for (const svc of Object.keys(realGraph.routes)) {
    const c = map.routes[svc].color;
    assert.ok(c, `${svc} has no color`);
    colors.add(c);
  }
  assert.equal(colors.size, Object.keys(realGraph.routes).length, 'two routes share a color');
  assert.deepEqual(new Set(Object.keys(ROUTE_COLORS)), new Set(Object.keys(realGraph.routes)));
});

test('friendlyLabel: curated landmarks resolve, mechanical faculty/LT patterns resolve, unknown codes stay null', () => {
  assert.equal(friendlyLabel('utown'), 'University Town', 'case-insensitive');
  assert.equal(friendlyLabel('COM1'), 'School of Computing (COM1)');
  assert.equal(friendlyLabel('LT27'), 'Lecture Theatre 27');
  assert.equal(friendlyLabel('AS5'), 'Faculty of Arts & Social Sciences (AS5)');
  assert.equal(friendlyLabel('E2A'), 'Faculty of Engineering (E2A)');
  assert.equal(friendlyLabel('PGPR14'), null, 'a residence-hall room block is not guessed');
  assert.equal(friendlyLabel('S10CTN'), null, 'a suffixed room code is not mistaken for a faculty block');
});

test('buildDestinations covers every stop and resolves every known venue to a real stop code', () => {
  const dest = buildDestinations(realGraph);
  const byCode = new Map(realGraph.stops.map((s) => [s.code, s]));

  const stopEntries = dest.filter((d) => d.kind === 'stop');
  assert.equal(stopEntries.length, realGraph.stops.length);

  for (const d of dest) {
    assert.ok(byCode.has(d.stopCode), `${d.code} resolves to unknown stop ${d.stopCode}`);
  }

  const com1 = dest.find((d) => d.code === 'COM1');
  assert.ok(com1, 'COM1 must be a known venue');
  assert.equal(com1.kind, 'building');
  assert.match(com1.label, /School of Computing/);
});

test('the search list has no junk: no internal ids, bare room numbers or unnamed codes', () => {
  const dest = buildDestinations(realGraph);
  assert.ok(dest.filter((d) => d.kind === 'building').length > 20, 'buildings are listed');
  for (const d of dest) {
    assert.ok(!/^\d+$/.test(d.code), `bare number ${d.code}`);
    if (d.kind === 'building') assert.notEqual(d.label, d.code, `${d.code} has no name`);
  }
  assert.ok(venuesJson.venues['1770998002592394'], 'junk stays in the import lookup table');
  assert.ok(!dest.some((d) => d.code === '1770998002592394'), 'but is never listed');
  const lt27 = dest.find((d) => d.code === 'LT27');
  assert.ok(lt27, 'lecture theatres are searchable');
  const room = dest.find((d) => d.kind === 'room' && d.label !== d.code);
  assert.ok(room, 'rooms carry their NUSMods names');
  assert.ok(dest.filter((d) => d.kind !== 'stop').every((d) => Number.isFinite(d.walkM)));
  const buildings = dest.filter((d) => d.kind === 'building').map((d) => `${d.label}|${d.stopCode}`);
  assert.equal(new Set(buildings).size, buildings.length, 'one entry per building');
});

test('nicknames: faculty short names and the obvious ones', () => {
  const dest = buildDestinations(realGraph);
  const has = (code, alias) => assert.ok(dest.find((d) => d.code === code)?.aliases?.includes(alias), `${code} ~ ${alias}`);
  has('COM1', 'soc');
  has('AS5', 'fass');
  has('KR-MRT', 'mrt');
  has('CLB', 'library');
});

test('boardAt: live etas sort first, an ended service is dropped, an unreachable feed is unknown not silent', () => {
  const idx = indexGraph(GRAPH);
  const stopCode = 'COM3';
  const nowMs = Date.parse('2026-03-02T05:00:00Z');

  const sa = {
    code: stopCode,
    arrivals: [
      { svc: 'D2', etaS: 240, crowd: null, plate: 'PA1', berth: `${stopCode}-D2-S` },
      { svc: 'D1', etaS: null, crowd: null, plate: null, berth: null },
    ],
    fetchedAt: nowMs,
    stale: false,
    available: true,
  };

  const rows = boardAt(GRAPH, idx, stopCode, sa, nowMs);
  const bySvc = new Map(rows.map((r) => [r.svc, r]));

  assert.equal(bySvc.get('D2').quality, 'live');
  assert.equal(bySvc.get('D2').etaS, 240);
  assert.equal(bySvc.get('D1').quality, 'scheduled', 'D1 answered with nothing boardable: a headway guess, not a live time');
  assert.equal(bySvc.get('D1').etaS, null);
  assert.equal(rows[0].svc, 'D2', 'live sorts ahead of scheduled, whatever the name');
});

test('boardAt: the buses after the next one come in later, soonest first, each keeping its own quality', () => {
  const idx = indexGraph(GRAPH);
  const nowMs = Date.parse('2026-03-02T05:00:00Z');
  const sa = {
    code: 'COM3',
    arrivals: [
      { svc: 'D2', etaS: 900, crowd: null, plate: 'PA2', berth: 'COM3-D2-S', scheduled: true },
      { svc: 'D2', etaS: 240, crowd: null, plate: 'PA1', berth: 'COM3-D2-S' },
      { svc: 'D2', etaS: 60, crowd: null, plate: 'PA0', berth: 'COM3-D2-E', ends: true },
      { svc: 'D1', etaS: 120, crowd: null, plate: 'PB1', berth: null },
    ],
    fetchedAt: nowMs,
    stale: true,
    available: true,
  };
  const bySvc = new Map(boardAt(GRAPH, idx, 'COM3', sa, nowMs).map((r) => [r.svc, r]));
  assert.equal(bySvc.get('D2').etaS, 240, 'a run ending here is not a bus you can board, now or later');
  assert.deepEqual(bySvc.get('D2').later, [{ etaS: 900, quality: 'scheduled', eta: '~15 min' }]);
  assert.deepEqual(bySvc.get('D1').later, []);
});

test('boardAt: an old answer counts from now, its gone buses dropped, and boardAsOf says how old', () => {
  const idx = indexGraph(GRAPH);
  const nowMs = Date.parse('2026-03-02T05:00:00Z');
  const fetchedAt = nowMs - 240_000;
  const sa = {
    code: 'COM3',
    arrivals: [
      { svc: 'D2', etaS: 120, crowd: null, plate: 'PA0', berth: null },
      { svc: 'D2', etaS: 420, crowd: null, plate: 'PA1', berth: null },
      { svc: 'D2', etaS: 900, crowd: null, plate: 'PA2', berth: null, scheduled: true },
      { svc: 'D1', etaS: 600, crowd: null, plate: 'PB1', berth: null, scheduled: true },
    ],
    fetchedAt,
    stale: true,
    available: true,
  };
  const bySvc = new Map(boardAt(GRAPH, idx, 'COM3', sa, nowMs).map((r) => [r.svc, r]));
  const d2 = bySvc.get('D2');
  assert.equal(d2.etaS, 180, 'due in 3 minutes now, not 7');
  assert.equal(d2.quality, 'stale');
  assert.equal(d2.eta, '~3 min');
  assert.deepEqual(d2.later, [{ etaS: 660, quality: 'scheduled', eta: '~11 min' }]);
  assert.equal(bySvc.get('D1').etaS, 360, 'a timetable time keeps its quality, counted from now too');
  assert.equal(bySvc.get('D1').eta, '~6 min');
  const down = { code: 'X', arrivals: [], fetchedAt: nowMs, stale: false, available: false };
  assert.equal(
    boardAsOf([sa, down, undefined], nowMs),
    fetchedAt,
    "the board is as old as its oldest feed; one that never answered doesn't count",
  );
  assert.equal(boardAsOf([down], nowMs), nowMs);
});

test('boardAt: a feed that never answered is unknown, never a fabricated time', () => {
  const idx = indexGraph(GRAPH);
  const nowMs = Date.parse('2026-03-02T05:00:00Z');
  const sa = { code: 'COM3', arrivals: [], fetchedAt: nowMs, stale: false, available: false };
  const rows = boardAt(GRAPH, idx, 'COM3', sa, nowMs);
  assert.ok(rows.every((r) => r.quality === 'unknown' && r.etaS === null));
});

test('boardAt: each row has its colour, where it goes, how full the first bus is and when the service ends', () => {
  const idx = indexGraph(REAL);
  const nowMs = Date.parse('2026-10-07T05:00:00Z');
  const sa = {
    code: 'YIH',
    arrivals: [
      { svc: 'K', etaS: 600, crowd: 'low', plate: 'PK2', berth: null },
      { svc: 'K', etaS: 180, crowd: 'high', plate: 'PK1', berth: null },
      { svc: 'A1', etaS: null, crowd: null, plate: null, berth: null },
    ],
    fetchedAt: nowMs,
    stale: false,
    available: true,
  };
  const bySvc = new Map(boardAt(REAL, idx, 'YIH', sa, nowMs).map((r) => [r.svc, r]));
  const k = bySvc.get('K');
  assert.equal(k.color, '#2b9ad6');
  assert.deepEqual(k.towards, ['Central Library', "Prince George's Park Foyer"]);
  assert.equal(k.crowd, 'high', 'the first bus’s, not the later one’s');
  assert.equal(k.endsAt, '2026-10-07T15:04:00.000Z', 'K runs until 23:04 on a weekday');
  const a1 = bySvc.get('A1');
  assert.equal(a1.crowd, null, 'no bus, no crowding');
  assert.deepEqual(a1.towards, ['Central Library', 'Kent Ridge Bus Terminal'], 'A1 is a loop: it ends where it started');
});

test('towards: a loop runs on from its last stop to its first; the end of a line goes nowhere', () => {
  const idx = indexGraph(REAL);
  assert.deepEqual(towardsFrom(idx, 'D1', 'BIZ2'), ['COM 3'], "from D1's last stop the next stop is the end: one name");
  assert.deepEqual(towardsFrom(idx, 'D1', 'COM3'), ['Opp HSSML', 'COM 3']);
  assert.deepEqual(towardsFrom(idx, 'K', 'PGPR'), [], 'K ends at PGP Foyer and does not loop');
  assert.deepEqual(towardsFrom(idx, 'K', 'NOPE'), []);
  assert.deepEqual(towardsFrom(idx, 'Z9', 'YIH'), []);
  const twice = indexGraph({
    stops: ['A', 'B', 'C'].map((code) => ({ code, name: code })),
    routes: { X: ['A', 'B', 'A', 'C'] },
    loops: { X: false },
  });
  assert.deepEqual(towardsFrom(twice, 'X', 'A'), ['B', 'C'], 'a route calling at a stop twice goes on from its first call there');
});

test('boardAt: a public bus has no colour of its own and still says where it goes', () => {
  const idx = indexGraph(GRAPH_PUBLIC);
  const code = REAL.stops.map((s) => s.code).find((c) => (idx.servingStop.get(c) ?? []).some((svc) => svc.includes('/')));
  const nowMs = Date.parse('2026-10-07T05:00:00Z');
  const sa = { code, arrivals: [], fetchedAt: nowMs, stale: false, available: true };
  const pub = boardAt(GRAPH_PUBLIC, idx, code, sa, nowMs).filter((r) => r.paid);
  assert.ok(pub.length, `public buses at ${code}`);
  for (const r of pub) {
    assert.equal(r.color, null);
    assert.ok(
      r.towards.every((t) => typeof t === 'string' && t.length),
      JSON.stringify(r.towards),
    );
    assert.ok(!r.svc.includes('/'), 'shown by its number, not its route key');
  }
});

const sgtAt = (day, h, m = 0) => Date.UTC(2026, 9, day, h - 8, m);
const iso = (ms) => new Date(ms).toISOString();

test('stopped services: ended for today, not yet started, or no service today, and when each is back', () => {
  assert.equal(stoppedReason(REAL, 'R1', sgtAt(7, 21, 30)), 'ended', 'Wednesday 21:30: R1 finished at 19:30, back Thursday 07:40');
  assert.equal(iso(serviceResumesAt(REAL, 'R1', sgtAt(7, 21, 30))), '2026-10-07T23:40:00.000Z');
  assert.equal(stoppedReason(REAL, 'R1', sgtAt(10, 9)), 'noService', "R1 doesn't run at weekends");
  assert.equal(iso(serviceResumesAt(REAL, 'R1', sgtAt(10, 9))), iso(sgtAt(12, 7, 40)));
  assert.equal(stoppedReason(REAL, 'K', sgtAt(7, 6)), 'notYet', 'K starts at 07:04');
  assert.equal(iso(serviceResumesAt(REAL, 'K', sgtAt(7, 6))), iso(sgtAt(7, 7, 4)));
  assert.equal(stoppedReason(REAL, 'R1', sgtAt(7, 12)), null);
  assert.equal(stoppedReason(REAL, 'Z9', sgtAt(7, 3)), null);
  assert.equal(serviceResumesAt(REAL, 'Z9', sgtAt(7, 3)), null, 'unknown hours count as running, with no next start');
  assert.equal(stoppedReason(REAL, 'R1', Date.UTC(2026, 11, 25, 2)), 'noService', 'Christmas Day is a public holiday: Sunday hours');
  assert.equal(iso(serviceResumesAt(REAL, 'R1', Date.UTC(2026, 11, 24, 13))), iso(Date.UTC(2026, 11, 27, 23, 40)));
  const never = { ...REAL, serviceHours: { X: { weekday: null, saturday: null, sunday: null } } };
  assert.equal(stoppedReason(never, 'X', sgtAt(7, 12)), 'noService', 'never runs');
  assert.equal(serviceResumesAt(never, 'X', sgtAt(7, 12)), null);
});

test('boardAt with stopped: services outside their hours come last, greyed, unless the feed still has a bus', () => {
  const idx = indexGraph(REAL);
  const nowMs = sgtAt(7, 21, 30);
  const sa = {
    code: 'PGP',
    arrivals: [{ svc: 'K', etaS: 120, crowd: 'low', plate: 'PK1', berth: null }],
    fetchedAt: nowMs,
    stale: false,
    available: true,
  };
  const plain = boardAt(REAL, idx, 'PGP', sa, nowMs);
  assert.ok(
    plain.every((r) => r.running === true && !('stopped' in r) && !('resumesAt' in r)),
    'unchanged without it, apart from running',
  );
  assert.ok(!plain.some((r) => r.svc === 'R1'));
  const rows = boardAt(REAL, idx, 'PGP', sa, nowMs, { stopped: true });
  assert.deepEqual(rows.slice(0, plain.length), plain, 'the running rows as before, first');
  const off = rows.slice(plain.length);
  assert.deepEqual(
    off.map((r) => r.svc),
    ['R1', 'R2'],
    'then the stopped ones, by name',
  );
  const r1 = off[0];
  assert.deepEqual(r1, {
    svc: 'R1',
    etaS: null,
    quality: 'ended',
    ambiguousBerth: false,
    later: [],
    color: '#f57c1f',
    towards: r1.towards,
    via: r1.via,
    crowd: null,
    endsAt: null,
    running: false,
    stopped: 'ended',
    resumesAt: '2026-10-07T23:40:00.000Z',
    eta: null,
    laterText: null,
    toText: r1.toText,
  });
  const late = { ...sa, arrivals: [...sa.arrivals, { svc: 'R1', etaS: 300, crowd: null, plate: 'PR1', berth: null }] };
  const r1Live = boardAt(REAL, idx, 'PGP', late, nowMs, { stopped: true }).find((r) => r.svc === 'R1');
  assert.equal(r1Live.running, true, 'the feed still reporting an R1 wins: a running row');
  assert.equal(r1Live.etaS, 300);
  assert.equal('stopped' in r1Live, false);
});

test("before a service opens, the feed's times hours ahead are not shown as live buses", () => {
  const idx = indexGraph(REAL);
  const night = sgtAt(8, 1, 13);
  const sa = (nowMs, arrivals) => ({ code: 'PGPR', arrivals, fetchedAt: nowMs, stale: false, available: true });
  const far = sa(night, [
    { svc: 'A2', etaS: 29_004, crowd: null, plate: 'PA1', berth: null },
    { svc: 'D2', etaS: 29_514, crowd: null, plate: 'PD1', berth: null },
  ]);
  const rows = boardAt(REAL, idx, 'PGPR', far, night, { stopped: true });
  for (const svc of ['A2', 'D2']) {
    const r = rows.find((x) => x.svc === svc);
    assert.equal(r.running, false, svc);
    assert.equal(r.stopped, 'notYet');
    assert.equal(r.resumesAt, iso(sgtAt(8, 7, 15)), 'from its hours, as K is');
  }
  assert.ok(!boardAt(REAL, idx, 'PGPR', far, night).some((r) => r.svc === 'A2'), 'left out of a board without stopped ones');

  const late = boardAt(REAL, idx, 'PGPR', sa(night, [{ svc: 'A2', etaS: 120, crowd: null, plate: 'PA1', berth: null }]), night);
  assert.equal(late.find((r) => r.svc === 'A2').quality, 'live', 'a bus still out from the night before is live');

  const early = sgtAt(8, 7, 5);
  const first = boardAt(REAL, idx, 'PGPR', sa(early, [{ svc: 'A2', etaS: 900, crowd: null, plate: 'PA1', berth: null }]), early).find(
    (r) => r.svc === 'A2',
  );
  assert.equal(first.running, true);
  assert.equal(first.quality, 'scheduled', "the first A2, before the opening, as the timetable's time");
  assert.equal(first.eta, '~15 min');

  const at = (etaS) => [{ svc: 'A2', etaS, crowd: null, plate: null, berth: null }];
  const open = sgtAt(8, 7, 15);
  assert.equal(beforeOpening(REAL, 'A2', at(open / 1000 - early / 1000 + FIRST_BUS_LEAD_S), early, early).length, 0, 'past the lead');
  assert.equal(beforeOpening(REAL, 'A2', at(FIRST_BUS_LEAD_S), early, early)[0].scheduled, true, 'at the lead');
  const noon = sgtAt(8, 12);
  assert.deepEqual(beforeOpening(REAL, 'A2', at(29_004), noon, noon), at(29_004), 'running: the feed as it is');
});

test('food courts are in the search, each with both of its stops', () => {
  const dest = buildDestinations(realGraph);
  const deck = dest.find((d) => d.code === 'THE-DECK');
  assert.equal(deck.kind, 'landmark');
  assert.deepEqual(deck.stops, ['AS5', 'NUSS-OPP']);
  assert.ok(deck.aliases.includes('deck'));
  assert.deepEqual(dest.find((d) => d.code === 'TECHNO-EDGE').stops, ['IT', 'CLB']);
  assert.deepEqual(dest.find((d) => d.code === 'FRONTIER-FOOD').stops, ['S17', 'LT27']);
});

test('every service colour has an ink, white or near-black #1c1917 as inkOn picks, that reaches WCAG 4.5:1 on it', () => {
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(((n >> 16) & 255) / 255) + 0.7152 * lin(((n >> 8) & 255) / 255) + 0.0722 * lin((n & 255) / 255);
  };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  for (const [svc, color] of Object.entries(ROUTE_COLORS)) {
    const best = Math.max(ratio(color, '#ffffff'), ratio(color, '#1c1917'));
    assert.ok(best >= 4.5, `${svc} ${color}: ${best.toFixed(2)}`);
  }
});

test('services wear the colours NUS paints them', () => {
  assert.equal(ROUTE_COLORS.A1, '#d32f2f', 'red');
  assert.equal(ROUTE_COLORS.A2, '#d9a000', 'yellow');
  assert.equal(ROUTE_COLORS.D2, '#8e44c9', 'purple');
  assert.equal(ROUTE_COLORS.K, '#2b9ad6', 'light blue');
  assert.equal(ROUTE_COLORS.R1, '#f57c1f', 'orange');
  assert.equal(ROUTE_COLORS.R2, '#34a853', 'green');
});

test('every route is drawn along the roads, through its own stops', () => {
  const map = buildCampusMap(realGraph);
  const byCode = new Map(realGraph.stops.map((s) => [s.code, s]));
  for (const [svc, seq] of Object.entries(realGraph.routes)) {
    const r = map.routes[svc];
    assert.equal(r.shaped, true, `${svc} has no road shape for its current stops: run scripts/data/route_shapes.py`);
    assert.ok(r.line.length > seq.length, `${svc} line is too coarse`);
    for (const code of seq) {
      const st = byCode.get(code);
      const near = Math.min(...r.line.map(([lon, lat]) => Math.hypot((lon - st.lon) * 111_320, (lat - st.lat) * 110_540)));
      assert.ok(near < 70, `${svc}: ${code} is ${Math.round(near)} m from the line it joined the road at`);
    }
  }
});

test('a route whose stops changed since the shapes were made is drawn straight, not wrong', () => {
  const seq = [...realGraph.routes.D2];
  seq.splice(2, 1);
  assert.equal(shapeFor('D2', seq), null);
  const graph = { ...realGraph, routes: { ...realGraph.routes, D2: seq } };
  const r = buildCampusMap(graph).routes.D2;
  assert.equal(r.shaped, false);
  assert.equal(r.line.length, seq.length);
});

test('each stop lists the services that call there', () => {
  const map = buildCampusMap(realGraph);
  const com3 = map.stops.find((s) => s.code === 'COM3');
  assert.deepEqual(com3.services.sort(), ['D1', 'D2']);
  for (const s of map.stops) assert.ok(s.services.length > 0, `${s.code} has no services`);
});

test('search lists each place once: LT3 is a building and a room of the same name', () => {
  const dest = buildDestinations(realGraph);
  const seen = new Map();
  for (const d of dest) {
    const k = `${d.code}|${d.label}`;
    assert.ok(!seen.has(k), `${d.code} "${d.label}" is listed as a ${seen.get(k)} and a ${d.kind}`);
    seen.set(k, d.kind);
  }
  assert.equal(dest.filter((d) => d.code === 'LT3').length, 1);
});

test('code-unit order picks the same first code per building and lists residences as localeCompare did, for the real data', async () => {
  const entries = Object.entries(venuesJson.venues);
  const winners = (cmp) => {
    const won = new Map();
    for (const [code, v] of [...entries].sort(([a], [b]) => a.length - b.length || cmp(a, b))) {
      const label = friendlyLabel(code);
      if (label && !won.has(`${label}|${v.stop}`)) won.set(`${label}|${v.stop}`, code);
    }
    return won;
  };
  const units = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  assert.deepEqual(
    winners(units),
    winners((a, b) => a.localeCompare(b)),
  );

  const { residenceList } = await import('../src/answer/residences.ts');
  const list = residenceList();
  const locale = [...list].sort((a, b) => Number(b.common) - Number(a.common) || a.name.localeCompare(b.name));
  assert.deepEqual(
    list.map((r) => r.code),
    locale.map((r) => r.code),
  );
});

test('boardAt: a service whose rows the feed garbled has no data; the rest of the stop is live', () => {
  const idx = indexGraph(GRAPH);
  const nowMs = Date.parse('2026-03-02T05:00:00Z');
  const sa = {
    code: 'COM3',
    arrivals: [{ svc: 'D1', etaS: 120, crowd: null, plate: 'PB1', berth: null }],
    fetchedAt: nowMs,
    stale: false,
    available: true,
    unread: ['D2'],
  };
  const bySvc = new Map(boardAt(GRAPH, idx, 'COM3', sa, nowMs).map((r) => [r.svc, r]));
  assert.equal(bySvc.get('D1').quality, 'live');
  assert.equal(bySvc.get('D1').etaS, 120);
  assert.equal(bySvc.get('D2').quality, 'unknown', 'no data, not a headway guess');
  assert.equal(bySvc.get('D2').etaS, null);
  const { unread: _u, ...read } = sa;
  assert.equal(
    new Map(boardAt(GRAPH, idx, 'COM3', read, nowMs).map((r) => [r.svc, r])).get('D2').quality,
    'scheduled',
    'without the mark, no rows is the feed\'s "no bus": a guess',
  );
});
