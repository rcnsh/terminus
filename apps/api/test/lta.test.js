/**
 * The LTA DataMall client (src/lta.ts): reading the feed, telling a two-way
 * service's directions apart, and the same quiet-under-failure caching as
 * the shuttle feed. The fixtures are real replies captured 2026-10-06.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { installGlobals, ltaPayload, makeCtx, makeEnv, makeFetch, FROZEN_NOW } from './_stubs.mjs';
import { LtaRefused, fetchPublicArrivals, getPublicArrivals, normalizePublic, parseLoad, publicProblem, routeFor } from '../src/lta.ts';
import { GRAPH_PUBLIC } from '../src/graph.ts';
import { TTL } from '../src/config.ts';

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
// The captures were taken at 17:28 SGT on 2026-10-06.
const CAPTURED = Date.parse('2026-10-06T09:28:50Z');
const env = () => ({ ...makeEnv(), LTA_ACCOUNT_KEY: 'test-account-key' });

test('a real reply at YIH (16171) becomes arrivals for 151 and 95, each on its route', () => {
  const rows = normalizePublic(fixture('lta-BusArrival-16171.json'), 'YIH', GRAPH_PUBLIC, CAPTURED);
  assert.equal(rows.length, 6);
  // 151 towards Kent Ridge Terminal calls at YIH: direction 1.
  assert.deepEqual([...new Set(rows.map((a) => a.svc))].sort(), ['151/1', '95']);
  for (const a of rows) {
    assert.ok(a.etaS > 0 && a.etaS < 60 * 60, `eta ${a.etaS}`);
    assert.equal(a.plate, null);
    assert.equal(a.berth, null);
    assert.equal(a.scheduled, undefined, 'every bus in this capture was on the road');
  }
  assert.equal(rows[0].crowd, 'low');
  // The feed lists the three buses of a service soonest first; so do we.
  const of151 = rows.filter((a) => a.svc === '151/1').map((a) => a.etaS);
  assert.deepEqual(of151, [...of151].sort((a, b) => a - b));
});

test('a timetabled bus (Monitored 0) is marked scheduled, never passed off as live', () => {
  const rows = normalizePublic(fixture('lta-BusArrival-18329.json'), 'UHC', GRAPH_PUBLIC, CAPTURED);
  const live = rows.filter((a) => !a.scheduled);
  const sched = rows.filter((a) => a.scheduled);
  assert.equal(live.length, 1);
  assert.equal(sched.length, 4);
  // 95B: an evening short-working with the 95's stops, its own route in the graph.
  assert.ok(rows.some((a) => a.svc === '95B'));
});

test('a two-way service is told apart by the stop it is at, else by where the bus is going', () => {
  // The 151 calls at the Museum only towards the terminal, at IT only away from it.
  assert.equal(routeFor(GRAPH_PUBLIC, 'MUSEUM', '151', null), '151/1');
  assert.equal(routeFor(GRAPH_PUBLIC, 'IT', '151', null), '151/2');
  // At Kent Ridge Terminal's public stop both directions call: the destination tells.
  assert.equal(routeFor(GRAPH_PUBLIC, '16009', '151', '16009'), '151/1');
  assert.equal(routeFor(GRAPH_PUBLIC, '16009', '151', '64009'), '151/2');
  assert.equal(routeFor(GRAPH_PUBLIC, '16009', '151', null), null);
  // A loop is one route, named after itself.
  assert.equal(routeFor(GRAPH_PUBLIC, 'CLB', '95', '16009'), '95');
  // A service the graph doesn't know, or one that doesn't call here, is nobody's.
  assert.equal(routeFor(GRAPH_PUBLIC, 'CLB', '999', null), null);
  assert.equal(routeFor(GRAPH_PUBLIC, 'PGP', '95', '16009'), null);
});

test('load bands become crowd levels; anything else is unknown', () => {
  assert.equal(parseLoad('SEA'), 'low');
  assert.equal(parseLoad('SDA'), 'medium');
  assert.equal(parseLoad('LSD'), 'high');
  assert.equal(parseLoad(''), null);
  assert.equal(parseLoad(undefined), null);
});

test('a bus a minute gone is dropped; one just due reads as now, never 0', () => {
  const raw = ltaPayload('16181', [{ ServiceNo: '95', buses: [{ etaS: -90, dest: '16009' }, { etaS: -20, dest: '16009' }, { etaS: 300, dest: '16009' }] }]);
  const rows = normalizePublic(raw, 'CLB', GRAPH_PUBLIC, FROZEN_NOW);
  assert.deepEqual(rows.map((a) => a.etaS), [1, 300]);
});

test('empty slots and unknown services are skipped; a reply with no Services list is a problem', () => {
  const raw = ltaPayload('16181', [
    { ServiceNo: '95', buses: [{ etaS: 120, dest: '16009' }] },
    { ServiceNo: '999', buses: [{ etaS: 60, dest: '00000' }] },
  ]);
  const rows = normalizePublic(raw, 'CLB', GRAPH_PUBLIC, FROZEN_NOW);
  assert.deepEqual(rows.map((a) => [a.svc, a.etaS]), [['95', 120]]);
  const problem = (raw, stop = 'CLB') => publicProblem(raw, stop, GRAPH_PUBLIC, FROZEN_NOW);
  assert.equal(problem(raw), null);
  // Services listed, none with a bus: a real "no bus" at night.
  assert.equal(problem(ltaPayload('16181', [{ ServiceNo: '95', buses: [] }])), null);
  assert.equal(problem({ odata: 'x' }), 'no Services list');
  // Only a service the graph doesn't know (it adds new ones weekly), or only
  // a bus already gone: real replies, not a changed feed.
  assert.equal(problem(ltaPayload('16181', [{ ServiceNo: '999', buses: [{ etaS: 60, dest: '00000' }] }])), null);
  assert.equal(problem(ltaPayload('16181', [{ ServiceNo: '95', buses: [{ etaS: -120, dest: '16009' }] }])), null);
});

/** [raw] with every bus's [field] renamed to [to], or set to [value] when [to] is null. */
function withBus(raw, field, to, value) {
  for (const s of raw.Services) {
    for (const slot of ['NextBus', 'NextBus2', 'NextBus3']) {
      const b = s[slot];
      if (!b.EstimatedArrival) continue;
      if (to) {
        b[to] = b[field];
        delete b[field];
      } else if (value === undefined) delete b[field];
      else b[field] = value;
    }
  }
  return raw;
}

