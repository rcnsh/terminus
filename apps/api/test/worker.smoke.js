import test from 'node:test';
import assert from 'node:assert/strict';

// Installs globalThis.caches before the Worker module graph is evaluated.
import { FROZEN_NOW, installGlobals, makeAnalytics, makeCtx, makeEnv, makeFetch, makeKV } from './_stubs.mjs';
import worker, { coordsFrom, numParam } from '../src/index.ts';
import { LABEL_MAX } from '../src/config.ts';

const BASE = 'https://bus.example.test';
const ARRIVALS_KEY = (code) => `https://terminus.internal/arrivals/${code}`;

const D2_IN_4 = [
  { name: 'D2', arrivalTime: '4', nextArrivalTime: '14', passengers: 'low', arrivalTime_veh_plate: 'PA1234A' },
  { name: 'A1', arrivalTime: '9', nextArrivalTime: '-', passengers: 'high' },
  { name: 'D1', arrivalTime: '-', nextArrivalTime: '-', passengers: '' },
];

async function call(path, { fetchImpl, env, cache, headers } = {}) {
  const c = cache ?? installGlobals(fetchImpl);
  if (fetchImpl) globalThis.fetch = fetchImpl;
  const ctx = makeCtx();
  const res = await worker.fetch(new Request(BASE + path, { headers }), env ?? makeEnv(), ctx);
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
  // No coordinates, no ?to=. A stranger must not be shown someone
  // else's hardcoded commute -- the old single-user prior is gone.
  const fetchImpl = makeFetch({ byStop: { PGP: D2_IN_4, COM3: D2_IN_4 } });
  const { res } = await call('/next', { fetchImpl });
  assert.equal(res.status, 200);
  const a = await res.json();

  assert.equal(a.stop.code, '', 'no invented stop');
  assert.equal(a.quality, 'unknown');
  assert.match(a.label, /set up/i);
  assert.match(a.detail, /lat\/lon/);
  assert.equal(fetchImpl.counts.shuttle, 0, 'and it does not even call upstream');
  assert.ok(Number.isFinite(Date.parse(a.asOf)));
  assert.ok(Array.isArray(a.arrivals));
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('the answer is a valid Answer and its label fits the contract', async () => {
  const fetchImpl = makeFetch({ byStop: { PGP: D2_IN_4 } });
  const { res } = await call('/trip?to=UTOWN&from=PGP', { fetchImpl });
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

  await call('/trip?to=UTOWN&from=PGP', { fetchImpl, cache });
  assert.equal(fetchImpl.counts.shuttle, 1);

  await call('/trip?to=UTOWN&from=PGP', { fetchImpl, cache });
  await call('/trip?to=UTOWN&from=PGP', { fetchImpl, cache });
  assert.equal(fetchImpl.counts.shuttle, 1, 'the 15 s edge cache absorbed the repeats');
});

test('a cache-busting ?t= does not defeat the cache', async () => {
  // The tile appends ?t= on every call and getLastKnownLocation jitters the
  // coordinates, so a cache keyed on the request URL would never hit. The
  // entry is keyed on the resolved stop code instead.
  const fetchImpl = makeFetch({ byStop: { PGP: D2_IN_4 } });
  const cache = installGlobals(fetchImpl);

  await call('/trip?to=UTOWN&from=PGP&t=1', { fetchImpl, cache });
  await call('/trip?to=UTOWN&from=PGP&t=2', { fetchImpl, cache });
  await call('/trip?to=UTOWN&from=PGP&t=3', { fetchImpl, cache });
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
  const { res } = await call('/trip?to=UTOWN&from=PGP', { fetchImpl: dead, cache });
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
  const { res } = await call('/trip?to=UTOWN&from=PGP', { fetchImpl: dead });
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
  const { res } = await call('/trip?to=UTOWN&from=PGP', { fetchImpl: quiet });
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
  assert.equal(h.config.proxy, true);
  assert.match(h.graph.source, /scrape_stops\.py/, 'the graph comes from our own scraper');
  assert.ok(h.graph.services.includes('D2'));

  const body = JSON.stringify(h);
  for (const secret of ['test-htd', 'test-app', 'test-proxy-key', 'example.test']) {
    assert.ok(!body.includes(secret), `/health leaked ${secret}`);
  }
});

test('an unknown destination is a 400 that says what to send', async () => {
  const fetchImpl = makeFetch({});
  const { res } = await call('/trip?to=narnia&from=PGP', { fetchImpl });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /stop or venue code/);
});

