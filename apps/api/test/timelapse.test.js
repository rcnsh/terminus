/**
 * The timelapse recorder (src/timelapse.ts, src/timelapsedo.ts) and the
 * replay that reads its days back (apps/web/public/admin/timelapse/replay.js).
 *
 * The recorder is the one poller of the NUS feed, so most of this
 * is about what it must NOT do: ask faster than its floor, ask outside its
 * hours, ask with the breaker open or the switch off, or ask NUS at all when
 * the edge cache already has the answer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FROZEN_NOW, installGlobals, makeAnalytics, makeBucket, makeDurableObjects, makeEnv, makeFetch, makeKV } from './_stubs.mjs';
import worker from '../src/index.ts';
import { TimelapseRecorder } from '../src/timelapsedo.ts';
import { MIN_POLL_MS, TIMELAPSE } from '../src/config.ts';
import { buildDayFile, encodeBus, ensureRecorder, inWindow, mapSnapshot, nextOpen, pollInterval, serviceDate, timelapseEnabled, windowLength, windowOf } from '../src/timelapse.ts';
import { getBuses } from '../src/fms.ts';
import { pointAlong } from '../src/buses.ts';
import { shapeFor } from '../src/campus.ts';
import { inService } from '../src/resolve.ts';
import { GRAPH } from '../src/graph.ts';
import { BUNDLED } from '../src/calendar.ts';
import { CALENDAR_DATA_KEY, resetCalendar } from '../src/calendarsync.ts';
import { busesAt, countBySvc, decodeDay, FADE_MS, GAP_MS, haversineM, placeAt, pointAt, timeOn } from '../../web/public/admin/timelapse/replay.js';

/** Singapore wall time on a date, as epoch ms. */
const sgt = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`);
const DATE = serviceDate(FROZEN_NOW); // Thursday 2026-08-27, 09:00 SGT
const RUNNING = Object.keys(GRAPH.routes).filter((svc) => inService(GRAPH, svc, FROZEN_NOW)).sort();
const BREAKER = 'https://terminus.internal/breaker';

/** A bus as the feed reports it, [m] metres along [svc]'s line, driving its way. */
function busOn(svc, m, plate = `PX${svc}1`) {
  const p = pointAlong(shapeFor(svc, GRAPH.routes[svc]), m);
  return { vehplate: plate, lat: p.lat, lng: p.lon, speed: 25, direction: p.bearing ?? 0, loadInfo: { capacity: 88, ridership: 20 } };
}

/** A recorder with a fake feed, cache, R2 and analytics, at FROZEN_NOW. */
function harness({ enabled = 'on', buses = {}, kv = makeKV() } = {}) {
  const fetchImpl = makeFetch({ buses });
  const cache = installGlobals(fetchImpl, FROZEN_NOW);
  const ae = makeAnalytics();
  const bucket = makeBucket(async () => null);
  let env;
  const ns = makeDurableObjects(TimelapseRecorder, () => env);
  env = { ...makeEnv(kv, ae), TIMELAPSE: ns, TIMELAPSE_ENABLED: enabled, DOWNLOADS: bucket, HEALTH_TOKEN: 'op' };
  const busCalls = () => fetchImpl.requests.filter((r) => r.url.endsWith('/active-bus'));
  return { env, ns, fetchImpl, cache, ae, bucket, busCalls, buses };
}

/** Fires the recorder's alarms in time order, the clock following, until [until]. [before] runs before each one. */
async function runUntil(h, until, before = async () => {}) {
  for (;;) {
    const due = [...h.ns.alarms.values()];
    const next = Math.min(...due);
    if (!due.length || next > until) break;
    Date.now = () => next;
    await before(next);
    await h.ns.fireDue(next);
  }
  Date.now = () => until;
}

const start = (h, date = DATE) => h.ns.get(h.ns.idFromName(date)).fetch(`https://timelapse.internal/start?date=${date}`, { method: 'POST' });
const status = async (h, date = DATE) => (await h.ns.get(date).fetch(`https://timelapse.internal/status?date=${date}`)).json();
const gunzip = async (body) => new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'))).json();

/* ------------------------------------------------------------------ */
/* When it records                                                     */
/* ------------------------------------------------------------------ */

test('the poll interval never goes below its floor', () => {
  assert.equal(MIN_POLL_MS, 15_000);
  assert.equal(pollInterval(30_000, 8), 30_000, 'the default, with eight routes');
  // Two services: the day's ceiling is far off, so only the floor applies.
  assert.equal(pollInterval(30_000, 2), 30_000);
  assert.equal(pollInterval(15_000, 2), 15_000);
  assert.equal(pollInterval(5_000, 2), 15_000, 'a lower setting is raised to the floor');
  assert.equal(pollInterval(0, 2), 15_000);
  assert.equal(pollInterval(-1, 2), 15_000);
  assert.equal(pollInterval(Number.NaN, 2), 30_000, 'nonsense is the default, not zero');
});

/** The most a day can poll: each service at most once per interval, inside the window. */
const mostPolls = (services, intervalMs) => services * Math.ceil(windowLength() / intervalMs);

test('a day never polls more than its ceiling, with the real routes or more of them', () => {
  assert.equal(TIMELAPSE.maxPollsPerDay, 17_280);
  assert.equal(windowLength(), 18 * 3_600_000);
  // stops.json as it is (eight routes, every 30 s: exactly the ceiling).
  const routes = Object.keys(GRAPH.routes).length;
  assert.ok(pollInterval() >= TIMELAPSE.pollMs);
  assert.ok(mostPolls(routes, pollInterval()) <= TIMELAPSE.maxPollsPerDay, `${routes} routes`);
  assert.equal(mostPolls(8, pollInterval(30_000, 8)), 17_280);
  // The weekly scrape adds routes: each is polled less often, the day no more.
  assert.equal(pollInterval(30_000, 12), 45_000);
  for (let n = 1; n <= 200; n++) {
    const ms = pollInterval(TIMELAPSE.pollMs, n);
    assert.ok(ms >= MIN_POLL_MS && ms >= TIMELAPSE.pollMs, `${n} services: ${ms} ms`);
    assert.ok(mostPolls(n, ms) <= TIMELAPSE.maxPollsPerDay, `${n} services: ${mostPolls(n, ms)} polls`);
    // A lower setting can't get round it either.
    assert.ok(mostPolls(n, pollInterval(MIN_POLL_MS, n)) <= TIMELAPSE.maxPollsPerDay);
  }
});