test('a bus is live only when Monitored is 1; anything else is the timetable', () => {
  const read = (value) => normalizePublic(withBus(ltaPayload('16181', [{ ServiceNo: '95', buses: [{ etaS: 300, dest: '16009' }] }]), 'Monitored', null, value), 'CLB', GRAPH_PUBLIC, FROZEN_NOW)[0];
  for (const live of [1, '1', ' 1', true]) assert.equal(read(live).scheduled, undefined, JSON.stringify(live));
  for (const timetable of [0, '0', false, 'false', null, undefined, '', 2, -1, 'N', {}]) assert.equal(read(timetable).scheduled, true, JSON.stringify(timetable));
  // Renamed, it's missing: the timetable, never live.
  const renamed = withBus(ltaPayload('16181', [{ ServiceNo: '95', buses: [{ etaS: 300, dest: '16009' }] }]), 'Monitored', 'IsMonitored');
  assert.equal(normalizePublic(renamed, 'CLB', GRAPH_PUBLIC, FROZEN_NOW)[0].scheduled, true);
});

test('a time without its zone, or more than a week away, is not a bus, and says the feed changed', () => {
  const one = () => ltaPayload('16181', [{ ServiceNo: '95', buses: [{ etaS: 300, dest: '16009' }] }]);
  const at = (iso) => withBus(one(), 'EstimatedArrival', null, iso);
  // DataMall's own form, and the same moment in another zone, read alike.
  const local = new Date(FROZEN_NOW + 8 * 3_600_000 + 300_000).toISOString().replace(/\.\d+Z$/, '');
  for (const iso of [`${local}+08:00`, new Date(FROZEN_NOW + 300_000).toISOString()]) {
    assert.deepEqual(normalizePublic(at(iso), 'CLB', GRAPH_PUBLIC, FROZEN_NOW).map((a) => a.etaS), [300], iso);
  }
  // No zone: read as UTC on a Worker, it would be 8 h late and still live.
  for (const iso of [local, local.replace('T', ' '), new Date(FROZEN_NOW + 30 * 86_400_000).toISOString(), 'soon']) {
    const raw = at(iso);
    assert.deepEqual(normalizePublic(raw, 'CLB', GRAPH_PUBLIC, FROZEN_NOW), [], iso);
    assert.match(publicProblem(raw, 'CLB', GRAPH_PUBLIC, FROZEN_NOW), /an arrival time it cannot read \(95\)/, iso);
  }
});