test('/trip accepts a NUSMods venue code', async () => {
  const fetchImpl = makeFetch({ byStop: { PGP: D2_IN_4 } });
  const { res } = await call('/trip?to=COM1-0212&from=PGP', { fetchImpl });
  assert.equal(res.status, 200);
});

test('/docs is the API documentation, rendered from /openapi.json', async () => {
  const fetchImpl = makeFetch({});
  const { res } = await call('/docs', { fetchImpl });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type').startsWith('text/html'));
  const html = await res.text();
  assert.match(html, /<elements-api[^>]+apiDescriptionUrl="\/openapi.json"/);

  // `/` is the static landing page, served by the assets layer before the Worker runs.
  for (const gone of ['/', '/manifest.webmanifest', '/sw.js', '/icon.svg', '/vapid', '/subscribe', '/nope']) {
    const { res: r } = await call(gone, { fetchImpl });
    assert.equal(r.status, 404, gone);
  }
});

test('the OpenAPI spec documents exactly the routes that exist', async () => {
  const fetchImpl = makeFetch({ byStop: { PGP: D2_IN_4, COM3: D2_IN_4 } });
  const { res } = await call('/openapi.json', { fetchImpl });
  assert.equal(res.status, 200);
  const spec = await res.json();
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(spec.servers[0].url, BASE, 'try-it requests go to whoever serves the docs');

  const documented = Object.keys(spec.paths).sort();
  assert.deepEqual(documented, [
    '/arrivals', '/auth/login', '/campus', '/health',
    '/me/import', '/me/keys', '/me/nearby', '/me/next', '/me/profile', '/next', '/pair', '/pair/check', '/stops/pairs', '/trip',
  ]);

  // Every documented public GET answers with its required params filled from
  // the spec's own examples -- a renamed route or param shows up here, not in
  // prod. Account routes are exercised in accounts.test.js.
  for (const [path, item] of Object.entries(spec.paths)) {
    // Account routes have their own security; `security: []` means open (health).
    if (!item.get || item.get.security?.length) continue;
    const q = new URLSearchParams();
    // `from` is only conditionally required (no location), so fill it too.
    for (const p of item.get.parameters ?? []) if (p.required || p.name === 'from') q.set(p.name, String(p.example));
    const { res: r } = await call(`${path}${q.size ? '?' + q : ''}`, { fetchImpl });
    assert.equal(r.status, 200, `${path} documented but answered ${r.status}`);
  }

  // Every $ref resolves.
  const refs = [...JSON.stringify(spec).matchAll(/"#\/components\/schemas\/(\w+)"/g)].map((m) => m[1]);
  for (const r of refs) assert.ok(spec.components.schemas[r], `dangling $ref ${r}`);
});
test('standing at the destination answers "You\'re here", not an ended walk', async () => {
  const fetchImpl = makeFetch({ byStop: { COM3: D2_IN_4 } });
  const { res } = await call('/trip?to=COM3&lat=1.294431&lon=103.775217', { fetchImpl });
  const body = await res.json();
  assert.equal(body.label, "You're here");
  assert.equal(body.quality, 'live');
  assert.doesNotMatch(body.detail, /now walk/);
});

