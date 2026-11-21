import test from 'node:test';
import assert from 'node:assert/strict';

import { FROZEN_NOW, installGlobals, makeAnalytics, makeCtx, makeEnv, makeFetch, makeKV, named } from './_stubs.mjs';
import { failureReason, getArrivals, noteFailure, renewToken } from '../src/feeds/fms.ts';
import { scopeCache } from '../src/feeds/edgecache.ts';
import { GateBusy } from '../src/feeds/feedgate.ts';
import { MintQuiet, UpstreamRejected, forgetAppVersion } from '../src/feeds/auth.ts';
import { runCron } from '../src/ops/monitor.ts';
import { TTL } from '../src/config.ts';

const VERSION = '0.0.0-test';

async function keep(kv, leftMs, version = VERSION) {
  await kv.put(
    'auth:session',
    JSON.stringify({ token: 'kept.token.x', userid: 'U', domain: 'PUBLIC', expMs: FROZEN_NOW + leftMs, version }),
  );
}

const kept = async (kv) => JSON.parse(await kv.get('auth:session'));

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

function jwt(expMs, lifeMs) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return [b64({ alg: 'HS256' }), b64({ domain: 'PUBLIC', iat: (expMs - lifeMs) / 1000, exp: expMs / 1000 }), 'sig'].join('.');
}

test('a 24-hour token is renewed once less than half its life is left', async () => {
  const DAY = 86_400_000;
  for (const [leftMs, mints] of [
    [13 * 3_600_000, 0],
    [11 * 3_600_000, 1],
    [-60_000, 0],
  ]) {
    const fetchImpl = makeFetch();
    installGlobals(fetchImpl);
    const env = makeEnv();
    scopeCache(env);
    const expMs = FROZEN_NOW + leftMs;
    await env.KV.put('auth:session', JSON.stringify({ token: jwt(expMs, DAY), userid: 'U', domain: 'PUBLIC', expMs, version: VERSION }));
    assert.equal(await renewToken(env, FROZEN_NOW), mints === 1, `left ${leftMs}`);
    assert.equal(fetchImpl.counts.auth, mints, `left ${leftMs}`);
  }
});

test('a token without iat counts as the default lifetime, renewed in its last half', async () => {
  const halfMs = TTL.tokenDefaultS * 1000 * TTL.tokenRenewShare;
  for (const [leftMs, mints] of [
    [halfMs + 60_000, 0],
    [halfMs - 60_000, 1],
    [-60_000, 0],
    [null, 0],
  ]) {
    const fetchImpl = makeFetch();
    installGlobals(fetchImpl);
    const env = makeEnv();
    scopeCache(env);
    if (leftMs !== null) await keep(env.KV, leftMs);
    assert.equal(await renewToken(env, FROZEN_NOW), mints === 1, `left ${leftMs}`);
    assert.equal(fetchImpl.counts.auth, mints, `left ${leftMs}`);
    assert.equal(fetchImpl.counts.shuttle, 0, 'a token only, no feed call');
    if (mints) assert.notEqual((await kept(env.KV)).token, 'kept.token.x', 'the new token is kept');
  }
});

test('a token for another version is left to the next request', async () => {
  const fetchImpl = makeFetch();
  installGlobals(fetchImpl);
  const env = makeEnv();
  scopeCache(env);
  await keep(env.KV, 10 * 60_000, 'univus_android_1.0.0_1');
  assert.equal(await renewToken(env, FROZEN_NOW), false);
  assert.equal(fetchImpl.counts.auth, 0);
});

test('after a renewal, none for twelve hours, however short the new token', async () => {
  const fetchImpl = makeFetch();
  installGlobals(fetchImpl);
  const env = makeEnv();
  scopeCache(env);
  await keep(env.KV, 10 * 60_000);
  assert.equal(await renewToken(env, FROZEN_NOW), true);
  await keep(env.KV, 10 * 60_000);
  assert.equal(await renewToken(env, FROZEN_NOW + 15 * 60_000), false);
  assert.equal(fetchImpl.counts.auth, 1);
});

