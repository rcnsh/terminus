/**
 * The arrival-time model (etamodel.ts): arrivals read off the map's placed
 * buses, segment times, the bus's position carried forward, the blend with
 * the feed, and fitting and scoring it as the backtest does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { placeBuses } from '../src/buses.ts';
import {
  actualFor,
  biasS,
  buildTable,
  earlyS,
  busStates,
  casesOf,
  errorStats,
  fitModel,
  heldAfterS,
  historicalEtaS,
  historyFor,
  horizonOf,
  passingIndex,
  passingsFromReadings,
  predictS,
  quantile,
  recentIndex,
  recentS,
  ringOf,
  scoreCases,
  segmentS,
  segmentsOf,
  slotOf,
} from '../src/etamodel.ts';

// Wednesday 21 October 2026, 08:00 Singapore time.
const T0 = Date.UTC(2026, 9, 21, 0, 0);
const S = 1000;
const LOOP = ringOf(['A', 'B', 'C', 'D', 'A'], true);
const LINE = ringOf(['P', 'Q', 'R'], false);
const ROUTES = { L: LOOP, O: LINE };

const reading = (t, plate, state, svc = 'L') => ({ t, svc, plate, at: null, last: null, next: null, ...state });

test('a route is rung once round: a loop drops its repeated first stop', () => {
  assert.deepEqual(LOOP, { seq: ['A', 'B', 'C', 'D'], loop: true });
  assert.deepEqual(LINE, { seq: ['P', 'Q', 'R'], loop: false });
  assert.deepEqual(ringOf(['A', 'B', 'C'], true).seq, ['A', 'B', 'C'], 'already rung: as it is');
});

test('a bus heading for a stop and then at it, or past it, reached it between the two readings', () => {
  const passings = passingsFromReadings([
    reading(T0, 'PA1', { at: 'A', next: 'B' }),
    reading(T0 + 20 * S, 'PA1', { last: 'A', next: 'B' }),
    // Heading for B, then at B: reached it between, taken as the middle.
    reading(T0 + 40 * S, 'PA1', { at: 'B', next: 'C' }),
    // Still at B: not again.
    reading(T0 + 60 * S, 'PA1', { at: 'B', next: 'C' }),
    reading(T0 + 80 * S, 'PA1', { last: 'B', next: 'C' }),
    // Past C without being seen at it: reached it all the same.
    reading(T0 + 100 * S, 'PA1', { last: 'C', next: 'D' }),
  ]);
  assert.deepEqual(passings, [
    { svc: 'L', plate: 'PA1', stop: 'B', t: T0 + 30 * S, seen: T0 + 40 * S },
    { svc: 'L', plate: 'PA1', stop: 'C', t: T0 + 90 * S, seen: T0 + 100 * S },
  ]);
});

test('no arrival from a first sighting, a gap in the readings, or another bus', () => {
  assert.deepEqual(passingsFromReadings([reading(T0, 'PA1', { at: 'B', next: 'C' })]), [], 'first seen at a stop: not arriving');
  assert.deepEqual(
    passingsFromReadings([reading(T0, 'PA1', { last: 'A', next: 'B' }), reading(T0 + 5 * 60 * S, 'PA1', { at: 'B', next: 'C' })]),
    [],
    'five minutes apart: anything could have happened',
  );
  assert.deepEqual(
    passingsFromReadings([reading(T0, 'PA1', { last: 'A', next: 'B' }), reading(T0 + 20 * S, 'PA2', { at: 'B', next: 'C' })]),
    [],
    'one bus heading there and another bus there',
  );
  // Out of order in the file, in order by time.
  const later = passingsFromReadings([reading(T0 + 20 * S, 'PA1', { at: 'B', next: 'C' }), reading(T0, 'PA1', { last: 'A', next: 'B' })]);
  assert.equal(later.length, 1);
});

test('replaying the real feed every 20 s finds the same arrivals as every 5 s, to within the polling', async () => {
  // test/fixtures/bus-trace.jsonl (15 minutes of A1, A2, D1, D2), placed
  // as /api/buses places them on every update, read as the recorder would.
  const graph = (await import('./fixtures/bus-trace-routes.json', { with: { type: 'json' } })).default;
  const rows = readFileSync(new URL('./fixtures/bus-trace.jsonl', import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const polls = new Map();
  for (const r of rows) {
    const key = `${r.svc}|${r.t}`;
    if (!polls.has(key)) polls.set(key, { svc: r.svc, t: r.t, raw: [] });
    polls.get(key).raw.push({ plate: r.bus, lat: r.lat, lon: r.lng, heading: r.direction, speed: r.speed, crowd: null });
  }
  const tracks = {};
  const every5 = [];
  for (const p of [...polls.values()].sort((a, b) => a.t - b.t)) {
    const placed = await placeBuses(graph, p.svc, p.raw, p.t * 1000, tracks[p.svc] ?? {}, graph.shapes[p.svc]);
    tracks[p.svc] = placed.tracks;
    for (const b of placed.buses) {
      every5.push({
        t: Math.round(p.t * 1000),
        svc: p.svc,
        plate: b.plate,
        at: b.at?.code ?? null,
        last: b.stretch?.last.code ?? null,
        next: b.nextStop?.code ?? null,
      });
    }
  }
  const fine = passingsFromReadings(every5);
  // The recorder's 20 s: every fourth of each service's polls.
  const times = new Map();
  for (const r of every5) times.set(r.svc, [...new Set([...(times.get(r.svc) ?? []), r.t])]);
  const kept = new Set([...times].flatMap(([svc, ts]) => ts.filter((_, i) => i % 4 === 0).map((t) => `${svc}|${t}`)));
  const coarse = passingsFromReadings(every5.filter((r) => kept.has(`${r.svc}|${r.t}`)));

  assert.ok(fine.length >= 30, `${fine.length} arrivals in 15 minutes of four services`);
  assert.ok(coarse.length >= fine.length * 0.8, `${coarse.length} of ${fine.length} still found at 20 s`);
  for (const c of coarse) {
    const f = fine.find((x) => x.plate === c.plate && x.stop === c.stop && Math.abs(x.t - c.t) <= 30_000);
    assert.ok(f, `${c.svc} ${c.plate} at ${c.stop} (${c.t}) is one of the 5 s arrivals`);
    // Within half the gap between the two readings either side (20 s, or
    // 40 s when a bus is missing from one poll), and half a 5 s poll.
    assert.ok(Math.abs(f.t - c.t) <= c.seen - c.t + 2_700, `${c.plate} at ${c.stop}: ${Math.abs(f.t - c.t)} ms out`);
  }
  // Each bus's arrivals follow its route, a stop at a time.
  const routes = Object.fromEntries(Object.keys(graph.shapes).map((svc) => [svc, ringOf(graph.routes[svc], graph.loops?.[svc] ?? true)]));
  const segments = segmentsOf(fine, routes);
  assert.ok(segments.length >= 15);
  // Except out of a loop's first stop, where a bus lays over (D1 at COM3: 765 s).
  const driving = segments.filter((g) => g.from !== routes[g.svc].seq[0]);
  assert.ok(
    driving.every((g) => g.s >= 5 && g.s <= 8 * 60),
    'stop to stop in seconds to minutes',
  );
  // The gate: history won't sum a D1 at COM3 through its layover, but will one on its way.
  const table = buildTable(segments);
  const atCom3 = fine.find((p) => p.svc === 'D1' && p.stop === 'COM3');
  assert.ok(atCom3, 'a D1 reaches COM3 in the trace');
  const bus = { plate: atCom3.plate, stop: 'COM3', t: atCom3.t };
  const ungated = historicalEtaS(table, routes.D1, 'D1', bus, routes.D1.seq[1], atCom3.t);
  assert.ok(ungated > 5 * 60, `${ungated} s: the layover summed as if driven`);
  assert.equal(historicalEtaS(table, routes.D1, 'D1', bus, routes.D1.seq[1], atCom3.t, 0, { gate: true }), null);
  const moving = driving.find((g) => g.svc === 'D1');
  const ahead = routes.D1.seq[(routes.D1.seq.indexOf(moving.to) + 1) % routes.D1.seq.length];
  const on = { plate: 'X', stop: moving.to, t: moving.t + moving.s * 1000 };
  const driven = historicalEtaS(table, routes.D1, 'D1', on, ahead, on.t);
  assert.ok(driven !== null && ahead !== routes.D1.seq[0], `a D1 at ${moving.to} heading for ${ahead}`);
  assert.equal(historicalEtaS(table, routes.D1, 'D1', on, ahead, on.t, 0, { gate: true }), driven, 'gated or not, the same');
});

/** A passing: [plate] reached [stop] at T0 + [s] seconds. */
const at = (stop, s, plate = 'PA1', svc = 'L') => ({ svc, plate, stop, t: T0 + s * S });

