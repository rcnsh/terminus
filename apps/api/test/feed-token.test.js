/**
 * The guest token renewed by the cron before it runs out (renewToken), so
 * the first request after a quiet spell doesn't mint, and why a NUS call
 * failed kept in the logs and Analytics Engine (noteFailure), so a stop
 * that reads "No live data" while the feed is up can be explained.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FROZEN_NOW, installGlobals, makeAnalytics, makeCtx, makeEnv, makeFetch, makeKV } from './_stubs.mjs';
import { failureReason, getArrivals, noteFailure, renewToken } from '../src/feeds/fms.ts';
import { scopeCache } from '../src/feeds/edgecache.ts';
import { GateBusy } from '../src/feeds/feedgate.ts';
import { UpstreamRejected } from '../src/feeds/auth.ts';
import { runCron } from '../src/ops/monitor.ts';
import { TTL } from '../src/config.ts';

const VERSION = '0.0.0-test';

/** A kept token with [leftMs] to go, as auth.ts stores it. */
async function keep(kv, leftMs, version = VERSION) {
  await kv.put(
    'auth:session',
    JSON.stringify({ token: 'kept.token.x', userid: 'U', domain: 'PUBLIC', expMs: FROZEN_NOW + leftMs, version }),
  );
}

const kept = async (kv) => JSON.parse(await kv.get('auth:session'));

/** Runs fn with console.warn and console.error collected. */
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

test('a token with more than tokenRenewAheadMs left is kept; one nearer its end, or none, is renewed', async () => {
  for (const [leftMs, mints] of [
    [TTL.tokenRenewAheadMs + 60_000, 0],
    [TTL.tokenRenewAheadMs - 60_000, 1],
    [-60_000, 1],
    [null, 1],
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

test('a token minted with another version is renewed at once', async () => {
  const fetchImpl = makeFetch();
  installGlobals(fetchImpl);
  const env = makeEnv();
  scopeCache(env);
  await keep(env.KV, 20 * 3_600_000, 'univus_android_1.0.0_1');
  assert.equal(await renewToken(env, FROZEN_NOW), true);
  assert.equal((await kept(env.KV)).version, VERSION);
});

test('a renewal that fails leaves the kept token in use and quiets nothing', async () => {
  const fetchImpl = makeFetch({ mintStatus: 400, byStop: { COM3: [] } });
  const cache = installGlobals(fetchImpl);
  const env = makeEnv();
  scopeCache(env);
  await keep(env.KV, 10 * 60_000);
  await assert.rejects(renewToken(env, FROZEN_NOW), /auth HTTP 400/);
  assert.equal(await cache.match('https://terminus.internal/mint-failed'), undefined, 'no mint memo');
  // The stop is still answered with the kept token, without another mint.
  const sa = await getArrivals(env, makeCtx(), 'COM3', FROZEN_NOW);
  assert.equal(sa.available, true);
  assert.equal(fetchImpl.counts.auth, 1);
  assert.equal(fetchImpl.requests[0].headers.get('authorization'), 'Bearer kept.token.x');
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

test('the stable cron renews after its health check, and not while the feed is down', async () => {
  // Up: the check mints for its own call, then the token step finds a near-expiry one and renews it.
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
  // Down (NUS refusing our version): the version search mints, the token step doesn't.
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
  // Refused with a code a new token doesn't cure: the stop fails without opening the breaker.
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
  assert.equal(rows[0].blobs[1], 'feed arrivals');
  assert.match(rows[0].blobs[2], /shuttle-service rejected: code=401/);
  assert.ok(lines.some((l) => /NUS arrivals for PGP failed: shuttle-service rejected: code=401/.test(l)));
});

test('the gate having nothing to share yet, or a version already switched away from, is not noted', async () => {
  const ae = makeAnalytics();
  const env = makeEnv(makeKV(), ae);
  const outdated = new UpstreamRejected('10009', 'refused');
  outdated.outdated = true;
  const lines = await collected(() => {
    noteFailure(env, 'buses', 'A1', new GateBusy('elsewhere'));
    noteFailure(env, 'buses', 'A1', outdated);
    noteFailure(env, 'buses', 'A1', new TypeError('x is undefined'));
  });
  assert.deepEqual(
    ae.rows('error').map((r) => r.blobs),
    [['error', 'feed buses', 'TypeError: x is undefined']],
  );
  assert.equal(lines.length, 1);
});

test('a reason carries no credentials and stays short', () => {
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjF9.c2ln';
  const reason = failureReason(new Error(`shuttle-service non-JSON (200): {"token":"${jwt}"} ${'x'.repeat(300)}`));
  assert.ok(!reason.includes(jwt));
  assert.ok(reason.length <= 160);
});
