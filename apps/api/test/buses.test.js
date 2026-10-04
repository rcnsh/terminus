import test from 'node:test';
import assert from 'node:assert/strict';
import { SHAPES } from '../src/campus.ts';
import { alongLine, follow, nextOf, placeBuses, sectionOf, trackedBuses } from '../src/buses.ts';
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
/** A line's length in metres, as the API measures it. */
const cumulativeOf = (line) => line.slice(1).reduce((m, p, i) => m + metres(line[i], p), 0);

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
  const section = sectionOf(shape, along, true);
  assert.equal(section.at, k, 'at the stop');
  assert.equal(shape.stops[nextOf(shape, section, true)], shape.stops[k + 1]);
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
  // there, then joins its line ahead. At the loop's end (the terminus) it
  // waits as long as its track lasts: at Kent Ridge Bus Terminal, A1 waited
  // more than two minutes and was drawn 261 m back.
  const w = 500 / mLon(1.3), h = 200 / M_LAT;
  const block = { stops: ['T', 'X', 'T'], line: [[103.77, 1.3], [103.77 + w, 1.3], [103.77 + w, 1.3 + h], [103.77, 1.3 + h], [103.77, 1.3]], at: [0, 700, 1400] };
  const up = { lon: 103.77, lat: 1.3 + 150 / M_LAT, heading: 0 };
  const waits = follow(block, up, track(1390, 0), 20_000, true);
  assert.equal(waits.place.along, 1390);
  assert.ok(Math.abs(follow(block, { lon: 103.77 + (w * 30) / 500, lat: 1.3, heading: 90 }, waits.track, 40_000, true).place.along - 30) < 2, 'and then on ahead');
  assert.equal(follow(block, up, track(1390, 0), 130_000, true).place.along, 1390, 'at the loop end, still waiting after two minutes');
  assert.ok(follow(block, up, track(1390, 0), 700_000, true).place.along < 1300, 'its track gone (10 minutes): placed afresh');
  // Mid-route, behind it for more than two minutes: placed afresh.
  const side = { lon: 103.77 + w, lat: 1.3 + 50 / M_LAT, heading: 180 };
  assert.ok(follow(block, side, track(800, 0), 20_000, true).place.along === 800, 'mid-route, waits');
  assert.ok(follow(block, side, track(800, 0), 130_000, true).place.along < 800, 'mid-route, after two minutes: placed afresh');
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
    assert.equal(s.along, d.along, `shown in the same place, not across the road`);
    checked++;
  }
  assert.ok(checked > 0, 'found a two-way stretch of D2 to test on');
});

/**
 * A straight road east, 1 km, with stops A, B and C at 0, 500 and 1000 m,
 * their dots 10 m north of the line, as a graph and a shape.
 */
function straight() {
  const east = 1000 / mLon(1.3);
  const lonAt = (m) => 103.77 + (east * m) / 1000;
  const dot = 10 / M_LAT;
  return {
    lonAt,
    graph: {
      stops: [['A', 0], ['B', 500], ['C', 1000]].map(([code, m]) => ({ code, name: `Stop ${code}`, lat: 1.3 + dot, lon: lonAt(m) })),
      routes: { T: ['A', 'B', 'C'] },
      loops: { T: false },
    },
    shape: { stops: ['A', 'B', 'C'], line: [[103.77, 1.3], [103.77 + east, 1.3]], at: [0, 500, 1000] },
  };
}

test('a bus within 40 m of a stop along its line is at the stop; otherwise between two', () => {
  const { shape } = straight();
  assert.deepEqual(sectionOf(shape, 535, false), { at: 1, from: 1, to: null }, '35 m past B: at B');
  assert.deepEqual(sectionOf(shape, 462, false), { at: 1, from: 1, to: null }, '38 m before B: at B');
  assert.deepEqual(sectionOf(shape, 545, false), { at: null, from: 1, to: 2 }, '45 m past B: between B and C');
  assert.deepEqual(sectionOf(shape, 455, false), { at: null, from: 0, to: 1 }, '45 m before B: between A and B');
  assert.equal(nextOf(shape, sectionOf(shape, 535, false), false), 2, 'at B, next is C');
  assert.equal(nextOf(shape, sectionOf(shape, 300, false), false), 1, 'between A and B, next is B');
  assert.equal(nextOf(shape, sectionOf(shape, 1000, false), false), null, 'at the end of a one-way route: none');
  // A loop: its first stop is its last.
  const loop = { stops: ['A', 'B', 'C', 'A'], line: [[103.77, 1.3], [103.78, 1.3], [103.78, 1.301], [103.77, 1.301], [103.77, 1.3]], at: [0, 100, 1300, 2400] };
  loop.at[3] = cumulativeOf(loop.line);
  assert.equal(sectionOf(loop, loop.at[3] - 20, true).at, 0, '20 m before the end of the loop: at its first stop');
  assert.equal(nextOf(loop, sectionOf(loop, loop.at[3] - 20, true), true), 1, 'and next is B');
  assert.equal(nextOf(loop, sectionOf(loop, 50, true), true), 1);
});

