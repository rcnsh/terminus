/**
 * The /me/next answer at its edges: operating hours, the age of an answer,
 * which stops are tried, the walk the whole way, and what is shown as live.
 * On the real stop graph (data/stops.json), as the answer is made.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { GRAPH, GRAPH_PUBLIC } from '../src/graph.ts';
import {
  candidateStops,
  indexGraph,
  pickAlt,
  scoreOptions,
  serviceEndsAt,
  serviceResumesAt,
  shuttleRideS,
  walkAllTheWayS,
  wholeWalk,
} from '../src/resolve.ts';
import { leaveBy } from '../src/leave.ts';
import { walkVerdict } from '../src/format.ts';
import { mergeFeeds } from '../src/answer.ts';
import { cardFor } from '../src/card.ts';
import { haversineM } from '../src/geo.ts';
import { RIDE, WALK } from '../src/config.ts';

const idx = indexGraph(GRAPH);
const stop = (code) => idx.byCode.get(code);
/** An instant from a Singapore wall-clock time, "2026-08-27T06:30". */
const at = (sgt) => Date.parse(`${sgt}+08:00`);
const MIN = 60_000;
/** Each stop's board, fetched at `fetchedAt`: `rows` for the stops named, nothing at the rest. */
const boards = (codes, fetchedAt, rows = {}, extra = {}) =>
  new Map(codes.map((code) => [code, { code, arrivals: (rows[code] ?? []).map((r) => ({ crowd: null, plate: null, berth: null, ...r })), fetchedAt, stale: false, available: true, ...extra }]));
/** From home at PGP, a five-minute walk to the stop, no location. */
const FROM_PGP = { lat: null, lon: null, to: 'UTOWN', originCode: 'PGP', originWalkS: 300 };
const codesOf = (cands) => cands.map((c) => c.stop.code);

/* Operating hours. */

test('before the first bus, a class gets the first bus after it starts, not "Services ended"', () => {
  const now = at('2026-08-27T06:30'); // a Thursday; the D2 starts at 07:15
  const classAt = at('2026-08-27T08:00');
  const cands = candidateStops(GRAPH, FROM_PGP);
  const byStop = boards(codesOf(cands), now);
  assert.deepEqual(scoreOptions(GRAPH, cands, byStop, now), [], 'nothing runs now');

  const opts = scoreOptions(GRAPH, cands, byStop, now, undefined, { openBy: classAt });
  const d2 = opts.find((o) => o.svc === 'D2');
  assert.ok(d2, 'the D2 starts before the class');
  assert.equal(d2.quality, 'scheduled');
  const opens = serviceResumesAt(GRAPH, 'D2', now);
  assert.ok(d2.fromMs + d2.boardS * 1000 > opens, 'a bus after it starts');
  assert.ok(d2.opensInS > 0);
  // Waiting for it to start is no reason to walk 32 minutes instead.
  assert.equal(walkVerdict(32 * 60, d2), 'lose');

  const leave = leaveBy({ options: opts, candidates: cands, byStop, graph: GRAPH, arriveBy: { atMs: classAt, venueWalkS: 0 }, walkAllS: null, nowMs: now });
  assert.equal(leave.svc, 'D2');
  assert.equal(leave.estimated, true);
  assert.ok(Date.parse(leave.board) >= opens);

  // A service that only starts after you'd need it is still no way there.
  assert.deepEqual(scoreOptions(GRAPH, cands, byStop, now, undefined, { openBy: at('2026-08-27T07:00') }), []);
});

test('no bus is guessed after the service stops for the night', () => {
  const now = at('2026-08-27T22:58'); // at the stop 23:03; the last D2 is at 23:00
  const cands = candidateStops(GRAPH, FROM_PGP);
  assert.ok(!scoreOptions(GRAPH, cands, boards(codesOf(cands), now), now).some((o) => o.svc === 'D2'), 'the feed lists nothing');
  // The last listed bus leaves before you can get there: no headway after it either.
  const listed = boards(codesOf(cands), now, { PGP: [{ svc: 'D2', etaS: 60 }] });
  assert.ok(!scoreOptions(GRAPH, cands, listed, now).some((o) => o.svc === 'D2'), 'after the last bus');
  // Past the close itself, with the last bus still listed out of reach: no
  // guessed bus after it ("D2 · ~11 min · estimated" at 23:02).
  const later = at('2026-08-27T23:02');
  const stillListed = boards(codesOf(cands), later, { PGP: [{ svc: 'D2', etaS: 60 }] });
  assert.ok(!scoreOptions(GRAPH, cands, stillListed, later).some((o) => o.svc === 'D2'), 'after the close');
  // With a class's openBy, the next start is tomorrow: still nothing tonight.
  assert.ok(!scoreOptions(GRAPH, cands, stillListed, later, undefined, { openBy: at('2026-08-27T23:30') }).some((o) => o.svc === 'D2'));
});