test('with routes added mid-day, the recorder slows down to stay under the ceiling', async () => {
  const extra = ['X1', 'X2', 'X3', 'X4'];
  for (const svc of extra) GRAPH.routes[svc] = GRAPH.routes.D2;
  try {
    const services = Object.keys(GRAPH.routes).length;
    const h = harness({ buses: { D2: [busOn('D2', 400)] } });
    await start(h);
    // As if the day began on the deploy before, with eight routes and 30 s.
    const inst = h.ns.instances.get(DATE);
    inst.write('meta', { ...inst.read('meta'), pollMs: 30_000 });
    const hour = 3_600_000;
    await runUntil(h, FROZEN_NOW + hour - 1);
    const pollMs = inst.read('meta').pollMs;
    assert.equal(pollMs, pollInterval(TIMELAPSE.pollMs, services));
    assert.ok(pollMs > 30_000);
    const bySvc = {};
    for (const r of h.busCalls()) (bySvc[r.body.route_code] ??= []).push(r.at);
    assert.ok(bySvc.X1, 'the new routes are polled');
    for (const [svc, ts] of Object.entries(bySvc)) {
      assert.ok(ts.length <= Math.ceil(hour / pollMs), `${svc}: ${ts.length} polls in an hour`);
      for (let j = 1; j < ts.length; j++) assert.ok(ts[j] - ts[j - 1] >= pollMs, `${svc} asked again after ${ts[j] - ts[j - 1]} ms`);
    }
    // At this rate a whole window stays under the ceiling.
    assert.ok(mostPolls(services, pollMs) <= TIMELAPSE.maxPollsPerDay);
  } finally {
    for (const svc of extra) delete GRAPH.routes[svc];
  }
});

test('the window is 06:30 to 00:30 Singapore time, across midnight, and the day is the date it opened', () => {
  assert.deepEqual(TIMELAPSE.hours, { start: '06:30', end: '00:30' });
  const w = windowOf('2026-10-07');
  assert.equal(w.open, sgt('2026-10-07', '06:30'));
  assert.equal(w.close, sgt('2026-10-08', '00:30'), 'closes the next morning');

  assert.equal(inWindow(sgt('2026-10-07', '06:29')), false);
  assert.equal(inWindow(sgt('2026-10-07', '06:30')), true);
  assert.equal(inWindow(sgt('2026-10-07', '23:59')), true);
  // Past midnight: still the 7th's day, and still open until 00:30.
  assert.equal(inWindow(sgt('2026-10-08', '00:10')), true);
  assert.equal(serviceDate(sgt('2026-10-08', '00:10')), '2026-10-07');
  assert.equal(inWindow(sgt('2026-10-08', '00:30')), false, 'the close is not in the window');
  assert.equal(serviceDate(sgt('2026-10-08', '03:00')), '2026-10-07', 'the closed hours belong to the day before');
  assert.equal(serviceDate(sgt('2026-10-08', '06:30')), '2026-10-08');

  // Sleeping until the next window: from the closed hours, the same morning.
  assert.equal(nextOpen(sgt('2026-10-08', '03:00')), sgt('2026-10-08', '06:30'));
  assert.equal(nextOpen(sgt('2026-10-08', '00:30')), sgt('2026-10-08', '06:30'));
  assert.equal(nextOpen(sgt('2026-10-07', '12:00')), sgt('2026-10-07', '12:00'), 'open now is now');

  // A window that doesn't cross midnight closes the same day.
  const day = { start: '07:00', end: '23:00' };
  assert.equal(windowOf('2026-10-07', day).close, sgt('2026-10-07', '23:00'));
  assert.equal(inWindow(sgt('2026-10-07', '23:30'), day), false);
  assert.equal(nextOpen(sgt('2026-10-07', '23:30'), day), sgt('2026-10-08', '07:00'));
});

test('the kill switch: off unless turned on, and KV turns it off without a deploy', async () => {
  const env = (vars, kv = makeKV()) => ({ ...makeEnv(kv), ...vars });
  assert.equal(await timelapseEnabled(env({})), false, 'unset is off');
  assert.equal(await timelapseEnabled(env({ TIMELAPSE_ENABLED: 'off' })), false);
  assert.equal(await timelapseEnabled(env({ TIMELAPSE_ENABLED: 'on' })), true);
  const kv = makeKV();
  await kv.put('config:timelapse', 'off');
  assert.equal(await timelapseEnabled(env({ TIMELAPSE_ENABLED: 'on' }, kv)), false, 'KV wins over the var');
  await kv.put('config:timelapse', 'on');
  assert.equal(await timelapseEnabled(env({ TIMELAPSE_ENABLED: 'off' }, kv)), true);
  // KV not answering may be hiding an "off": the var doesn't get to override it.
  const down = { ...makeKV(), get: async () => Promise.reject(new Error('KV unavailable')) };
  assert.equal(await timelapseEnabled(env({ TIMELAPSE_ENABLED: 'on' }, down)), false);
});

test('the cron starts the day only inside the window with the switch on', async () => {
  const off = harness({ enabled: 'off' });
  await ensureRecorder(off.env, FROZEN_NOW);
  assert.equal(off.ns.instances.size, 0, 'switched off: no recorder at all');

  const on = harness();
  await ensureRecorder(on.env, sgt('2026-08-28', '03:00'));
  assert.equal(on.ns.instances.size, 0, 'closed hours: nothing');
  await ensureRecorder(on.env, FROZEN_NOW);
  assert.deepEqual([...on.ns.alarms.keys()], [DATE], 'the day is named by its date');
  assert.equal(on.ns.alarms.get(DATE), FROZEN_NOW, 'and asks straight away');
  // Again (the next cron run): nothing new.
  await ensureRecorder(on.env, FROZEN_NOW + 900_000);
  assert.equal(on.ns.instances.size, 1);
  assert.equal(on.busCalls().length, 0, 'starting it asks NUS nothing by itself');
});

/* ------------------------------------------------------------------ */
/* What it asks NUS                                                    */
/* ------------------------------------------------------------------ */

test('each round asks each running service at most once, spread across the interval', async () => {
  assert.ok(RUNNING.length >= 4, `services running at 09:00: ${RUNNING}`);
  const h = harness({ buses: { D2: [busOn('D2', 400)] } });
  await start(h);
  const times = [];
  await runUntil(h, FROZEN_NOW + 30_000 - 1, async (t) => times.push(t));

  const asked = h.busCalls().map((r) => r.body.route_code);
  assert.deepEqual([...asked].sort(), RUNNING, 'every running service, each once in one round');
  // Spread out: one service per slot, never a burst.
  const slot = 30_000 / RUNNING.length;
  assert.deepEqual(times, RUNNING.map((_, i) => FROZEN_NOW + i * slot));
  // Not one more until the round is over.
  await runUntil(h, FROZEN_NOW + 60_000 - 1);
  const twice = h.busCalls().map((r) => r.body.route_code);
  for (const svc of RUNNING) assert.equal(twice.filter((s) => s === svc).length, 2, `${svc}: once per 30 s`);
  // Each one counted as a real request to NUS.
  assert.equal(h.ae.rows('timelapse').filter((r) => r.blobs[1] === 'upstream').length, RUNNING.length * 2);
});

test('a public holiday known only from KV runs holiday hours: services not running are not asked', async () => {
  const holiday = { ...BUNDLED, generated: '2099-01-01', holidays: [...BUNDLED.holidays, { date: DATE, name: 'A holiday announced late' }] };
  resetCalendar();
  try {
    const h = harness({ buses: { D2: [busOn('D2', 400)] }, kv: makeKV({ [CALENDAR_DATA_KEY]: holiday }) });
    await start(h);
    await runUntil(h, FROZEN_NOW + 30_000 - 1);
    const asked = [...new Set(h.busCalls().map((r) => r.body.route_code))].sort();
    const onHoliday = Object.keys(GRAPH.routes).filter((svc) => inService(GRAPH, svc, FROZEN_NOW)).sort();
    assert.ok(onHoliday.length < RUNNING.length, `holiday services: ${onHoliday}`);
    assert.deepEqual(asked, onHoliday);
  } finally {
    resetCalendar();
  }
});