test('segments are consecutive arrivals at adjacent stops, round a loop too', () => {
  const segs = segmentsOf([at('A', 0), at('B', 60), at('C', 150), at('D', 200), at('A', 300), at('C', 900)], ROUTES);
  assert.deepEqual(
    segs.map((g) => `${g.from}${g.to}${g.s}`),
    ['AB60', 'BC90', 'CD50', 'DA100'],
    'A to C skips B: not a segment',
  );
  // A one-way route doesn't wrap, and an hour's gap is a bus laid up.
  assert.deepEqual(segmentsOf([at('R', 0, 'PB1', 'O'), at('P', 60, 'PB1', 'O')], ROUTES), []);
  assert.deepEqual(segmentsOf([at('A', 0), at('B', 3600)], ROUTES), []);
});

test('a segment takes its slot median, pulled towards its overall median the fewer it has', () => {
  const weekday8 = T0;
  const weekday17 = T0 + 9 * 3600 * S;
  const segs = [
    ...[60, 62, 64].map((s, i) => ({ svc: 'L', from: 'A', to: 'B', t: weekday8 + i, s })),
    ...[120, 120, 120, 120, 120].map((s, i) => ({ svc: 'L', from: 'A', to: 'B', t: weekday17 + i, s })),
  ];
  const table = buildTable(segs);
  assert.equal(slotOf(weekday8), 'wd|8');
  assert.equal(slotOf(Date.UTC(2026, 9, 24, 2)), 'we|10', 'Saturday');
  assert.deepEqual(table.all['L|A|B'], [8, 120]);
  assert.deepEqual(table.slot['L|A|B|wd|8'], [3, 62]);
  // (3 × 62 + 4 × 120) / 7
  assert.equal(Math.round(segmentS(table, 'L', 'A', 'B', weekday8)), 95);
  assert.equal(segmentS(table, 'L', 'A', 'B', weekday8 + 3 * 3600 * S), 120, 'an hour with none: the overall median');
  assert.equal(segmentS(table, 'L', 'B', 'C', weekday8), null, 'a pair never driven');
});

