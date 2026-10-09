/**
 * Changing buses (transfer.ts): which trips with a change are worth timing,
 * how many stops that asks the feed about, and how each is timed, ranked,
 * worded and planned for a class. On the real stop graph (data/stops.json).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { GRAPH, GRAPH_PUBLIC } from '../src/graph.ts';
import { candidateStops, indexGraph, pickAlt, scoreOptions, targetsFor, worseOf } from '../src/resolve.ts';
import { planTransfers, transferRoutes } from '../src/transfer.ts';
import { buildAnswer } from '../src/format.ts';
import { leaveBy } from '../src/leave.ts';
import { isPublic } from '../src/public.ts';
import { withLang } from '../src/i18n.ts';
import { TRANSFER, WALK } from '../src/config.ts';

const idx = indexGraph(GRAPH);
const stop = (code) => idx.byCode.get(code);
/** An instant from a Singapore wall-clock time, "2026-08-27T09:00". */
const at = (sgt) => Date.parse(`${sgt}+08:00`);
const NOW = at('2026-08-27T09:00'); // a Thursday in term
/** Each stop's board, fetched at `fetchedAt`: `rows` for the stops named, nothing at the rest. */
const boards = (codes, fetchedAt, rows = {}, extra = {}) =>
  new Map(codes.map((code) => [code, { code, arrivals: (rows[code] ?? []).map((r) => ({ crowd: null, plate: null, berth: null, ...r })), fetchedAt, stale: false, available: true, ...extra[code] }]));

/** From COM3 without a location, to Cheng Yi Hall (CG): only P goes there, and not from COM3. */
const COM3_CG = { lat: null, lon: null, to: 'CG', originCode: 'COM3' };

/** The trip planned and scored as answerFor does it. */
function scored(input, rows, { extra, nowMs = NOW, graph = GRAPH } = {}) {
  const cands = candidateStops(graph, input);
  const plan = planTransfers(graph, input, cands);
  const byStop = boards([...cands.map((c) => c.stop.code), ...plan.fetch], nowMs, rows, extra);
  const options = scoreOptions(graph, cands, byStop, nowMs, () => 0, plan.routes.length ? { transfers: plan.routes } : {});
  return { cands, plan, byStop, options };
}

// Changing buses on, as it will ship; each test of 'beats' sets that itself.
TRANSFER.mode = 'noDirect';

const answerOf = ({ cands, options }, nowMs = NOW) =>
  buildAnswer({ options, alt: pickAlt(options), fallbackStop: cands[0].stop, nearestStop: null, origin: stop('COM3'), destLabel: 'CG', walkAllS: 3600, confidence: 0.8, arrivals: [], nowMs });

test('no single bus from COM3 to CG; one change of bus gets there, always onto P', () => {
  assert.ok(candidateStops(GRAPH, COM3_CG).every((c) => c.legs.length === 0));
  const routes = transferRoutes(GRAPH, stop('COM3'), targetsFor(idx, COM3_CG));
  assert.ok(routes.length > 0);
  for (const r of routes) {
    assert.equal(r.leg2.svc, 'P');
    assert.notEqual(r.leg1.svc, r.leg2.svc);
  }
  // The change by D2 at KR MRT and by D1 at UTown are both there.
  assert.ok(routes.some((r) => r.leg1.svc === 'D2' && r.at.code === 'KR-MRT'));
  assert.ok(routes.some((r) => r.leg1.svc === 'D1' && r.at.code === 'UTOWN'));
});

test('a change is never at the start or the end, never onto the same service, and never onto a public bus', () => {
  const pidx = indexGraph(GRAPH_PUBLIC);
  for (const from of GRAPH_PUBLIC.stops) {
    for (const to of ['CG', 'BG-MRT', 'UTOWN', 'KR-MRT', 'PGP']) {
      const targets = targetsFor(pidx, { to, lat: null, lon: null, originCode: from.code });
      for (const r of transferRoutes(GRAPH_PUBLIC, from, targets)) {
        assert.ok(!isPublic(GRAPH_PUBLIC, r.leg1.svc) && !isPublic(GRAPH_PUBLIC, r.leg2.svc), `${r.leg1.svc} ${r.leg2.svc}`);
        assert.notEqual(r.leg1.svc, r.leg2.svc);
        assert.notEqual(r.board.code, from.code);
        assert.ok(!targets.some((t) => t.code === r.board.code || t.code === r.at.code));
        // Across the road only when it changes to the twin.
        assert.equal(r.crossM > 0, r.board.code !== r.at.code);
      }
    }
  }
});