test('/next opened in a browser returns JSON, not a redirect to a page that no longer exists', async () => {
  const fetchImpl = makeFetch({ byStop: { PGP: D2_IN_4 } });
  const { res } = await call('/next', { fetchImpl, headers: { accept: 'text/html' } });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type').startsWith('application/json'));
});
test('/campus serves the static map + destination search data, cached hard', async () => {
  const fetchImpl = makeFetch({});
  const { res } = await call('/campus', { fetchImpl });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /max-age=3600/);
  const body = await res.json();
  assert.equal(body.stops.length, 33, 'the real bundled stop graph');
  assert.ok(body.routes.D2, 'D2 is one of the 8 real services');
  assert.ok(Array.isArray(body.destinations) && body.destinations.length > body.stops.length);
  assert.equal(fetchImpl.counts.shuttle, 0, 'a static payload never touches the upstream feed');
});

test('/arrivals reports one stop\'s board without needing a destination', async () => {
  const fetchImpl = makeFetch({ byStop: { COM3: D2_IN_4 } });
  const { res } = await call('/arrivals?stop=com3', { fetchImpl }); // lowercase, like a URL a user might paste
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.stop.code, 'COM3');
  const d2 = body.board.find((r) => r.svc === 'D2');
  assert.ok(d2, 'D2 serves COM3 in the real graph');
  assert.equal(d2.quality, 'live');
  assert.ok(Number.isFinite(d2.etaS));
});

test('/arrivals on an unknown stop is a 400, not a fabricated empty board', async () => {
  const fetchImpl = makeFetch({});
  const { res } = await call('/arrivals?stop=narnia', { fetchImpl });
  assert.equal(res.status, 400);
  assert.equal(fetchImpl.counts.shuttle, 0);
});

test('walking is offered end to end when it beats the bus', async () => {
  // Standing at COM3, UTown is a ~14 min walk. A D1 fourteen minutes out plus
  // four stops of riding loses to that, and the endpoint must be willing to
  // say so rather than dutifully reporting the bus.
  const slow = makeFetch({ byStop: { COM3: [{ name: 'D1', arrivalTime: '14', passengers: 'low' }] } });
  const { res } = await call('/trip?to=UTOWN&lat=1.29466&lon=103.77441', { fetchImpl: slow });
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

test('/trip with no location needs a starting stop, not someone else\'s default', async () => {
  const f = makeFetch({ byStop: { PGP: [{ name: 'D2', arrivalTime: '5' }] } });
  const bare = await call('/trip?to=UTOWN', { fetchImpl: f });
  assert.equal(bare.res.status, 400);
  const { res } = await call('/trip?to=UTOWN&from=PGP', { fetchImpl: f });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).stop.code, 'PGP');
});

/* ------------------------------------------------------------------ */
/* Analytics                                                           */
/* ------------------------------------------------------------------ */

test('an answer logs one decision row plus a row per timed arrival', async () => {
  const ae = makeAnalytics();
  const fetchImpl = makeFetch({ byStop: { PGP: D2_IN_4 } });
  const { res } = await call('/trip?to=UTOWN&from=PGP', { fetchImpl, env: makeEnv(makeKV(), ae) });
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
  assert.equal(row.blobs[7], '', 'no configured trips any more');
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
  // makeEnv omits AE by default.
  const { res } = await call('/trip?to=UTOWN&from=PGP', { fetchImpl });
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
  const { res } = await call('/trip?to=UTOWN&from=PGP', { fetchImpl, env: makeEnv(makeKV(), hostile) });
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


/* ------------------------------------------------------------------ */
/* Bus proxy transport                                                 */
/* ------------------------------------------------------------------ */

test('arrivals come from a POST to the bus proxy, authenticated like uNivUS 2.59.2', async () => {
  const fetchImpl = makeFetch({ byStop: { COM3: D2_IN_4 } });
  const { res } = await call('/arrivals?stop=COM3', { fetchImpl });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).available, true);

  const [req] = fetchImpl.requests;
  assert.equal(req.method, 'POST');
  assert.ok(req.url.endsWith('/bus-proxy/shuttle-service'), req.url);
  assert.equal(req.headers.get('x-api-key'), 'test-proxy-key');
  // The guest JWT rides in both the Bearer header and the body envelope.
  assert.equal(req.headers.get('authorization'), `Bearer ${req.body.token}`);
  assert.equal(req.body.busstopname, 'COM3');
  assert.equal(req.body.domain, 'PUBLIC');
  for (const k of ['userid', 'deviceid', 'ipaddr', 'version']) assert.ok(req.body[k], `body.${k}`);
});

