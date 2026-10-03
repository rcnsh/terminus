import test from 'node:test';
import assert from 'node:assert/strict';
import { SHAPES } from '../src/campus.ts';
import { alongLine, follow, nextStopIndex, placeBuses, trackedBuses } from '../src/buses.ts';
import { makeCache } from './_stubs.mjs';

const M_LAT = 110_574;
const mLon = (lat) => 111_320 * Math.cos((lat * Math.PI) / 180);
const metres = (a, b) => Math.hypot((b[0] - a[0]) * mLon(a[1]), (b[1] - a[1]) * M_LAT);
const bearingOf = (a, b) => (Math.atan2((b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), b[1] - a[1]) * 180 / Math.PI + 360) % 360;

/**
 * One road used both ways: out east 500 m, then back west [gap] m to the
 * north. Stops A (start), B (the far end) and C (back at the start).
 */
function twoWay(gap = 8) {
  const east = 500 / mLon(1.3);
  const north = gap / M_LAT;
  return {
    east,
    north,
    shape: { stops: ['A', 'B', 'C'], line: [[103.77, 1.3], [103.77 + east, 1.3], [103.77 + east, 1.3 + north], [103.77, 1.3 + north]], at: [0, 500 + gap, 1000 + gap] },
  };
}
/** A fix [m] metres east of the start and [n] metres north of the eastbound side. */
const at = ({ east }, m, n, heading = null) => ({ lon: 103.77 + (east * m) / 500, lat: 1.3 + n / M_LAT, heading });
const track = (along, at, doubt = 0) => ({ along, at, doubt, offSince: null });

test('a live bus is placed on its line, and its next stop is the one ahead', () => {
  const shape = SHAPES.A1;
  // At the line's vertex for its 3rd stop, heading along the line: the next
  // stop is the 4th.
  const k = 2;
  let walked = 0;
  let idx = 0;
  for (; idx + 1 < shape.line.length && walked + 1 < shape.at[k]; idx++) walked += metres(shape.line[idx], shape.line[idx + 1]);
  const [lon, lat] = shape.line[idx];
  const heading = bearingOf(shape.line[idx], shape.line[idx + 1]);
  const along = alongLine(shape, lat, lon, heading);
  assert.ok(along != null && Math.abs(along - shape.at[k]) < 20, `placed at ${along}, stop at ${shape.at[k]}`);
  assert.equal(shape.stops[nextStopIndex(shape, along, true)], shape.stops[k + 1]);
  // Far from the line: not on the route.
  assert.equal(alongLine(shape, lat + 0.01, lon, heading), null);
});

test('on a road its route uses both ways, a bus keeps to its own side', () => {
  const road = twoWay();
  const { shape } = road;
  // 280 m along eastbound, but GPS puts it 5 m north: nearer the westbound side.
  const fix = at(road, 280, 5);
  assert.ok(alongLine(shape, fix.lat, fix.lon, null) > 500, 'with nothing to go on, the nearer side');
  // It was at 270 m ten seconds ago: standing, it's still eastbound.
  const kept = follow(shape, fix, track(270, 0), 10_000);
  assert.ok(Math.abs(kept.place.along - 280) < 2, `standing, kept its side: ${kept.place.along}`);
  // Moving west once (a bad heading): still eastbound, with a doubt.
  const odd = follow(shape, { ...fix, heading: 270 }, track(270, 0), 10_000);
  assert.ok(Math.abs(odd.place.along - 280) < 2, `one odd heading: ${odd.place.along}`);
  assert.equal(odd.track.doubt, 1);
  // The same reading again (the feed holds one for 15-20 s): the same answer, no more doubt.
  const again = follow(shape, { ...fix, heading: 270 }, odd.track, 15_000);
  assert.equal(again.place.along, odd.place.along);
  assert.equal(again.track.doubt, 1);
  // A second reading moving west: the track was wrong, and gives way.
  const turned = follow(shape, at(road, 274, 5, 270), odd.track, 25_000);
  assert.ok(turned.place.along > 500, `seen going west again: ${turned.place.along}`);
  assert.equal(turned.track.doubt, 0);
  // A heading that agrees clears the doubt.
  assert.equal(follow(shape, at(road, 290, 5, 90), odd.track, 25_000).track.doubt, 0);
  // Somewhere it can't have driven to since: placed afresh.
  assert.ok(follow(shape, fix, track(0, 0), 1_000).place.along > 500);
});

