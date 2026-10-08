/**
 * What the 15-minute cron asks of the feeds (CLAUDE.md, rule 2): one NUS
 * stop and one LTA stop a run, past the cache; the public feed's record;
 * the app-version candidate check, which costs NUS a mint and a call per
 * candidate and so must not spend them on failures that say nothing of the
 * version; and the calendar kept in KV, which a broken copy mustn't stop.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import nusmods from './fixtures/calendar/nusmods.json' with { type: 'json' };
import holidays from './fixtures/calendar/holidays.json' with { type: 'json' };

import { FROZEN_NOW, installGlobals, makeAnalytics, makeEnv, makeFetch, makeKV, shuttlePayload } from './_stubs.mjs';
import { APKCOMBO_URL, PLAY_URL, autoUpdateVersion } from '../src/appversion.ts';
import { PROBE_STOP, PUBLIC_PROBE, checkPublicFeed, checkUpstream, readPublicFeed, readUpstream, runCron } from '../src/monitor.ts';
import { CALENDAR_DATA_KEY, NUSMODS_CALENDAR, SG_HOLIDAYS, calendarSource, loadCalendar, refreshCalendar, resetCalendar } from '../src/calendarsync.ts';

const OLD = 'univus_android_2.59.2_140';
const NEW = 'univus_android_2.60.0_141';
const ltaEnv = (kv = makeKV()) => ({ ...makeEnv(kv), LTA_ACCOUNT_KEY: 'test-account-key' });

/** Runs [fn] with console.error and console.log quiet: the cron logs its failures. */
async function quietly(fn) {
  const { error, log } = console;
  console.error = console.log = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { error, log });
  }
}

/* ------------------------------------------------------------------ */
/* One stop of each feed a run                                         */
/* ------------------------------------------------------------------ */

test('a cron run asks NUS for one stop and LTA for one stop, past the cache, and nothing more', async () => {
  const fetchImpl = makeFetch({ byStop: { [PROBE_STOP]: [] }, publicStops: { [PUBLIC_PROBE[1]]: [] } });
  const cache = installGlobals(fetchImpl);
  // Fresh answers for both stops are in the cache: the probe goes past them,
  // or a cached answer would hide an outage.
  cache.seed(`https://terminus.internal/arrivals/${PROBE_STOP}`, { code: PROBE_STOP, arrivals: [], fetchedAt: FROZEN_NOW });
  cache.seed(`https://terminus.internal/public/${PUBLIC_PROBE[1]}`, { code: PUBLIC_PROBE[0], arrivals: [], fetchedAt: FROZEN_NOW });
  const env = ltaEnv();
  await quietly(() => runCron(env, FROZEN_NOW));
  assert.equal(fetchImpl.counts.shuttle, 1, 'one NUS stop');
  assert.deepEqual(fetchImpl.requests.filter((r) => r.url.includes('bus-proxy')).map((r) => r.body.busstopname), [PROBE_STOP]);
  assert.equal(fetchImpl.counts.public, 1, 'one LTA stop');
  assert.equal(fetchImpl.counts.auth, 1, 'and the token for the NUS call');
  assert.equal((await readUpstream(env)).up, true);
  assert.equal((await readPublicFeed(env)).up, true);
});

/* ------------------------------------------------------------------ */
/* The public feed's record                                            */
/* ------------------------------------------------------------------ */

test('the public feed: down since the first failed check, kept while it stays down, then back up', async () => {
  const env = ltaEnv();
  const check = async (nowMs, opts) => {
    installGlobals(makeFetch(opts), nowMs);
    return quietly(() => checkPublicFeed(env, nowMs));
  };
  const Q = 15 * 60_000;
  assert.deepEqual(await check(FROZEN_NOW, {}), { up: true, since: FROZEN_NOW, reason: null, checkedAt: FROZEN_NOW });
  const down = await check(FROZEN_NOW + Q, { publicStatus: 503 });
  assert.equal(down.up, false);
  assert.equal(down.since, FROZEN_NOW + Q);
  assert.match(down.reason, /DataMall answered HTTP 503/);
  const still = await check(FROZEN_NOW + 2 * Q, { publicStatus: 401 });
  assert.equal(still.since, FROZEN_NOW + Q, 'since kept while it stays down');
  assert.match(still.reason, /DataMall refused: HTTP 401/, 'the latest reason');
  assert.equal(still.checkedAt, FROZEN_NOW + 2 * Q);
  assert.deepEqual(await readPublicFeed(env), still);
  const back = await check(FROZEN_NOW + 3 * Q, {});
  assert.deepEqual(back, { up: true, since: FROZEN_NOW + 3 * Q, reason: null, checkedAt: FROZEN_NOW + 3 * Q });
  assert.equal((await check(FROZEN_NOW + 4 * Q, {})).since, FROZEN_NOW + 3 * Q);
});