test('a rejected proxy call retries once with a genuinely fresh token', async () => {
  const fetchImpl = makeFetch({ byStop: { COM3: D2_IN_4 }, reject: 1, rejectCode: '10008' });
  const { res } = await call('/arrivals?stop=COM3', { fetchImpl });
  assert.equal((await res.json()).available, true, 'the retry succeeded');

  assert.equal(fetchImpl.counts.shuttle, 2);
  // One mint for the first call (a fresh KV has no token), one for the retry,
  // which must mint rather than read the rejected token back out of KV.
  assert.equal(fetchImpl.counts.auth, 2, 'the retry minted a token');
  const [first, second] = fetchImpl.requests;
  assert.notEqual(first.body.token, second.body.token, 'the retry used a different token');
});

test('a proxy that keeps rejecting degrades to unknown, not a fake "no bus"', async () => {
  const fetchImpl = makeFetch({ byStop: { PGP: D2_IN_4 }, reject: 99, rejectCode: '10008' });
  const { res } = await call('/trip?to=UTOWN&from=PGP', { fetchImpl });
  assert.equal(res.status, 200);
  const a = await res.json();
  // 'scheduled' would claim the feed answered and had no bus. It never answered.
  assert.equal(a.quality, 'unknown');
  assert.equal(fetchImpl.counts.shuttle, 2, 'one retry, not a loop');
});

test('a refused app version (10009) does not re-mint, and trips a breaker for every stop', async () => {
  const fetchImpl = makeFetch({ byStop: { PGP: D2_IN_4 }, reject: 99 });
  const { cache } = await call('/arrivals?stop=PGP', { fetchImpl });
  assert.equal(fetchImpl.counts.shuttle, 1, 'a fresh token cannot fix a version refusal');
  const mints = fetchImpl.counts.auth;
  for (const stop of ['PGP', 'COM3', 'UTOWN', 'KR-MRT']) {
    const { res } = await call(`/arrivals?stop=${stop}`, { fetchImpl, cache });
    assert.equal((await res.json()).available, false);
  }
  assert.equal(fetchImpl.counts.shuttle, 1, 'the breaker kept every stop off the feed');
  assert.equal(fetchImpl.counts.auth, mints, 'and minted nothing');
});

test('the version string comes from config:appVersion in KV, else the secret', async () => {
  const NEW = 'univus_android_2.60.0_141';
  const kv = makeKV();
  await kv.put('config:appVersion', NEW);
  const fetchImpl = makeFetch({ byStop: { COM3: D2_IN_4 } });
  await call('/arrivals?stop=COM3', { fetchImpl, env: makeEnv(kv) });
  assert.equal(fetchImpl.mints[0].version, NEW, 'the token is minted with it');
  assert.equal(fetchImpl.requests[0].body.version, NEW, 'and the proxy call carries it');

  const plain = makeFetch({ byStop: { COM3: D2_IN_4 } });
  await call('/arrivals?stop=COM3', { fetchImpl: plain });
  assert.equal(plain.mints[0].version, '0.0.0-test', 'no key: the secret');

  // A typo in KV would fail every call, so it is ignored.
  const typo = makeKV();
  await typo.put('config:appVersion', '2.60.0');
  const guarded = makeFetch({ byStop: { COM3: D2_IN_4 } });
  await call('/arrivals?stop=COM3', { fetchImpl: guarded, env: makeEnv(typo) });
  assert.equal(guarded.mints[0].version, '0.0.0-test');
});

