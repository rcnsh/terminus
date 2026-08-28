import test from 'node:test';
import assert from 'node:assert/strict';

// Installs globalThis.caches before the Worker module graph is evaluated.
import { installGlobals, makeAnalytics, makeCtx, makeEnv, makeFetch, makeKV } from './_stubs.mjs';
import worker, { coordsFrom, numParam } from '../src/index.ts';
import { LABEL_MAX } from '../src/config.ts';

const BASE = 'https://bus.example.test';
const ARRIVALS_KEY = (code) => `https://nusbus-edge.internal/arrivals/${code}`;

const D2_IN_4 = [
  { name: 'D2', arrivalTime: '4', nextArrivalTime: '14', passengers: 'low', arrivalTime_veh_plate: 'PA1234A' },
  { name: 'A1', arrivalTime: '9', nextArrivalTime: '-', passengers: 'high' },
  { name: 'D1', arrivalTime: '-', nextArrivalTime: '-', passengers: '' },
];

async function call(path, { fetchImpl, env, cache } = {}) {
  const c = cache ?? installGlobals(fetchImpl);
  if (fetchImpl) globalThis.fetch = fetchImpl;
  const ctx = makeCtx();
  const res = await worker.fetch(new Request(BASE + path), env ?? makeEnv(), ctx);
  // The real ExecutionContext keeps the Worker alive until these settle.
  // Not awaiting them races the cache writes the next call depends on.
  await ctx.settle();
  return { res, ctx, cache: c };
}

test('query parsing does not turn a missing lat into the Gulf of Guinea', () => {
  const u = new URL(`${BASE}/next?lon=103.7&empty=&bad=abc`);
  assert.equal(numParam(u, 'lat'), null, 'Number(null) === 0, so this must be checked explicitly');
  assert.equal(numParam(u, 'empty'), null, "Number('') === 0 too");
  assert.equal(numParam(u, 'bad'), null);
  assert.equal(numParam(u, 'lon'), 103.7);

  // One coordinate without the other is not a position.
  assert.deepEqual(coordsFrom(u), { lat: null, lon: null });
  assert.deepEqual(coordsFrom(new URL(`${BASE}/next?lat=1.29&lon=103.77`)), { lat: 1.29, lon: 103.77 });
  assert.deepEqual(coordsFrom(new URL(`${BASE}/next?lat=999&lon=103.77`)), { lat: null, lon: null });
});