test('buses are drawn at their stop’s dot, or spread evenly between two stops', async () => {
  const { graph, lonAt } = straight();
  const bus = (plate, m) => ({ plate, lat: 1.3, lon: lonAt(m), heading: 90, speed: 20, crowd: 'low' });
  const { shape } = straight();
  const { buses } = await placeBuses(graph, 'T', [bus('P1', 520), bus('P2', 150), bus('P3', 470), bus('P4', 300), bus('P5', 700)], 0, {}, shape);
  const by = Object.fromEntries(buses.map((b) => [b.plate, b]));
  assert.deepEqual(buses.map((b) => b.plate), ['P1', 'P2', 'P3', 'P4', 'P5'], 'in the feed’s order');
  // At B: drawn on its dot, the one further on in front.
  assert.equal(by.P1.at.code, 'B');
  assert.equal(by.P1.slot, 0);
  assert.equal(by.P3.at.code, 'B');
  assert.equal(by.P3.slot, 1);
  assert.equal(by.P1.lat, Math.round(graph.stops[1].lat * 1e6) / 1e6);
  assert.equal(by.P1.lon, Math.round(graph.stops[1].lon * 1e6) / 1e6);
  assert.equal(by.P1.along, 500);
  assert.equal(by.P1.nextStop.code, 'C');
  assert.equal(by.P1.stretch, null, 'at a stop: no stretch');
  // Two between A and B: a third and two thirds of the way.
  assert.equal(by.P2.at, null);
  assert.ok(Math.abs(by.P2.along - 500 / 3) < 0.1, `the one behind at a third: ${by.P2.along}`);
  assert.ok(Math.abs(by.P4.along - 1000 / 3) < 0.1, `the one ahead at two thirds: ${by.P4.along}`);
  assert.equal(by.P2.slot, 0);
  assert.equal(by.P2.nextStop.code, 'B');
  assert.deepEqual(by.P2.stretch, { from: 0, to: 500, last: { code: 'A', name: graph.stops[0].name } }, 'somewhere from A to B');
  // One between B and C: halfway, on the line, pointing along the road.
  assert.equal(by.P5.along, 750);
  assert.ok(metres([by.P5.lon, by.P5.lat], [lonAt(750), 1.3]) < 3);
  assert.equal(by.P5.heading, 90);
  assert.equal(by.P5.crowd, 'low');
  assert.deepEqual([by.P5.stretch.from, by.P5.stretch.to, by.P5.stretch.last.code], [500, 1000, 'B']);
});

test('a bus off its route, or on a service with no route line, is not shown', async () => {
  const { graph, lonAt } = straight();
  const far = { plate: 'FAR', lat: 1.31, lon: lonAt(300), heading: 90, speed: 0, crowd: null };
  const placed = await placeBuses(graph, 'T', [far], 0, {}, straight().shape);
  assert.deepEqual(placed.buses, []);
  assert.deepEqual(placed.tracks, {});
  assert.deepEqual((await placeBuses({ ...graph, routes: { X: ['A', 'B'] } }, 'X', [far], 0)).buses, []);
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
  assert.ok(later[0].along >= first[0].along, 'the next update is placed from the kept track, not back');
});

test('replaying 15 minutes of the real feed: no bus changes side, and none is shown going back', async () => {
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
  /** Each bus at each poll: where its reading is along the line, and where it's shown. */
  const seen = new Map();
  let atStops = 0;
  let between = 0;
  const outside = [];
  for (const p of [...polls.values()].sort((a, b) => a.t - b.t)) {
    const placed = await placeBuses(graph, p.svc, p.raw, p.t * 1000, tracks[p.svc] ?? {});
    tracks[p.svc] = placed.tracks;
    const shown = new Map(placed.buses.map((b) => [b.plate, b]));
    for (const r of p.raw) {
      // Off its line (not shown): its reading is null, and it starts afresh.
      const b = shown.get(r.plate);
      const key = `${p.svc} ${r.plate}`;
      const list = seen.get(key) ?? [];
      list.push({ t: p.t, reading: b ? placed.tracks[b.id].along : null, shown: b?.along ?? null, fix: `${r.lat},${r.lon}` });
      seen.set(key, list);
      if (b?.at) atStops++;
      else if (b) {
        between++;
        // Drawn inside its stretch, which runs from the stop it passed to its next.
        if (!(b.stretch.from < b.along && b.along < b.stretch.to) || b.stretch.last.code === b.nextStop.code) outside.push(`${key} at ${p.t} s: ${b.along} in ${JSON.stringify(b.stretch)}`);
      }
    }
  }
  assert.deepEqual(outside, []);
  const wrong = [];
  const back = [];
  for (const [key, list] of seen) {
    const total = SHAPES[key.split(' ')[0]].at.at(-1);
    const wrap = (d) => (d < -total / 2 ? d + total : d > total / 2 ? d - total : d);
    // Each new reading's place, with when it was first given.
    const readings = list.filter((x, i) => i === 0 || x.fix !== list[i - 1].fix || (x.reading == null) !== (list[i - 1].reading == null));
    for (let i = 1; i < readings.length; i++) {
      const [a, b] = [readings[i - 1], readings[i]];
      if (a.reading == null || b.reading == null) continue;
      const gone = wrap(b.reading - a.reading);
      // Back more than GPS error, or further than a bus can drive: the other side.
      if (gone < -60 || gone > 100 + 20 * (b.t - a.t)) wrong.push(`${key} at ${b.t} s: ${a.reading} → ${b.reading}`);
    }
    for (let i = 1; i < list.length; i++) {
      const [a, b] = [list[i - 1], list[i]];
      if (a.shown != null && b.shown != null && wrap(b.shown - a.shown) < 0) back.push(`${key} at ${b.t} s: shown ${a.shown} → ${b.shown}`);
    }
  }
  assert.deepEqual(wrong, []);
  assert.deepEqual(back, []);
  assert.ok(atStops > 100 && between > 100, `shown at stops ${atStops} times, between ${between}`);
});
