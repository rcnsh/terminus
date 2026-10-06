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
  assert.equal(publicProblem(raw, rows), null);
  // Services listed, none with a bus: a real "no bus" at night.
  const quiet = ltaPayload('16181', [{ ServiceNo: '95', buses: [] }]);
  assert.equal(publicProblem(quiet, normalizePublic(quiet, 'CLB', GRAPH_PUBLIC, FROZEN_NOW)), null);
  assert.equal(publicProblem({ odata: 'x' }, []), 'no Services list');
  // Services with buses and not one placed: the shape (or the graph) moved.
  const odd = ltaPayload('16181', [{ ServiceNo: '999', buses: [{ etaS: 60, dest: '00000' }] }]);
  assert.equal(publicProblem(odd, normalizePublic(odd, 'CLB', GRAPH_PUBLIC, FROZEN_NOW)), 'no bus could be placed on a route');
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