test('an alarm that runs late moves the rest later: no burst, no service asked again too soon', async () => {
  const h = harness({ buses: { D2: [busOn('D2', 400)] } });
  await start(h);
  const slot = 30_000 / RUNNING.length;
  const at = [];
  const record = async (t) => at.push(t);
  await runUntil(h, FROZEN_NOW + slot, record);
  // The third alarm fires 20 s late (the object was busy, or evicted).
  const late = FROZEN_NOW + 2 * slot + 20_000;
  h.ns.alarms.set(DATE, late);
  await runUntil(h, FROZEN_NOW + 120_000, record);
  const gaps = at.slice(1).map((t, i) => t - at[i]);
  assert.ok(gaps.every((g) => g >= slot - 1), `never closer than a slot: ${gaps}`);
  const calls = h.busCalls().map((r) => r.body.route_code);
  for (const svc of RUNNING) {
    const times = calls.map((s, i) => (s === svc ? at[i] : null)).filter((t) => t !== null);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= MIN_POLL_MS, `${svc} asked again after ${times[i] - times[i - 1]} ms`);
  }
});

test('with the cache warm (the map just asked), a round costs NUS nothing', async () => {
  const h = harness({ buses: { D2: [busOn('D2', 400)] } });
  await start(h);
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  let byRecorder = 0;
  await runUntil(h, FROZEN_NOW + 30_000 - 1, async (t) => {
    // A user's map, a moment before each slot.
    for (const svc of RUNNING) await getBuses(h.env, ctx, svc, t);
    const before = h.busCalls().length;
    await h.ns.fireDue(t);
    byRecorder += h.busCalls().length - before;
  });
  assert.equal(byRecorder, 0, 'every poll was a cache hit');
  const rows = h.ae.rows('timelapse');
  assert.equal(rows.length, RUNNING.length);
  assert.ok(rows.every((r) => r.blobs[1] === 'hit'), rows.map((r) => r.blobs[1]).join());
  assert.equal((await status(h)).samples, RUNNING.length, 'and still recorded');
});

test('with the breaker open, a poll is skipped, not retried harder', async () => {
  const h = harness({ buses: { D2: [busOn('D2', 400)] } });
  await start(h);
  h.cache.seed(BREAKER, 'shuttle-service rejected: code=10009', 60);
  await h.ns.fireDue(FROZEN_NOW);
  assert.equal(h.busCalls().length, 0, 'nothing asked');
  const [row] = h.ae.rows('timelapse');
  assert.deepEqual(row.blobs, ['timelapse', 'skipped', RUNNING[0]]);
  // The next poll is the next slot, as usual: no sooner.
  assert.equal(h.ns.alarms.get(DATE), FROZEN_NOW + 30_000 / RUNNING.length);
  assert.equal((await status(h)).samples, 0);
});

test('a failed poll records nothing, but a request that reached NUS still counts as one', async () => {
  const h = harness();
  // A reply it can't read: this service's failure alone. (No answer at all
  // would open the breaker for every service, a test of its own.)
  globalThis.fetch = makeFetch({ raw: { code: '00000', msg: '', data: { somethingNew: 1 } } });
  await start(h);
  await h.ns.fireDue(FROZEN_NOW);
  // It asked, and the request failed: an `error`, counted with the requests,
  // as is the token it minted first (the recorder's first poll, cold).
  assert.deepEqual(h.ae.rows('timelapse').map((r) => r.blobs[1]), ['retry', 'error']);
  assert.equal((await status(h)).samples, 0);
  // The same service again within failMemoS isn't asked: `failed`, no request.
  const inst = h.ns.instances.get(DATE);
  const meta = inst.read('meta');
  inst.write('meta', { ...meta, round: { ...meta.round, i: 0 }, asked: {} });
  Date.now = () => FROZEN_NOW + 1_000;
  await h.ns.get(DATE).fetch(`https://timelapse.internal/status?date=${DATE}`);
  h.ns.alarms.set(DATE, FROZEN_NOW + 1_000);
  await h.ns.fireDue(FROZEN_NOW + 1_000);
  assert.deepEqual(h.ae.rows('timelapse').map((r) => r.blobs[1]), ['retry', 'error', 'failed']);
});

test('a poll that throws after asking is a failed poll: the round goes on, and that service is not asked again sooner', async () => {
  const h = harness({ buses: { D2: [busOn('D2', 400)] } });
  await start(h);
  const inst = h.ns.instances.get(DATE);
  const real = inst.poll;
  // The request went out, then something after it threw (placement, storage), every time.
  const broken = RUNNING[0];
  inst.poll = async function (meta, svc, now) {
    const n = await real.call(this, meta, svc, now);
    if (svc === broken) throw new Error('boom');
    return n;
  };
  await h.ns.fireDue(FROZEN_NOW);
  assert.equal(h.busCalls().length, 1);
  const slot = 30_000 / RUNNING.length;
  assert.equal(h.ns.alarms.get(DATE), FROZEN_NOW + slot, 'on to the next service, a slot later');
  // A whole day's worth of rounds would be lost otherwise: every service is
  // still recorded, and the broken one asked no more than once a round.
  await runUntil(h, FROZEN_NOW + 3 * 30_000 - 1);
  const asked = h.busCalls().map((r) => r.body.route_code);
  for (const svc of RUNNING) assert.equal(asked.filter((s) => s === svc).length, 3, `${svc}: once a round`);
  assert.equal((await status(h)).state, 'polling');
  assert.ok((await status(h)).samples >= 3 * (RUNNING.length - 1));
  assert.equal(inst.read('meta').failing, 0, 'the others answered: not a failing feed');
  inst.poll = real;
});

test('an alarm that throws after asking, run again by the platform, does not ask again', async () => {
  const h = harness({ buses: { D2: [busOn('D2', 400)] } });
  await start(h);
  const inst = h.ns.instances.get(DATE);
  // The request went out, then setting the next alarm failed.
  const { setAlarm } = inst.storage;
  inst.storage.setAlarm = async () => {
    inst.storage.setAlarm = setAlarm;
    throw new Error('boom');
  };
  await assert.rejects(h.ns.fireDue(FROZEN_NOW));
  assert.equal(h.busCalls().length, 1);
  // The platform retries a thrown alarm within seconds: the next service, not this one again.
  Date.now = () => FROZEN_NOW + 6_000;
  await inst.alarm();
  const asked = h.busCalls().map((r) => r.body.route_code);
  assert.deepEqual(asked, RUNNING.slice(0, 2));
});

