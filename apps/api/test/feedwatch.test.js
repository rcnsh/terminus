/**
 * The beta's cron asks neither NUS nor LTA (CLAUDE.md, rule 2): it reads the
 * breaker trips its own traffic noted (src/feedwatch.ts) as its check.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FROZEN_NOW, installGlobals, makeCtx, makeEnv, makeFetch, makeKV } from './_stubs.mjs';
import { CHECK_EVERY_MS, KV_NAMESPACE_IDS, checkPublicFeed, checkUpstream, readPublicFeed, readUpstream, runCron, sawTrip } from '../src/monitor.ts';
import { lastTrip, noteTrip, resetNotes } from '../src/feedwatch.ts';
import { scopeCache } from '../src/edgecache.ts';
import { getArrivals } from '../src/fms.ts';
import { getPublicArrivals } from '../src/lta.ts';
import { GRAPH_PUBLIC } from '../src/graph.ts';
import { UpstreamRejected } from '../src/auth.ts';
import { makeEmail } from './_d1.mjs';

const BETA_ORIGIN = 'https://beta.terminus.rcn.sh';
const VERSION = 'univus_android_3.1.0_310';

function site(beta, ae = []) {
  return {
    ...makeEnv(makeKV(), { writeDataPoint: (p) => ae.push(p) }),
    NEXTBUS_APP_VERSION: VERSION,
    LTA_ACCOUNT_KEY: 'test-lta-key',
    EMAIL: makeEmail(),
    EMAIL_FROM: 'login@example.test',
    ALERT_EMAIL: 'ops@example.test',
    ...(beta ? { PUBLIC_ORIGIN: BETA_ORIGIN, AE_DATASET: 'terminus_beta' } : {}),
  };
}

/** Runs `fn` with console.error and console.log collected rather than printed. */
async function quietly(fn) {
  const logged = [];
  const { error, log } = console;
  console.error = console.log = (...a) => logged.push(a.join(' '));
  try {
    await fn();
  } finally {
    console.error = error;
    console.log = log;
  }
  return logged;
}

test('the beta cron asks neither NUS nor LTA; the stable one asks each once', async () => {
  for (const beta of [false, true]) {
    const fetchImpl = makeFetch({ byStop: { COM3: [] } });
    installGlobals(fetchImpl);
    const env = site(beta);
    scopeCache(env);
    await quietly(() => runCron(env, FROZEN_NOW));
    if (beta) {
      assert.deepEqual(fetchImpl.counts, { auth: 0, shuttle: 0, public: 0 }, 'the beta made no call to either feed');
      assert.equal((await readUpstream(env)).up, true, 'nothing seen failing: up, and checked');
      assert.equal((await readUpstream(env)).checkedAt, FROZEN_NOW, 'so /health does not take the cron for stopped');
    } else {
      assert.equal(fetchImpl.counts.shuttle, 1);
      assert.equal(fetchImpl.counts.public, 1);
    }
  }
});

test('a breaker trip on the beta is noted for its cron; on the stable site it is not', async () => {
  for (const beta of [false, true]) {
    resetNotes();
    installGlobals(makeFetch({ proxyStatus: 503, publicStatus: 503 }));
    const env = site(beta);
    scopeCache(env);
    const ctx = makeCtx();
    await assert.rejects(getArrivals(env, ctx, 'COM3', FROZEN_NOW));
    await assert.rejects(getPublicArrivals(env, ctx, GRAPH_PUBLIC, 'CLB', '16181', FROZEN_NOW));
    await ctx.settle();
    const nus = await lastTrip(env, 'nus');
    const lta = await lastTrip(env, 'lta');
    if (beta) {
      assert.equal(nus?.at, FROZEN_NOW);
      assert.match(nus.reason, /503/);
      assert.equal(lta?.at, FROZEN_NOW);
    } else {
      assert.equal(nus, null);
      assert.equal(lta, null);
    }
  }
  scopeCache(site(false));
});

test('a note is written at most once a minute per isolate', async () => {
  resetNotes();
  const env = site(true);
  let writes = 0;
  const put = env.KV.put.bind(env.KV);
  env.KV.put = async (...a) => {
    writes++;
    return put(...a);
  };
  await noteTrip(env, 'nus', new Error('HTTP 503'), 1_000_000);
  await noteTrip(env, 'nus', new Error('HTTP 503'), 1_030_000);
  await noteTrip(env, 'lta', new Error('HTTP 503'), 1_030_000);
  assert.equal(writes, 2, 'each feed once');
  await noteTrip(env, 'nus', new Error('HTTP 502'), 1_060_000);
  assert.equal(writes, 3);
  assert.match((await lastTrip(env, 'nus')).reason, /502/);
});