test('where a single bus goes there, no change is timed (mode noDirect)', () => {
  const input = { lat: null, lon: null, to: 'UTOWN', originCode: 'COM3' };
  const cands = candidateStops(GRAPH, input);
  assert.ok(cands.some((c) => c.legs.length > 0));
  assert.deepEqual(planTransfers(GRAPH, input, cands), { routes: [], fetch: [] });
});

for (const mode of ['noDirect', 'beats']) test(`a trip with a change asks the feed about at most TRANSFER.maxFetch more stops, from anywhere to anywhere (${mode})`, () => {
  // Every pair of stops, from the stop and from a location at it: the
  // stops near you as ever, and no more than maxFetch more.
  const was = TRANSFER.mode;
  TRANSFER.mode = mode;
  try {
  for (const from of GRAPH.stops) {
    for (const to of GRAPH.stops) {
      if (from === to) continue;
      for (const input of [
        { lat: null, lon: null, to: to.code, originCode: from.code },
        { lat: from.lat, lon: from.lon, to: to.code, originCode: null },
      ]) {
        const cands = candidateStops(GRAPH, input);
        const plan = planTransfers(GRAPH, input, cands);
        const origins = new Set(plan.routes.map((r) => r.origin.code));
        // Where no bus goes there, the stops near you stand in for the one the answer had.
        const direct = cands.some((c) => c.legs.length > 0);
        const extra = plan.fetch.filter((c) => direct || !origins.has(c));
        assert.ok(extra.length <= TRANSFER.maxFetch, `${from.code}->${to.code}: ${plan.fetch}`);
        assert.ok(origins.size <= WALK.maxCandidates);
        // Every route is timed on stops that are fetched.
        const fetched = new Set([...cands.map((c) => c.stop.code), ...plan.fetch]);
        for (const r of plan.routes) assert.ok(fetched.has(r.origin.code) && fetched.has(r.board.code));
      }
    }
  }
  } finally {
    TRANSFER.mode = was;
  }
});

test('both buses live: the trip is live, and the second bus is the first you can catch after the first gets in', () => {
  // D1 in 2 min to UTown, a P there before you're off it (in 5) and after (in 15).
  const s = scored(COM3_CG, { COM3: [{ svc: 'D1', etaS: 120 }], UTOWN: [{ svc: 'P', etaS: 300 }, { svc: 'P', etaS: 900 }] });
  const best = s.options[0];
  assert.equal(best.svc, 'D1');
  assert.equal(best.change.svc, 'P');
  assert.equal(best.change.at.code, 'UTOWN');
  assert.equal(best.quality, 'live');
  assert.equal(best.boardS, 120);
  assert.equal(best.change.reachS, 120 + best.rideS);
  assert.equal(best.change.boardS, 900, 'the P in 5 min leaves before the D1 gets there');
  assert.equal(best.totalS, 900 + best.change.rideS);
});

test('a second bus past what the feed lists is a headway guess, and so is the whole trip', () => {
  const s = scored(COM3_CG, { COM3: [{ svc: 'D1', etaS: 120 }], UTOWN: [{ svc: 'P', etaS: 60 }] });
  const best = s.options.find((o) => o.change?.at.code === 'UTOWN');
  assert.equal(best.change.quality, 'scheduled');
  assert.equal(best.quality, 'scheduled');
  assert.equal(worseOf('live', 'scheduled'), 'scheduled');
  assert.equal(worseOf('stale', 'live'), 'stale');
  assert.equal(worseOf('unknown', 'stale'), 'unknown');
});

test('a change stop the feed did not answer for leaves the trip without times', () => {
  const codes = ['UTOWN', 'KR-MRT', 'KR-MRT-OPP'];
  const extra = Object.fromEntries(codes.map((c) => [c, { available: false }]));
  const s = scored(COM3_CG, { COM3: [{ svc: 'D1', etaS: 120 }, { svc: 'D2', etaS: 200 }] }, { extra });
  assert.ok(s.options.length > 0);
  assert.ok(s.options.every((o) => o.quality === 'unknown'));
  const a = answerOf(s);
  assert.equal(a.departsAt, null);
  assert.equal(a.bus.board, null);
  assert.equal(a.bus.change.board, null);
});