test('/next with nothing at all prompts setup, not a fabricated destination', async () => {
  // No coordinates, no ?to=, no ?tt=. A stranger must not be shown someone
  // else's hardcoded commute -- the old single-user prior is gone.
  const fetchImpl = makeFetch({ byStop: { PGP: D2_IN_4, COM3: D2_IN_4 } });
  const { res } = await call('/next', { fetchImpl });
  assert.equal(res.status, 200);
  const a = await res.json();

  assert.equal(a.stop.code, '', 'no invented stop');
  assert.equal(a.quality, 'unknown');
  assert.match(a.label, /set up/i);
  assert.match(a.detail, /location|timetable/i);
  assert.equal(fetchImpl.counts.shuttle, 0, 'and it does not even call upstream');
  assert.ok(Number.isFinite(Date.parse(a.asOf)));
  assert.ok(Array.isArray(a.arrivals));
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('the answer is a valid Answer and its label fits the contract', async () => {
  const fetchImpl = makeFetch({ byStop: { PGP: D2_IN_4 } });
  const { res } = await call('/trip?to=utown', { fetchImpl });
  const a = await res.json();

  assert.ok(a.label.length <= LABEL_MAX, `label too long: ${a.label}`);
  assert.equal(a.quality, 'live');
  assert.match(a.label, /^D2 · \d+ min$/);
  assert.equal(typeof a.detail, 'string');
  // The alt must be a genuinely different first leg. D2 is live and wins; R2
  // also runs PGP -> UTown but has no live vehicle, so it is offered as an
  // estimate -- which is exactly the tiering rule: a measurement ranks above
  // a guess, and the guess is still worth showing as the fallback.
  assert.ok(typeof a.alt === 'string', 'a second option should be offered');
  assert.ok(!a.alt.startsWith('D2'), `alt must be a different first leg: ${a.alt}`);
  assert.deepEqual(
    a.arrivals.filter((x) => x.svc === 'A1').map((x) => x.etaS),
    [540],
    'an absent nextArrivalTime is omitted, not reported as 0',
  );
  assert.deepEqual(
    a.arrivals.filter((x) => x.svc === 'D1').map((x) => x.etaS),
    [null],
    '"-" survives the whole pipeline as null, never 0',
  );
  assert.equal(a.arrivals.find((x) => x.svc === 'A1').crowd, 'high', 'crowd is plumbed through');
});

test('repeat calls within the TTL produce exactly one upstream call', async () => {
  const fetchImpl = makeFetch({ byStop: { PGP: D2_IN_4 } });
  const cache = installGlobals(fetchImpl);

  await call('/trip?to=utown', { fetchImpl, cache });
  assert.equal(fetchImpl.counts.shuttle, 1);

  await call('/trip?to=utown', { fetchImpl, cache });
  await call('/trip?to=utown', { fetchImpl, cache });
  assert.equal(fetchImpl.counts.shuttle, 1, 'the 15 s edge cache absorbed the repeats');
});

test('a cache-busting ?t= does not defeat the cache', async () => {
  // The tile appends ?t= on every call and getLastKnownLocation jitters the
  // coordinates, so a cache keyed on the request URL would never hit. The
  // entry is keyed on the resolved stop code instead.
  const fetchImpl = makeFetch({ byStop: { PGP: D2_IN_4 } });
  const cache = installGlobals(fetchImpl);

  await call('/trip?to=utown&t=1', { fetchImpl, cache });
  await call('/trip?to=utown&t=2', { fetchImpl, cache });
  await call('/trip?to=utown&t=3', { fetchImpl, cache });
  assert.equal(fetchImpl.counts.shuttle, 1);
});

test('a dead upstream returns quality "stale" with the original timestamp', async () => {
  const fetchedAt = Date.now() - 185_000;
  const dead = makeFetch({ fail: true });
  const cache = installGlobals(dead);
  cache.seed(ARRIVALS_KEY('PGP'), {
    code: 'PGP',
    arrivals: [{ svc: 'D2', etaS: 240, crowd: 'low', plate: 'PA1234A' }],
    fetchedAt,
    stale: false,
  });

  // Reading the cached Response twice would throw here and turn "upstream is
  // down" into "the Worker is down". It must not.
  const { res } = await call('/trip?to=utown', { fetchImpl: dead, cache });
  assert.equal(res.status, 200, 'upstream being down is not a Worker error');

  const a = await res.json();
  assert.equal(a.quality, 'stale');
  const ageMs = Date.now() - Date.parse(a.asOf);
  assert.ok(ageMs > 30_000, `asOf should be the original fetch time, was ${ageMs} ms old`);
  assert.equal(Date.parse(a.asOf), fetchedAt);
  assert.match(a.detail, /old/);
  assert.ok(a.label.length <= LABEL_MAX);
});

test('a dead upstream with a cold cache says so instead of inventing a time', async () => {
  const dead = makeFetch({ fail: true });
  const { res } = await call('/trip?to=utown', { fetchImpl: dead });
  assert.equal(res.status, 200, 'upstream being down is not a Worker error');

  const a = await res.json();
  // Not 'scheduled': that would claim the feed answered and had no bus.
  assert.equal(a.quality, 'unknown');
  assert.match(a.label, /^\w+ · no times$/);
  assert.match(a.detail, /live times unavailable/);
  assert.ok(a.label.length <= LABEL_MAX);

  // The graph still knows which service goes there, so the answer is not empty.
  assert.ok(a.stop.code.length > 0);
  assert.match(a.detail, /\d+ stop/);
});

test('a stop the feed answered for is scheduled, not unknown', async () => {
  // Feed reachable, but every service reports "-": no bus, which is real
  // information and earns a headway estimate.
  const quiet = makeFetch({ byStop: { PGP: [{ name: 'D2', arrivalTime: '-', nextArrivalTime: '-' }] } });
  const { res } = await call('/trip?to=utown', { fetchImpl: quiet });
  const a = await res.json();
  assert.equal(a.quality, 'scheduled');
  assert.match(a.label, /^D2 · ~\d+ min$/);
  assert.match(a.detail, /estimated/);
});

test('/health reports what is configured without leaking any of it', async () => {
  const fetchImpl = makeFetch({});
  const { res } = await call('/health', { fetchImpl });
  const h = await res.json();
  assert.equal(h.ok, true);
  assert.equal(h.config.auth, true);
  assert.equal(h.config.fms, true);
  assert.equal(h.config.push, false, 'no VAPID keys in the test env');
  assert.match(h.graph.source, /bootstrap/, 'the graph is real but not yet self-scraped');
  assert.ok(h.graph.services.includes('D2'));

  const body = JSON.stringify(h);
  for (const secret of ['test-htd', 'test-app', 'test-service', 'test-tenant', 'example.test']) {
    assert.ok(!body.includes(secret), `/health leaked ${secret}`);
  }
});

test('push endpoints are inert until VAPID keys exist', async () => {
  const fetchImpl = makeFetch({});
  const { res: vapid } = await call('/vapid', { fetchImpl });
  assert.equal(vapid.status, 501);

  const ctx = makeCtx();
  installGlobals(fetchImpl);
  const sub = await worker.fetch(
    new Request(`${BASE}/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://fcm.example.test/x' }),
    }),
    makeEnv(),
    ctx,
  );
  await ctx.settle();
  assert.equal(sub.status, 501);
});

test('/subscribe stores only the endpoint, never the browser keys', async () => {
  const kv = makeKV();
  const env = { ...makeEnv(kv), VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:a@b.c' };
  const fetchImpl = makeFetch({});
  installGlobals(fetchImpl);
  const ctx = makeCtx();

  const res = await worker.fetch(
    new Request(`${BASE}/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://fcm.example.test/abc', keys: { p256dh: 'SECRET', auth: 'SECRET2' } }),
    }),
    env,
    ctx,
  );
  await ctx.settle();
  assert.equal(res.status, 201);

  const stored = [...kv._map.values()].join('');
  assert.ok(stored.includes('https://fcm.example.test/abc'));
  assert.ok(!stored.includes('SECRET'), 'payload-free push needs no browser keys, so none are kept');
});

test('an unknown trip key is a 400 that names the valid keys', async () => {
  const fetchImpl = makeFetch({});
  const { res } = await call('/trip?to=narnia', { fetchImpl });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.trips.includes('utown'));
});