test('the public feed is not checked at all without an LTA key', async () => {
  const fetchImpl = makeFetch();
  installGlobals(fetchImpl);
  const env = makeEnv();
  assert.equal(await checkPublicFeed(env, FROZEN_NOW), null);
  assert.equal(fetchImpl.counts.public, 0);
  assert.equal(await readPublicFeed(env), null);
});

/* ------------------------------------------------------------------ */
/* The app-version candidate check                                     */
/* ------------------------------------------------------------------ */

/**
 * NUS plus the two pages, which both show 2.60.0 (141). `mint` and `proxy`
 * answer for a version string: a Response, or undefined for the usual
 * accepted answer.
 */
function world({ mint = () => undefined, proxy = () => undefined } = {}) {
  const hits = { mint: 0, proxy: 0, pages: 0 };
  let serial = 0;
  const jwt = () => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return [b64({ alg: 'RS256' }), b64({ exp: Math.floor(Date.now() / 1000) + 3600, n: ++serial }), 'sig'].join('.');
  };
  const fetchImpl = async (input, init = {}) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (url === PLAY_URL) {
      hits.pages++;
      return new Response('<script>[[["2.60.0"]],[[[35]],[[[23,"6.0"]]]]]</script>');
    }
    if (url === APKCOMBO_URL) {
      hits.pages++;
      return new Response('<h2><a>Latest Version</a></h2> <div><a>2.60.0 <span class="blur">(141)</span></a></div>');
    }
    const body = JSON.parse(init.body ?? '{}');
    if (url.includes('get-access-token')) {
      hits.mint++;
      return mint(body.version) ?? Response.json({ code: '00000', data: { token: jwt(), userid: 'U', domain: 'PUBLIC' } });
    }
    if (url.includes('bus-proxy')) {
      hits.proxy++;
      return proxy(body.version) ?? (body.version === OLD ? Response.json({ code: '10009', msg: 'We have a new release of uNivUS', data: null }) : Response.json(shuttlePayload([])));
    }
    return new Response('unexpected ' + url, { status: 599 });
  };
  installGlobals(fetchImpl);
  const env = { ...makeEnv(makeKV()), NEXTBUS_APP_VERSION: OLD };
  return { env, hits };
}

const refused10009 = () => Response.json({ code: '10009', msg: 'We have a new release of uNivUS', data: null });

test('a candidate whose token mint is refused (10009) is refused, tried once, and costs no call', async () => {
  const { env, hits } = world({ mint: (v) => (v === OLD ? undefined : refused10009()) });
  const r = await autoUpdateVersion(env, FROZEN_NOW, null, 'COM3');
  assert.equal(r.status, 'failed');
  assert.match(r.note, /NUS refused univus_android_2\.60\.0_141, univus_android_2\.60\.0_142, univus_android_2\.60\.0_143/);
  assert.equal(hits.mint, 3);
  assert.equal(hits.proxy, 0, 'a refused mint asks the proxy nothing');
  const again = await autoUpdateVersion(env, FROZEN_NOW + 15 * 60_000, `{"want":"${NEW}"}`, 'COM3');
  assert.match(again.note, /nothing new to try/, 'not tried again, even when the refusal names it');
  assert.equal(hits.mint, 3);
});

test('a candidate the proxy refuses with 10009 is refused, and not tried again', async () => {
  const { env, hits } = world({ proxy: () => refused10009() });
  const r = await autoUpdateVersion(env, FROZEN_NOW, `{"want":"${NEW}"}`, 'COM3');
  assert.match(r.note, /NUS refused univus_android_2\.60\.0_141/);
  const calls = hits.proxy;
  await autoUpdateVersion(env, FROZEN_NOW + 15 * 60_000, `{"want":"${NEW}"}`, 'COM3');
  assert.equal(hits.proxy, calls);
});