test('a leave-by never boards a bus after the service has stopped', () => {
  // Saturday 17:30, a class at 20:30 at Opp SDE 3: the K stops at 19:04 on Saturdays.
  const now = at('2026-10-10T17:30');
  const cands = candidateStops(GRAPH, { ...FROM_PGP, to: 'SDE3-OPP' });
  const byStop = boards(codesOf(cands), now, { PGP: [{ svc: 'K', etaS: 600 }] });
  const opts = scoreOptions(GRAPH, cands, byStop, now);
  const leave = leaveBy({ options: opts, candidates: cands, byStop, graph: GRAPH, arriveBy: { atMs: at('2026-10-10T20:30'), venueWalkS: 0 }, walkAllS: null, nowMs: now });
  assert.equal(leave.svc, 'K');
  assert.ok(Date.parse(leave.board) <= serviceEndsAt(GRAPH, 'K', now), `boards ${leave.board}`);
});

test('too late for a bus with no live times: board when you can reach the stop, never in the past', () => {
  const now = at('2026-08-27T09:50'); // class at 10:00, the feed has no times
  const cands = candidateStops(GRAPH, FROM_PGP);
  const byStop = boards(codesOf(cands), now);
  const opts = scoreOptions(GRAPH, cands, byStop, now);
  const leave = leaveBy({ options: opts, candidates: cands, byStop, graph: GRAPH, arriveBy: { atMs: at('2026-08-27T10:00'), venueWalkS: 0 }, walkAllS: null, nowMs: now });
  assert.ok(Date.parse(leave.board) >= now + 300_000, `boards ${leave.board}: you can't be there sooner`);
  assert.equal(Date.parse(leave.at), now, 'go now');
  assert.ok(Date.parse(leave.arrive) > at('2026-08-27T10:00'), 'and say you will be late');
});

test('late because the service has not started yet: leave for its first bus, not now', () => {
  // 06:20, a class at 08:30 at Botanic Gardens MRT: the P from Kent Vale starts at 08:20.
  const now = at('2026-10-08T06:20');
  const cands = candidateStops(GRAPH, { ...FROM_PGP, to: 'BG-MRT', originCode: 'KV' });
  const byStop = boards(codesOf(cands), now);
  const classAt = at('2026-10-08T08:30');
  const opts = scoreOptions(GRAPH, cands, byStop, now, undefined, { openBy: classAt });
  const leave = leaveBy({ options: opts, candidates: cands, byStop, graph: GRAPH, arriveBy: { atMs: classAt, venueWalkS: 0 }, walkAllS: null, nowMs: now });
  assert.equal(leave.svc, 'P');
  const opens = serviceResumesAt(GRAPH, 'P', now);
  assert.equal(Date.parse(leave.board), opens);
  assert.ok(Date.parse(leave.at) > now + 100 * MIN, `leave ${leave.at}`);
});

/* Which stops are tried. */

test('without a location, the stop across the road is tried too, a crossing further', () => {
  const cands = candidateStops(GRAPH, { ...FROM_PGP, to: 'COM3', originCode: 'KR-MRT' });
  const opp = cands.find((c) => c.stop.code === 'KR-MRT-OPP');
  assert.ok(opp, codesOf(cands).join());
  assert.ok(opp.walkS > 300 && opp.walkS < 300 + 120, `${opp.walkS} s`);
  // AS 5 has no bus to Kent Vale; Opp NUSS, across the road, has.
  const kv = candidateStops(GRAPH, { ...FROM_PGP, to: 'KV', originCode: 'AS5' });
  assert.ok(kv.some((c) => c.stop.code === 'NUSS-OPP' && c.legs.length), codesOf(kv).join());
});

test('without a location, from home, every home stop is tried', () => {
  const cands = candidateStops(GRAPH, { ...FROM_PGP, originCode: 'PGPR', preferStops: ['PGPR', 'PGP'] });
  const pgp = cands.find((c) => c.stop.code === 'PGP');
  assert.ok(pgp, codesOf(cands).join());
  assert.equal(pgp.walkS, 300, 'the walk from home, as to the first');
});

