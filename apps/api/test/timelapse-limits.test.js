/**
 * The timelapse recorder's limits on NUS (CLAUDE.md, rule 2's one
 * exception), in time: the back-off while the feed fails, the interval a
 * day keeps once it has a longer one, a service that closes mid-round, and
 * a whole recorded day that asks for live buses and nothing else.
 * timelapse.test.js has the rest; this file has its own small harness.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FROZEN_NOW, installGlobals, makeAnalytics, makeBucket, makeDurableObjects, makeEnv, makeFetch, makeKV } from './_stubs.mjs';
import { TimelapseRecorder, backoffOf } from '../src/timelapsedo.ts';
import { TIMELAPSE } from '../src/config.ts';
import { pollInterval, serviceDate, windowOf } from '../src/timelapse.ts';
import { pointAlong } from '../src/buses.ts';
import { shapeFor } from '../src/campus.ts';
import { inService } from '../src/resolve.ts';
import { GRAPH } from '../src/graph.ts';

const sgt = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`);
const DATE = serviceDate(FROZEN_NOW); // Thursday 2026-08-27, 09:00 SGT
const RUNNING = Object.keys(GRAPH.routes).filter((svc) => inService(GRAPH, svc, FROZEN_NOW)).sort();

function busOn(svc, m, plate = `PX${svc}1`) {
  const p = pointAlong(shapeFor(svc, GRAPH.routes[svc]), m);
  return { vehplate: plate, lat: p.lat, lng: p.lon, speed: 25, direction: p.bearing ?? 0, loadInfo: { capacity: 88, ridership: 20 } };
}

/** [base] with every request's URL, body and time kept in `log`, failed ones too. */
function logged(base) {
  const log = [];
  const fn = async (input, init = {}) => {
    const url = String(typeof input === 'string' ? input : input.url);
    log.push({ url, body: init.body ? JSON.parse(init.body) : null, at: Date.now() });
    return base(input, init);
  };
  fn.log = log;
  fn.counts = base.counts;
  return fn;
}

function harness({ fetchImpl = makeFetch() } = {}) {
  const feed = logged(fetchImpl);
  const cache = installGlobals(feed, FROZEN_NOW);
  const ae = makeAnalytics();
  let env;
  const ns = makeDurableObjects(TimelapseRecorder, () => env);
  env = { ...makeEnv(makeKV(), ae), TIMELAPSE: ns, TIMELAPSE_ENABLED: 'on', DOWNLOADS: makeBucket(async () => null), HEALTH_TOKEN: 'op' };
  return { env, ns, feed, cache, ae };
}

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
const busAsks = (h) => h.feed.log.filter((r) => r.url.endsWith('/active-bus'));

test('backoffOf: 1, then 2, 4 and 8 rounds, and never longer', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 50].map(backoffOf), [1, 2, 4, 8, 8, 8, 8]);
});

test('a feed down all morning is asked 60, 120, 240, then every 240 s', async () => {
  const h = harness({ fetchImpl: makeFetch({ fail: true }) });
  await start(h);
  // Rounds at 0, 60, 180, 420 and 660 s.
  await runUntil(h, FROZEN_NOW + 12 * 60_000);
  const asks = busAsks(h);
  // The first service fails and opens the breaker, so the rest of each
  // round is skipped without asking: one request a round.
  assert.ok(asks.every((r) => r.body.route_code === RUNNING[0]), asks.map((r) => r.body.route_code).join());
  const gaps = asks.slice(1).map((r, i) => (r.at - asks[i].at) / 1000);
  assert.deepEqual(gaps, [60, 120, 240, 240]);
});

test('a day that began with a longer interval keeps it', async () => {
  const h = harness({ fetchImpl: makeFetch({ buses: { D2: [busOn('D2', 400)] } }) });
  await start(h);
  const inst = h.ns.instances.get(DATE);
  // As if the day began on an earlier deploy with more routes.
  const longer = pollInterval() * 2;
  inst.write('meta', { ...inst.read('meta'), pollMs: longer });
  await h.ns.fireDue(FROZEN_NOW);
  assert.equal(inst.read('meta').pollMs, longer, 'never shortened mid-day');
  assert.equal(h.ns.alarms.get(DATE), FROZEN_NOW + longer / RUNNING.length, 'and the slots are its');
});

test('a service that closes partway through a round is not asked, and is counted closed', async () => {
  // A round that begins at 22:59:50 on a Thursday: most services close at
  // 23:00, so the later ones close before their turn.
  const from = sgt(DATE, '22:59') + 50_000;
  const list = Object.keys(GRAPH.routes).filter((svc) => inService(GRAPH, svc, from)).sort();
  const h = harness();
  Date.now = () => from;
  await start(h);
  const inst = h.ns.instances.get(DATE);
  const times = [];
  await runUntil(h, from + 30_000 - 1, async (t) => times.push(t));
  const round = inst.read('meta').round;
  assert.deepEqual(round.list, list);
  const closed = list.filter((svc, i) => !inService(GRAPH, svc, times[i]));
  assert.ok(closed.length > 0 && closed.length < list.length, `closed before their turn: ${closed}`);
  const asked = busAsks(h).map((r) => r.body.route_code);
  for (const svc of closed) assert.ok(!asked.includes(svc), `${svc} asked after it closed`);
  assert.equal(round.closed, closed.length);
  assert.equal(round.answered, list.length - closed.length);
  // Every service it asked answered with no bus: an idle round, not a failing one.
  assert.equal(inst.read('meta').failing, 0);
  await runUntil(h, from + 30_000);
  assert.equal(inst.read('meta').idle, 1, 'the closed ones do not stop it counting as idle');
});

test('a whole recorded day asks NUS for live buses only: never arrivals, never LTA, and under its ceiling', async () => {
  const fetchImpl = makeFetch({ buses: Object.fromEntries(Object.keys(GRAPH.routes).map((svc) => [svc, [busOn(svc, 400)]])) });
  const h = harness({ fetchImpl });
  h.env.LTA_ACCOUNT_KEY = 'test-account-key';
  const { open, close } = windowOf(DATE);
  Date.now = () => open - 60_000;
  await start(h);
  await runUntil(h, close + 1);
  const kinds = new Set(h.feed.log.map((r) => (r.url.endsWith('/active-bus') ? 'active-bus' : r.url.includes('get-access-token') ? 'mint' : r.url)));
  assert.deepEqual([...kinds].sort(), ['active-bus', 'mint'], 'only live buses, and the token for them');
  assert.equal(fetchImpl.counts.public, 0);
  const asks = busAsks(h);
  assert.ok(asks.length > 1000, `recorded a day: ${asks.length} polls`);
  assert.ok(asks.length <= TIMELAPSE.maxPollsPerDay, `${asks.length} polls`);
  assert.ok(asks.every((r) => r.at >= open && r.at < close && inService(GRAPH, r.body.route_code, r.at)), 'inside the window and the service hours');
  assert.equal(h.env.DOWNLOADS._written.size, 1, 'and the day went to R2');
});