/** A table with the same time for each segment, in every slot. */
const flat = (times) => buildTable(Object.entries(times).map(([pair, s]) => ({ svc: 'L', from: pair[0], to: pair[1], t: T0, s })));
const TABLE = flat({ AB: 60, BC: 90, CD: 50, DA: 100 });

test("history's time: the rest of the bus's segment, then each one on to the stop", () => {
  const bus = { plate: 'PA1', stop: 'A', t: T0 };
  assert.equal(historicalEtaS(TABLE, LOOP, 'L', bus, 'C', T0), 150);
  assert.equal(historicalEtaS(TABLE, LOOP, 'L', bus, 'C', T0 + 40 * S), 110, '40 s into A to B');
  assert.equal(historicalEtaS(TABLE, LOOP, 'L', bus, 'C', T0 + 300 * S), 100, 'overdue: still 10 s from B, then B to C');
  assert.equal(historicalEtaS(TABLE, LOOP, 'L', { ...bus, stop: 'D' }, 'B', T0), 160, 'round the end of the loop');
  assert.equal(historicalEtaS(TABLE, LOOP, 'L', bus, 'A', T0 + 30 * S, 60), 0, 'just passed: that bus is there');
  assert.equal(historicalEtaS(TABLE, LOOP, 'L', bus, 'A', T0 + 30 * S), 270, 'or gone, with a lap to come round');
  const line = buildTable([{ svc: 'O', from: 'P', to: 'Q', t: T0, s: 60 }]);
  assert.equal(historicalEtaS(line, LINE, 'O', { plate: 'PB1', stop: 'Q', t: T0 }, 'P', T0), null, 'behind it on a one-way route');
  assert.equal(historicalEtaS(line, LINE, 'O', { plate: 'PB1', stop: 'P', t: T0 }, 'R', T0), null, 'Q to R never driven');
});

