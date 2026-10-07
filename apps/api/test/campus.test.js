import test from 'node:test';
import assert from 'node:assert/strict';

import graphJson from './fixtures/graph.json' with { type: 'json' };
import realGraph from '../data/stops.json' with { type: 'json' };
import venuesJson from '../data/venues.json' with { type: 'json' };

import { buildCampusMap, buildDestinations, friendlyLabel, ROUTE_COLORS, shapeFor } from '../src/campus.ts';
import { boardAt, indexGraph, serviceResumesAt, stoppedReason, towardsFrom } from '../src/resolve.ts';
import { GRAPH as REAL, GRAPH_PUBLIC } from '../src/graph.ts';

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
  // Real distances from the campus centroid (computed once from data/stops.json):
  // 30 stops sit within ~1.1km; BG-MRT, OTH and CG sit at ~5.3km+ on P's
  // excursion to Botanic Gardens MRT. A wrong classification here would
  // either shrink the whole map to fit 3 far stops, or silently drop real
  // campus stops from the map.
  const map = buildCampusMap(realGraph);
  const byCode = new Map(map.stops.map((s) => [s.code, s]));
  for (const code of ['BG-MRT', 'OTH', 'CG']) {
    assert.equal(byCode.get(code)?.core, false, `${code} should be classified as an off-campus outlier`);
  }
  const coreCount = map.stops.filter((s) => s.core).length;
  assert.equal(coreCount, realGraph.stops.length - 3, 'exactly the 3 known outliers are excluded from the core');
});

test('buildCampusMap keeps real relative geography: two stops far apart in lat/lon project far apart', () => {
  // COM3 and PGP are on opposite ends of the D2 loop.
  const map = buildCampusMap(realGraph);
  const byCode = new Map(map.stops.map((s) => [s.code, s]));
  const com3 = byCode.get('COM3');
  const pgp = byCode.get('PGP');
  assert.ok(com3 && pgp, 'fixture must carry both stops');
  const d = Math.hypot(com3.x - pgp.x, com3.y - pgp.y);
  assert.ok(d > 50, `COM3/PGP projected only ${d}px apart -- projection collapsed`);
});

test('buildCampusMap drops the closing repeat of a loop route so the polyline has no zero-length segment', () => {
  const map = buildCampusMap(realGraph);
  for (const [svc, seq] of Object.entries(realGraph.routes)) {
    if (map.routes[svc].loop) {
      assert.notEqual(seq[0], map.routes[svc].seq.at(-1), `${svc}: loop-closing repeat was not dropped`);
    }
  }
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
  for (const d of dest) {
    assert.ok(!/^\d+$/.test(d.code), `bare number ${d.code}`);
    if (d.kind === 'building') assert.notEqual(d.label, d.code, `${d.code} has no name`);
  }
  // Junk stays in the import lookup table, just never listed.
  assert.ok(venuesJson.venues['1770998002592394']);
  assert.ok(!dest.some((d) => d.code === '1770998002592394'));
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
  const stopCode = 'COM3'; // hosts D1 and D2 in the fixture graph
  const nowMs = Date.parse('2026-03-02T05:00:00Z'); // 13:00 SGT, well inside service hours

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
  // D1 answered with nothing boardable -- a headway guess, not a live time.
  assert.equal(bySvc.get('D1').quality, 'scheduled');
  assert.equal(bySvc.get('D1').etaS, null);
  // live sorts ahead of scheduled regardless of service name.
  assert.equal(rows[0].svc, 'D2');
});