test('with a location, a nearby stop no bus there calls at does not crowd out one that does', () => {
  // Opp SDE 3 is nearest, but only the K calls there, and it doesn't go to UTown.
  const cands = candidateStops(GRAPH, { lat: 1.297, lon: 103.771, to: 'UTOWN', originCode: null });
  assert.ok(!cands.some((c) => c.stop.code === 'SDE3-OPP'), codesOf(cands).join());
  assert.ok(cands.some((c) => c.stop.code === 'LT13-OPP'), codesOf(cands).join());
});

test('the same D2 from the other side of the road, the wrong way round the loop, is no alternative', () => {
  const kr = stop('KR-MRT');
  const cands = candidateStops(GRAPH, { lat: kr.lat, lon: kr.lon, to: 'COM3', originCode: null });
  const now = at('2026-08-27T09:00');
  const opts = scoreOptions(GRAPH, cands, boards(codesOf(cands), now, { 'KR-MRT': [{ svc: 'D2', etaS: 240 }], 'KR-MRT-OPP': [{ svc: 'D2', etaS: 240 }] }), now);
  assert.equal(opts[0].stop.code, 'KR-MRT-OPP');
  assert.equal(pickAlt(opts), null);
});

/* Riding. */

test('route P is timed by distance over its long stretches', () => {
  const kv = stop('KV');
  const cg = stop('CG');
  const s = shuttleRideS(idx, ['KV', 'CG'], RIDE.secondsPerHop);
  assert.equal(s, Math.round(haversineM(kv.lat, kv.lon, cg.lat, cg.lon) / RIDE.longHopMs));
  assert.ok(s > 10 * 60, `${s} s`);
  // An ordinary hop is the per-stop figure, as ever.
  assert.equal(shuttleRideS(idx, ['PGP', 'KR-MRT'], RIDE.secondsPerHop), RIDE.secondsPerHop);
  const leg = candidateStops(GRAPH, { ...FROM_PGP, to: 'CG', originCode: 'KV' })[0].legs.find((l) => l.svc === 'P');
  assert.equal(leg.rideS, s);
});

/* The walk the whole way. */

test('the whole walk follows the paths, the same with a location or without', () => {
  const from = stop('UHALL-OPP');
  const located = walkAllTheWayS(GRAPH, { lat: from.lat, lon: from.lon, to: 'COM3', originCode: null }, null);
  const blind = walkAllTheWayS(GRAPH, { lat: null, lon: null, to: 'COM3', originCode: 'UHALL-OPP' }, from);
  assert.ok(Math.abs(located - blind) <= 60, `${located} s located, ${blind} s from the stop`);
});

test('a room near you is walked to directly, not by way of its stop', () => {
  // The room 400 m north of UTown's stop; you, 100 m north of the room.
  const utown = stop('UTOWN');
  const room = { lat: utown.lat + 0.0036, lon: utown.lon };
  const input = { lat: room.lat + 0.0009, lon: room.lon, to: 'UTOWN', originCode: null, endWalkS: 336, destAt: room };
  const w = wholeWalk(GRAPH, input, null);
  assert.equal(w.endS, 0);
  assert.ok(w.s < 120, `${w.s} s`);
});

test('a place with several stops is walked to by whichever is nearest the walk', () => {
  const from = stop('UHALL-OPP');
  const input = { lat: null, lon: null, to: 'COM3', toAlso: ['UHALL-OPP'], originCode: 'UHALL-OPP', endWalkByStopS: { COM3: 0, 'UHALL-OPP': 90 } };
  assert.deepEqual(wholeWalk(GRAPH, input, from), { s: 0, endS: 90 });
});

/* The age of an answer. */

test('a stale answer is counted from now: its bus is no further away than it is', () => {
  const now = at('2026-08-27T09:00');
  const fetchedAt = now - 240_000;
  const cands = candidateStops(GRAPH, { ...FROM_PGP, originWalkS: 60 });
  const byStop = boards(codesOf(cands), fetchedAt, { PGP: [{ svc: 'D2', etaS: 420 }] }, { stale: true });
  const d2 = scoreOptions(GRAPH, cands, byStop, now).find((o) => o.svc === 'D2' && o.stop.code === 'PGP');
  assert.equal(d2.quality, 'stale');
  assert.equal(d2.boardS, 180, 'due in 3 minutes now, not 7');
  assert.equal(d2.fromMs + d2.boardS * 1000, fetchedAt + 420_000, 'the same departure');
  // A walk a minute quicker than the bus is no reason to walk.
  assert.notEqual(walkVerdict(d2.totalS - 60, d2), 'win');
});