test("the gate: history only for a bus on its way, not through a loop's first stop or held", () => {
  const gate = { gate: true };
  const bus = { plate: 'PA1', stop: 'B', t: T0 };
  assert.equal(historicalEtaS(TABLE, LOOP, 'L', bus, 'D', T0, 0, gate), 140, 'B to D: no first stop on the way');
  assert.equal(historicalEtaS(TABLE, LOOP, 'L', { ...bus, stop: 'A' }, 'C', T0, 0, gate), null, 'at A, the first stop: waiting there');
  assert.equal(historicalEtaS(TABLE, LOOP, 'L', { ...bus, stop: 'D' }, 'B', T0, 0, gate), null, 'D to B goes through A');
  assert.equal(historicalEtaS(TABLE, LOOP, 'L', { ...bus, stop: 'D' }, 'A', T0, 0, gate), 100, 'D to A ends there: arriving is driving');
  // B to C takes 90 s: held past max(2 × 90, 90 + 120) = 210 s.
  assert.equal(heldAfterS(90), 210);
  assert.equal(historicalEtaS(TABLE, LOOP, 'L', bus, 'C', T0 + 200 * S, 0, gate), 10, 'overdue, not yet held');
  assert.equal(historicalEtaS(TABLE, LOOP, 'L', bus, 'C', T0 + 211 * S, 0, gate), null, 'held');
  assert.equal(historicalEtaS(TABLE, LOOP, 'L', bus, 'C', T0 + 211 * S), 10, 'without the gate, still 10 s away');
});

test("with the gate, the next bus of any plate is still the soonest: one waiting at the first stop isn't skipped", () => {
  const states = [
    { plate: 'PA1', stop: 'A', t: T0 },
    { plate: 'PA2', stop: 'D', t: T0 },
  ];
  const q = { t: T0, svc: 'L', stop: 'C', etaS: 120 };
  assert.equal(historyFor(TABLE, LOOP, states, q), 150, 'PA1, from A');
  assert.equal(historyFor(TABLE, LOOP, states, q, { gate: true }), null, 'PA1 must leave A: the feed, not PA2 a lap later');
  const held = [{ plate: 'PA3', stop: 'B', t: T0 - 300 * S }, ...states];
  assert.equal(historyFor(TABLE, LOOP, held, q), 10, 'PA3, overdue between B and C');
  assert.equal(historyFor(TABLE, LOOP, held, q, { gate: true }), null, 'PA3 is held: the feed');
  assert.equal(historyFor(TABLE, LOOP, [{ plate: 'PA4', stop: 'B', t: T0 }], q, { gate: true }), 90);
});

test('the buses just ahead: segments driven in the last half hour, only once known, replace the median', () => {
  const segs = [
    { svc: 'L', from: 'B', to: 'C', t: T0 - 50 * 60 * S, s: 300, known: T0 - 45 * 60 * S },
    { svc: 'L', from: 'B', to: 'C', t: T0 - 10 * 60 * S, s: 120, known: T0 - 8 * 60 * S },
    { svc: 'L', from: 'B', to: 'C', t: T0 - 6 * 60 * S, s: 140, known: T0 - 4 * 60 * S },
    // Driven before T0 but not known until after it.
    { svc: 'L', from: 'B', to: 'C', t: T0 - 2 * 60 * S, s: 900, known: T0 + 10 * S },
  ];
  const index = recentIndex(segs);
  const window = 30 * 60_000;
  assert.deepEqual(recentS(index, 'L', 'B', 'C', T0, window), [2, 130], 'not the one 45 minutes ago, nor the one not yet known');
  assert.deepEqual(recentS(index, 'L', 'B', 'C', T0 + 10 * S, window), [3, 140]);
  assert.equal(recentS(index, 'L', 'C', 'D', T0, window), null);
  const bus = { plate: 'PA1', stop: 'B', t: T0 };
  const recent = (o) => ({ gate: true, recent: { index, at: T0, windowMs: window, minN: 2, prior: 0, ...o } });
  assert.equal(historicalEtaS(TABLE, LOOP, 'L', bus, 'D', T0, 0, recent()), 180, 'B to C 130 s, as just driven, then C to D 50 s');
  assert.equal(historicalEtaS(TABLE, LOOP, 'L', bus, 'D', T0, 0, recent({ minN: 3 })), 140, 'too few: the median');
  // (2 × 130 + 2 × 90) / 4 = 110
  assert.equal(historicalEtaS(TABLE, LOOP, 'L', bus, 'D', T0, 0, recent({ prior: 2 })), 160, 'shrunk towards the median');
});

test("the model's cases never use a segment driven after the question", () => {
  const rec = morning({ minutes: 40 });
  // A bus that crawls B to C long after every question: it mustn't change any earlier answer.
  const crawl = [at('B', 3000, 'PZ'), at('C', 3600, 'PZ')];
  const model = fitModel({ L: LOOP }, [morning({ minutes: 60 })]);
  const before = casesOf(model, { L: LOOP }, rec).filter((c) => c.t < T0 + 3000 * S);
  const after = casesOf(model, { L: LOOP }, { ...rec, passings: [...rec.passings, ...crawl] }).filter((c) => c.t < T0 + 3000 * S);
  assert.deepEqual(
    after.map((c) => c.hist),
    before.map((c) => c.hist),
  );
  assert.ok(before.some((c) => c.hist.recent !== null));
});