test('a token that could not be saved is not counted as a renewal', async () => {
  const fetchImpl = makeFetch();
  installGlobals(fetchImpl);
  const env = makeEnv();
  scopeCache(env);
  await keep(env.KV, 10 * 60_000);
  const put = env.KV.put.bind(env.KV);
  env.KV.put = (key, ...rest) => (key === 'auth:session' ? Promise.reject(new Error('KV down')) : put(key, ...rest));
  assert.equal(await renewToken(env, FROZEN_NOW), true);
  assert.equal(await env.KV.get('auth:renewed'), null, 'the next run tries again');
});

test('a renewal that fails leaves the kept token in use, and is tried again next run', async () => {
  const fetchImpl = makeFetch({ mintStatus: 400, byStop: { COM3: [] } });
  installGlobals(fetchImpl);
  const env = makeEnv();
  scopeCache(env);
  await keep(env.KV, 20 * 60_000);
  await assert.rejects(renewToken(env, FROZEN_NOW), /auth HTTP 400/);
  assert.equal(await env.KV.get('auth:renewed'), null, 'not counted as a renewal');
  const sa = await getArrivals(env, makeCtx(), 'COM3', FROZEN_NOW);
  assert.equal(sa.available, true);
  assert.equal(fetchImpl.counts.auth, 1, 'the stop is answered with the kept token, without another mint');
  assert.equal(fetchImpl.requests[0].headers.get('authorization'), 'Bearer kept.token.x');
  installGlobals(fetchImpl, FROZEN_NOW + 15 * 60_000);
  await assert.rejects(renewToken(env, FROZEN_NOW + 15 * 60_000), /auth HTTP 400/);
  assert.equal(fetchImpl.counts.auth, 2, 'the next run, with the token still good, tries once more');
});

test('a renewal NUS refused for its version or key is not tried again for that token', async () => {
  for (const code of ['10009', '10000']) {
    const fetchImpl = makeFetch({ mintReject: code });
    installGlobals(fetchImpl);
    const env = makeEnv();
    scopeCache(env);
    await keep(env.KV, 20 * 60_000);
    await assert.rejects(renewToken(env, FROZEN_NOW), new RegExp(`code=${code}`));
    installGlobals(fetchImpl, FROZEN_NOW + 15 * 60_000);
    assert.equal(await renewToken(env, FROZEN_NOW + 15 * 60_000), false, code);
    assert.equal(fetchImpl.counts.auth, 1, `${code}: one refused mint, not one a run`);
    await keep(env.KV, 50 * 60_000, 'univus_android_9.9.9_999');
    await env.KV.put('config:appVersion', 'univus_android_9.9.9_999');
    forgetAppVersion(env);
    installGlobals(fetchImpl, FROZEN_NOW + 30 * 60_000);
    await assert.rejects(renewToken(env, FROZEN_NOW + 30 * 60_000), new RegExp(`code=${code}`));
    assert.equal(fetchImpl.counts.auth, 2, code);
  }
});

test('nothing is minted while the breaker is open', async () => {
  const fetchImpl = makeFetch();
  const cache = installGlobals(fetchImpl);
  const env = makeEnv();
  scopeCache(env);
  await cache.put(
    new Request('https://terminus.internal/breaker'),
    new Response('refused', { headers: { 'cache-control': 'max-age=60' } }),
  );
  assert.equal(await renewToken(env, FROZEN_NOW), false);
  assert.equal(fetchImpl.counts.auth, 0);
});

test("a request's mint that failed a moment ago skips the renewal quietly", async () => {
  const fetchImpl = makeFetch();
  const cache = installGlobals(fetchImpl);
  const env = makeEnv();
  scopeCache(env);
  await keep(env.KV, 10 * 60_000);
  await cache.put(
    new Request('https://terminus.internal/mint-failed'),
    new Response('auth HTTP 503', { headers: { 'cache-control': 'max-age=20' } }),
  );
  assert.equal(await renewToken(env, FROZEN_NOW), false);
  assert.equal(fetchImpl.counts.auth, 0);
});

