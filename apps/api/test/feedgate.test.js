/**
 * The feed gate (feedgate.ts): rule 2's limits across every data centre, not
 * only within one. Each "data centre" here is a fresh edge cache
 * (installGlobals) sharing one FEED_GATE namespace, as they share the real one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FROZEN_NOW, installGlobals, makeCtx, makeDurableObjects, makeEnv, makeFetch } from './_stubs.mjs';
import { FeedGate, GateBusy, throughGate } from '../src/feedgate.ts';
import { getArrivals, getBuses } from '../src/fms.ts';
import { getPublicArrivals } from '../src/lta.ts';
import { GRAPH_PUBLIC } from '../src/graph.ts';
import { TTL } from '../src/config.ts';

const D2_IN_4 = [{ name: 'D2', arrivalTime: '4', nextArrivalTime: '14', passengers: 'low', arrivalTime_veh_plate: 'PA1234A' }];
const D1_BUS = { vehplate: 'PD1001A', lat: 1.2966, lng: 103.7764, speed: 20, direction: 90, loadInfo: { capacity: 88, ridership: 10 } };

const gated = () => ({ ...makeEnv(), FEED_GATE: makeDurableObjects(FeedGate) });

/** A call in a data centre of its own: an empty edge cache, the same gate. */
async function elsewhere(env, fetchImpl, nowMs, call) {
  installGlobals(fetchImpl, nowMs);
  const ctx = makeCtx();
  try {
    return await call(ctx);
  } finally {
    await ctx.settle();
  }
}

test('a stop asked for in many data centres at once reaches NUS once a window', async () => {
  const env = gated();
  const f = makeFetch({ byStop: { COM3: D2_IN_4 } });
  for (let dc = 0; dc < 5; dc++) {
    const sa = await elsewhere(env, f, FROZEN_NOW + dc * 1_000, (ctx) => getArrivals(env, ctx, 'COM3', FROZEN_NOW + dc * 1_000));
    assert.equal(sa.arrivals[0]?.svc, 'D2', `data centre ${dc} gets the answer`);
  }
  assert.equal(f.counts.shuttle, 1);
  // The next window, one more call, wherever it's asked.
  const next = FROZEN_NOW + TTL.arrivalsMs;
  await elsewhere(env, f, next, (ctx) => getArrivals(env, ctx, 'COM3', next));
  await elsewhere(env, f, next + 1_000, (ctx) => getArrivals(env, ctx, 'COM3', next + 1_000));
  assert.equal(f.counts.shuttle, 2);
});

test('without the gate each data centre asks NUS itself (what the gate is for)', async () => {
  const env = makeEnv();
  const f = makeFetch({ byStop: { COM3: D2_IN_4 } });
  for (let dc = 0; dc < 3; dc++) await elsewhere(env, f, FROZEN_NOW, (ctx) => getArrivals(env, ctx, 'COM3', FROZEN_NOW));
  assert.equal(f.counts.shuttle, 3);
});

test('a service\'s buses and a stop\'s public buses are gated too', async () => {
  const env = { ...gated(), LTA_ACCOUNT_KEY: 'test' };
  const f = makeFetch({ buses: { D1: [D1_BUS] }, publicStops: { 16189: [] } });
  for (let dc = 0; dc < 3; dc++) await elsewhere(env, f, FROZEN_NOW, (ctx) => getBuses(env, ctx, 'D1', FROZEN_NOW));
  assert.equal(f.counts.shuttle, 1);
  const stop = Object.values(GRAPH_PUBLIC.stops).find((s) => s.publicCode);
  if (stop) {
    for (let dc = 0; dc < 3; dc++) await elsewhere(env, f, FROZEN_NOW, (ctx) => getPublicArrivals(env, ctx, GRAPH_PUBLIC, stop.code, stop.publicCode, FROZEN_NOW).catch(() => null));
    assert.ok(f.counts.public <= 1, `public calls: ${f.counts.public}`);
  }
});

test('a caller arriving while another\'s call runs waits for its answer', async () => {
  const env = gated();
  installGlobals(null, FROZEN_NOW);
  let release;
  let calls = 0;
  const slow = () => (calls++, new Promise((r) => (release = r)));
  const ctx = makeCtx();
  const first = throughGate(env, ctx, 'k', 15_000, slow);
  await new Promise((r) => setTimeout(r, 5));
  const second = throughGate(env, makeCtx(), 'k', 15_000, async () => (calls++, 'mine'));
  await new Promise((r) => setTimeout(r, 5));
  release({ v: 'theirs' });
  assert.deepEqual(await first, { v: 'theirs' });
  await ctx.settle();
  assert.deepEqual(await second, { v: 'theirs' });
  assert.equal(calls, 1);
});

test('a failed call holds its window: nobody else asks the feed until it ends', async () => {
  const env = gated();
  installGlobals(null, FROZEN_NOW);
  const ctx = makeCtx();
  await assert.rejects(throughGate(env, ctx, 'k', 15_000, async () => { throw new Error('down'); }), /down/);
  await ctx.settle();
  let asked = 0;
  await assert.rejects(throughGate(env, makeCtx(), 'k', 15_000, async () => (asked++, 'x')), GateBusy);
  assert.equal(asked, 0);
  Date.now = () => FROZEN_NOW + 15_000;
  assert.equal(await throughGate(env, makeCtx(), 'k', 15_000, async () => (asked++, 'x')), 'x');
  assert.equal(asked, 1);
});

test('an answer from a call that outlived its window does not replace a newer one', async () => {
  const env = gated();
  installGlobals(null, FROZEN_NOW);
  let release;
  const old = makeCtx();
  const late = throughGate(env, old, 'k', 15_000, () => new Promise((r) => (release = r)));
  await new Promise((r) => setTimeout(r, 5));
  Date.now = () => FROZEN_NOW + 15_000;
  const ctx = makeCtx();
  assert.equal(await throughGate(env, ctx, 'k', 15_000, async () => 'new'), 'new');
  await ctx.settle();
  release('old');
  await late;
  await old.settle();
  assert.equal(await throughGate(env, makeCtx(), 'k', 15_000, async () => 'never'), 'new');
});

test('an unreachable gate is skipped: the call goes ahead on the data centre\'s own limits', async () => {
  const broken = { idFromName: (n) => n, get: () => ({ fetch: async () => { throw new Error('gate down'); } }) };
  const env = { ...makeEnv(), FEED_GATE: broken };
  installGlobals(null, FROZEN_NOW);
  assert.equal(await throughGate(env, makeCtx(), 'k', 15_000, async () => 'ok'), 'ok');
});

test('a gate with nothing to share yet neither quiets the stop nor trips the breaker', async () => {
  const env = gated();
  const failing = makeFetch({ fail: true });
  await elsewhere(env, failing, FROZEN_NOW, (ctx) => getArrivals(env, ctx, 'COM3', FROZEN_NOW).catch(() => null));
  const before = failing.counts.shuttle;
  // Another data centre, inside the failed window: no call, an error, and no memo left behind.
  const cache = installGlobals(failing, FROZEN_NOW + 1_000);
  const ctx = makeCtx();
  await assert.rejects(getArrivals(env, ctx, 'COM3', FROZEN_NOW + 1_000));
  await ctx.settle();
  assert.equal(failing.counts.shuttle, before);
  assert.equal(await cache.match(new Request('https://terminus.internal/breaker')), undefined);
  assert.equal(await cache.match(new Request('https://terminus.internal/failed/COM3')), undefined);
});