test('a bus is where it was last seen to be, and only from when that could be known', () => {
  const passings = [at('A', 0), at('B', 60), { ...at('C', 150), seen: T0 + 170 * S }, at('A', 0, 'PA2')];
  assert.deepEqual(busStates(passings, 'L', T0 + 160 * S, 30_000), [
    { plate: 'PA1', stop: 'B', t: T0 + 60 * S },
    { plate: 'PA2', stop: 'A', t: T0 },
  ]);
  assert.equal(busStates(passings, 'L', T0 + 170 * S, 30_000)[0].stop, 'C', 'seen at 170 s');
  assert.deepEqual(busStates([at('A', 0)], 'L', T0 + 15 * S, 30_000), [], 'a recorder passing is known a poll later');
  assert.deepEqual(busStates([at('A', 0)], 'L', T0 + 30 * 60 * S, 0), [], 'half an hour old: lost');
});

test('the next bus of any plate is the soonest, and not one that has just left', () => {
  const states = [
    { plate: 'PA1', stop: 'B', t: T0 },
    { plate: 'PA2', stop: 'D', t: T0 },
    { plate: 'PA3', stop: 'C', t: T0 - 40 * S },
  ];
  assert.equal(historyFor(TABLE, LOOP, states, { t: T0, svc: 'L', stop: 'C', etaS: 60 }), 90, 'PA3 left 40 s ago');
  assert.equal(historyFor(TABLE, LOOP, states.slice(2), { t: T0 - 20 * S, svc: 'L', stop: 'C', etaS: 0 }), 0, 'PA3 there 20 s ago');
  assert.equal(historyFor(TABLE, LOOP, states, { t: T0, svc: 'L', stop: 'C', etaS: 60, plate: 'PA2' }), 250);
  assert.equal(historyFor(TABLE, LOOP, states, { t: T0, svc: 'L', stop: 'C', etaS: 0, plate: 'PA3' }), 0, 'its own plate, just passed');
  assert.equal(historyFor(TABLE, LOOP, states, { t: T0, svc: 'L', stop: 'C', etaS: 60, plate: 'PZ9' }), null);
});

test('the actual arrival is the first after asking, a minute earlier for a bus said to be there', () => {
  const index = passingIndex([at('C', -50), at('C', 200, 'PA2'), at('C', 400)]);
  assert.equal(earlyS({ etaS: 60 }), 30);
  assert.equal(earlyS({ etaS: 61 }), 0);
  assert.equal(earlyS({ etaS: 120, plate: 'PA1' }), 60);
  assert.equal(actualFor({ t: T0 - 20 * S, svc: 'L', stop: 'C', etaS: 30 }, index), T0 - 50 * S, 'said 30 s: the one there 30 s ago');
  assert.equal(actualFor({ t: T0, svc: 'L', stop: 'C', etaS: 30 }, index), T0 + 200 * S, 'not one gone 50 s ago, without a plate');
  assert.equal(actualFor({ t: T0, svc: 'L', stop: 'C', etaS: 30, plate: 'PA1' }, index), T0 - 50 * S, 'that plate, a minute back');
  assert.equal(actualFor({ t: T0, svc: 'L', stop: 'C', etaS: 240 }, index), T0 + 200 * S, 'the next of any plate');
  assert.equal(actualFor({ t: T0, svc: 'L', stop: 'C', etaS: 240, plate: 'PA1' }, index), T0 + 400 * S, 'or that plate');
  assert.equal(actualFor({ t: T0 + 500 * S, svc: 'L', stop: 'C', etaS: 60 }, index), null, 'none came');
});