test('a feed failing round after round is asked less and less often, and as usual once it answers', async () => {
  const h = harness();
  const down = makeFetch({ fail: true });
  globalThis.fetch = down;
  await start(h);
  await runUntil(h, FROZEN_NOW + 10 * 60_000 - 1);
  // Rounds at 0, 60, 180 and 420 s: 2, 4, then 8 times pollMs apart, one
  // request each (the first service's, which opens the breaker for the rest).
  assert.equal(down.counts.shuttle, 4, `asked ${down.counts.shuttle} times in ten minutes`);
  assert.equal((await status(h)).state, 'polling', 'an outage still is not an idle day');
  // Back up: the next round answers, and the one after is pollMs later again.
  const up = makeFetch({ buses: { D2: [busOn('D2', 400)] } });
  globalThis.fetch = up;
  h.fetchImpl.requests.length = 0;
  const next = h.ns.alarms.get(DATE);
  await runUntil(h, next + 240_000 + 30_000 - 1);
  const asked = up.requests.filter((r) => r.url.endsWith('/active-bus') && r.body.route_code === RUNNING[0]).map((r) => r.at);
  assert.ok(asked.length >= 2);
  assert.equal(asked[1] - asked[0], 30_000, 'back to every pollMs');
});

test('a retry inside a poll is counted as the request to NUS it is', async () => {
  const h = harness({ buses: { D2: [busOn('D2', 400)] } });
  await start(h);
  const feed = makeFetch({ buses: { [RUNNING[0]]: [busOn('D2', 400)] }, reject: 1, rejectCode: '10008' });
  globalThis.fetch = feed;
  await h.ns.fireDue(FROZEN_NOW);
  // A token (none yet), a refused call, a fresh token, and the call again:
  // four requests.
  assert.deepEqual(h.ae.rows('timelapse').map((r) => r.blobs[1]), ['retry', 'retry', 'retry', 'upstream']);
});

test('no service is asked twice within pollMs, even when the next round has fewer services', async () => {
  // 22:59:30 on a Thursday: most services close at 23:00, so the round
  // after has fewer services in it, and shorter slots.
  const from = sgt(DATE, '22:59') + 30_000;
  const before = Object.keys(GRAPH.routes).filter((svc) => inService(GRAPH, svc, from)).length;
  const after = Object.keys(GRAPH.routes).filter((svc) => inService(GRAPH, svc, from + 60_000)).length;
  assert.ok(after > 0 && after < before, `services running: ${before} then ${after}`);
  const h = harness({ buses: { K: [busOn('K', 400)] } });
  Date.now = () => from;
  await start(h);
  await runUntil(h, from + 3 * 60_000);
  // Every service's asks are at least pollMs apart, and none after it closed.
  const stamps = h.fetchImpl.requests.filter((r) => r.url.endsWith('/active-bus')).map((r) => [r.body.route_code, r.at]);
  for (const [svc, t] of stamps) assert.ok(inService(GRAPH, svc, t), `${svc} asked at ${new Date(t).toISOString()} after it closed`);
  const bySvc = {};
  for (const [svc, t] of stamps) (bySvc[svc] ??= []).push(t);
  for (const [svc, ts] of Object.entries(bySvc)) {
    for (let j = 1; j < ts.length; j++) assert.ok(ts[j] - ts[j - 1] >= 30_000, `${svc} asked again after ${ts[j] - ts[j - 1]} ms`);
  }
});

test('a partial outage is not an idle day: one service failing while the rest have no buses', async () => {
  const h = harness({ buses: { D2: [busOn('D2', 400)] } });
  await start(h);
  await runUntil(h, FROZEN_NOW + 30_000 - 1);
  // D2, the only service with buses out, fails from now on; the rest answer empty.
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    // A reply it can't read, so only D2 fails (no answer at all would open the breaker).
    if (String(input).endsWith('/active-bus') && JSON.parse(init.body ?? '{}').route_code === 'D2') return Response.json({ code: '00000', msg: '', data: { somethingNew: 1 } });
    return real(input, init);
  };
  await runUntil(h, FROZEN_NOW + 12 * 30_000);
  assert.equal((await status(h)).state, 'polling', 'still recording: D2 may well have buses out');
});

test('a deploy that changes a line mid-day keeps positions but not metres along', async () => {
  const h = harness({ buses: { D2: [busOn('D2', 400)] } });
  await start(h);
  // As if the day began on an older D2 line.
  const inst = h.ns.instances.get(DATE);
  const meta = inst.read('meta');
  inst.write('meta', { ...meta, lines: { ...meta.lines, D2: 'an older line' } });
  await runUntil(h, FROZEN_NOW + 30_000 - 1);
  const res = await h.ns.get(DATE).fetch(`https://timelapse.internal/day?date=${DATE}`);
  const file = await gunzip(new Uint8Array(await res.arrayBuffer()));
  const d2 = file.samples.find((s) => file.services[s[1]] === 'D2');
  assert.equal(d2.length, 2 + 4, 'the bus is kept');
  assert.equal(d2[5], -1, 'without metres along');
  assert.equal(decodeDay(file).tracks.length, 0, 'and the replay leaves it out');
});

test('a day begun before line fingerprints were kept checks against its saved map', async () => {
  const h = harness({ buses: { D2: [busOn('D2', 400)] } });
  await start(h);
  // As if begun by an older deploy: no fingerprints, and a saved map whose D2 line differs.
  const inst = h.ns.instances.get(DATE);
  const { lines, ...meta } = inst.read('meta');
  assert.ok(lines);
  inst.write('meta', meta);
  const map = inst.read('map');
  inst.write('map', { ...map, routes: { ...map.routes, D2: { ...map.routes.D2, line: map.routes.D2.line.slice(1) } } });
  await runUntil(h, FROZEN_NOW + 30_000 - 1);
  const res = await h.ns.get(DATE).fetch(`https://timelapse.internal/day?date=${DATE}`);
  const file = await gunzip(new Uint8Array(await res.arrayBuffer()));
  const d2 = file.samples.find((s) => file.services[s[1]] === 'D2');
  assert.equal(d2[5], -1, 'no metres along on a line that has changed');
});

test('the switch turned off mid-day stops polling within a round; on again, the cron resumes it', async () => {
  const kv = makeKV();
  const h = harness({ kv, buses: { D2: [busOn('D2', 400)] } });
  await start(h);
  await runUntil(h, FROZEN_NOW + 30_000 - 1);
  const asked = h.busCalls().length;
  await kv.put('config:timelapse', 'off');
  await runUntil(h, FROZEN_NOW + 30_000);
  assert.equal((await status(h)).state, 'off');
  assert.equal(h.ns.alarms.get(DATE), windowOf(DATE).close, 'asleep until the close, to write what it has');
  await runUntil(h, FROZEN_NOW + 600_000);
  assert.equal(h.busCalls().length, asked, 'nothing asked while off');

  await kv.put('config:timelapse', 'on');
  Date.now = () => FROZEN_NOW + 900_000;
  await ensureRecorder(h.env, FROZEN_NOW + 900_000);
  assert.equal((await status(h)).state, 'polling');
  assert.equal(h.ns.alarms.get(DATE), FROZEN_NOW + 900_000);
});