test('the beta goes down on trips in two runs in a row, and back up after two without; no email, but logged and counted', async () => {
  resetNotes();
  installGlobals(makeFetch());
  const ae = [];
  const env = site(true, ae);
  scopeCache(env);
  const t0 = FROZEN_NOW;
  const logged = await quietly(async () => {
    await noteTrip(env, 'nus', new Error('bus-proxy HTTP 503'), t0 - 60_000);
    await runCron(env, t0);
    assert.equal((await readUpstream(env)).up, true, 'one failed check is a blip');
    resetNotes();
    await noteTrip(env, 'nus', new Error('bus-proxy HTTP 503'), t0 + CHECK_EVERY_MS - 60_000);
    await runCron(env, t0 + CHECK_EVERY_MS);
    assert.equal((await readUpstream(env)).up, false);
    // A trip older than a run's gap was the last run's news.
    await runCron(env, t0 + 2 * CHECK_EVERY_MS);
    await runCron(env, t0 + 3 * CHECK_EVERY_MS);
  });
  assert.equal((await readUpstream(env)).up, true, 'back after two runs without a trip');
  assert.equal(env.EMAIL.sent.length, 0, 'the beta emails no one');
  assert.ok(logged.some((l) => /beta: terminus: NUS bus feed is down/.test(l)), logged.join('\n'));
  assert.ok(logged.some((l) => /beta: terminus: NUS bus feed recovered/.test(l)));
  assert.equal(ae.filter((p) => p.blobs[1] === 'cron feed down').length, 2, 'each run while down counts on the dashboard');
});

test('a version refusal the beta saw runs the automatic update, with the fix in the beta store', async () => {
  resetNotes();
  installGlobals(makeFetch());
  const env = site(true);
  const refusal = () => {
    const err = new UpstreamRejected('10009', 'auth rejected: code=10009 msg=We have a new release of uNivUS', '{"code":"10009"}');
    err.version = VERSION;
    return err;
  };
  await noteTrip(env, 'nus', refusal(), FROZEN_NOW - 60_000);
  const tried = [];
  const fix = async (detail) => {
    tried.push(detail);
    return { status: 'failed', note: 'nothing new to try' };
  };
  const logged = await quietly(async () => {
    await checkUpstream(env, FROZEN_NOW, sawTrip(env, 'nus', FROZEN_NOW), fix);
    resetNotes();
    await noteTrip(env, 'nus', refusal(), FROZEN_NOW + CHECK_EVERY_MS - 60_000);
    await checkUpstream(env, FROZEN_NOW + CHECK_EVERY_MS, sawTrip(env, 'nus', FROZEN_NOW + CHECK_EVERY_MS), fix);
  });
  assert.deepEqual(tried, ['{"code":"10009"}', '{"code":"10009"}'], 'with NUS’s response, as the stable check does');
  const u = await readUpstream(env);
  assert.equal(u.up, false);
  const alert = logged.find((l) => /NUS bus feed is down/.test(l));
  assert.ok(alert, logged.join('\n'));
  assert.ok(alert.includes(`--namespace-id ${KV_NAMESPACE_IDS.beta}`), 'the fix goes in the beta’s KV');
  assert.ok(!alert.includes(KV_NAMESPACE_IDS.stable));
});

test('a refusal of a version switched away from since is not counted', async () => {
  resetNotes();
  const env = site(true);
  const err = new UpstreamRejected('10009', 'auth rejected: code=10009', '');
  err.version = 'univus_android_3.0.0_300';
  await noteTrip(env, 'nus', err, FROZEN_NOW - 60_000);
  await sawTrip(env, 'nus', FROZEN_NOW)();
  err.version = VERSION;
  resetNotes();
  await noteTrip(env, 'nus', err, FROZEN_NOW - 60_000);
  await assert.rejects(sawTrip(env, 'nus', FROZEN_NOW)(), (e) => e instanceof UpstreamRejected && e.code === '10009');
});

test('the beta records the public feed from its own trips too', async () => {
  resetNotes();
  const env = site(true);
  await checkPublicFeed(env, FROZEN_NOW, sawTrip(env, 'lta', FROZEN_NOW));
  assert.equal((await readPublicFeed(env)).up, true);
  await noteTrip(env, 'lta', new Error('DataMall HTTP 503'), FROZEN_NOW + 1000);
  await quietly(() => checkPublicFeed(env, FROZEN_NOW + 2000, sawTrip(env, 'lta', FROZEN_NOW + 2000)));
  assert.equal((await readPublicFeed(env)).up, false);
  assert.match((await readPublicFeed(env)).reason, /503/);
});