test('the blend: the feed corrected by its usual error, weighted with history per horizon', () => {
  const model = {
    v: 1,
    table: TABLE,
    bias: { '*|1': [100, 30], 'L|1': [10, 60], '*|0': [50, -10] },
    weights: [0, 0.5, 1, 1],
  };
  assert.equal(horizonOf(0), 0);
  assert.equal(horizonOf(120), 0);
  assert.equal(horizonOf(121), 1);
  assert.equal(horizonOf(5000), 3, 'past the last: the last');
  // (10 × 60 + 10 × 30) / 20: a service's own bias pulled towards everyone's.
  assert.equal(biasS(model, 'L', 200), 45);
  assert.equal(biasS(model, 'X', 200), 30);
  assert.equal(biasS(model, 'L', 700), 0, 'no bias known at that horizon');
  assert.deepEqual(predictS(model, 'L', 200, 300), { feed: 200, corrected: 245, history: 300, blend: 273 });
  assert.deepEqual(predictS(model, 'L', 60, 300), { feed: 60, corrected: 50, history: 300, blend: 50 }, 'weight 0: the feed corrected');
  assert.deepEqual(predictS(model, 'L', 200, null), { feed: 200, corrected: 245, history: null, blend: 245 });
  assert.deepEqual(predictS(model, 'L', null, 300), { feed: null, corrected: null, history: 300, blend: 300 });
  assert.equal(predictS(model, 'L', 5, null).corrected, 0, 'never in the past');
});

/**
 * A morning on route L: [buses] buses a lap apart in time, each driving
 * the segments of TABLE exactly, with the feed asked at every stop each
 * minute and always [feedErrS] too soon. Not asked within a minute of a
 * bus reaching the stop, when which bus is meant is a guess.
 */
function morning({ minutes, buses = 3, feedErrS = 0, noise = () => 0 }) {
  const lap = [
    ['A', 0],
    ['B', 60],
    ['C', 150],
    ['D', 200],
  ];
  const passings = [];
  for (let b = 0; b < buses; b++) {
    for (let start = b * 100; start < minutes * 60; start += 300) {
      for (const [stop, s] of lap) passings.push(at(stop, start + s, `P${b}`));
    }
  }
  const index = passingIndex(passings);
  const queries = [];
  for (let m = 0; m < minutes; m++) {
    for (const stop of ['B', 'C', 'D']) {
      const t = T0 + m * 60 * S;
      const came = index.get(`L|${stop}`).find((x) => x > t);
      if (came === undefined || index.get(`L|${stop}`).some((x) => x <= t && x > t - 60 * S)) continue;
      queries.push({ t, svc: 'L', stop, etaS: Math.max(0, Math.round((came - t) / 1000) - feedErrS + noise(m, stop)) });
    }
  }
  return { passings: passings.sort((a, b) => a.t - b.t), queries, lagMs: 0 };
}

test('fitted on a morning where the feed says a minute too soon, the model learns the minute and beats the feed', () => {
  const train = morning({ minutes: 60, feedErrS: 60 });
  const model = fitModel({ L: LOOP }, [train]);
  assert.deepEqual(model.table.all['L|B|C'], [36, 90]);
  assert.equal(model.bias['*|1'][1], 60, 'the bus comes a minute after the feed said');
  const cases = casesOf(model, { L: LOOP }, morning({ minutes: 30, feedErrS: 60 }));
  const scored = scoreCases(cases);
  assert.ok(scored.overall.feed.n > 20);
  assert.equal(scored.horizons[1].stats.feed.bias, 60, '2 to 5 min: none said 0 for a bus under a minute away');
  assert.ok(scored.overall.corrected.mae < scored.overall.feed.mae);
  assert.ok(scored.overall.blend.mae <= scored.overall.corrected.mae);
  assert.equal(scored.overall.history.mae, 0, 'buses that drive their medians exactly');
});

test('with a noisy feed and buses that keep to time, the blend leans on history', () => {
  // The feed off by up to two minutes either way; the buses exactly to time.
  const noise = (m, stop) => ((m * 37 + stop.charCodeAt(0) * 11) % 240) - 120;
  const model = fitModel({ L: LOOP }, [morning({ minutes: 90, noise })]);
  assert.ok(
    model.weights.some((w) => w >= 0.8),
    `weights ${model.weights}`,
  );
  const scored = scoreCases(casesOf(model, { L: LOOP }, morning({ minutes: 30, noise })));
  assert.ok(scored.overall.blend.mae < scored.overall.feed.mae / 2, JSON.stringify(scored.overall));
  assert.equal(scored.coverage, 1);
});

test('error statistics: mean and quantiles of the absolute error, and the signed mean', () => {
  assert.deepEqual(errorStats([]), { n: 0, mae: null, p50: null, p90: null, bias: null });
  assert.deepEqual(errorStats([10, -20, 30, -40, 50, 60, -70, 80, 90, -100]), { n: 10, mae: 55, p50: 50, p90: 90, bias: 9 });
  assert.equal(quantile([3, 1, 2], 0.5), 2);
});
