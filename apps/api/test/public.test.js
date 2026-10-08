/**
 * Public buses in the stop graph and the answer (src/public.ts, and what
 * resolve.ts, answer.ts, format.ts and leave.ts do with them).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { installGlobals, makeCtx, makeEnv, makeFetch, FROZEN_NOW } from './_stubs.mjs';
import { makeD1, makeEmail } from './_d1.mjs';
import worker from '../src/index.ts';
import { GRAPH, GRAPH_PUBLIC } from '../src/graph.ts';
import { isPublic, publicCodeOf, rideMetres, shuttleCalls, svcName } from '../src/public.ts';
import { boardAt, candidateStops, feedFor, inService, indexGraph, legRideS, reach, scoreOptions } from '../src/resolve.ts';
import { collectArrivals, mergeFeeds } from '../src/answer.ts';
import { planOfLeave } from '../src/plan.ts';
import { leaveOf } from '../src/trip.ts';
import { leaveBy } from '../src/leave.ts';
import { DEFAULT_HEADWAY_S, PUBLIC, RIDE, WALK } from '../src/config.ts';

const idx = indexGraph(GRAPH_PUBLIC);
const stop = (code) => idx.byCode.get(code);
const key = (e) => ({ ...makeEnv(), LTA_ACCOUNT_KEY: 'test-account-key', ...e });

test('the public graph keeps every shuttle stop and route, and adds the public ones', () => {
  for (const s of GRAPH.stops) assert.ok(idx.byCode.has(s.code), s.code);
  for (const svc of Object.keys(GRAPH.routes)) assert.deepEqual(GRAPH_PUBLIC.routes[svc], GRAPH.routes[svc]);
  // A shared shelter: the shuttle's code, with LTA's alongside.
  assert.equal(stop('CLB').publicCode, '16181');
  assert.equal(publicCodeOf(stop('CLB')), '16181');
  assert.equal(shuttleCalls(stop('CLB')), true);
  // Kent Ridge Terminal's public stop on Clementi Road: a stop of its own.
  assert.equal(stop('16009').public, true);
  assert.equal(publicCodeOf(stop('16009')), '16009');
  assert.equal(shuttleCalls(stop('16009')), false);
  // A shuttle-only stop has no public code.
  assert.equal(publicCodeOf(stop('PGP')), null);
  // The plain graph knows nothing of any of this.
  assert.equal(GRAPH.public, undefined);
  assert.equal(indexGraph(GRAPH).byCode.get('CLB').publicCode, undefined);
});

test('a two-way service is two routes that show as one name; a loop is itself', () => {
  assert.equal(svcName('151/1'), '151');
  assert.equal(svcName('95'), '95');
  assert.equal(svcName('D2'), 'D2');
  assert.ok(isPublic(GRAPH_PUBLIC, '151/1'));
  assert.ok(isPublic(GRAPH_PUBLIC, '95'));
  assert.ok(!isPublic(GRAPH_PUBLIC, 'D2'));
  assert.ok(!isPublic(GRAPH, '95'));
  assert.equal(GRAPH_PUBLIC.public['151/1'].svc, '151');
  assert.equal(GRAPH_PUBLIC.public['95'].operator, 'SBST');
});

test('ride time on a public bus is the metres along its route, the long way round included', () => {
  // The 95 from IT to Opp KR MRT: along Lower Kent Ridge Road, under 2 km.
  const m = rideMetres(idx, '95', 'IT', 'KR-MRT-OPP');
  assert.ok(m > 1_500 && m < 2_000, `${m} m`);
  // From Opp KR MRT to KR MRT it goes out to Holland Village and back: several km, not a hop.
  const round = rideMetres(idx, '95', 'KR-MRT-OPP', 'KR-MRT');
  assert.ok(round > 5_000, `${round} m`);
  // Wrapping the loop: from the Central Library back round through the terminal to IT.
  const wrap = rideMetres(idx, '95', 'CLB', 'IT');
  const toEnd = rideMetres(idx, '95', 'CLB', '16009');
  const fromStart = rideMetres(idx, '95', '16009', 'IT');
  assert.equal(wrap, toEnd + fromStart);
  // Not downstream on a one-way route; the shuttle has no metres.
  assert.equal(rideMetres(idx, '151/1', '16009', 'MUSEUM'), null);
  assert.equal(rideMetres(idx, 'D2', 'PGP', 'UTOWN'), null);
  assert.equal(rideMetres(idx, '95', 'CLB', 'CLB'), 0);
});

// Standing at the Central Library, going to Kent Ridge MRT: A1 and 95 both go,
// each on past its terminal (Kent Ridge Bus Terminal, Kent Ridge Ter).
const AT_CLB = { lat: 1.296544, lon: 103.772569, to: 'KR-MRT', originCode: null };
// Standing at IT, going to Kent Ridge MRT: A2 and 95 both go, straight there.
const AT_IT = { lat: 1.297204, lon: 103.772688, to: 'KR-MRT', originCode: null };

test('candidates at a shared shelter carry the public leg with its ride time from metres', () => {
  const cands = candidateStops(GRAPH_PUBLIC, AT_IT);
  const it = cands.find((c) => c.stop.code === 'IT');
  const leg = it.legs.find((l) => l.svc === '95');
  assert.ok(leg, '95 goes from IT to KR MRT');
  // It gets off across the road (Opp KR MRT), the sooner side on the loop; the ride is the metres to there.
  assert.equal(leg.to.code, 'KR-MRT-OPP');
  assert.ok(leg.crossS > 0);
  const expect = Math.round(rideMetres(idx, '95', 'IT', 'KR-MRT-OPP') / PUBLIC.speedMs);
  assert.equal(leg.rideS, expect);
  // The shuttle legs are as they were: a count of stops, no rideS of their own.
  const a2 = it.legs.find((l) => l.svc === 'A2');
  assert.ok(a2 && a2.rideS === undefined);
  // The plain graph has no 95 anywhere.
  assert.ok(!candidateStops(GRAPH, AT_IT).some((c) => c.legs.some((l) => l.svc === '95')));
});

test('a ride on past a loop\'s terminal waits there for the next run, a headway', () => {
  const clb = candidateStops(GRAPH_PUBLIC, AT_CLB).find((c) => c.stop.code === 'CLB');
  // The 95 ends its loop at Kent Ridge Ter, between CLB and Kent Ridge MRT.
  const bus95 = clb.legs.find((l) => l.svc === '95');
  assert.equal(bus95.rideS, Math.round(rideMetres(idx, '95', 'CLB', 'KR-MRT-OPP') / PUBLIC.speedMs) + GRAPH_PUBLIC.headwayS['95']);
  // The A1 ends its at Kent Ridge Bus Terminal, the stop after CLB.
  const a1 = clb.legs.find((l) => l.svc === 'A1');
  assert.equal(a1.rideS, a1.hops * RIDE.secondsPerHop + DEFAULT_HEADWAY_S);
  // The 96's interchange (Clementi) isn't a campus stop: riding round from Raffles Hall goes through it.
  assert.ok(reach(idx, '96', 'RAFFLES', 'IT').through, '96 round through Clementi');
  assert.ok(!reach(idx, '96', 'IT', 'RAFFLES').through, 'IT to Raffles Hall: the same run');
});

const arrivals = (code, rows, extra = {}) => ({ code, arrivals: rows, fetchedAt: FROZEN_NOW, stale: false, available: true, ...extra });

test('a public bus is the headline only when it clearly beats the free bus; otherwise the alternative', () => {
  const cands = candidateStops(GRAPH_PUBLIC, AT_IT).filter((c) => c.stop.code === 'IT');
  const a2 = cands[0].legs.find((l) => l.svc === 'A2');
  const bus95 = cands[0].legs.find((l) => l.svc === '95');
  const a2Ride = legRideS(a2);
  // The 95 comes in 5 min and rides faster, but saves less than a fare is worth: A2 stays the answer.
  const close = new Map([['IT', arrivals('IT', [
    { svc: 'A2', etaS: 300 + legRideS(bus95) - a2Ride + PUBLIC.fareWorthS - 30, crowd: null, plate: 'PA2', berth: null },
    { svc: '95', etaS: 300, crowd: 'low', plate: null, berth: null },
  ])]]);
  let opts = scoreOptions(GRAPH_PUBLIC, cands, close, FROZEN_NOW);
  assert.equal(opts[0].svc, 'A2');
  assert.equal(opts[1].svc, '95');
  assert.equal(opts[1].paid, true);
  assert.equal(opts[0].paid, undefined);
  // The A2 is a little later still: now the 95 saves more than the fare is worth and wins.
  const clear = new Map([['IT', arrivals('IT', [
    { svc: 'A2', etaS: 300 + legRideS(bus95) - a2Ride + PUBLIC.fareWorthS + 30, crowd: null, plate: 'PA2', berth: null },
    { svc: '95', etaS: 300, crowd: 'low', plate: null, berth: null },
  ])]]);
  opts = scoreOptions(GRAPH_PUBLIC, cands, clear, FROZEN_NOW);
  assert.equal(opts[0].svc, '95');
  assert.equal(opts[0].quality, 'live');
});

test('a weekday-only public service is not running at weekends, so no time is guessed for it', () => {
  const sunday = Date.parse('2026-10-11T18:00:00+08:00');
  const wednesday = Date.parse('2026-10-07T18:00:00+08:00');
  for (const svc of ['95B', '96A', '96B', '33A', '188e']) {
    assert.equal(GRAPH_PUBLIC.serviceHours[svc].sunday, null, svc);
    assert.equal(inService(GRAPH_PUBLIC, svc, sunday), false, `${svc} on a Sunday`);
  }
  assert.equal(inService(GRAPH_PUBLIC, '95B', wednesday), true, 'and it runs on a weekday evening');
  // At IT on a Sunday with the feed saying nothing, no 95B is offered.
  const board = boardAt(GRAPH_PUBLIC, idx, 'IT', arrivals('IT', []), sunday);
  for (const svc of ['95B', '96A', '96B']) assert.ok(!board.some((r) => r.svc === svc && r.quality === 'scheduled'), svc);
});

test('a timetabled public bus ranks as an estimate, below any live bus', () => {
  const cands = candidateStops(GRAPH_PUBLIC, AT_CLB).filter((c) => c.stop.code === 'CLB');
  const byStop = new Map([['CLB', arrivals('CLB', [
    { svc: 'A1', etaS: 900, crowd: null, plate: 'PA1', berth: null },
    { svc: '95', etaS: 60, crowd: 'low', plate: null, berth: null, scheduled: true },
  ])]]);
  const opts = scoreOptions(GRAPH_PUBLIC, cands, byStop, FROZEN_NOW);
  assert.equal(opts[0].svc, 'A1');
  const pub = opts.find((o) => o.svc === '95');
  assert.equal(pub.quality, 'scheduled');
  const board = boardAt(GRAPH_PUBLIC, idx, 'CLB', byStop.get('CLB'), FROZEN_NOW);
  const row = board.find((r) => r.svc === '95');
  assert.deepEqual([row.quality, row.paid, row.etaS], ['scheduled', true, 60]);
  assert.equal(board.find((r) => r.svc === 'A1').paid, undefined);
});

test('two feeds at one shelter keep their own state: one down does not read as the other saying "no bus"', () => {
  const shuttle = arrivals('CLB', [{ svc: 'A1', etaS: 300, crowd: null, plate: 'PA1', berth: null }], { fetchedAt: FROZEN_NOW - 10_000 });
  const merged = mergeFeeds('CLB', FROZEN_NOW, shuttle, null);
  assert.equal(merged.available, true);
  assert.equal(merged.fetchedAt, FROZEN_NOW - 10_000);
  assert.equal(feedFor(merged, false).available, true);
  assert.equal(feedFor(merged, true).available, false);
  assert.equal(feedFor(merged, false).fetchedAt, FROZEN_NOW - 10_000);
  // A stop asked of one feed is that feed's state.
  assert.equal(feedFor(shuttle, true), shuttle);
  assert.equal(feedFor(undefined, true), undefined);

  const cands = candidateStops(GRAPH_PUBLIC, AT_CLB).filter((c) => c.stop.code === 'CLB');
  const opts = scoreOptions(GRAPH_PUBLIC, cands, new Map([['CLB', merged]]), FROZEN_NOW);
  assert.equal(opts.find((o) => o.svc === 'A1').quality, 'live');
  // The public feed was never reached: the 95 is unknown, not a headway guess.
  assert.equal(opts.find((o) => o.svc === '95').quality, 'unknown');
  // Both up, one stale: only the stale one's buses read as stale.
  const both = mergeFeeds('CLB', FROZEN_NOW, { ...shuttle, stale: true }, arrivals('CLB', [{ svc: '95', etaS: 240, crowd: null, plate: null, berth: null }]));
  assert.equal(both.stale, true);
  const o2 = scoreOptions(GRAPH_PUBLIC, cands, new Map([['CLB', both]]), FROZEN_NOW);
  assert.equal(o2.find((o) => o.svc === 'A1').quality, 'stale');
  assert.equal(o2.find((o) => o.svc === '95').quality, 'live');
});

test('collectArrivals asks each stop of the feeds that call there', async () => {
  const fetch = makeFetch({
    byStop: { CLB: [{ name: 'A1', arrivalTime: '5', nextArrivalTime: '15' }] },
    publicStops: { 16181: [{ ServiceNo: '95', buses: [{ etaS: 240, dest: '16009' }] }], 16009: [{ ServiceNo: '151', buses: [{ etaS: 120, dest: '64009' }] }] },
  });
  installGlobals(fetch, FROZEN_NOW);
  const ctx = makeCtx();
  const byStop = await collectArrivals(key(), ctx, ['CLB', '16009', 'PGP'], FROZEN_NOW, GRAPH_PUBLIC);
  await ctx.settle();
  assert.deepEqual(byStop.get('CLB').arrivals.map((a) => a.svc).sort(), ['95', 'A1', 'A1']);
  assert.ok(byStop.get('CLB').feeds.shuttle.available && byStop.get('CLB').feeds.public.available);
  // A public-only stop: LTA alone; a shuttle-only stop: NUS alone.
  assert.deepEqual(byStop.get('16009').arrivals.map((a) => a.svc), ['151/2']);
  assert.equal(byStop.get('16009').feeds, undefined);
  assert.equal(byStop.get('PGP').feeds, undefined);
  assert.equal(fetch.counts.shuttle, 2, 'CLB and PGP');
  assert.equal(fetch.counts.public, 2, 'CLB (as 16181) and 16009');
  // Without public buses, the plain graph asks NUS only, as ever.
  const plain = makeFetch({ byStop: {} });
  installGlobals(plain, FROZEN_NOW);
  await collectArrivals(key(), makeCtx(), ['CLB'], FROZEN_NOW);
  assert.equal(plain.counts.public, 0);
});

const BASE = 'https://bus.example.test';

test('/next?public=1 names the public bus, says it is one, and marks its leg paid; without it nothing changes', async () => {
  const fetch = makeFetch({
    byStop: { IT: [{ name: 'A2', arrivalTime: '9', nextArrivalTime: '19' }] },
    publicStops: { 16189: [{ ServiceNo: '95', buses: [{ etaS: 90, dest: '16009', load: 'SDA' }] }] },
  });
  installGlobals(fetch, FROZEN_NOW);
  const env = key();
  const ask = async (path) => {
    const ctx = makeCtx();
    const res = await worker.fetch(new Request(BASE + path), env, ctx);
    await ctx.settle();
    return res.json();
  };
  const pub = await ask(`/next?lat=${AT_IT.lat}&lon=${AT_IT.lon}&to=KR-MRT&public=1`);
  assert.match(pub.label, /^95 · /);
  assert.match(pub.detail, /public bus/);
  assert.match(pub.detail, /crowding: medium/);
  assert.equal(pub.bus.svc, '95');
  assert.equal(pub.bus.paid, true);
  assert.equal(pub.altBus.svc, 'A2');
  assert.equal(pub.altBus.paid, undefined);
  assert.equal(pub.leave?.svc ?? '95', '95');
  // The raw arrivals are named as the buses are, not by route key.
  assert.ok(pub.arrivals.every((a) => !a.svc.includes('/')));
  const plain = await ask(`/next?lat=${AT_IT.lat}&lon=${AT_IT.lon}&to=KR-MRT`);
  assert.match(plain.label, /^A2 · /);
  assert.ok(!plain.detail.includes('public bus'));
  assert.equal(plain.bus.paid, undefined);
});

test('/arrivals lists public buses at a public stop, and at a shared shelter only when asked', async () => {
  const fetch = makeFetch({
    byStop: { CLB: [{ name: 'A1', arrivalTime: '5', nextArrivalTime: '15' }] },
    publicStops: { 16181: [{ ServiceNo: '95', buses: [{ etaS: 240, dest: '16009' }] }], 16009: [{ ServiceNo: '151', buses: [{ etaS: 120, dest: '64009' }, { etaS: 900, dest: '64009', monitored: false }] }] },
  });
  installGlobals(fetch, FROZEN_NOW);
  const env = key();
  const ask = async (path) => {
    const ctx = makeCtx();
    const res = await worker.fetch(new Request(BASE + path), env, ctx);
    await ctx.settle();
    return [res.status, await res.json()];
  };
  const [s1, own] = await ask('/arrivals?stop=16009');
  assert.equal(s1, 200);
  assert.equal(own.stop.name, 'Kent Ridge Ter');
  // Both directions of the 151 start or end here: the one with a bus, and the other as a guess.
  assert.deepEqual(own.board.filter((r) => r.svc === '151').map((r) => [r.etaS, r.quality, r.paid]), [[120, 'live', true], [null, 'scheduled', true]]);
  const [, shared] = await ask('/arrivals?stop=CLB&public=1');
  assert.deepEqual(shared.board.map((r) => r.svc).filter((s) => s === '95' || s === 'A1').sort(), ['95', 'A1']);
  const [, plain] = await ask('/arrivals?stop=CLB');
  assert.ok(!plain.board.some((r) => r.svc === '95'));
  const [s4] = await ask('/arrivals?stop=99999');
  assert.equal(s4, 400);
});

test('an account with publicBuses on gets public buses on /me/next and /me/nearby; the default does not', async () => {
  const fetch = makeFetch({
    byStop: { IT: [{ name: 'A2', arrivalTime: '9', nextArrivalTime: '19' }], CLB: [], 'YIH-OPP': [] },
    publicStops: { 16189: [{ ServiceNo: '95', buses: [{ etaS: 90, dest: '16009' }] }, { ServiceNo: '151', buses: [{ etaS: 200, dest: '64009' }] }] },
  });
  installGlobals(fetch, FROZEN_NOW);
  const env = { ...key(), DB: makeD1(), EMAIL: makeEmail(), EMAIL_FROM: 'x@example.test' };
  const call = async (path, init = {}) => {
    const ctx = makeCtx();
    const res = await worker.fetch(new Request(BASE + path, init), env, ctx);
    await ctx.settle();
    return res;
  };
  await call('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'you@u.nus.edu' }) });
  const verify = await call('/auth/verify', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `t=${env.EMAIL.lastToken()}` });
  const cookie = verify.headers.get('set-cookie').split(';')[0];
  const put = async (profile) => call('/me/profile', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(profile) });
  const get = (path) => call(path, { headers: { cookie } }).then((r) => r.json());
  const places = [{ key: 'mrt', label: 'KR MRT', to: 'KR-MRT' }];

  assert.equal((await put({ home: { stops: ['PGP'] }, places, publicBuses: 'yes' })).status, 400);
  assert.equal((await put({ home: { stops: ['PGP'] }, places })).status, 200);
  const off = await get(`/me/next?place=mrt&lat=${AT_IT.lat}&lon=${AT_IT.lon}`);
  assert.match(off.label, /^A2 · /);
  assert.equal((await get('/me/profile')).publicBuses, false);

  assert.equal((await put({ home: { stops: ['PGP'] }, places, publicBuses: true })).status, 200);
  assert.equal((await get('/me/profile')).publicBuses, true);
  const on = await get(`/me/next?place=mrt&lat=${AT_IT.lat}&lon=${AT_IT.lon}`);
  assert.match(on.label, /^95 · /);
  assert.equal(on.bus.paid, true);
  assert.equal(on.card.journey.bus.svc, '95');
  assert.equal(on.card.journey.bus.paid, true);
  assert.equal(on.card.journey.backup.svc, 'A2');
  assert.equal(on.card.journey.backup.paid, undefined);
  // The card's words name it with its fare too, for the clients that show only them (the Mac, notifications).
  assert.equal(on.leave.paid, true);
  assert.match(on.card.leaveVia, /\b95 \(\$\) at /);
  const nearby = await get(`/me/nearby?lat=${AT_IT.lat}&lon=${AT_IT.lon}`);
  const it = nearby.stops.find((s) => s.stop.code === 'IT');
  const row = it.board.find((r) => r.svc === '95');
  assert.deepEqual([row.etaS, row.paid, row.color], [90, true, null]);
  // Within walking range, up to the usual number of stops, so no extra load on either feed.
  assert.ok(nearby.stops.length <= WALK.maxCandidates + 1);
});

test('a live public bus does not outrank a free bus with only a headway guess unless the fare is worth it', () => {
  const cands = candidateStops(GRAPH_PUBLIC, AT_IT).filter((c) => c.stop.code === 'IT');
  // The shuttle feed answered with nothing for A2 (a headway guess); the 95 is live, 3 min away.
  const byStop = new Map([['IT', arrivals('IT', [{ svc: '95', etaS: 180, crowd: null, plate: null, berth: null }])]]);
  const opts = scoreOptions(GRAPH_PUBLIC, cands, byStop, FROZEN_NOW);
  const a2 = opts.find((o) => o.svc === 'A2');
  const bus95 = opts.find((o) => o.svc === '95');
  assert.equal(a2.quality, 'scheduled');
  assert.equal(bus95.quality, 'live');
  // Here the guess for A2 is quicker than the 95 plus its fare: A2 stays first despite its tier.
  const costA2 = a2.totalS;
  const cost95 = bus95.totalS + PUBLIC.fareWorthS;
  assert.equal(opts[0].svc, costA2 <= cost95 ? 'A2' : '95');
  // A 95 pulling in now, saving well over the fare's worth: it wins.
  const soon = new Map([['IT', arrivals('IT', [{ svc: '95', etaS: 30, crowd: null, plate: null, berth: null }])]]);
  const o2 = scoreOptions(GRAPH_PUBLIC, cands, soon, FROZEN_NOW);
  assert.equal(o2[0].svc, o2.find((o) => o.svc === '95').totalS + PUBLIC.fareWorthS < costA2 ? '95' : 'A2');
});

test('turning public buses on never crowds a shuttle stop out of the candidates', () => {
  // Between the terminal and LT13, where two public-only stops on Kent Ridge Crescent are the nearest of all.
  const here = { lat: 1.2947, lon: 103.7707, to: 'UTOWN', originCode: null };
  const plain = candidateStops(GRAPH, here).map((c) => c.stop.code);
  const withPub = candidateStops(GRAPH_PUBLIC, here).map((c) => c.stop.code);
  for (const code of plain) assert.ok(withPub.includes(code), `${code} lost`);
  // At most one public-only stop joins them.
  assert.ok(withPub.filter((c) => idx.byCode.get(c).public).length <= 1);
  assert.ok(withPub.length <= plain.length + 1);
});

test('a kept plan for a public bus keeps its fare mark and its route', () => {
  const cands = candidateStops(GRAPH_PUBLIC, { lat: 1.293619, lon: 103.771475, to: 'IT', originCode: null }).filter((c) => c.stop.code === '16009');
  assert.ok(cands.length, 'Kent Ridge Terminal public stop is a candidate');
  const byStop = new Map([['16009', arrivals('16009', [{ svc: '151/2', etaS: 240, crowd: null, plate: null, berth: null }])]]);
  const opts = scoreOptions(GRAPH_PUBLIC, cands, byStop, FROZEN_NOW);
  const leave = leaveBy({ options: opts, candidates: cands, byStop, graph: GRAPH_PUBLIC, arriveBy: null, walkAllS: null, nowMs: FROZEN_NOW - 600_000 });
  assert.equal(leave.svc, '151');
  assert.equal(leave.paid, true);
  assert.equal(leave.route, '151/2');
  const plan = planOfLeave(leave, true, 'IT');
  assert.equal(plan.paid, true);
  assert.equal(plan.route, '151/2');
  const again = leaveOf(plan);
  assert.equal(again.paid, true);
  assert.equal(again.route, '151/2');
});