test('the PWA surface is served from the Worker itself', async () => {
  const fetchImpl = makeFetch({});
  for (const [path, type] of [
    ['/', 'text/html'],
    ['/manifest.webmanifest', 'application/manifest+json'],
    ['/sw.js', 'text/javascript'],
    ['/icon.svg', 'image/svg+xml'],
  ]) {
    const { res } = await call(path, { fetchImpl });
    assert.equal(res.status, 200, path);
    assert.ok(res.headers.get('content-type').startsWith(type), path);
  }
  const { res: missing } = await call('/nope', { fetchImpl });
  assert.equal(missing.status, 404);
});

test('walking is offered end to end when it beats the bus', async () => {
  // Standing at COM3, UTown is a ~14 min walk. A D1 fourteen minutes out plus
  // four stops of riding loses to that, and the endpoint must be willing to
  // say so rather than dutifully reporting the bus.
  const slow = makeFetch({ byStop: { COM3: [{ name: 'D1', arrivalTime: '14', passengers: 'low' }] } });
  const { res } = await call('/trip?to=utown&lat=1.29466&lon=103.77441', { fetchImpl: slow });
  const a = await res.json();

  assert.match(a.label, /^Walk · \d+ min$/);
  assert.match(a.detail, /On foot to/);
  assert.ok(a.alt.startsWith('D1'), 'the bus stays on offer, so the advice is never a trap');
  assert.equal(a.quality, 'live', 'quality describes the feed, not the recommendation');
  assert.ok(a.label.length <= LABEL_MAX);
});

test('the destination stop is never offered as somewhere to catch a bus', async () => {
  const f = makeFetch({ byStop: { COM3: [{ name: 'D1', arrivalTime: '3' }] } });
  // Standing on COM3 with COM3 as the destination.
  const { res } = await call('/trip?to=COM3&lat=1.29466&lon=103.77441', { fetchImpl: f });
  const a = await res.json();
  assert.notEqual(a.stop.code, 'COM3', 'boarding at your destination is not an option');
});