test('no buses for idleRounds rounds: before any bus it rests, after service it stops for the day', async () => {
  // Nothing out yet (early morning): rests, then tries again.
  const quiet = harness();
  await start(quiet);
  await runUntil(quiet, FROZEN_NOW + TIMELAPSE.idleRounds * 30_000);
  assert.equal((await status(quiet)).state, 'resting');
  assert.equal(quiet.ns.alarms.get(DATE), FROZEN_NOW + TIMELAPSE.idleRounds * 30_000 + TIMELAPSE.idleSleepMs);

  // K, the last service of a Thursday, until it closes at 23:00; then no
  // service is in its hours, and the day is over: done until the close.
  const late = sgt(DATE, '22:58');
  const buses = { K: [busOn('K', 400)] };
  const h = harness({ buses });
  Date.now = () => late;
  await start(h);
  await runUntil(h, late + 60_000);
  assert.ok(h.busCalls().length > 0, 'K was asked while it ran');
  delete buses.K;
  // Empty while K is still in its hours: a gap, so it rests; when it wakes,
  // no service is running, and after idleRounds more it's over.
  await runUntil(h, sgt(DATE, '23:00') + TIMELAPSE.idleRounds * 30_000);
  assert.equal((await status(h)).state, 'resting');
  await runUntil(h, sgt(DATE, '23:00') + TIMELAPSE.idleSleepMs + (2 * TIMELAPSE.idleRounds + 1) * 30_000);
  assert.equal((await status(h)).state, 'done');
  assert.equal(h.ns.alarms.get(DATE), windowOf(DATE).close);
});

test('no buses for a few minutes while services are in their hours is a gap: it rests and asks again', async () => {
  const buses = { D2: [busOn('D2', 400)] };
  const h = harness({ buses });
  await start(h);
  await runUntil(h, FROZEN_NOW + 30_000 - 1);
  delete buses.D2;
  await runUntil(h, FROZEN_NOW + (TIMELAPSE.idleRounds + 1) * 30_000);
  assert.equal((await status(h)).state, 'resting', 'not done: D2 is still inside its hours');
  const wake = h.ns.alarms.get(DATE);
  assert.ok(wake > FROZEN_NOW + TIMELAPSE.idleRounds * 30_000 && wake <= FROZEN_NOW + (TIMELAPSE.idleRounds + 1) * 30_000 + TIMELAPSE.idleSleepMs, 'asleep for idleSleepMs');
  const asked = h.busCalls().length;
  await runUntil(h, wake - 1);
  assert.equal(h.busCalls().length, asked, 'nothing asked while it rests');

  // The buses are back: it records again.
  buses.D2 = [busOn('D2', 900)];
  await runUntil(h, wake + 30_000);
  assert.equal((await status(h)).state, 'polling');
  assert.ok(h.busCalls().length > asked);
});

test('only empty rounds in a row stop it: one that could not confirm starts the count again', async () => {
  const buses = { D2: [busOn('D2', 400)] };
  const h = harness({ buses });
  await start(h);
  await runUntil(h, FROZEN_NOW + 30_000 - 1);
  delete buses.D2;
  // Empty rounds, one short of stopping; then one where D2 fails; then more empty ones.
  await runUntil(h, FROZEN_NOW + TIMELAPSE.idleRounds * 30_000 - 1);
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    // A reply it can't read, so only D2 fails (no answer at all would open the breaker).
    if (String(input).endsWith('/active-bus') && JSON.parse(init.body ?? '{}').route_code === 'D2') return Response.json({ code: '00000', msg: '', data: { somethingNew: 1 } });
    return real(input, init);
  };
  try {
    await runUntil(h, FROZEN_NOW + (TIMELAPSE.idleRounds + 1) * 30_000 - 1);
  } finally {
    globalThis.fetch = real;
  }
  await runUntil(h, FROZEN_NOW + (TIMELAPSE.idleRounds + 3) * 30_000 - 1);
  assert.equal((await status(h)).state, 'polling', 'two empty rounds since the outage, not six');
  await runUntil(h, FROZEN_NOW + (2 * TIMELAPSE.idleRounds + 1) * 30_000);
  // Stopped (resting, since services are still in their hours: see above).
  assert.equal((await status(h)).state, 'resting');
});

test('an outage is not an idle day: rounds where nothing answered do not stop it', async () => {
  const h = harness({ buses: { D2: [busOn('D2', 400)] } });
  await start(h);
  await runUntil(h, FROZEN_NOW + 30_000 - 1);
  // NUS refuses everything for ten rounds; the breaker stays open throughout.
  await runUntil(h, FROZEN_NOW + 11 * 30_000, async () => h.cache.seed(BREAKER, 'refused', 60));
  assert.equal((await status(h)).state, 'polling');
});

/* ------------------------------------------------------------------ */
/* What it keeps                                                       */
/* ------------------------------------------------------------------ */

test("a reading keeps each bus's plate, position and metres along its line, as buses.ts placed it", async () => {
  const h = harness({ buses: { D2: [busOn('D2', 400, 'PD111A'), busOn('D2', 1500, 'PD222B')] } });
  await start(h);
  await runUntil(h, FROZEN_NOW + 30_000 - 1);
  const res = await h.ns.get(DATE).fetch(`https://timelapse.internal/day?date=${DATE}`);
  const file = await gunzip(new Uint8Array(await res.arrayBuffer()));
  assert.equal(file.date, DATE);
  assert.deepEqual(file.services, RUNNING);
  const day = decodeDay(file);
  const tracks = Object.fromEntries(day.tracks.map((t) => [t.plate, t.pts[0]]));
  assert.ok(Math.abs(tracks.PD111A.along - 400) < 25, `along ${tracks.PD111A.along}`);
  assert.ok(Math.abs(tracks.PD222B.along - 1500) < 25, `along ${tracks.PD222B.along}`);
  assert.ok(haversineM(tracks.PD111A.lat, tracks.PD111A.lon, busOn('D2', 400).lat, busOn('D2', 400).lng) < 1.6, 'quantised to about a metre');
});

test('a reading and the times that date it are saved together, or neither is', async () => {
  const h = harness({ buses: { D2: [busOn('D2', 400)] } });
  await start(h);
  const inst = h.ns.instances.get(DATE);
  const before = inst.read('meta');
  const write = inst.write;
  // Storage fails between the row and the meta that dates it.
  inst.write = function (k, v) {
    if (k === 'meta' && Object.keys(v.last).length > 0) throw new Error('storage reset');
    return write.call(this, k, v);
  };
  await h.ns.fireDue(FROZEN_NOW);
  inst.write = write;
  assert.equal((await status(h)).samples, 0, 'the row went with it');
  const meta = inst.read('meta');
  assert.equal(meta.lastT, before.lastT);
  assert.deepEqual(meta.last, {});
  // The next reading counts from the last one actually kept.
  await runUntil(h, FROZEN_NOW + 30_000 - 1);
  assert.equal((await status(h)).samples, RUNNING.length - 1);
});