test('the stable cron renews after its health check, and not while the feed is down', async () => {
  {
    const fetchImpl = makeFetch({ byStop: { COM3: [] } });
    installGlobals(fetchImpl);
    const env = makeEnv();
    scopeCache(env);
    await keep(env.KV, 10 * 60_000);
    await collected(() => runCron(env, FROZEN_NOW));
    assert.equal(fetchImpl.counts.shuttle, 1, 'the health check, with the kept token');
    assert.equal(fetchImpl.requests[0].headers.get('authorization'), 'Bearer kept.token.x', 'the check ran before the renewal');
    assert.equal(fetchImpl.counts.auth, 1, 'then one renewal');
    assert.notEqual((await kept(env.KV)).token, 'kept.token.x');
  }
  {
    const fetchImpl = makeFetch({ byStop: { COM3: [] }, reject: 99, rejectCode: '10009' });
    installGlobals(fetchImpl);
    const env = makeEnv();
    scopeCache(env);
    await keep(env.KV, 10 * 60_000);
    await collected(() => runCron(env, FROZEN_NOW));
    assert.deepEqual(
      fetchImpl.mints.filter((m) => m.version === VERSION),
      [],
      'no renewal while the feed is down (any mint is a version candidate)',
    );
  }
});

test("a failed call is logged with its reason and counted as an 'error' row of route 'feed arrivals'", async () => {
  installGlobals(makeFetch({ reject: 2, rejectCode: '401' }));
  const ae = makeAnalytics();
  const env = makeEnv(makeKV(), ae);
  scopeCache(env);
  let err;
  const lines = await collected(async () => {
    err = await getArrivals(env, makeCtx(), 'PGP', FROZEN_NOW).catch((e) => e);
  });
  assert.ok(err instanceof UpstreamRejected);
  const rows = ae.rows('error');
  assert.equal(rows.length, 1);
  assert.equal(named(rows[0]).route, 'feed arrivals');
  assert.match(named(rows[0]).reason, /shuttle-service rejected: code=401/);
  assert.ok(lines.some((l) => /NUS arrivals for PGP failed: shuttle-service rejected: code=401/.test(l)));
});

test('the gate having nothing to share yet, a version switched away from, or no call made, is not noted; a repeat is noted once', async () => {
  const ae = makeAnalytics();
  const env = makeEnv(makeKV(), ae);
  const outdated = new UpstreamRejected('10009', 'refused');
  outdated.outdated = true;
  const lines = await collected(() => {
    noteFailure(env, 'buses', 'A1', new GateBusy('elsewhere'));
    noteFailure(env, 'buses', 'A1', outdated);
    noteFailure(env, 'buses', 'A1', new MintQuiet('token mint failed a moment ago'));
    noteFailure(env, 'buses', 'A1', new TypeError('x is undefined'), FROZEN_NOW);
    noteFailure(env, 'buses', 'A1', new TypeError('x is undefined'), FROZEN_NOW + 30_000);
  });
  assert.deepEqual(ae.named('error'), [{ kind: 'error', route: 'feed buses', reason: 'TypeError: x is undefined' }]);
  assert.equal(lines.length, 1);
});

test('a reason carries no credentials and stays short', () => {
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjF9.c2ln';
  const reason = failureReason(new Error(`shuttle-service non-JSON (200): {"token":"${jwt}"} ${'x'.repeat(300)}`));
  assert.ok(!reason.includes(jwt));
  assert.ok(reason.length <= 160);
  for (const cut of [
    `{"token":"${jwt.slice(0, 20)}`,
    '{"userid":"STUB-USER-ID-1234',
    '{"x-api-key":"abcd1234secretvalue',
    '{"secret": "hunter2-not-closed',
  ]) {
    const r = failureReason(new Error(`shuttle-service non-JSON (200): ${cut}`));
    assert.ok(!r.includes(cut.split('"')[3]), r);
    assert.ok(r.includes('[redacted]'), r);
  }
});

test('a failure noted a moment ago stays quiet however many other failures came since', async () => {
  const ae = makeAnalytics();
  const env = makeEnv(makeKV(), ae);
  const note = (stop, at) => noteFailure(env, 'buses', stop, new TypeError('x is undefined'), at);
  await collected(() => {
    for (let i = 0; i < 500; i++) note(`S${i}`, FROZEN_NOW);
    note('HOT', FROZEN_NOW);
    note('S500', FROZEN_NOW);
  });
  const again = await collected(() => note('HOT', FROZEN_NOW + 1000));
  assert.deepEqual(again, [], 'the failure noted just now is still remembered');
  assert.equal(ae.rows('error').length, 502);
});
