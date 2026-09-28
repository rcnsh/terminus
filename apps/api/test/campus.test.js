import test from 'node:test';
import assert from 'node:assert/strict';

import graphJson from './fixtures/graph.json' with { type: 'json' };
import realGraph from '../data/stops.json' with { type: 'json' };
import venuesJson from '../data/venues.json' with { type: 'json' };

import { buildCampusMap, buildDestinations, friendlyLabel, ROUTE_COLORS } from '../src/campus.ts';
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

  const venueCount = Object.keys(venuesJson.venues).length;
  assert.equal(dest.length, realGraph.stops.length + venueCount);

  for (const d of dest) {
    assert.ok(byCode.has(d.stopCode), `${d.code} resolves to unknown stop ${d.stopCode}`);
  }

  const com1 = dest.find((d) => d.code === 'COM1');
  assert.ok(com1, 'COM1 must be a known venue');
  assert.equal(com1.kind, 'building');
  assert.match(com1.label, /School of Computing/);
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
