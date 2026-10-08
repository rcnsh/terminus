/**
 * Rule 2 in time: how long each limit on the NUS and LTA feeds holds, not
 * only that it holds at one instant. The other tests make their calls back
 * to back, so a breaker that closed after a second, or a cache that went
 * stale after one, passed them; these step the clock across each limit's
 * edge and count what reached upstream on either side of it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FROZEN_NOW, installGlobals, makeCtx, makeEnv, makeFetch, makeKV } from './_stubs.mjs';
import worker from '../src/index.ts';
import { MIN_POLL_MS, TIMELAPSE, TTL } from '../src/config.ts';
import { fetchArrivals, getArrivals } from '../src/fms.ts';
import { getPublicArrivals } from '../src/lta.ts';
import { GRAPH_PUBLIC } from '../src/graph.ts';
import { cachedFetch } from '../src/edgecache.ts';

const BASE = 'https://bus.example.test';
const D2_IN_4 = [{ name: 'D2', arrivalTime: '4', nextArrivalTime: '14', passengers: 'low', arrivalTime_veh_plate: 'PA1234A' }];
const D1_BUS = { vehplate: 'PD1001A', lat: 1.2966, lng: 103.7764, speed: 20, direction: 90, loadInfo: { capacity: 88, ridership: 10 } };
const HTML = '<!doctype html><html><body>Scheduled maintenance</body></html>';

/** One request to the Worker at `atMs`, its waitUntil work settled. */
async function at(atMs, path, { fetchImpl, env = makeEnv() } = {}) {
  Date.now = () => atMs;
  if (fetchImpl) globalThis.fetch = fetchImpl;
  const ctx = makeCtx();
  const res = await worker.fetch(new Request(BASE + path), env, ctx);
  await ctx.settle();
  return res;
}

/** [base] with the hosts matching [re] answering HTTP 200 and an HTML page,
 *  as a NUS host in maintenance does. Counted in base.counts as usual. */
function htmlFrom(re, base) {
  const fn = async (input, init) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (!re.test(url)) return base(input, init);
    if (url.includes('get-access-token')) base.counts.auth++;
    else if (url.includes('bus-proxy')) base.counts.shuttle++;
    else if (url.startsWith('https://datamall2.mytransport.sg/')) base.counts.public++;
    return new Response(HTML, { headers: { 'content-type': 'text/html' } });
  };
  fn.counts = base.counts;
  fn.requests = base.requests;
  return fn;
}

/* ------------------------------------------------------------------ */
/* The documented limits, as numbers                                   */
/* ------------------------------------------------------------------ */

test('no limit on the feeds is below what CLAUDE.md and internals.md promise', () => {
  // Raising any of these is fine; lowering one sends more to NUS or LTA.
  assert.ok(TTL.arrivalsMs >= 15_000, `arrivalsMs ${TTL.arrivalsMs}`);
  assert.ok(TTL.busesMs >= 5_000, `busesMs ${TTL.busesMs}`);
  assert.ok(TTL.failMemoS >= 20, `failMemoS ${TTL.failMemoS}`);
  assert.ok(TTL.breakerS >= 60, `breakerS ${TTL.breakerS}`);
  assert.ok(TTL.remintGapS >= 60, `remintGapS ${TTL.remintGapS}`);
  // The stale fallback is what an outage is answered from instead of NUS.
  assert.ok(TTL.staleMaxS >= 300, `staleMaxS ${TTL.staleMaxS}`);
  assert.ok(TIMELAPSE.pollMs >= 30_000, `TIMELAPSE.pollMs ${TIMELAPSE.pollMs}`);
  assert.ok(MIN_POLL_MS >= 15_000, `MIN_POLL_MS ${MIN_POLL_MS}`);
  assert.ok(TIMELAPSE.maxPollsPerDay <= 17_280, `maxPollsPerDay ${TIMELAPSE.maxPollsPerDay}`);
  assert.deepEqual(TIMELAPSE.hours, { start: '06:30', end: '00:30' });
});

/* ------------------------------------------------------------------ */
/* Freshness windows                                                   */
/* ------------------------------------------------------------------ */

test('/trip asks NUS once per stop per 15 s: not again at 14.9 s, again at 15.1 s', async () => {
  const fetchImpl = makeFetch({ byStop: { PGP: D2_IN_4 } });
  installGlobals(fetchImpl);
  await at(FROZEN_NOW, '/trip?to=UTOWN&from=PGP');
  assert.equal(fetchImpl.counts.shuttle, 1);
  await at(FROZEN_NOW + 14_900, '/trip?to=UTOWN&from=PGP');
  assert.equal(fetchImpl.counts.shuttle, 1, 'still fresh at 14.9 s');
  await at(FROZEN_NOW + 15_100, '/trip?to=UTOWN&from=PGP');
  assert.equal(fetchImpl.counts.shuttle, 2, 'asked again once 15 s have passed');
});