test('boardAt: the buses after the next one come in later, soonest first, each keeping its own quality', () => {
  const idx = indexGraph(GRAPH);
  const nowMs = Date.parse('2026-03-02T05:00:00Z');
  const sa = {
    code: 'COM3',
    arrivals: [
      { svc: 'D2', etaS: 900, crowd: null, plate: 'PA2', berth: 'COM3-D2-S', scheduled: true },
      { svc: 'D2', etaS: 240, crowd: null, plate: 'PA1', berth: 'COM3-D2-S' },
      // A run ending here is not a bus you can board, now or later.
      { svc: 'D2', etaS: 60, crowd: null, plate: 'PA0', berth: 'COM3-D2-E' },
      { svc: 'D1', etaS: 120, crowd: null, plate: 'PB1', berth: null },
    ],
    fetchedAt: nowMs,
    stale: true,
    available: true,
  };
  const bySvc = new Map(boardAt(GRAPH, idx, 'COM3', sa, nowMs).map((r) => [r.svc, r]));
  assert.equal(bySvc.get('D2').etaS, 240);
  assert.deepEqual(bySvc.get('D2').later, [{ etaS: 900, quality: 'scheduled' }]);
  assert.deepEqual(bySvc.get('D1').later, []);
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
  // Wednesday 7 October 2026, 13:00 in Singapore.
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
  // K runs YIH, CLB, ... and ends at PGP Foyer: the next stop, then the end, by their full names.
  assert.deepEqual(k.towards, ['Central Library', "Prince George's Park Foyer"]);
  assert.equal(k.crowd, 'high', 'the first bus’s, not the later one’s');
  assert.equal(k.endsAt, '2026-10-07T15:04:00.000Z', 'K runs until 23:04 on a weekday');
  const a1 = bySvc.get('A1');
  assert.equal(a1.crowd, null, 'no bus, no crowding');
  assert.deepEqual(a1.towards, ['Central Library', 'Kent Ridge Bus Terminal'], 'A1 is a loop: it ends where it started');
});

test('towards: a loop runs on from its last stop to its first; the end of a line goes nowhere', () => {
  const idx = indexGraph(REAL);
  // D1's last stop before COM3 again: the next stop is the end, so one name.
  assert.deepEqual(towardsFrom(idx, 'D1', 'BIZ2'), ['COM 3']);
  assert.deepEqual(towardsFrom(idx, 'D1', 'COM3'), ['Opp HSSML', 'COM 3']);
  // K ends at PGP Foyer and does not loop.
  assert.deepEqual(towardsFrom(idx, 'K', 'PGPR'), []);
  assert.deepEqual(towardsFrom(idx, 'K', 'NOPE'), []);
  assert.deepEqual(towardsFrom(idx, 'Z9', 'YIH'), []);
  // A route calling at a stop twice goes on from its first call there.
  const twice = indexGraph({ stops: ['A', 'B', 'C'].map((code) => ({ code, name: code })), routes: { X: ['A', 'B', 'A', 'C'] }, loops: { X: false } });
  assert.deepEqual(towardsFrom(twice, 'X', 'A'), ['B', 'C']);
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
    assert.ok(r.towards.every((t) => typeof t === 'string' && t.length), JSON.stringify(r.towards));
    assert.ok(!r.svc.includes('/'), 'shown by its number, not its route key');
  }
});

// Singapore time, as epoch ms: October 2026 has no public holidays on these days.
const sgtAt = (day, h, m = 0) => Date.UTC(2026, 9, day, h - 8, m);
const iso = (ms) => new Date(ms).toISOString();