test('a bus is never put back along its line', () => {
  const road = twoWay();
  const moved = follow(road.shape, at(road, 280, 0), track(300, 0), 5_000);
  assert.equal(moved.place.along, 300, 'GPS a little behind: it stays where it was');
  assert.ok(metres([moved.place.lon, moved.place.lat], [at(road, 300, 0).lon, 1.3]) < 1, 'drawn there too');
  assert.equal(moved.track.along, 300);
  // Round a loop, past its start is ahead, not 1 km back.
  const loop = { stops: ['A', 'B', 'A'], line: [[103.77, 1.3], [103.77 + road.east, 1.3], [103.77 + road.east, 1.3 + road.north], [103.77, 1.3 + road.north], [103.77, 1.3]], at: [0, 508, 1016] };
  const past = follow(loop, at(road, 30, 0, 90), track(1010, 0), 5_000, true);
  assert.ok(Math.abs(past.place.along - 30) < 2, `round the loop: ${past.place.along}`);
  // A loop round a block, 500 m by 200 m: east, north, west, then south
  // into the terminus at its start. Leaving the terminus, the bus drives
  // north up the road it came in by: up to 500 m behind its place, it waits
  // there (for two minutes at most), then joins its line ahead.
  const w = 500 / mLon(1.3), h = 200 / M_LAT;
  const block = { stops: ['T', 'X', 'T'], line: [[103.77, 1.3], [103.77 + w, 1.3], [103.77 + w, 1.3 + h], [103.77, 1.3 + h], [103.77, 1.3]], at: [0, 700, 1400] };
  const up = { lon: 103.77, lat: 1.3 + 150 / M_LAT, heading: 0 };
  const waits = follow(block, up, track(1390, 0), 20_000, true);
  assert.equal(waits.place.along, 1390);
  assert.ok(Math.abs(follow(block, { lon: 103.77 + (w * 30) / 500, lat: 1.3, heading: 90 }, waits.track, 40_000, true).place.along - 30) < 2, 'and then on ahead');
  assert.ok(follow(block, up, track(1390, 0), 130_000, true).place.along < 1300, 'still there after two minutes: placed afresh');
});

test('a tracked bus that jumps off its line for a moment stays on it', () => {
  const road = twoWay();
  const away = at(road, 280, -200);
  const held = follow(road.shape, away, track(280, 0), 5_000);
  assert.equal(held.place.along, 280);
  assert.equal(held.track.offSince, 5_000);
  const still = follow(road.shape, away, held.track, 30_000);
  assert.equal(still.place.along, 280, '25 s off: still held');
  assert.equal(follow(road.shape, away, still.track, 36_000).place, null, 'over 30 s off: where the feed puts it');
  assert.equal(follow(road.shape, away, null, 5_000).place, null, 'no track: off its route');
});

test('standing with no track, a bus at a stop is on that stop’s side', () => {
  // Both directions drawn on the very same points (as OpenStreetMap draws
  // many two-way roads): GPS can't choose, the stops can.
  const road = twoWay(0);
  const south = { lat: 1.3 - 8 / M_LAT, lon: 103.77 + (road.east * 250) / 500 };
  const north = { lat: 1.3 + 8 / M_LAT, lon: 103.77 + (road.east * 250) / 500 };
  const shape = { ...road.shape, stops: ['A', 'S', 'B', 'N', 'C'], at: [0, 250, 500, 750, 1000] };
  const stops = [null, south, null, north, null];
  const bySouth = follow(shape, at(road, 252, -3), null, 0, false, stops);
  assert.ok(Math.abs(bySouth.place.along - 252) < 2, `at the eastbound stop: ${bySouth.place.along}`);
  const byNorth = follow(shape, at(road, 252, 3), null, 0, false, stops);
  assert.ok(Math.abs(byNorth.place.along - 748) < 2, `at the westbound stop: ${byNorth.place.along}`);
  // Moving, its heading decides.
  assert.ok(follow(shape, at(road, 252, 3, 90), null, 0, false, stops).place.along < 500);
});