test('the answer says where to change and to which bus, in English and Chinese, and keeps the first bus where old apps look', () => {
  const s = scored(COM3_CG, { COM3: [{ svc: 'D1', etaS: 120 }, { svc: 'D2', etaS: 300 }], UTOWN: [{ svc: 'P', etaS: 900 }], 'KR-MRT': [{ svc: 'P', etaS: 1100 }] });
  const a = answerOf(s);
  assert.match(a.label, /^D1 · 2 min$/);
  assert.match(a.detail, /change at UTown to P/);
  assert.match(a.alt, /^D2 → P · /);
  // The bus to catch is the first; the trip's end is the destination.
  assert.equal(a.bus.svc, 'D1');
  assert.equal(a.bus.stopCode, 'COM3');
  assert.equal(a.bus.toStop, s.options[0].to && a.bus.toStop);
  assert.equal(s.options[0].to.code, 'CG');
  assert.equal(a.arriveAt, a.bus.arrive);
  assert.deepEqual(Object.keys(a.bus.change).sort(), ['board', 'estimated', 'from', 'fromCode', 'reach', 'rideS', 'stop', 'stopCode', 'svc']);
  assert.equal(a.bus.change.fromCode, 'UTOWN');
  assert.ok(Date.parse(a.bus.change.reach) < Date.parse(a.bus.change.board));
  const zh = withLang('zh', () => answerOf(s));
  assert.match(zh.detail, /在 UTown 换乘 P/);
});

test('in mode beats, a change wins only when it saves TRANSFER.worthS over the single bus', () => {
  const was = TRANSFER.mode;
  TRANSFER.mode = 'beats';
  try {
    // At CLB, to Botanic Gardens MRT: P from a stop nearby the long way round, or K to KV and P from there.
    const input = { lat: stop('CLB').lat, lon: stop('CLB').lon, to: 'BG-MRT', originCode: null };
    const cands = candidateStops(GRAPH, input);
    assert.ok(cands.some((c) => c.legs.length > 0), 'a single bus goes there');
    const plan = planTransfers(GRAPH, input, cands);
    assert.ok(plan.routes.some((r) => r.leg1.svc === 'K' && r.at.code === 'KV' && r.leg2.svc === 'P'));
    const direct = cands.flatMap((c) => c.legs.map((l) => l.svc));
    const rows = (pS) => ({ CLB: [{ svc: 'K', etaS: 120 }, ...direct.map((svc) => ({ svc, etaS: 600 }))], KV: [{ svc: 'P', etaS: pS }] });
    const time = (pS) => {
      const byStop = boards([...cands.map((c) => c.stop.code), ...plan.fetch], NOW, rows(pS));
      return scoreOptions(GRAPH, cands, byStop, NOW, () => 0, { transfers: plan.routes });
    };
    const options = time(600);
    const change = options.find((o) => o.change);
    const single = options.find((o) => !o.change);
    assert.ok(change && single);
    // The ranking counts the change as worthS: first only when it saves more.
    assert.equal(options[0] === change, change.totalS + TRANSFER.worthS < single.totalS);
    // The alternative to a change is the single bus.
    if (options[0] === change) assert.equal(pickAlt(options), single);
    else assert.ok(!pickAlt(options)?.change);
  } finally {
    TRANSFER.mode = was;
  }
});

test('a guessed single bus still loses to a measured change only when the change is worth it', () => {
  const was = TRANSFER.mode;
  TRANSFER.mode = 'beats';
  try {
    const input = { lat: stop('CLB').lat, lon: stop('CLB').lon, to: 'BG-MRT', originCode: null };
    const cands = candidateStops(GRAPH, input);
    const plan = planTransfers(GRAPH, input, cands);
    // Live K and P; the single bus has no times (a headway guess). The
    // change is measured, so it ranks first by tier, unless the guessed
    // single bus gets there sooner than the change by what it's worth.
    const byStop = boards([...cands.map((c) => c.stop.code), ...plan.fetch], NOW, { CLB: [{ svc: 'K', etaS: 120 }], KV: [{ svc: 'P', etaS: 2400 }] });
    const options = scoreOptions(GRAPH, cands, byStop, NOW, () => 0, { transfers: plan.routes });
    const change = options.find((o) => o.change);
    const single = options.find((o) => !o.change && o.quality !== 'unknown');
    if (change && single && single.totalS <= change.totalS + TRANSFER.worthS) assert.equal(options[0].change, undefined);
  } finally {
    TRANSFER.mode = was;
  }
});

