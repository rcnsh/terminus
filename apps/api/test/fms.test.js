/**
 * The bus proxy client (src/fms.ts) on its own: one re-mint on a rejection a
 * fresh token could fix, none on one it can't, and a refusal that names the
 * endpoint it came from. worker.smoke.js covers the same through /arrivals.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { installGlobals, makeEnv, makeFetch, FROZEN_NOW } from './_stubs.mjs';
import { fetchActiveBuses, fetchArrivals } from '../src/fms.ts';
import { UpstreamRejected } from '../src/auth.ts';

test('fetchArrivals and fetchActiveBuses retry a rejection once with a fresh token', async () => {
  for (const [name, call] of [
    ['shuttle-service', (env) => fetchArrivals(env, 'COM3', FROZEN_NOW)],
    ['active-bus', (env) => fetchActiveBuses(env, 'D2', FROZEN_NOW)],
  ]) {
    const fetch = makeFetch({ reject: 1, rejectCode: '10008' });
    installGlobals(fetch);
    const out = await call(makeEnv());
    assert.equal(out.stale, false, name);
    assert.equal(fetch.counts.shuttle, 2, `${name}: one retry`);
    assert.equal(fetch.counts.auth, 2, `${name}: the retry minted a token`);
  }
});

test('a proxy that keeps rejecting throws UpstreamRejected naming the endpoint', async () => {
  for (const [name, call] of [
    ['shuttle-service', (env) => fetchArrivals(env, 'COM3', FROZEN_NOW)],
    ['active-bus', (env) => fetchActiveBuses(env, 'D2', FROZEN_NOW)],
  ]) {
    const fetch = makeFetch({ reject: 99, rejectCode: '10008' });
    installGlobals(fetch);
    await assert.rejects(call(makeEnv()), (err) => {
      assert.ok(err instanceof UpstreamRejected);
      assert.equal(err.code, '10008');
      assert.equal(err.message, `${name} rejected: code=10008 msg=token invalid`);
      return true;
    });
    assert.equal(fetch.counts.shuttle, 2, `${name}: one retry, not a loop`);

    // A refused version: a fresh token can't fix it, so no second call.
    const refused = makeFetch({ reject: 99 });
    installGlobals(refused);
    await assert.rejects(call(makeEnv()), (err) => err instanceof UpstreamRejected && err.code === '10009');
    assert.equal(refused.counts.shuttle, 1, `${name}: no re-mint on 10009`);
  }
});

test('without the proxy configured, nothing is asked', async () => {
  const fetch = makeFetch();
  installGlobals(fetch);
  const env = { ...makeEnv(), NEXTBUS_PROXY_BASE: undefined };
  await assert.rejects(fetchArrivals(env, 'COM3', FROZEN_NOW), /bus proxy not configured/);
  await assert.rejects(fetchActiveBuses(env, 'D2', FROZEN_NOW), /bus proxy not configured/);
  assert.equal(fetch.counts.shuttle + fetch.counts.auth, 0);
});
