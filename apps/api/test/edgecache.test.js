/**
 * The edge-cache fetch (src/feeds/edgecache.ts) on its own: what a failure around
 * the fetch does to the answer and to the key's memo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { installGlobals, makeCtx, FROZEN_NOW } from './_stubs.mjs';
import { cachedFetch } from '../src/feeds/edgecache.ts';

const options = (over = {}) => ({
  ctx: makeCtx(),
  nowMs: FROZEN_NOW,
  key: 'https://terminus.internal/test/A',
  failKey: 'https://terminus.internal/test-failed/A',
  fetch: async () => ({ value: 1, fetchedAt: FROZEN_NOW }),
  freshMs: 15_000,
  staleMaxS: 300,
  failMemoS: 20,
  inflight: new Map(),
  ...over,
});

test('a cache that cannot be written to still serves the good answer, and marks no failure', async () => {
  const cache = installGlobals(null);
  const put = cache.put.bind(cache);
  cache.put = async (req, res) => {
    if ((typeof req === 'string' ? req : req.url) === 'https://terminus.internal/test/A') throw new Error('cache write failed');
    return put(req, res);
  };
  const o = options();
  const out = await cachedFetch(o);
  await o.ctx.settle();
  assert.equal(out.value, 1);
  assert.equal(out.available, true);
  assert.equal(await cache.match('https://terminus.internal/test-failed/A'), undefined, 'no failure memo for a good answer');
});

/** A promise and the function that settles it, for holding a cache write. */
function gate() {
  let open;
  const p = new Promise((r) => (open = r));
  return { p, open };
}

test("the answer doesn't wait for its cache write; until it lands, the marker stays and this isolate shares the fetch", async () => {
  const cache = installGlobals(null);
  const put = cache.put.bind(cache);
  const held = gate();
  cache.put = async (req, res) => {
    if ((typeof req === 'string' ? req : req.url) === 'https://terminus.internal/test/A') await held.p;
    return put(req, res);
  };
  let calls = 0;
  const o = options({ fetch: async () => ({ value: ++calls, fetchedAt: FROZEN_NOW }) });
  const out = await cachedFetch(o);
  assert.equal(out.value, 1, 'answered with the write still held');
  assert.ok(await cache.match('https://terminus.internal/test/A/pending'), 'the marker is up until the answer is in the cache');
  assert.equal((await cachedFetch(o)).value, 1, 'a second caller here shares the fetch rather than making another');
  assert.equal(calls, 1);

  held.open();
  await o.ctx.settle();
  assert.equal(o.inflight.size, 0);
  assert.equal(await cache.match('https://terminus.internal/test/A/pending'), undefined, 'the marker is cleared once the write is in');
  assert.equal((await (await cache.match('https://terminus.internal/test/A')).json()).value, 1);
});

test('a failure answers at once, and its memos are set before this isolate lets go of the key', async () => {
  const cache = installGlobals(null);
  const put = cache.put.bind(cache);
  const held = gate();
  cache.put = async (req, res) => {
    if ((typeof req === 'string' ? req : req.url) === 'https://terminus.internal/test-failed/A') await held.p;
    return put(req, res);
  };
  let calls = 0;
  const o = options({
    fetch: async () => {
      calls++;
      throw new Error('feed down');
    },
  });
  await assert.rejects(cachedFetch(o), /feed down/);
  await assert.rejects(cachedFetch(o), /feed down/, 'the failed job is shared until its memo is written');
  assert.equal(calls, 1);
  held.open();
  await o.ctx.settle();
  assert.equal(o.inflight.size, 0);
  assert.ok(await cache.match('https://terminus.internal/test-failed/A'));
  await assert.rejects(cachedFetch(o), /recently failed/, 'then the memo quiets the key');
  assert.equal(calls, 1);
});

test("a marker write slower than the fetch can't outlive it", async () => {
  const cache = installGlobals(null);
  const put = cache.put.bind(cache);
  const held = gate();
  cache.put = async (req, res) => {
    if ((typeof req === 'string' ? req : req.url) === 'https://terminus.internal/test/A/pending') await held.p;
    return put(req, res);
  };
  const o = options();
  assert.equal((await cachedFetch(o)).value, 1);
  held.open();
  await o.ctx.settle();
  assert.equal(await cache.match('https://terminus.internal/test/A/pending'), undefined, 'deleted after it was written, not before');
});