test('encoding round trip: quantised positions, delta times (even out of order), plates and services', () => {
  const t0 = FROZEN_NOW;
  const plates = ['PA1', 'PB2'];
  const raw = [
    { at: t0 + 1_000, svc: 'D2', buses: [{ plate: 'PA1', lat: 1.296_123_4, lon: 103.776_543_2, along: 812.4 }] },
    // A cached answer fetched a moment before the reading stored ahead of it.
    { at: t0 + 800, svc: 'A1', buses: [{ plate: 'PB2', lat: 1.2999, lon: 103.7701, along: null }] },
    { at: t0 + 31_000, svc: 'D2', buses: [] },
  ];
  let last = t0;
  const rows = raw.map((r) => {
    const row = { dt: r.at - last, svc: r.svc, buses: r.buses.flatMap((b) => encodeBus(b, plates.indexOf(b.plate))) };
    last = r.at;
    return row;
  });
  assert.equal(rows[1].dt, -200, 'deltas may be negative');
  const file = JSON.parse(JSON.stringify(buildDayFile({ date: DATE, t0, pollMs: 30_000, plates, rows, map: mapSnapshot() })));
  assert.equal(file.samples.length, 3);
  assert.ok(file.samples.flat().every(Number.isInteger), 'whole numbers only');
  const day = decodeDay(file);
  assert.equal(day.start, t0 + 800);
  assert.equal(day.end, t0 + 31_000);
  assert.equal(day.readings, 3);
  // PB2 was off its line: kept in the file, not drawn.
  assert.deepEqual(day.tracks.map((t) => t.key), ['D2 PA1']);
  const [p] = day.tracks[0].pts;
  assert.equal(p.t, t0 + 1_000);
  assert.equal(p.along, 812);
  assert.ok(Math.abs(p.lat - 1.296_12) < 1e-9 && Math.abs(p.lon - 103.776_54) < 1e-9, `${p.lat}, ${p.lon}`);
  // The file keeps the lines the alongs were measured on.
  assert.deepEqual(day.routes.D2.line, mapSnapshot().routes.D2.line);
});

test('at the close the day goes to R2 and the recorder is emptied', async () => {
  const h = harness({ buses: { D2: [busOn('D2', 400)] } });
  await start(h);
  await runUntil(h, FROZEN_NOW + 60_000 - 1);
  const samples = (await status(h)).samples;
  assert.equal(samples, RUNNING.length * 2);
  // Jump to the close (the alarm is capped at it).
  const { close } = windowOf(DATE);
  h.ns.alarms.set(DATE, close);
  Date.now = () => close;
  await h.ns.fireDue(close);

  const stored = h.bucket._written.get(`timelapse/${DATE}.json.gz`);
  assert.ok(stored, 'written as timelapse/YYYY-MM-DD.json.gz');
  const file = await gunzip(stored);
  assert.equal(file.samples.length, samples);
  assert.equal(file.date, DATE);
  assert.equal(h.ns.alarms.has(DATE), false, 'no alarm left');
  assert.deepEqual(await status(h), { date: null, samples: 0, state: 'idle' }, 'storage cleared');
  // The cron the next morning starts the next day's recorder, not this one.
  await ensureRecorder(h.env, sgt('2026-08-28', '06:30'));
  assert.deepEqual([...h.ns.alarms.keys()], ['2026-08-28']);
});

test('asking about a day nobody recorded leaves no storage behind', async () => {
  const h = harness();
  const date = '2026-08-20';
  assert.deepEqual(await status(h, date), { date: null, samples: 0, state: 'idle' });
  assert.equal((await h.ns.get(date).fetch(`https://timelapse.internal/day?date=${date}`)).status, 404);
  // A past day's start, too: closed, so nothing to begin.
  assert.equal((await (await start(h, date)).json()).state, 'closed');
  const tables = h.ns.instances.get(date).storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray();
  assert.deepEqual(tables, [], 'no tables created');
});

test('a close that fails anywhere keeps the day and tries again, for a week; then the storage goes', async () => {
  const h = harness({ buses: { D2: [busOn('D2', 400)] } });
  await start(h);
  await runUntil(h, FROZEN_NOW + 30_000 - 1);
  const inst = h.ns.instances.get(DATE);
  const { close } = windowOf(DATE);
  // Storage itself fails at the close, outside the write to R2.
  const count = inst.count;
  inst.count = () => {
    throw new Error('storage unavailable');
  };
  h.ns.alarms.set(DATE, close);
  Date.now = () => close;
  await h.ns.fireDue(close);
  assert.equal(h.ns.alarms.get(DATE), close + 10 * 60_000, 'tried again ten minutes later');
  inst.count = count;
  await runUntil(h, close + 10 * 60_000);
  assert.ok(h.bucket._written.has(`timelapse/${DATE}.json.gz`), 'written once storage is back');
  assert.equal(h.ns.alarms.has(DATE), false);

  // R2 refusing for over a week: given up, and nothing left behind.
  const g = harness({ buses: { D2: [busOn('D2', 400)] } });
  await start(g);
  await runUntil(g, FROZEN_NOW + 30_000 - 1);
  g.bucket.put = async () => {
    throw new Error('R2 down');
  };
  g.ns.alarms.set(DATE, close);
  await runUntil(g, close + 6 * 86_400_000);
  assert.equal((await status(g)).samples, RUNNING.length, 'still held after six days');
  await runUntil(g, close + 8 * 86_400_000);
  assert.equal(g.ns.alarms.has(DATE), false);
  assert.deepEqual(await status(g), { date: null, samples: 0, state: 'idle' }, 'storage deleted');
});

test('a past day whose alarm is gone is woken by the next morning\'s cron and written', async () => {
  const h = harness({ buses: { D2: [busOn('D2', 400)] } });
  await start(h);
  await runUntil(h, FROZEN_NOW + 30_000 - 1);
  // The platform's retries ran out: the day is held with no alarm at all.
  h.ns.alarms.delete(DATE);
  const morning = sgt('2026-08-29', '06:30');
  Date.now = () => morning;
  // Switched off by then: the cleanup happens anyway, and asks NUS nothing.
  await h.env.KV.put('config:timelapse', 'off');
  const asked = h.busCalls().length;
  await ensureRecorder(h.env, morning);
  assert.equal(h.ns.alarms.get(DATE), morning);
  await h.ns.fireDue(morning);
  assert.ok(h.bucket._written.has(`timelapse/${DATE}.json.gz`));
  assert.equal(h.ns.alarms.has(DATE), false);
  assert.equal(h.busCalls().length, asked);
  // Later runs that day don't ask the past week's recorders again.
  const before = h.ns.instances.size;
  await ensureRecorder(h.env, morning + 15 * 60_000);
  assert.equal(h.ns.instances.size, before);
});