test("a class's leave-by with a change: the latest first bus that makes the latest second bus that's on time", () => {
  // A 10:00 class at CG, two minutes on from the stop. P every 20 min at KR MRT and UTown.
  const rows = {
    COM3: [{ svc: 'D1', etaS: 120 }, { svc: 'D1', etaS: 840 }, { svc: 'D2', etaS: 300 }, { svc: 'D2', etaS: 1200 }],
    UTOWN: [{ svc: 'P', etaS: 900 }, { svc: 'P', etaS: 2100 }],
    'KR-MRT': [{ svc: 'P', etaS: 1100 }, { svc: 'P', etaS: 2300 }],
  };
  const s = scored(COM3_CG, rows);
  const arriveBy = { atMs: at('2026-08-27T10:00'), venueWalkS: 120 };
  const leave = leaveBy({ options: s.options, candidates: s.cands, byStop: s.byStop, graph: GRAPH, arriveBy, walkAllS: null, nowMs: NOW });
  assert.ok(leave.change, 'the leave-by is for a trip with a change');
  assert.equal(leave.svc, leave.svc.trim());
  assert.ok(Date.parse(leave.arrive) <= arriveBy.atMs, 'on time');
  // The first bus gets in before the second leaves, with time to change.
  assert.ok(Date.parse(leave.change.reach) + TRANSFER.changeBufferS * 1000 <= Date.parse(leave.change.board));
  assert.ok(Date.parse(leave.board) < Date.parse(leave.change.reach));
  assert.equal(leave.estimated, false, 'both buses are live');
  // No later pair of live buses would still be on time.
  for (const o of s.options) {
    if (!o.change) continue;
    assert.ok(o.fromMs + o.totalS * 1000 + 120_000 > arriveBy.atMs || Date.parse(leave.board) >= o.fromMs + o.boardS * 1000);
  }
});

test('a leave-by with a change and no live times aims a headway early for each bus, as an estimate', () => {
  const s = scored(COM3_CG, {});
  const arriveBy = { atMs: at('2026-08-27T11:00'), venueWalkS: 0 };
  const leave = leaveBy({ options: s.options, candidates: s.cands, byStop: s.byStop, graph: GRAPH, arriveBy, walkAllS: null, nowMs: NOW });
  assert.ok(leave.change);
  assert.equal(leave.estimated, true);
  assert.ok(Date.parse(leave.arrive) <= arriveBy.atMs);
  assert.ok(Date.parse(leave.at) > NOW);
});

test('late whatever you do: the first bus you can catch, then the first second bus after it', () => {
  const rows = { COM3: [{ svc: 'D1', etaS: 120 }, { svc: 'D2', etaS: 300 }], UTOWN: [{ svc: 'P', etaS: 900 }], 'KR-MRT': [{ svc: 'P', etaS: 1100 }] };
  const s = scored(COM3_CG, rows);
  const arriveBy = { atMs: at('2026-08-27T09:20'), venueWalkS: 0 };
  const leave = leaveBy({ options: s.options, candidates: s.cands, byStop: s.byStop, graph: GRAPH, arriveBy, walkAllS: null, nowMs: NOW });
  assert.ok(leave.change);
  assert.ok(Date.parse(leave.arrive) > arriveBy.atMs);
  assert.ok(Date.parse(leave.at) <= NOW + 1000, 'leave now');
});

/* Following a trip that changes buses (trip.ts, plan.ts). */

import { CHANGE_GRACE_MS, laterChange, leaveOf, rideStage, secondBusOf, secondLeavesMs, tripEnd } from '../src/trip.ts';
import { planOfLeave, sameBus } from '../src/plan.ts';

/** A leave-by for K at PGP to Kent Vale, then P to College Green. */
const TWO_BUS_LEAVE = {
  at: '2026-08-27T01:17:40Z',
  estimated: false,
  svc: 'K',
  stop: 'PGP',
  stopCode: 'PGP',
  board: '2026-08-27T01:23:00Z',
  arrive: '2026-08-27T01:55:38Z',
  note: null,
  walkS: 300,
  rideS: 855,
  toStop: 'College Gr',
  toCode: 'CG',
  change: { svc: 'P', from: 'Kent Vale', fromCode: 'KV', stop: 'Kent Vale', stopCode: 'KV', reach: '2026-08-27T01:37:15Z', board: '2026-08-27T01:42:00Z', rideS: 818, estimated: false },
};