test('stopped services: ended for today, not yet started, or no service today, and when each is back', () => {
  // Wednesday 7 October, 21:30: R1 finished at 19:30 and is back Thursday at 07:40.
  assert.equal(stoppedReason(REAL, 'R1', sgtAt(7, 21, 30)), 'ended');
  assert.equal(iso(serviceResumesAt(REAL, 'R1', sgtAt(7, 21, 30))), '2026-10-07T23:40:00.000Z');
  // Saturday 10 October, 09:00: R1 doesn't run at weekends; back Monday 12th at 07:40.
  assert.equal(stoppedReason(REAL, 'R1', sgtAt(10, 9)), 'noService');
  assert.equal(iso(serviceResumesAt(REAL, 'R1', sgtAt(10, 9))), iso(sgtAt(12, 7, 40)));
  // A weekday at 06:00: K starts at 07:04.
  assert.equal(stoppedReason(REAL, 'K', sgtAt(7, 6)), 'notYet');
  assert.equal(iso(serviceResumesAt(REAL, 'K', sgtAt(7, 6))), iso(sgtAt(7, 7, 4)));
  // Running: no reason. Unknown hours count as running, and have no next start.
  assert.equal(stoppedReason(REAL, 'R1', sgtAt(7, 12)), null);
  assert.equal(stoppedReason(REAL, 'Z9', sgtAt(7, 3)), null);
  assert.equal(serviceResumesAt(REAL, 'Z9', sgtAt(7, 3)), null);
  // Christmas Day 2026 is a Friday and a public holiday: Sunday hours, so R1 is
  // off from the Thursday evening until Monday 28th.
  assert.equal(stoppedReason(REAL, 'R1', Date.UTC(2026, 11, 25, 2)), 'noService');
  assert.equal(iso(serviceResumesAt(REAL, 'R1', Date.UTC(2026, 11, 24, 13))), iso(Date.UTC(2026, 11, 27, 23, 40)));
  // Never runs: nothing found.
  const never = { ...REAL, serviceHours: { X: { weekday: null, saturday: null, sunday: null } } };
  assert.equal(stoppedReason(never, 'X', sgtAt(7, 12)), 'noService');
  assert.equal(serviceResumesAt(never, 'X', sgtAt(7, 12)), null);
});

test('boardAt with stopped: services outside their hours come last, greyed, unless the feed still has a bus', () => {
  const idx = indexGraph(REAL);
  const nowMs = sgtAt(7, 21, 30); // R1 and R2 have finished
  const sa = { code: 'PGP', arrivals: [{ svc: 'K', etaS: 120, crowd: 'low', plate: 'PK1', berth: null }], fetchedAt: nowMs, stale: false, available: true };
  const plain = boardAt(REAL, idx, 'PGP', sa, nowMs);
  assert.ok(plain.every((r) => r.running === true && !('stopped' in r) && !('resumesAt' in r)), 'unchanged without it, apart from running');
  assert.ok(!plain.some((r) => r.svc === 'R1'));
  const rows = boardAt(REAL, idx, 'PGP', sa, nowMs, { stopped: true });
  assert.deepEqual(rows.slice(0, plain.length), plain, 'the running rows as before, first');
  const off = rows.slice(plain.length);
  assert.deepEqual(off.map((r) => r.svc), ['R1', 'R2'], 'then the stopped ones, by name');
  const r1 = off[0];
  assert.deepEqual(r1, {
    svc: 'R1', etaS: null, quality: 'ended', ambiguousBerth: false, later: [], color: '#f57c1f',
    towards: r1.towards, crowd: null, endsAt: null, running: false, stopped: 'ended', resumesAt: '2026-10-07T23:40:00.000Z',
  });
  // The feed still reporting an R1 at PGP: the feed wins, and it is a running row.
  const late = { ...sa, arrivals: [...sa.arrivals, { svc: 'R1', etaS: 300, crowd: null, plate: 'PR1', berth: null }] };
  const r1Live = boardAt(REAL, idx, 'PGP', late, nowMs, { stopped: true }).find((r) => r.svc === 'R1');
  assert.equal(r1Live.running, true);
  assert.equal(r1Live.etaS, 300);
  assert.equal('stopped' in r1Live, false);
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

test('services wear the colours NUS paints them', () => {
  assert.equal(ROUTE_COLORS.A1, '#e53935', 'red');
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
    assert.equal(r.shaped, true, `${svc} has no road shape for its current stops: run scripts/route_shapes.py`);
    assert.ok(r.line.length > seq.length, `${svc} line is too coarse`);
    // Each stop is near the line (it joined the road there).
    for (const code of seq) {
      const st = byCode.get(code);
      const near = Math.min(...r.line.map(([lon, lat]) => Math.hypot((lon - st.lon) * 111_320, (lat - st.lat) * 110_540)));
      assert.ok(near < 70, `${svc}: ${code} is ${Math.round(near)} m from the line`);
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