test('a day still retrying a week after its close is cleaned up by the next morning\'s cron', async () => {
  const h = harness({ buses: { D2: [busOn('D2', 400)] } });
  await start(h);
  await runUntil(h, FROZEN_NOW + 30_000 - 1);
  h.bucket.put = async () => {
    throw new Error('R2 down');
  };
  const { close } = windowOf(DATE);
  // Retrying past the last morning within a week (09:00 on the seventh
  // day after), then the alarm is lost before the give-up.
  const late = close + 6 * 86_400_000 + 9 * 3_600_000;
  Date.now = () => late;
  h.ns.alarms.set(DATE, late);
  await h.ns.fireDue(late);
  assert.equal(h.ns.alarms.get(DATE), late + 10 * 60_000, 'still retrying');
  h.ns.alarms.delete(DATE);
  // The morning after the give-up deadline still asks this day.
  const morning = sgt(serviceDate(close + 7 * 86_400_000 + 6 * 3_600_000), '06:30');
  assert.ok(morning > close + 7 * 86_400_000);
  Date.now = () => morning;
  await ensureRecorder(h.env, morning);
  assert.equal(h.ns.alarms.get(DATE), morning);
  await h.ns.fireDue(morning);
  assert.equal(h.ns.alarms.has(DATE), false);
  assert.deepEqual(await status(h), { date: null, samples: 0, state: 'idle' }, 'storage deleted');
});

test('the tables are made once, /status counts nothing, and an empty recorder asked for its status stays empty', async () => {
  const h = harness({ buses: { D2: [busOn('D2', 400)] } });
  // A past day's recorder, never started (or emptied at its close): asking makes nothing.
  assert.deepEqual(await status(h, '2026-08-26'), { date: null, samples: 0, state: 'idle' });
  const past = h.ns.instances.get('2026-08-26').storage.sql;
  assert.deepEqual(past.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray(), [], 'no tables made by a read');

  await start(h);
  const sql = h.ns.instances.get(DATE).storage.sql;
  const queries = [];
  const exec = sql.exec.bind(sql);
  sql.exec = (q, ...args) => (queries.push(q), exec(q, ...args));
  await runUntil(h, FROZEN_NOW + 60_000 - 1);
  const samples = (await status(h)).samples;
  assert.equal(samples, RUNNING.length * 2, 'kept in meta as rows were added');
  assert.equal(queries.filter((q) => /CREATE TABLE/.test(q)).length, 0, 'made once, when the day started');
  assert.equal(queries.filter((q) => /COUNT\(\*\) AS n FROM samples/.test(q)).length, 0);

  // At the close the tables go, and a status afterwards doesn't bring them back.
  const { close } = windowOf(DATE);
  h.ns.alarms.set(DATE, close);
  Date.now = () => close;
  await h.ns.fireDue(close);
  assert.ok(h.bucket._written.has(`timelapse/${DATE}.json.gz`));
  assert.deepEqual(await status(h), { date: null, samples: 0, state: 'idle' });
  assert.deepEqual(exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray(), []);
});

/* ------------------------------------------------------------------ */
/* The routes                                                          */
/* ------------------------------------------------------------------ */

test('/api/timelapse/days: operator only, today while recording, closed days from R2 cached for a year', async () => {
  const h = harness({ buses: { D2: [busOn('D2', 400)] } });
  await start(h);
  await runUntil(h, FROZEN_NOW + 30_000 - 1);
  const call = async (path, token = 'op') => {
    const ctx = { waitUntil() {}, passThroughOnException() {} };
    return worker.fetch(new Request(`https://bus.example.test${path}`, { headers: token ? { 'x-health-token': token } : {} }), h.env, ctx);
  };
  assert.equal((await call('/api/timelapse/days', null)).status, 404);
  assert.equal((await call('/api/timelapse/days', 'wrong')).status, 404);
  assert.equal((await call(`/api/timelapse/days/${DATE}`, null)).status, 404);

  const list = await (await call('/api/timelapse/days')).json();
  assert.deepEqual(list.days, [{ date: DATE, closed: false, bytes: null, samples: RUNNING.length }]);
  assert.deepEqual(list.recording, { date: DATE, enabled: true, state: 'polling', samples: RUNNING.length });

  const open = await call(`/api/timelapse/days/${DATE}`);
  assert.equal(open.status, 200);
  assert.equal(open.headers.get('cache-control'), 'no-store', 'still changing');
  assert.equal((await gunzip(new Uint8Array(await open.arrayBuffer()))).samples.length, RUNNING.length);

  await h.bucket.put('timelapse/2026-08-26.json.gz', new Uint8Array([31, 139, 8, 0]));
  const closed = await call('/api/timelapse/days/2026-08-26');
  assert.equal(closed.status, 200);
  assert.equal(closed.headers.get('content-type'), 'application/gzip');
  assert.match(closed.headers.get('cache-control'), /max-age=31536000, immutable/);
  assert.equal((await call('/api/timelapse/days/2026-08-25')).status, 404);
  assert.equal((await call('/api/timelapse/days/nonsense')).status, 404);
  const both = await (await call('/api/timelapse/days')).json();
  assert.deepEqual(both.days.map((d) => [d.date, d.closed]), [[DATE, false], ['2026-08-26', true]]);
});

/* ------------------------------------------------------------------ */
/* Replaying it                                                        */
/* ------------------------------------------------------------------ */

/** A day with one D2 bus at these [t, along] readings. */
function oneBus(readings) {
  const plates = ['PD1'];
  const shape = shapeFor('D2', GRAPH.routes.D2);
  let last = FROZEN_NOW;
  const rows = readings.map(([t, along]) => {
    const p = pointAlong(shape, along);
    const row = { dt: FROZEN_NOW + t - last, svc: 'D2', buses: encodeBus({ plate: 'PD1', lat: p.lat, lon: p.lon, along }, 0) };
    last = FROZEN_NOW + t;
    return row;
  });
  return decodeDay(buildDayFile({ date: DATE, t0: FROZEN_NOW, pollMs: 30_000, plates, rows, map: mapSnapshot() }));
}

test('between readings a bus moves along the road, not in a straight line', () => {
  const path = oneBus([]).routes.D2.path;
  // A stretch of D2 with a bend in it: 300 m whose ends are much closer than 300 m apart.
  let a = 0;
  while (a + 300 < path.total) {
    const [p, q] = [pointAt(path, a), pointAt(path, a + 300)];
    if (haversineM(p.lat, p.lon, q.lat, q.lon) < 220) break;
    a += 10;
  }
  assert.ok(a + 300 < path.total, 'D2 bends somewhere');
  const day = oneBus([[0, a], [30_000, a + 300]]);
  const [mid] = busesAt(day, FROZEN_NOW + 15_000);
  const onRoad = pointAt(path, a + 150);
  assert.ok(haversineM(mid.lat, mid.lon, onRoad.lat, onRoad.lon) < 0.5, 'halfway along the road');
  const [p, q] = [pointAt(path, a), pointAt(path, a + 300)];
  assert.ok(haversineM(mid.lat, mid.lon, (p.lat + q.lat) / 2, (p.lon + q.lon) / 2) > 20, 'well off the straight line between the readings');
  assert.equal(mid.alpha, 1);
  assert.equal(mid.color, '#8e44c9');
  assert.deepEqual(countBySvc(busesAt(day, FROZEN_NOW + 15_000)), { D2: 1 });
});