test('a live bus that stops on a two-way stretch of D2 keeps its next stop', async () => {
  const shape = SHAPES.D2;
  const cum = [0];
  for (let i = 1; i < shape.line.length; i++) cum.push(cum[i - 1] + metres(shape.line[i - 1], shape.line[i]));
  const graph = { stops: [], routes: { D2: shape.stops } };
  let checked = 0;
  for (let i = 0; i + 1 < shape.line.length && checked < 3; i++) {
    const j = shape.line.findIndex((q, jj) => Math.abs(cum[jj] - cum[i]) > 400 && jj + 1 < shape.line.length && metres(shape.line[i], q) > 6 && metres(shape.line[i], q) < 15);
    if (j < 0) continue;
    const [a, b] = [shape.line[i], shape.line[i + 1]];
    const heading = bearingOf(a, b);
    // Two thirds of the way across the road: nearer the other direction.
    const lon = a[0] + (shape.line[j][0] - a[0]) * 0.67, lat = a[1] + (shape.line[j][1] - a[1]) * 0.67;
    const raw = (speed) => [{ plate: `T${i}`, lat, lon, heading, speed, crowd: null }];
    const driving = await placeBuses(graph, 'D2', raw(20), 0);
    const stopped = await placeBuses(graph, 'D2', raw(0), 15_000, driving.tracks);
    const stranger = await placeBuses(graph, 'D2', raw(0), 15_000);
    const [d, s, x] = [driving.buses[0], stopped.buses[0], stranger.buses[0]];
    if (!d.nextStop || d.nextStop.code === x.nextStop?.code) continue;
    assert.equal(s.nextStop?.code, d.nextStop.code, `stopped at line point ${i}`);
    assert.ok(metres([s.lon, s.lat], [d.lon, d.lat]) < 1, 'drawn on the same side, not the other');
    checked++;
  }
  assert.ok(checked > 0, 'found a two-way stretch of D2 to test on');
});

test('a live bus is drawn on its line, pointing along the road; one far off stays where it is', async () => {
  const shape = SHAPES.A1;
  // The longest stretch of the line, and a point 40 m to one side of its middle.
  let i = 0;
  for (let j = 1; j + 1 < shape.line.length; j++) if (metres(shape.line[j], shape.line[j + 1]) > metres(shape.line[i], shape.line[i + 1])) i = j;
  const [a, b] = [shape.line[i], shape.line[i + 1]];
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const len = metres(a, b);
  const nx = -(b[1] - a[1]) * M_LAT / len, ny = (b[0] - a[0]) * mLon(a[1]) / len;
  const off = [mid[0] + (nx * 40) / mLon(mid[1]), mid[1] + (ny * 40) / M_LAT];
  const road = bearingOf(a, b);
  const graph = { stops: [], routes: { A1: shape.stops } };
  const raw = (plate, lon, lat) => ({ plate, lat, lon, heading: (road + 30) % 360, speed: 20, crowd: null });
  const { buses: [bus], tracks } = await placeBuses(graph, 'A1', [raw('P1', off[0], off[1])]);
  assert.ok(metres([bus.lon, bus.lat], mid) < 2, `drawn ${metres([bus.lon, bus.lat], mid)} m from the line`);
  assert.equal(bus.heading, Math.round(road));
  assert.ok(Math.abs(bus.along - alongLine(shape, mid[1], mid[0], road)) < 1, 'along: where it is drawn, for gliding along the road');
  assert.equal(Object.keys(tracks).length, 1, 'and it has a track');
  const { buses: [far] } = await placeBuses(graph, 'A1', [raw('P2', mid[0], mid[1] + 0.01)]);
  assert.equal(far.lat, Math.round((mid[1] + 0.01) * 1e6) / 1e6, 'off its route: where it is');
  assert.equal(far.nextStop, null);
  assert.equal(far.along, null);
});

