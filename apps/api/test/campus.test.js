import test from 'node:test';
import assert from 'node:assert/strict';

import graphJson from './fixtures/graph.json' with { type: 'json' };
import realGraph from '../data/stops.json' with { type: 'json' };
import venuesJson from '../data/venues.json' with { type: 'json' };

import { buildCampusMap, buildDestinations, friendlyLabel, ROUTE_COLORS, shapeFor, SHAPES } from '../src/campus.ts';
import { alongLine, nextStopIndex } from '../src/buses.ts';
import { boardAt, indexGraph } from '../src/resolve.ts';

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

test('boardAt: a feed that never answered is unknown, never a fabricated time', () => {
  const idx = indexGraph(GRAPH);
  const nowMs = Date.parse('2026-03-02T05:00:00Z');
  const sa = { code: 'COM3', arrivals: [], fetchedAt: nowMs, stale: false, available: false };
  const rows = boardAt(GRAPH, idx, 'COM3', sa, nowMs);
  assert.ok(rows.every((r) => r.quality === 'unknown' && r.etaS === null));
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

test('a live bus is placed on its line, and its next stop is the one ahead', () => {
  const shape = SHAPES.A1;
  // At the line's vertex for its 3rd stop, heading along the line: the next
  // stop is the 4th.
  const k = 2;
  let walked = 0;
  let idx = 0;
  for (; idx + 1 < shape.line.length && walked + 1 < shape.at[k]; idx++) {
    const [aLon, aLat] = shape.line[idx];
    const [bLon, bLat] = shape.line[idx + 1];
    walked += Math.hypot((bLon - aLon) * 111_320 * Math.cos(aLat * Math.PI / 180), (bLat - aLat) * 110_574);
  }
  const [lon, lat] = shape.line[idx];
  const [nLon, nLat] = shape.line[idx + 1];
  const heading = (Math.atan2((nLon - lon) * Math.cos(lat * Math.PI / 180), nLat - lat) * 180 / Math.PI + 360) % 360;
  const along = alongLine(shape, lat, lon, heading);
  assert.ok(along != null && Math.abs(along - shape.at[k]) < 20, `placed at ${along}, stop at ${shape.at[k]}`);
  assert.equal(shape.stops[nextStopIndex(shape, along, true)], shape.stops[k + 1]);
  // Far from the line: not on the route.
  assert.equal(alongLine(shape, lat + 0.01, lon, heading), null);
});

test('past its last stop, a loop starts again and a one-way route has ended', () => {
  const shape = { stops: ['A', 'B', 'C', 'A'], line: [], at: [0, 100, 200, 300] };
  assert.equal(nextStopIndex(shape, 50, true), 1);
  assert.equal(nextStopIndex(shape, 80, true), 1, 'not yet at B');
  assert.equal(nextStopIndex(shape, 95, true), 2, 'at B (within a few metres): next is C');
  assert.equal(nextStopIndex(shape, 299, true), 1, 'back at the start: next is B');
  assert.equal(nextStopIndex({ ...shape, stops: ['A', 'B', 'C'], at: [0, 100, 200] }, 199, false), null);
});