test('a reply whose fields moved is a problem, not "no bus"', () => {
  const problem = (raw, stop = 'CLB') => publicProblem(raw, stop, GRAPH_PUBLIC, FROZEN_NOW);
  const one = () => ltaPayload('16181', [{ ServiceNo: '95', buses: [{ etaS: 300, dest: '16009' }] }]);
  assert.match(problem(withBus(one(), 'EstimatedArrival', 'Arrival')), /an arrival time it cannot read/);
  const moved = one();
  moved.Services[0].Next_Bus = moved.Services[0].NextBus;
  delete moved.Services[0].NextBus;
  assert.match(problem(moved), /no NextBus for 95/);
  const flat = one();
  flat.Services[0].NextBus = '2026-08-27T09:05:00+08:00';
  assert.match(problem(flat), /an arrival time it cannot read/);
  assert.match(problem({ Services: [null] }), /a service it cannot read/);
  // At Kent Ridge Terminal both directions of the 151 call: without its
  // destination a bus can't be put on either, and would vanish unnoticed.
  const both = () => ltaPayload('16009', [
    { ServiceNo: '95', buses: [{ etaS: 120, dest: '16009' }] },
    { ServiceNo: '151', buses: [{ etaS: 240, dest: '64009' }] },
  ]);
  assert.equal(problem(both(), '16009'), null);
  assert.match(problem(withBus(both(), 'DestinationCode', 'Destination'), '16009'), /a bus with no destination \(151\)/);
  // The loop never needs one, so on its own it's fine without.
  assert.equal(problem(withBus(one(), 'DestinationCode', 'Destination')), null);
});

test('fetchPublicArrivals sends the account key, and a 401 is a refusal, not "no bus"', async () => {
  const fetch = makeFetch({ publicStops: { 16181: [{ ServiceNo: '95', buses: [{ etaS: 240, dest: '16009' }] }] } });
  installGlobals(fetch);
  const sa = await fetchPublicArrivals(env(), GRAPH_PUBLIC, 'CLB', '16181', FROZEN_NOW);
  assert.equal(sa.code, 'CLB');
  assert.deepEqual(sa.arrivals.map((a) => [a.svc, a.etaS, a.crowd]), [['95', 240, 'low']]);
  const req = fetch.requests.at(-1);
  assert.equal(req.headers.get('AccountKey'), 'test-account-key');
  assert.match(req.url, /v3\/BusArrival\?BusStopCode=16181$/);

  installGlobals(makeFetch({ publicStatus: 401 }));
  await assert.rejects(fetchPublicArrivals(env(), GRAPH_PUBLIC, 'CLB', '16181', FROZEN_NOW), LtaRefused);
  // Without the key there is nothing to ask with.
  await assert.rejects(fetchPublicArrivals(makeEnv(), GRAPH_PUBLIC, 'CLB', '16181', FROZEN_NOW), /not configured/);
});

test('getPublicArrivals: one call per stop per 15 s, stale served when the feed fails, a refused key quiets every stop', async () => {
  const fetch = makeFetch({ publicStops: { 16181: [{ ServiceNo: '95', buses: [{ etaS: 240, dest: '16009' }] }] } });
  installGlobals(fetch, FROZEN_NOW);
  const e = env();
  const ctx = makeCtx();
  const a = await getPublicArrivals(e, ctx, GRAPH_PUBLIC, 'CLB', '16181', FROZEN_NOW);
  const b = await getPublicArrivals(e, ctx, GRAPH_PUBLIC, 'CLB', '16181', FROZEN_NOW + 5_000);
  await ctx.settle();
  assert.equal(fetch.counts.public, 1, 'the second ask inside the window is served from the cache');
  assert.equal(a.available, true);
  assert.equal(b.stale, false);

  // The feed goes away: the stale answer is served, marked stale.
  const down = makeFetch({ publicFail: true });
  globalThis.fetch = down;
  const c = await getPublicArrivals(e, ctx, GRAPH_PUBLIC, 'CLB', '16181', FROZEN_NOW + TTL.arrivalsMs + 1_000);
  await ctx.settle();
  assert.equal(c.stale, true);
  assert.deepEqual(c.arrivals.map((x) => x.svc), ['95']);

  // A refused key trips the breaker: another stop isn't even asked.
  installGlobals(makeFetch({ publicStatus: 401 }), FROZEN_NOW);
  const ctx2 = makeCtx();
  await assert.rejects(getPublicArrivals(e, ctx2, GRAPH_PUBLIC, 'IT', '16189', FROZEN_NOW));
  await ctx2.settle();
  const refused = makeFetch({ publicStatus: 401 });
  globalThis.fetch = refused;
  await assert.rejects(getPublicArrivals(e, ctx2, GRAPH_PUBLIC, 'YIH', '16171', FROZEN_NOW + 1_000), /recently failed/);
  assert.equal(refused.counts.public, 0, 'nothing is asked of a feed that refused the key');
});