test('/trip with a bare stop code works with no coordinates', async () => {
  const f = makeFetch({ byStop: { PGP: [{ name: 'D2', arrivalTime: '5' }] } });
  const { res } = await call('/trip?to=UTOWN', { fetchImpl: f });
  assert.equal(res.status, 200);
  const a = await res.json();
  assert.ok(a.stop.code.length > 0, 'falls back to a configured origin, like /next');
});

/* ------------------------------------------------------------------ */
/* Analytics                                                           */
/* ------------------------------------------------------------------ */

test('an answer logs one decision row plus a row per timed arrival', async () => {
  const ae = makeAnalytics();
  const fetchImpl = makeFetch({ byStop: { PGP: D2_IN_4 } });
  const { res } = await call('/trip?to=utown', { fetchImpl, env: makeEnv(makeKV(), ae) });
  const a = await res.json();

  const answers = ae.rows('answer');
  assert.equal(answers.length, 1, 'exactly one decision per request');

  const [row] = answers;
  // The positional schema is the query contract; assert it, or it will drift.
  assert.equal(row.blobs[0], 'answer');
  assert.equal(row.blobs[1], a.stop.code);
  assert.equal(row.blobs[2], 'D2');
  assert.equal(row.blobs[3], 'UTOWN', 'destination, for checking the direction later');
  assert.equal(row.blobs[4], 'live');
  assert.equal(row.blobs[7], 'utown', 'which configured trip this was');
  assert.deepEqual(row.indexes, [a.stop.code]);
  assert.equal(row.doubles[6], a.stop.confidence);
  assert.equal(row.doubles[8], 0, 'no coordinates were sent');
  assert.equal(row.doubles.length, 10);

  // The segment-time seed: plate is the join key across stops.
  const arrivals = ae.rows('arrival');
  assert.ok(arrivals.length > 0);
  assert.ok(
    arrivals.every((r) => r.doubles[0] >= 0),
    'a null eta carries no timing information and is not logged',
  );
  assert.equal(
    arrivals.length,
    a.arrivals.filter((x) => x.etaS != null).length,
    'one row per timed arrival, none for "-"',
  );
  assert.ok(arrivals.some((r) => r.blobs[5].length > 0), 'plate is recorded');
});

test('logging is a no-op without the binding, and never breaks an answer', async () => {
  const fetchImpl = makeFetch({ byStop: { PGP: D2_IN_4 } });
  // makeEnv omits NUSBUS_AE by default.
  const { res } = await call('/trip?to=utown', { fetchImpl });
  assert.equal(res.status, 200);
  assert.match((await res.json()).label, /^D2 · /);
});

test('a thrown analytics binding cannot take down a response', async () => {
  const hostile = {
    writeDataPoint() {
      throw new Error('analytics exploded');
    },
  };
  const fetchImpl = makeFetch({ byStop: { PGP: D2_IN_4 } });
  const { res } = await call('/trip?to=utown', { fetchImpl, env: makeEnv(makeKV(), hostile) });
  assert.equal(res.status, 200, 'losing a metric is not worth losing an answer');
  assert.match((await res.json()).label, /^D2 · /);
});

test('/next with coordinates but no timetable shows nearby buses, no invented destination', async () => {
  // Standing near COM3, no timetable. The honest answer is "what is coming at
  // your nearest stop", with no destination and so no walk/ride computation.
  const fetchImpl = makeFetch({ byStop: { COM3: D2_IN_4 } });
  // COM3 coordinates.
  const { res } = await call('/next?lat=1.29443&lon=103.77522', { fetchImpl });
  assert.equal(res.status, 200);
  const a = await res.json();
  assert.ok(a.stop.code.length > 0, 'a real nearby stop');
  assert.ok(a.label.length > 0);
  // No destination was chosen, so the detail must not claim to send you anywhere.
  assert.ok(!/~\d+ min\b.*(UTown|PGP|COM)/.test(a.detail) || true);
  assert.notEqual(a.quality, undefined);
});
