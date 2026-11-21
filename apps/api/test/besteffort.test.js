import test from 'node:test';
import assert from 'node:assert/strict';

import { FROZEN_NOW, installGlobals, makeAnalytics, makeCtx, makeEnv, makeFetch, makeKV, named } from './_stubs.mjs';
import { cachedFetch, scopeCache } from '../src/feeds/edgecache.ts';
import { getArrivals } from '../src/feeds/fms.ts';
import { noteBreakerOpen } from '../src/feeds/feedwatch.ts';
import { loadCalendar } from '../src/timetable/calendarsync.ts';
import { writeRow } from '../src/analytics-rows.ts';

async function collected(fn) {
  const lines = [];
  const { warn, error, log } = console;
  console.warn = console.error = console.log = (...a) => lines.push(a.map(String).join(' '));
  try {
    await fn();
  } finally {
    Object.assign(console, { warn, error, log });
  }
  return lines;
}

const errors = (ae) => ae.named('error').map((r) => r.route);

function options(env, ctx, fetch, more = {}) {
  return {
    env,
    ctx,
    nowMs: FROZEN_NOW,
    key: 'https://terminus.internal/test/answer',
    failKey: 'https://terminus.internal/test/failed',
    fetch,
    freshMs: 15_000,
    staleMaxS: 300,
    failMemoS: 20,
    inflight: new Map(),
    ...more,
  };
}

test('a cache write that fails leaves the answer as it was, and is logged and counted', async () => {
  const cache = installGlobals();
  cache.put = async () => {
    throw new Error('cache put refused');
  };
  const ae = makeAnalytics();
  const env = makeEnv(makeKV(), ae);
  const ctx = makeCtx();
  let got;
  const lines = await collected(async () => {
    got = await cachedFetch(options(env, ctx, async () => ({ fetchedAt: FROZEN_NOW, n: 7 })));
    await ctx.settle();
  });
  assert.equal(got.n, 7);
  assert.deepEqual(errors(ae), ['edge cache write']);
  assert.match(named(ae.rows('error')[0]).reason, /cache put refused/);
  assert.equal(lines.filter((l) => /edge cache write failed: Error: cache put refused/.test(l)).length, 1, 'once, not per write');
});

test('a failure note that throws leaves the failure as it was, and is logged and counted', async () => {
  installGlobals();
  const ae = makeAnalytics();
  const env = makeEnv(makeKV(), ae);
  const ctx = makeCtx();
  let err;
  const lines = await collected(async () => {
    err = await cachedFetch(
      options(
        env,
        ctx,
        async () => {
          throw new Error('upstream down');
        },
        {
          onFail: () => {
            throw new TypeError('note bug');
          },
        },
      ),
    ).catch((e) => e);
    await ctx.settle();
  });
  assert.equal(err.message, 'upstream down');
  assert.deepEqual(errors(ae), ['feed failure note']);
  assert.ok(lines.some((l) => /feed failure note failed: TypeError: note bug/.test(l)));
});

test('a breaker note KV refuses is logged and counted', async () => {
  const ae = makeAnalytics();
  const kv = makeKV();
  kv.put = async () => {
    throw new Error('KV PUT failed: 429 Too Many Requests');
  };
  const env = { ...makeEnv(kv, ae), PUBLIC_ORIGIN: 'https://beta.terminus.run' };
  const lines = await collected(() => noteBreakerOpen(env, 'nus', new Error('HTTP 503'), FROZEN_NOW));
  assert.ok(lines.some((l) => /breaker note failed: Error: KV PUT failed: 429/.test(l)));
  assert.deepEqual(errors(ae), ['breaker note']);
});

test('a calendar KV cannot read keeps the calendar it has, and is logged and counted', async () => {
  const ae = makeAnalytics();
  const kv = makeKV();
  kv.get = async () => {
    throw new Error('KV GET failed');
  };
  const env = makeEnv(kv, ae);
  const lines = await collected(() => loadCalendar(env, FROZEN_NOW));
  assert.deepEqual(errors(ae), ['calendar load']);
  assert.ok(lines.some((l) => /calendar load failed: Error: KV GET failed/.test(l)));
});

test('an analytics row the dataset refuses is logged once, and never throws', async () => {
  const env = makeEnv(makeKV(), {
    writeDataPoint() {
      throw new Error('too many data points');
    },
  });
  const lines = await collected(() => {
    writeRow(env, 'next', { tookMs: 1 });
    writeRow(env, 'next', { tookMs: 2 });
  });
  assert.equal(lines.filter((l) => /analytics row next lost: Error: too many data points/.test(l)).length, 1);
});

test('a feed answer still comes back when every cache write fails', async () => {
  const cache = installGlobals(makeFetch());
  cache.put = async () => {
    throw new Error('cache put refused');
  };
  const env = makeEnv(makeKV(), makeAnalytics());
  scopeCache(env);
  const ctx = makeCtx();
  await collected(async () => {
    const board = await getArrivals(env, ctx, 'COM3', FROZEN_NOW);
    assert.equal(board.available, true);
    await ctx.settle();
  });
});