test('/buses asks NUS once per service per 5 s: not again at 4.9 s, again at 5.1 s', async () => {
  const fetchImpl = makeFetch({ buses: { D1: [D1_BUS] } });
  installGlobals(fetchImpl);
  const busCalls = () => fetchImpl.requests.filter((r) => r.url.endsWith('/active-bus')).length;
  const first = await at(FROZEN_NOW, '/buses?svc=D1');
  assert.equal((await first.json()).available, true);
  assert.equal(busCalls(), 1);
  await at(FROZEN_NOW + 4_900, '/buses?svc=D1');
  assert.equal(busCalls(), 1, 'still fresh at 4.9 s');
  await at(FROZEN_NOW + 5_100, '/buses?svc=D1');
  assert.equal(busCalls(), 2, 'asked again once 5 s have passed');
});

test('with the feed down, the last answer is served stale for five minutes, then not at all', async () => {
  const up = makeFetch({ byStop: { PGP: D2_IN_4 } });
  installGlobals(up);
  const env = makeEnv();
  const ask = async (nowMs) => {
    Date.now = () => nowMs;
    const ctx = makeCtx();
    const out = await getArrivals(env, ctx, 'PGP', nowMs).catch((err) => ({ available: false, err }));
    await ctx.settle();
    return out;
  };
  // Fetched for real, so the cache keeps it as long as the code says.
  assert.equal((await ask(FROZEN_NOW)).stale, false);
  globalThis.fetch = makeFetch({ fail: true });
  const old = await ask(FROZEN_NOW + 200_000);
  assert.equal(old.available, true, 'three minutes on, the last answer still serves');
  assert.equal(old.stale, true);
  assert.equal(old.fetchedAt, FROZEN_NOW);
  const gone = await ask(FROZEN_NOW + (TTL.staleMaxS + 1) * 1000);
  assert.equal(gone.available, false, 'past staleMaxS it is no answer, not a stale one');
});

/* ------------------------------------------------------------------ */
/* The breaker                                                         */
/* ------------------------------------------------------------------ */

test('a tripped breaker keeps every stop off the feed for the whole 60 s, and only that long', async () => {
  const down = makeFetch({ proxyStatus: 503 });
  installGlobals(down);
  const env = makeEnv();
  await at(FROZEN_NOW, '/arrivals?stop=PGP', { fetchImpl: down, env });
  assert.equal(down.counts.shuttle, 1);
  // NUS is back, but the breaker isn't closed yet. A stop of its own each
  // time, so no stop's own failure memo is what's holding it.
  const up = makeFetch({ byStop: { COM3: D2_IN_4, UTOWN: D2_IN_4 } });
  const held = await at(FROZEN_NOW + 59_000, '/arrivals?stop=COM3', { fetchImpl: up, env });
  assert.equal((await held.json()).available, false);
  assert.equal(up.counts.shuttle, 0, 'nothing asked at 59 s');
  const open = await at(FROZEN_NOW + 61_000, '/arrivals?stop=UTOWN', { fetchImpl: up, env });
  assert.equal((await open.json()).available, true);
  assert.equal(up.counts.shuttle, 1, 'exactly one call once it closes');
});

test('every 5xx trips the breaker, 500 and 599 as much as 503', async () => {
  for (const status of [500, 502, 599]) {
    const fetchImpl = makeFetch({ byStop: { PGP: D2_IN_4, COM3: D2_IN_4 }, proxyStatus: status });
    installGlobals(fetchImpl);
    const env = makeEnv();
    await at(FROZEN_NOW, '/arrivals?stop=PGP', { fetchImpl, env });
    for (const stop of ['COM3', 'UTOWN']) {
      const res = await at(FROZEN_NOW + 1_000, `/arrivals?stop=${stop}`, { fetchImpl, env });
      assert.equal((await res.json()).available, false);
    }
    assert.equal(fetchImpl.counts.shuttle, 1, `${status}: the breaker kept every other stop off the feed`);
    assert.equal(fetchImpl.counts.auth, 1, `${status}: no fresh token for it`);
  }
});

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

test("a fresh isolate uses the token another isolate kept in KV: no mint", async () => {
  const kept = { token: 'kept-by-another-isolate-0123456789', userid: 'U1', domain: 'PUBLIC', expMs: FROZEN_NOW + 3_600_000, version: '0.0.0-test' };
  // A new KV binding is a new isolate here: the in-memory memo is per binding.
  const env = makeEnv(makeKV({ 'auth:session': kept }));
  const fetchImpl = makeFetch({ byStop: { COM3: D2_IN_4 } });
  installGlobals(fetchImpl);
  const res = await at(FROZEN_NOW, '/arrivals?stop=COM3', { fetchImpl, env });
  assert.equal((await res.json()).available, true);
  assert.equal(fetchImpl.counts.auth, 0, 'no mint');
  assert.equal(fetchImpl.requests[0].body.token, kept.token);
});