test('round a loop, a bus passing the start carries on forward', () => {
  const path = oneBus([]).routes.D2.path;
  assert.ok(path.loop);
  const day = oneBus([[0, Math.floor(path.total) - 100], [30_000, 100]]);
  const { along } = placeAt(day.tracks[0], path, FROZEN_NOW + 15_000);
  const atStart = pointAt(path, along);
  const start = pointAt(path, 0);
  assert.ok(haversineM(atStart.lat, atStart.lon, start.lat, start.lon) < 5, `at the start of the loop, not back round it: ${along} of ${path.total}`);
});

test('across a gap of more than two minutes a bus fades out and in, not across', () => {
  const day = oneBus([[0, 500], [30_000, 700], [30_000 + 5 * 60_000, 2_000]]);
  const track = day.tracks[0];
  const path = day.routes.D2.path;
  const t1 = FROZEN_NOW + 30_000;
  const t2 = t1 + 5 * 60_000;
  assert.ok(t2 - t1 > GAP_MS);
  assert.deepEqual(placeAt(track, path, t1), { along: 700, alpha: 1 });
  const fading = placeAt(track, path, t1 + FADE_MS / 3);
  assert.equal(fading.along, 700, 'held where it was last seen');
  assert.ok(Math.abs(fading.alpha - 2 / 3) < 1e-9);
  assert.equal(placeAt(track, path, t1 + 2 * 60_000), null, 'gone in the middle of the gap');
  const back = placeAt(track, path, t2 - FADE_MS / 3);
  assert.equal(back.along, 2_000, 'back where it is next seen');
  assert.ok(Math.abs(back.alpha - 2 / 3) < 1e-9);
  // Before its first reading and after its last, it fades in and out too.
  assert.equal(placeAt(track, path, FROZEN_NOW - FADE_MS - 1), null);
  assert.ok(placeAt(track, path, FROZEN_NOW - FADE_MS / 2).alpha > 0);
  assert.equal(placeAt(track, path, t2 + FADE_MS + 1), null);
  // Drawn, it stays for a poll after its last reading (it's due again then), then fades.
  assert.deepEqual(placeAt(track, path, t2 + 29_000, 30_000), { along: 2_000, alpha: 1 });
  assert.ok(Math.abs(placeAt(track, path, t2 + 30_000 + FADE_MS / 2, 30_000).alpha - 0.5) < 1e-9);
  assert.equal(placeAt(track, path, t2 + 30_000 + FADE_MS + 1, 30_000), null);
  assert.equal(busesAt(day, t2 + 29_000).length, 1, 'busesAt holds for the day file\'s poll interval');
  // A short gap (a missed poll) is driven across.
  const short = oneBus([[0, 500], [60_000, 900]]);
  assert.deepEqual(placeAt(short.tracks[0], path, FROZEN_NOW + 30_000), { along: 700, alpha: 1 });
});

test('a reading further on than a bus can drive is a jump: out at one place, in at the other', () => {
  const day = oneBus([[0, 100], [30_000, 3_000]]);
  const track = day.tracks[0];
  const path = day.routes.D2.path;
  const early = placeAt(track, path, FROZEN_NOW + 7_500);
  assert.equal(early.along, 100);
  assert.ok(Math.abs(early.alpha - 0.5) < 1e-9);
  const late = placeAt(track, path, FROZEN_NOW + 22_500);
  assert.equal(late.along, 3_000);
  assert.ok(Math.abs(late.alpha - 0.5) < 1e-9);
  // Still out the whole way through: the count doesn't blink to none.
  for (const t of [7_500, 14_000, 15_000, 16_000, 22_500]) assert.deepEqual(countBySvc(busesAt(day, FROZEN_NOW + t)), { D2: 1 }, `at +${t} ms`);
  // A gap is a real absence: none out in the middle of it.
  const gap = oneBus([[0, 500], [5 * 60_000, 700]]);
  assert.deepEqual(countBySvc(busesAt(gap, FROZEN_NOW + 2.5 * 60_000)), {});
});

test("start and end times on the day's timeline: after midnight is the next morning", () => {
  assert.equal(timeOn('2026-10-07', '08:00'), sgt('2026-10-07', '08:00'));
  assert.equal(timeOn('2026-10-07', '00:15'), sgt('2026-10-08', '00:15'));
  assert.equal(timeOn('2026-10-07', '06:30'), sgt('2026-10-07', '06:30'));
});

test("an earlier day stays in the list while its write to R2 is being retried", async () => {
  const h = harness({ buses: { D2: [busOn('D2', 400)] } });
  await start(h);
  await runUntil(h, FROZEN_NOW + 30_000 - 1);
  // Three mornings later: the 27th's recorder still holds its day (R2 refused it).
  const next = sgt('2026-08-30', '09:00');
  Date.now = () => next;
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const res = await worker.fetch(new Request('https://bus.example.test/api/timelapse/days', { headers: { 'x-health-token': 'op' } }), h.env, ctx);
  const { days } = await res.json();
  assert.deepEqual(days.map((d) => [d.date, d.closed, d.samples]), [[DATE, false, RUNNING.length]]);
});

test('a recorder that never answers holds up neither the cron nor the routes for long', async (t) => {
  const h = harness();
  const stuck = { idFromName: (name) => name, get: () => ({ fetch: () => new Promise(() => {}) }) };
  const env = { ...h.env, TIMELAPSE: stuck };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const settled = async (p) => {
    let result = null;
    p.then((value) => (result = { value }), (error) => (result = { error }));
    // Let it reach the recorder, then let ten seconds pass.
    for (let i = 0; i < 50 && !result; i++) {
      await new Promise(setImmediate);
      t.mock.timers.tick(1_000);
    }
    assert.ok(result, 'answered within the wait');
    if (result.error) throw result.error;
    return result.value;
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const get = (path) => worker.fetch(new Request(`https://bus.example.test${path}`, { headers: { 'x-health-token': 'op' } }), env, ctx);
  const day = await settled(get(`/api/timelapse/days/${DATE}`));
  assert.equal(day.status, 503);
  assert.equal(day.headers.get('retry-after'), '60');
  const list = await settled(get('/api/timelapse/days'));
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).days, []);
  await assert.rejects(settled(ensureRecorder(env, FROZEN_NOW)), /did not answer/);
});

test('TIMELAPSE_TOKEN opens the timelapse routes and nothing else', async () => {
  const h = harness();
  const env = { ...h.env, TIMELAPSE_TOKEN: 'render-only' };
  const call = async (path, token) => {
    const ctx = { waitUntil() {}, passThroughOnException() {} };
    return worker.fetch(new Request(`https://bus.example.test${path}`, { headers: { 'x-health-token': token } }), env, ctx);
  };
  assert.equal((await call('/api/timelapse/days', 'render-only')).status, 200);
  assert.equal((await call('/api/timelapse/days', 'op')).status, 200, 'the operator still can');
  assert.equal((await call('/api/admin/stats', 'render-only')).status, 404, 'not the dashboard');
  assert.equal((await (await call('/api/health?probe=1', 'render-only')).json()).auth, undefined, 'nor the auth probe');
  // Unset, it opens nothing.
  const none = { ...h.env, TIMELAPSE_TOKEN: undefined };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  assert.equal((await worker.fetch(new Request('https://bus.example.test/api/timelapse/days', { headers: { 'x-health-token': '' } }), none, ctx)).status, 404);
});