test('a plan that changes buses: the first bus to the change, the second to the end, and back to the same leave-by', () => {
  const plan = planOfLeave(TWO_BUS_LEAVE, true, 'CG');
  assert.equal(plan.svc, 'K');
  assert.equal(plan.alightCode, 'KV');
  assert.equal(plan.arrive, TWO_BUS_LEAVE.change.reach);
  assert.equal(plan.change.svc, 'P');
  assert.equal(plan.change.stopCode, 'KV');
  assert.equal(plan.change.alightCode, 'CG');
  assert.equal(tripEnd(plan), TWO_BUS_LEAVE.arrive);
  const back = leaveOf(plan);
  assert.equal(back.arrive, TWO_BUS_LEAVE.arrive);
  assert.equal(back.offCode, 'CG');
  assert.deepEqual(back.change, TWO_BUS_LEAVE.change);
  assert.deepEqual(secondBusOf(TWO_BUS_LEAVE, 'CG'), plan.change);
});

test('the same first bus with another change is another plan', () => {
  const a = planOfLeave(TWO_BUS_LEAVE, true, 'CG');
  assert.ok(sameBus(a, planOfLeave(TWO_BUS_LEAVE, true, 'CG')));
  const other = planOfLeave({ ...TWO_BUS_LEAVE, change: { ...TWO_BUS_LEAVE.change, stop: 'KR MRT', stopCode: 'KR-MRT', fromCode: 'KR-MRT' } }, true, 'CG');
  assert.ok(!sameBus(a, other));
  const { change: _c, ...single } = TWO_BUS_LEAVE;
  assert.ok(!sameBus(a, planOfLeave({ ...single }, true, 'CG')));
});

test('a trip that changes buses is on the first bus, at the change, then on the second', () => {
  const plan = planOfLeave(TWO_BUS_LEAVE, true, 'CG');
  const reach = Date.parse(TWO_BUS_LEAVE.change.reach);
  const board = Date.parse(TWO_BUS_LEAVE.change.board);
  assert.equal(rideStage(plan, reach - 1), 'first');
  assert.equal(rideStage(plan, reach), 'change');
  assert.equal(rideStage(plan, reach + 60_000, true), 'first', 'the feed still has the first bus on its way');
  assert.equal(rideStage(plan, board + CHANGE_GRACE_MS - 1), 'change');
  assert.equal(rideStage(plan, board + CHANGE_GRACE_MS), 'second');
  const { change: _c, ...single } = plan;
  assert.equal(rideStage(single, board * 2), 'first');
});

test('a guessed second bus keeps you at the change for a headway, and a later one from the feed for as long as it is due', () => {
  const plan = planOfLeave(TWO_BUS_LEAVE, true, 'CG');
  const board = Date.parse(TWO_BUS_LEAVE.change.board);
  const guess = { ...plan, change: { ...plan.change, estimated: true } };
  const latest = secondLeavesMs(guess.change);
  assert.ok(latest > board + 60_000, 'a guess leaves by a headway after it');
  assert.equal(rideStage(guess, board + CHANGE_GRACE_MS), 'change');
  assert.equal(rideStage(guess, latest + CHANGE_GRACE_MS - 1), 'change');
  assert.equal(rideStage(guess, latest + CHANGE_GRACE_MS), 'second');
  const due = { ...plan, change: { ...plan.change, board: new Date(board + 120_000).toISOString() } };
  assert.equal(rideStage(due, board + CHANGE_GRACE_MS), 'change', 'the feed still has the second bus due');
});

test('boarding a later first bus that misses the planned second one moves the second to when you get there, as a guess', () => {
  const plan = planOfLeave(TWO_BUS_LEAVE, true, 'CG');
  const reach = TWO_BUS_LEAVE.change.reach;
  assert.equal(laterChange(plan.change, reach, 0), plan.change);
  assert.equal(laterChange(plan.change, reach, 60_000), plan.change, 'still there before the planned bus');
  const shift = 10 * 60_000;
  const moved = laterChange(plan.change, reach, shift);
  const there = Date.parse(reach) + shift;
  assert.equal(Date.parse(moved.board), there);
  assert.equal(moved.estimated, true);
  assert.equal(Date.parse(moved.arrive), Date.parse(plan.change.arrive) + there - Date.parse(plan.change.board));
  const late = { ...plan, arrive: new Date(there).toISOString(), change: moved };
  assert.equal(rideStage(late, there + CHANGE_GRACE_MS), 'change', 'not on the second bus the moment you get off the first');
});