/* ------------------------------------------------------------------ */
/* NUS answering with a web page                                       */
/* ------------------------------------------------------------------ */

test('the bus proxy answering 200 with a web page: stale served, one call per stop per failMemoS, no extra mint', async () => {
  const base = makeFetch({ byStop: { PGP: D2_IN_4 } });
  installGlobals(base);
  const env = makeEnv();
  const ask = async (nowMs) => {
    Date.now = () => nowMs;
    const ctx = makeCtx();
    const out = await getArrivals(env, ctx, 'PGP', nowMs).catch(() => ({ available: false }));
    await ctx.settle();
    return out;
  };
  await ask(FROZEN_NOW);
  const mints = base.counts.auth;
  const calls = base.counts.shuttle;
  const page = htmlFrom(/bus-proxy/, base);
  globalThis.fetch = page;
  await assert.rejects(fetchArrivals(env, 'PGP', FROZEN_NOW), /non-JSON/);
  const t = FROZEN_NOW + 16_000;
  const stale = await ask(t);
  assert.equal(stale.available, true);
  assert.equal(stale.stale, true, 'the last answer, marked stale');
  assert.equal(base.counts.shuttle, calls + 2, 'one call (and the direct one above)');
  await ask(t + 10_000);
  await ask(t + (TTL.failMemoS - 1) * 1000);
  assert.equal(base.counts.shuttle, calls + 2, 'not asked again within failMemoS');
  await ask(t + (TTL.failMemoS + 1) * 1000);
  assert.equal(base.counts.shuttle, calls + 3, 'and once more after it');
  assert.equal(base.counts.auth, mints, 'a web page is not a refused token: no mint');
});

test('the token mint answering 200 with a web page: no other stop mints for failMemoS', async () => {
  const base = makeFetch({ byStop: { PGP: D2_IN_4, COM3: D2_IN_4, UTOWN: D2_IN_4 } });
  const fetchImpl = htmlFrom(/get-access-token/, base);
  installGlobals(fetchImpl);
  const env = makeEnv();
  for (const [dt, stop] of [[0, 'PGP'], [5_000, 'COM3'], [(TTL.failMemoS - 1) * 1000, 'UTOWN']]) {
    const res = await at(FROZEN_NOW + dt, `/arrivals?stop=${stop}`, { fetchImpl, env });
    assert.equal((await res.json()).available, false, stop);
  }
  assert.equal(base.counts.auth, 1, 'one mint, not one per stop');
  assert.equal(base.counts.shuttle, 0);
  // A stop not asked yet: the others' own memos are still set.
  await at(FROZEN_NOW + (TTL.failMemoS + 1) * 1000, '/arrivals?stop=KR-MRT', { fetchImpl, env });
  assert.equal(base.counts.auth, 2, 'tried again once failMemoS has passed');
});

/* ------------------------------------------------------------------ */
/* LTA DataMall                                                        */
/* ------------------------------------------------------------------ */

test('DataMall answering with a web page: the stop is not asked again within failMemoS', async () => {
  const base = makeFetch();
  const fetchImpl = htmlFrom(/datamall2/, base);
  installGlobals(fetchImpl);
  const env = { ...makeEnv(), LTA_ACCOUNT_KEY: 'test-account-key' };
  const ask = async (nowMs) => {
    const ctx = makeCtx();
    await assert.rejects(getPublicArrivals(env, ctx, GRAPH_PUBLIC, 'CLB', '16181', nowMs));
    await ctx.settle();
  };
  await ask(FROZEN_NOW);
  await ask(FROZEN_NOW + 10_000);
  await ask(FROZEN_NOW + (TTL.failMemoS - 1) * 1000);
  assert.equal(base.counts.public, 1, 'one call per stop per failMemoS');
});

/* ------------------------------------------------------------------ */
/* A cache entry it can't read                                         */
/* ------------------------------------------------------------------ */

test('a cached answer that is not JSON is a miss, not a crash', async () => {
  const cache = installGlobals(null);
  const key = 'https://terminus.internal/test/corrupt';
  cache._store.set(key, { body: new TextEncoder().encode('{"fetchedAt": 1, trunc').buffer, headers: {}, expiresAt: FROZEN_NOW + 60_000 });
  let calls = 0;
  const ctx = makeCtx();
  const out = await cachedFetch({
    ctx,
    nowMs: FROZEN_NOW,
    key,
    failKey: 'https://terminus.internal/test-failed/corrupt',
    fetch: async () => (calls++, { value: 2, fetchedAt: FROZEN_NOW }),
    freshMs: 15_000,
    staleMaxS: 300,
    failMemoS: 20,
    inflight: new Map(),
  });
  await ctx.settle();
  assert.equal(out.value, 2);
  assert.equal(out.available, true);
  assert.equal(calls, 1);
});