test('tracks are shared through the edge cache: every instance draws a bus the same way', async () => {
  globalThis.caches = { default: makeCache() };
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const shape = SHAPES.D2;
  const graph = { stops: [], routes: { D2: shape.stops } };
  // Driving along D2's 40th stretch, then standing two thirds across the road.
  const [a, b] = [shape.line[40], shape.line[41]];
  const raw = (speed, lat, lon) => [{ plate: 'SHARED', lat, lon, heading: bearingOf(a, b), speed, crowd: null }];
  const first = await trackedBuses(graph, 'D2', { buses: raw(20, a[1], a[0]), fetchedAt: 1_000 }, ctx);
  await Promise.all(pending);
  assert.deepEqual(await trackedBuses(graph, 'D2', { buses: raw(0, 0, 0), fetchedAt: 1_000 }, ctx), first, 'the same update: the same answer, placed once');
  const later = await trackedBuses(graph, 'D2', { buses: raw(0, a[1], a[0]), fetchedAt: 16_000 }, ctx);
  assert.equal(later[0].along, first[0].along, 'the next update is placed from the kept track');
});

test('past its last stop, a loop starts again and a one-way route has ended', () => {
  const shape = { stops: ['A', 'B', 'C', 'A'], line: [], at: [0, 100, 200, 300] };
  assert.equal(nextStopIndex(shape, 50, true), 1);
  assert.equal(nextStopIndex(shape, 80, true), 1, 'not yet at B');
  assert.equal(nextStopIndex(shape, 95, true), 2, 'at B (within a few metres): next is C');
  assert.equal(nextStopIndex(shape, 299, true), 1, 'back at the start: next is B');
  assert.equal(nextStopIndex({ ...shape, stops: ['A', 'B', 'C'], at: [0, 100, 200] }, 199, false), null);
});

test('replaying 15 minutes of the real feed, no bus changes side or goes back', async () => {
  // test/fixtures/bus-trace.jsonl: A1, A2, D1 and D2 on Saturday 3 October
  // 2026 at 1 pm, every 5 s (the probe workflow with `trace`). Before
  // tracks, the same readings switched a bus between sides 6 times on one
  // instance, and 12 times spread over four as in production.
  const { readFileSync } = await import('node:fs');
  const graph = (await import('../data/stops.json', { with: { type: 'json' } })).default;
  const rows = readFileSync(new URL('./fixtures/bus-trace.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const polls = new Map();
  for (const r of rows) {
    const key = `${r.svc}|${r.t}`;
    if (!polls.has(key)) polls.set(key, { svc: r.svc, t: r.t, raw: [] });
    polls.get(key).raw.push({ plate: r.bus, lat: r.lat, lon: r.lng, heading: r.direction, speed: r.speed, crowd: null });
  }
  const tracks = {};
  /** Each bus's distinct places along its line, with when each was first given. */
  const seen = new Map();
  const away = [];
  for (const p of [...polls.values()].sort((a, b) => a.t - b.t)) {
    const placed = await placeBuses(graph, p.svc, p.raw, p.t * 1000, tracks[p.svc] ?? {});
    tracks[p.svc] = placed.tracks;
    placed.buses.forEach((b, i) => {
      const key = `${p.svc} ${b.id}`;
      const list = seen.get(key) ?? [];
      if (!list.length || list[list.length - 1].along !== b.along) list.push({ t: p.t, along: b.along });
      seen.set(key, list);
      if (b.along != null) away.push(metres([b.lon, b.lat], [p.raw[i].lon, p.raw[i].lat]));
    });
  }
  const wrong = [];
  for (const [key, list] of seen) {
    const total = SHAPES[key.split(' ')[0]].at.at(-1);
    for (let i = 1; i < list.length; i++) {
      const [a, b] = [list[i - 1], list[i]];
      if (a.along == null || b.along == null) continue;
      let gone = b.along - a.along;
      if (gone < -total / 2) gone += total;
      // Back more than GPS error, or further than a bus can drive: the other side.
      if (gone < -60 || gone > 100 + 20 * (b.t - a.t)) wrong.push(`${key} at ${b.t} s: ${a.along} → ${b.along}`);
    }
  }
  assert.deepEqual(wrong, []);
  away.sort((a, b) => a - b);
  assert.ok(away[Math.floor(away.length / 2)] < 10, `drawn near where the feed puts it: median ${away[Math.floor(away.length / 2)]} m`);
});