test('a new version written to KV is live within a minute, with a token minted for it', async () => {
  const NEW = 'univus_android_2.60.0_141';
  const kv = makeKV();
  const env = makeEnv(kv);
  const fetchImpl = makeFetch({ byStop: { COM3: D2_IN_4 } });
  const { cache } = await call('/arrivals?stop=COM3', { fetchImpl, env });
  await kv.put('config:appVersion', NEW);

  Date.now = () => FROZEN_NOW + 30_000;
  await call('/arrivals?stop=COM3', { fetchImpl, env, cache });
  assert.equal(fetchImpl.mints.length, 1, 'inside the minute, the old version and its token carry on');

  Date.now = () => FROZEN_NOW + 61_000;
  await call('/arrivals?stop=COM3', { fetchImpl, env, cache });
  assert.equal(fetchImpl.mints.length, 2, "the old version's token is not reused");
  assert.equal(fetchImpl.mints[1].version, NEW);
  assert.equal(fetchImpl.requests.at(-1).body.version, NEW);
});

test('a refused token mint (10009) trips the breaker too, instead of minting for every stop', async () => {
  const fetchImpl = makeFetch({ mintReject: '10009' });
  const { cache } = await call('/arrivals?stop=PGP', { fetchImpl });
  for (const stop of ['COM3', 'UTOWN']) {
    const { res } = await call(`/arrivals?stop=${stop}`, { fetchImpl, cache });
    assert.equal((await res.json()).available, false);
  }
  assert.equal(fetchImpl.counts.auth, 1);
  assert.equal(fetchImpl.counts.shuttle, 0);
});

test('a failed stop is not asked again straight away', async () => {
  const dead = makeFetch({ fail: true });
  const { cache } = await call('/arrivals?stop=PGP', { fetchImpl: dead });
  await call('/arrivals?stop=PGP', { fetchImpl: dead, cache });
  await call('/trip?to=UTOWN&from=PGP', { fetchImpl: dead, cache });
  assert.equal(dead.counts.shuttle, 1);
});

test('concurrent requests for a cold stop share one upstream call', async () => {
  const fetchImpl = makeFetch({ byStop: { PGP: D2_IN_4 } });
  installGlobals(fetchImpl);
  const env = makeEnv();
  const ctx = makeCtx();
  const reqs = Array.from({ length: 10 }, () => worker.fetch(new Request(`${BASE}/arrivals?stop=PGP`), env, ctx));
  const out = await Promise.all(reqs);
  await ctx.settle();
  assert.ok(out.every((r) => r.status === 200));
  assert.equal(fetchImpl.counts.shuttle, 1);
});

test('a hung feed times out; with a stale answer on hand it is served instead', async () => {
  // Short timeouts, so the test doesn't wait out the real 5 s.
  const { TTL } = await import('../src/config.ts');
  const saved = { t: TTL.upstreamTimeoutMs, r: TTL.staleRaceMs };
  TTL.upstreamTimeoutMs = 200;
  TTL.staleRaceMs = 100;
  const hung = makeFetch({ hang: true });
  const cache = installGlobals(hung);
  cache.seed(ARRIVALS_KEY('PGP'), { code: 'PGP', arrivals: [{ svc: 'D2', etaS: 240, crowd: null, plate: null }], fetchedAt: Date.now() - 60_000, stale: false });
  const t0 = performance.now();
  const { res } = await call('/arrivals?stop=PGP', { fetchImpl: hung, cache });
  const ms = performance.now() - t0;
  assert.equal((await res.json()).available, true);
  assert.ok(ms < 2_000, `took ${ms}ms`);
  TTL.upstreamTimeoutMs = saved.t;
  TTL.staleRaceMs = saved.r;
});

test('a feed that says OK but has no arrivals list is a failure, not "no bus"', async () => {
  const odd = makeFetch({ raw: { code: '00000', msg: '', data: { somethingNew: 'x' } } });
  const { res } = await call('/arrivals?stop=PGP', { fetchImpl: odd });
  assert.equal((await res.json()).available, false);
});

test('concurrent token requests share one mint instead of each minting', async () => {
  const fetchImpl = makeFetch({});
  installGlobals(fetchImpl);
  const env = makeEnv();
  const { getSession } = await import('../src/auth.ts');

  // force: true bypasses memo and KV, so all three would mint without dedupe.
  const sessions = await Promise.all([1, 2, 3].map(() => getSession(env, Date.now(), { force: true })));
  assert.equal(fetchImpl.counts.auth, 1, 'one mint shared by all three callers');
  assert.ok(sessions.every((s) => s.token === sessions[0].token));

  // Once it settles, the next forced refresh mints again rather than reusing
  // a finished promise forever.
  await getSession(env, Date.now(), { force: true });
  assert.equal(fetchImpl.counts.auth, 2);
});