test('a stale answer\'s card counts from the request: its next change is never in the past', async () => {
  const { default: fixture } = await import('./fixtures/answers/class-bus.json', { with: { type: 'json' } });
  const { card: _card, refreshAt: _r, ...answer } = fixture;
  const now = Date.parse(answer.asOf);
  // Read four minutes ago; leave in two. Its "time to go" moment was a minute or more ago.
  const old = { ...answer, quality: 'stale', asOf: new Date(now - 240_000).toISOString(), leave: { ...answer.leave, at: new Date(now + 120_000).toISOString() } };
  const card = cardFor(old, false, { key: 'k', phase: 'idle' }, null, now);
  assert.ok(Date.parse(card.nextChangeAt) > now, card.nextChangeAt);
});

test('a leave-by sliding just ahead of now asks for a refetch no sooner than 30 s', async () => {
  const { nextPhaseAt, LEAVE_GAP_MS } = await import('../src/card.ts');
  const { default: fixture } = await import('./fixtures/answers/class-bus.json', { with: { type: 'json' } });
  const { card: _card, refreshAt: _r, ...answer } = fixture;
  const now = Date.parse(answer.asOf);
  const trip = { key: 'k', phase: 'due' };
  // A late bus: leave in 5 s, and the next fetch would say 5 s again.
  const sliding = { ...answer, leave: { ...answer.leave, at: new Date(now + 5_000).toISOString() } };
  const card = cardFor(sliding, false, trip, null, now);
  assert.equal(Date.parse(card.nextChangeAt), now + LEAVE_GAP_MS);
  // The Trip object keeps the exact time (it has its own gap).
  assert.equal(nextPhaseAt(sliding, trip, now), now + 5_000);
  // A leave-by further off is kept to the second.
  const later = { ...answer, leave: { ...answer.leave, at: new Date(now + 90_000).toISOString() } };
  assert.equal(Date.parse(cardFor(later, false, trip, null, now).nextChangeAt), now + 90_000);
});

/* Fares. */

test('walking is free: a public bus must beat it by its fare too', () => {
  const pub = { totalS: 614, quality: 'live', paid: true };
  assert.equal(walkVerdict(659, pub), 'win', 'a fare to save 45 s');
  assert.equal(walkVerdict(659, { ...pub, paid: undefined }), 'close');
});

test('a free bus with no times does not take the headline from a live public bus', () => {
  const it = stop('IT');
  const now = at('2026-08-27T09:00');
  const cands = candidateStops(GRAPH_PUBLIC, { lat: it.lat, lon: it.lon, to: 'KR-MRT', originCode: null }).filter((c) => c.stop.code === 'IT');
  const shuttleDown = null;
  // Ten minutes away: later than the A2's sort key, which is no time at all.
  const lta = { code: 'IT', arrivals: [{ svc: '95', etaS: 600, crowd: null, plate: null, berth: null }], fetchedAt: now, stale: false, available: true };
  const byStop = new Map([['IT', mergeFeeds('IT', now, shuttleDown, lta)]]);
  const opts = scoreOptions(GRAPH_PUBLIC, cands, byStop, now);
  assert.equal(opts[0].svc, '95');
  assert.equal(opts.find((o) => o.svc === 'A2').quality, 'unknown');
});

/* What is live. */

test('a leave-by from a stale feed is not shown as live', () => {
  const now = at('2026-08-27T09:00');
  const cands = candidateStops(GRAPH, FROM_PGP);
  // The D2 at 09:08, read two minutes ago; for a class at 09:25 it's the one to catch.
  const byStop = boards(codesOf(cands), now - 120_000, { PGP: [{ svc: 'D2', etaS: 600 }] }, { stale: true });
  const opts = scoreOptions(GRAPH, cands, byStop, now);
  const leave = leaveBy({ options: opts, candidates: cands, byStop, graph: GRAPH, arriveBy: { atMs: at('2026-08-27T09:25'), venueWalkS: 0 }, walkAllS: null, nowMs: now });
  assert.equal(Date.parse(leave.board), now + 480_000);
  assert.equal(leave.stale, true);
  assert.equal(leave.estimated, false, 'exact, if old');
  const noClass = leaveBy({ options: opts, candidates: cands, byStop, graph: GRAPH, arriveBy: null, walkAllS: null, nowMs: now });
  assert.equal(noClass.stale, true);
});

