/**
 * The edge-cache fetch (src/edgecache.ts) on its own: what a failure around
 * the fetch does to the answer and to the key's memo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { installGlobals, makeCtx, FROZEN_NOW } from './_stubs.mjs';
import { cachedFetch } from '../src/edgecache.ts';

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