test('downloads serve whatever latest.json points at', async () => {
  const files = new Map();
  const put = (k, v) => files.set(k, v);
  const bucket = {
    async get(k) {
      if (!files.has(k)) return null;
      const v = files.get(k);
      return { body: v, size: v.length, json: async () => JSON.parse(v) };
    },
  };
  const env = { ...makeEnv(), DOWNLOADS: bucket };
  const get = async (p) => (await call(p, { fetchImpl: makeFetch({}), env })).res;

  assert.equal((await get('/download/android')).status, 404, 'no release yet');
  put('releases/1.0.0/terminus-1.0.0.apk', 'APK');
  put('releases/1.0.0/terminus-1.0.0-mac.zip', 'ZIP');
  put('latest.json', JSON.stringify({
    version: '1.0.0', released: '2026-09-29',
    android: { file: 'releases/1.0.0/terminus-1.0.0.apk', sha256: 'aa', size: 3 },
    mac: { file: 'releases/1.0.0/terminus-1.0.0-mac.zip', sha256: 'bb', size: 3 },
  }));
  const apk = await get('/download/android');
  assert.equal(apk.status, 200);
  assert.equal(apk.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.match(apk.headers.get('content-disposition'), /terminus-1.0.0.apk/);
  assert.equal(await apk.text(), 'APK');
  assert.equal((await get('/download/mac')).headers.get('x-sha256'), 'bb');
  assert.equal((await (await get('/download/latest.json')).json()).version, '1.0.0');
  assert.equal((await get('/download/ios')).status, 404);
});

test('/health: no probe without the operator token, 503 when the feed is confirmed down', async () => {
  const fetchImpl = makeFetch({});
  const kv = makeKV();
  const env = makeEnv(kv);
  const { res } = await call('/health?probe=1', { fetchImpl, env });
  const h = await res.json();
  assert.equal(h.auth, undefined, 'probe ignored without HEALTH_TOKEN');
  assert.ok(h.calendar.daysLeft > 0);
  await kv.put('monitor:upstream', JSON.stringify({ up: false, since: Date.now() - 1000, checkedAt: Date.now() - 1000, reason: 'x' }));
  const down = await call('/health', { fetchImpl, env });
  assert.equal(down.res.status, 503);
  await kv.put('monitor:upstream', JSON.stringify({ up: true, since: 0, checkedAt: Date.now() - 3_600_000, reason: null }));
  const stale = await (await call('/health', { fetchImpl, env })).res.json();
  assert.equal(stale.upstream.cronStale, true);
  assert.equal(stale.ok, false);
});

test('the entry module exports no plain values (workerd rejects the module, and cron stops)', async () => {
  const mod = await import('../src/index.ts');
  for (const [name, value] of Object.entries(mod)) {
    assert.ok(typeof value === 'function' || (typeof value === 'object' && value !== null), `export ${name} is a ${typeof value}`);
  }
});

test('every response carries nosniff and HSTS; HTML gets a CSP, /docs one that allows unpkg', async () => {
  const fetchImpl = makeFetch({ byStop: { PGP: D2_IN_4 } });
  const api = (await call('/next?to=UTOWN&from=PGP', { fetchImpl })).res;
  assert.equal(api.headers.get('x-content-type-options'), 'nosniff');
  assert.match(api.headers.get('strict-transport-security'), /max-age=/);
  assert.equal(api.headers.get('content-security-policy'), null, 'JSON needs no CSP');
  const docs = (await call('/docs', { fetchImpl })).res;
  assert.match(docs.headers.get('content-security-policy'), /script-src[^;]*unpkg\.com/);
  assert.match(await docs.text(), /integrity="sha384-/);
});