test('a timetabled public bus in a class\'s leave-by is an estimate', () => {
  // Kent Ridge Ter's own stop, a class at IT: a live 95, and a 151 LTA only has from its timetable.
  const now = at('2026-08-27T09:00');
  const input = { lat: 1.293619, lon: 103.771475, to: 'IT', originCode: null };
  const cands = candidateStops(GRAPH_PUBLIC, input).filter((c) => c.stop.code === '16009');
  const byStop = boards(['16009'], now, { 16009: [{ svc: '95', etaS: 780 }, { svc: '151/2', etaS: 960, scheduled: true }] });
  const opts = scoreOptions(GRAPH_PUBLIC, cands, byStop, now);
  const leave = leaveBy({ options: opts, candidates: cands, byStop, graph: GRAPH_PUBLIC, arriveBy: { atMs: at('2026-08-27T09:30'), venueWalkS: 0 }, walkAllS: null, nowMs: now });
  assert.equal(leave.svc, '151');
  assert.equal(leave.estimated, true);
});

test('choosing the stops that go there still asks the feed about WALK.maxCandidates at most', () => {
  // Skipping stops with no bus there doesn't fan a request out to more of them.
  const cands = candidateStops(GRAPH, { lat: 1.297, lon: 103.771, to: 'UTOWN', originCode: null });
  assert.ok(cands.length <= WALK.maxCandidates);
});

test('riding a public bus reads its arrival from the public graph, by its route', async () => {
  const { nextArrival } = await import('../src/next.ts');
  const nowMs = Date.parse('2026-08-27T02:00:00Z');
  // A stop on the 151's first direction in the public graph.
  const pidx = indexGraph(GRAPH_PUBLIC);
  const alight = [...pidx.routes.get('151/1').pos.keys()][1];
  const asked = [];
  const deps = {
    graph: GRAPH,
    publicGraph: GRAPH_PUBLIC,
    answerFor: async () => { throw new Error('not used'); },
    collectArrivals: async (_env, _ctx, codes, at, graph) => {
      asked.push(graph);
      const arrivals = [{ svc: '151/1', etaS: 240, crowd: null, plate: null, berth: null }];
      return new Map(codes.map((code) => [code, { code, arrivals, fetchedAt: at, stale: false, available: true }]));
    },
  };
  const b = { svc: '151', route: '151/1', paid: true, stop: 'x', board: null, arrive: null, alightCode: alight };
  assert.equal(await nextArrival({}, {}, deps, b, nowMs), new Date(nowMs + 240_000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  assert.equal(asked[0], GRAPH_PUBLIC, 'asked of the graph that has LTA, not the shuttle feed');

  // A shuttle ride still asks the shuttle graph.
  await nextArrival({}, {}, deps, { svc: 'D2', stop: 'x', board: null, arrive: null, alightCode: 'COM3' }, nowMs);
  assert.equal(asked[1], GRAPH);
});

test('riding counts the bus from its own feed: at a shared shelter, not the older one', async () => {
  const { liveArrival, nextArrival } = await import('../src/next.ts');
  const nowMs = Date.parse('2026-08-27T02:00:00Z');
  const pidx = indexGraph(GRAPH_PUBLIC);
  const alight = [...pidx.routes.get('151/1').pos.keys()][1];
  // The shuttle half was fetched a minute ago and is stale; LTA 5 s ago. The
  // stop's own state is the two together: the older time, stale.
  const shuttle = { fetchedAt: nowMs - 60_000, stale: true, available: true };
  const pub = { fetchedAt: nowMs - 5_000, stale: false, available: true };
  const deps = {
    graph: GRAPH,
    publicGraph: GRAPH_PUBLIC,
    answerFor: async () => { throw new Error('not used'); },
    collectArrivals: async (_env, _ctx, codes) => {
      const arrivals = [{ svc: '151/1', etaS: 240, crowd: null, plate: 'SBS1A', berth: null }];
      return new Map(codes.map((code) => [code, { code, arrivals, fetchedAt: shuttle.fetchedAt, stale: true, available: true, feeds: { shuttle, public: pub } }]));
    },
  };
  const b = { svc: '151', route: '151/1', paid: true, stop: 'x', board: null, arrive: null, alightCode: alight, plate: 'SBS1A' };
  const want = new Date(pub.fetchedAt + 240_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  assert.equal(await liveArrival({}, {}, deps, b, nowMs), want);
  assert.equal(await nextArrival({}, {}, deps, b, nowMs), want);
  // The public feed stale itself: no live time.
  pub.stale = true;
  assert.equal(await liveArrival({}, {}, deps, b, nowMs), null);
  assert.equal(await nextArrival({}, {}, deps, b, nowMs), null);
});
