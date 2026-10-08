/**
 * The bus proxy client (src/fms.ts) on its own: one re-mint on a rejection a
 * fresh token could fix, none on one it can't, and a refusal that names the
 * endpoint it came from. worker.smoke.js covers the same through /arrivals.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { installGlobals, makeCtx, makeEnv, makeFetch, makeKV, FROZEN_NOW } from './_stubs.mjs';
import { breakerOpen, fetchActiveBuses, fetchArrivals, getArrivals, getBuses } from '../src/fms.ts';
import { UpstreamRejected, appVersion, deviceId } from '../src/auth.ts';
import { flagged } from '../src/edgecache.ts';

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

test('each request a bus fetch makes to NUS is reported, the first mint on a cold token included', async () => {
  const sent = (f) => f.counts.auth + f.counts.shuttle;
  // A cold token: a mint, then the call.
  let fetch = makeFetch({ buses: { D2: [] } });
  installGlobals(fetch);
  const env = makeEnv();
  let calls = 0;
  await getBuses(env, makeCtx(), 'D2', FROZEN_NOW, () => void calls++);
  assert.equal(fetch.counts.auth, 1);
  assert.equal(calls, sent(fetch), 'the mint and the call');
  // The token kept: the call alone.
  calls = 0;
  await fetchActiveBuses(env, 'D2', FROZEN_NOW, () => void calls++);
  assert.equal(calls, 1);
  assert.equal(sent(fetch), 3);
  // Cold, then refused: a mint, the call, a re-mint and the call again.
  fetch = makeFetch({ reject: 1, rejectCode: '10008' });
  installGlobals(fetch);
  calls = 0;
  await fetchActiveBuses(makeEnv(), 'D2', FROZEN_NOW, () => void calls++);
  assert.equal(sent(fetch), 4);
  assert.equal(calls, 4);
  // Two at once on a cold token share one mint: each reports only what it sent.
  fetch = makeFetch({});
  installGlobals(fetch);
  const shared = makeEnv();
  const each = [0, 0];
  await Promise.all(each.map((_, i) => fetchActiveBuses(shared, 'D2', FROZEN_NOW, () => void each[i]++)));
  assert.equal(fetch.counts.auth, 1);
  assert.equal(each[0] + each[1], sent(fetch), `${each}`);
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

test('the device id is made only when none is stored, and a failed read makes none', async () => {
  // KV down: no id made up, and nothing written over the stored one.
  const kv = makeKV({ 'auth:deviceid': 'stored' });
  const get = kv.get.bind(kv);
  let down = true;
  kv.get = async (k, type) => {
    if (down) throw new Error('KV unavailable');
    return get(k, type);
  };
  const env = makeEnv(kv);
  await assert.rejects(deviceId(env), /KV unavailable/);
  assert.equal(kv._map.get('auth:deviceid'), JSON.stringify('stored'));
  down = false;
  const id = await deviceId(env);
  // Once read, it is remembered: the token's mint and its calls carry the same.
  down = true;
  assert.equal(await deviceId(env), id);

  // None stored: one is made, kept, and the same comes back after.
  const fresh = makeEnv();
  const made = await deviceId(fresh);
  assert.match(made, /^[0-9a-f]{16}$/);
  assert.equal(await fresh.KV.get('auth:deviceid'), made);
  assert.equal(await deviceId(fresh), made);

  // Two isolates both found none: the one whose write lost takes the stored id next.
  const raced = makeEnv();
  const lost = await deviceId(raced);
  await raced.KV.put('auth:deviceid', 'abcdef0123456789');
  assert.notEqual(lost, 'abcdef0123456789');
  assert.equal(await deviceId(raced), 'abcdef0123456789');
});

test("fetchedAt is when the call that answered went out, not when the fetch began", async () => {
  for (const [name, call] of [
    ['shuttle-service', (env) => fetchArrivals(env, 'COM3', FROZEN_NOW)],
    ['active-bus', (env) => fetchActiveBuses(env, 'D2', FROZEN_NOW)],
  ]) {
    const feed = makeFetch({ reject: 1, rejectCode: '10008' });
    installGlobals(feed);
    // Every request to NUS takes 5 s: a mint, a refused call, a re-mint, then the answer.
    let clock = FROZEN_NOW;
    Date.now = () => clock;
    globalThis.fetch = async (input, init) => {
      const res = await feed(input, init);
      clock += 5_000;
      return res;
    };
    const out = await call(makeEnv());
    assert.equal(feed.counts.auth + feed.counts.shuttle, 4, name);
    assert.equal(out.fetchedAt, FROZEN_NOW + 15_000, name);
  }
});

test('a version refused after the switch away from it does not open the breaker for the isolates sending the new one', async () => {
  const OLD = 'univus_android_2.59.2_140';
  const NEW = 'univus_android_2.60.0_150';
  for (const mintRefused of [false, true]) {
    const fetchImpl = makeFetch(mintRefused ? { mintReject: '10009' } : { reject: 99 });
    installGlobals(fetchImpl);
    const kv = makeKV();
    await kv.put('config:appVersion', OLD);
    const env = makeEnv(kv);
    // This isolate read the old version; then another switched to the new one.
    assert.equal(await appVersion(env, FROZEN_NOW), OLD);
    await kv.put('config:appVersion', NEW);
    const ctx = makeCtx();
    await assert.rejects(getArrivals(env, ctx, 'COM3', FROZEN_NOW), (err) => err instanceof UpstreamRejected && err.outdated);
    await ctx.settle();
    assert.equal(await breakerOpen(), false, `mint refused: ${mintRefused}`);
    assert.equal(await flagged('https://terminus.internal/mint-failed'), false, 'nor the mint memo');
    assert.equal(await flagged('https://terminus.internal/failed/COM3'), false, 'nor the stop');
    // This isolate sends the new one from now on.
    assert.equal(await appVersion(env, FROZEN_NOW), NEW);

    // Refused while still the version to send, it opens the breaker as before.
    const env2 = makeEnv(makeKV());
    const ctx2 = makeCtx();
    await assert.rejects(getArrivals(env2, ctx2, 'PGP', FROZEN_NOW), (err) => err instanceof UpstreamRejected && !err.outdated);
    await ctx2.settle();
    assert.equal(await breakerOpen(), true);
  }
});

test('the device id is read from KV once, then kept; a new one is made only when none is stored', async () => {
  const env = makeEnv();
  delete env.NEXTBUS_DEVICE_ID;
  const get = env.KV.get.bind(env.KV);
  let reads = 0;
  env.KV.get = (k, ...rest) => {
    if (k === 'auth:deviceid') reads++;
    return get(k, ...rest);
  };
  const made = await deviceId(env);
  assert.match(made, /^[0-9a-f]{16}$/);
  assert.equal(await deviceId(env), made, 'the stored id, stable');
  assert.equal(await deviceId(env), made);
  assert.equal(reads, 2, 'read once to find none, once to find it stored, then kept');
});