test('a candidate check that fails for another reason stops, says so, and tries the same version next time', async () => {
  const cases = [
    ['another code', { proxy: (v) => (v === OLD ? undefined : Response.json({ code: '10000', msg: 'Invalid API KEY', data: null })) }, /code=10000/],
    ['the proxy answering 503', { proxy: (v) => (v === OLD ? undefined : new Response('busy', { status: 503 })) }, /shuttle-service HTTP 503/],
    ['the mint answering 503', { mint: (v) => (v === OLD ? undefined : new Response('busy', { status: 503 })) }, /auth HTTP 503/],
  ];
  for (const [what, opts, why] of cases) {
    let broken = true;
    const { env, hits } = world({
      mint: (v) => (broken ? opts.mint?.(v) : undefined),
      proxy: (v) => (broken ? opts.proxy?.(v) : undefined),
    });
    const r = await autoUpdateVersion(env, FROZEN_NOW, `{"want":"${NEW}"}`, 'COM3');
    assert.equal(r.status, 'failed', what);
    assert.match(r.note, new RegExp(`trying ${NEW} failed for another reason`), what);
    assert.match(r.note, why, what);
    assert.doesNotMatch(r.note, /NUS refused/, `${what}: no verdict on the version`);
    assert.equal(hits.mint, 1, `${what}: stopped at the first candidate`);
    // Fifteen minutes on, the pages aren't read again; the refusal still
    // names the version, which wasn't marked tried, so it's tried again.
    broken = false;
    const again = await autoUpdateVersion(env, FROZEN_NOW + 15 * 60_000, `{"want":"${NEW}"}`, 'COM3');
    assert.deepEqual(again, { status: 'switched', from: OLD, to: NEW }, what);
  }
});

test('the automatic update throwing inside the cron is noted, and the rest of the run goes on', async () => {
  const { env } = world();
  const ae = makeAnalytics();
  env.AE = ae;
  env.LTA_ACCOUNT_KEY = 'test-account-key';
  // NUS accepts the new version, but writing it to KV fails: autoUpdateVersion throws.
  const put = env.KV.put.bind(env.KV);
  env.KV.put = async (k, v, o) => {
    if (k === 'config:appVersion') throw new Error('KV write quota');
    return put(k, v, o);
  };
  await quietly(() => runCron(env, FROZEN_NOW));
  const u = await readUpstream(env);
  assert.equal(u.up, true, 'one failed check is not yet an outage');
  assert.equal(u.failures, 1);
  assert.match(u.auto, /the automatic update failed: KV write quota/);
  assert.ok(!ae.rows('error').some((r) => r.blobs[1] === 'cron upstream'), 'the upstream step did not fail');
  assert.ok(await readPublicFeed(env), 'the next step ran');
  // And checkUpstream on its own, with a fix that throws.
  const state = (await checkUpstream(env, FROZEN_NOW + 15 * 60_000, undefined, async () => {
    throw new Error('boom');
  })).state;
  assert.match(state.auto, /the automatic update failed: boom/);
});

/* ------------------------------------------------------------------ */
/* A broken calendar in KV                                             */
/* ------------------------------------------------------------------ */

test('a calendar in KV that is not JSON: loaded as nothing, and written over by the next fetch', async () => {
  resetCalendar();
  try {
    const kv = makeKV();
    await kv.put(CALENDAR_DATA_KEY, '{"semesters": [trunc');
    const env = makeEnv(kv);
    await loadCalendar(env, FROZEN_NOW);
    assert.equal(calendarSource(), 'bundled');
    globalThis.fetch = async (url) => {
      if (String(url) === NUSMODS_CALENDAR) return Response.json(nusmods);
      if (String(url) === SG_HOLIDAYS) return Response.json(holidays);
      return new Response('unexpected', { status: 599 });
    };
    const now = Date.UTC(2026, 9, 5, 2, 0);
    assert.equal(await refreshCalendar(env, now), 'updated');
    const kept = JSON.parse(await kv.get(CALENDAR_DATA_KEY));
    assert.ok(kept.semesters.length >= 4);
  } finally {
    resetCalendar();
  }
});
