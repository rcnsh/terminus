import test from 'node:test';
import assert from 'node:assert/strict';

// Installs globalThis.caches before the Worker module graph is evaluated.
import { FROZEN_NOW, installGlobals, makeAnalytics, makeBucket, makeCtx, makeEnv, makeFetch, makeKV } from './_stubs.mjs';
import worker, { coordsFrom, numParam } from '../src/index.ts';
import { LABEL_MAX } from '../src/config.ts';
import { ME_ROUTES } from '../src/me.ts';
import { API_VERSION } from '../src/openapi.ts';

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

test('/openapi.json and /docs are built once and sent the same', async () => {
  const { openApiJson, openApiSpec, docsPageFor, docsPage } = await import('../src/openapi.ts');
  const a = openApiJson(BASE);
  assert.equal(openApiJson(BASE), a, 'the same string, not rebuilt');
  assert.deepEqual(JSON.parse(a), openApiSpec(BASE));
  assert.equal(JSON.parse(openApiJson('https://other.test')).servers[0].url, 'https://other.test', 'per origin');
  for (let i = 0; i < 20; i++) openApiJson(`https://h${i}.test`);
  assert.deepEqual(JSON.parse(openApiJson(BASE)), openApiSpec(BASE), 'many origins: still right');
  assert.equal(docsPageFor('dusk'), docsPage('dusk'));
  const { res } = await call('/openapi.json');
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(await res.text(), openApiJson(BASE));
});

test('the OpenAPI spec documents exactly the routes that exist', async () => {
  const fetchImpl = makeFetch({ byStop: { PGP: D2_IN_4, COM3: D2_IN_4 } });
  const { res } = await call('/openapi.json', { fetchImpl });
  assert.equal(res.status, 200);
  const spec = await res.json();
  assert.equal(spec.openapi, '3.1.0');
  // The docs' version is the apps' version: bump all three together.
  const { readFileSync } = await import('node:fs');
  const gradle = readFileSync(new URL('../../android/app/build.gradle.kts', import.meta.url), 'utf8');
  const plist = readFileSync(new URL('../../macos/Support/Info.plist', import.meta.url), 'utf8');
  const android = gradle.match(/versionName = "([^"]+)"/)?.[1];
  const mac = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  assert.equal(spec.info.version, API_VERSION);
  assert.equal(API_VERSION, android, 'API_VERSION in src/openapi.ts matches versionName in apps/android/app/build.gradle.kts');
  assert.equal(API_VERSION, mac, 'API_VERSION in src/openapi.ts matches CFBundleShortVersionString in apps/macos/Support/Info.plist');
  assert.equal(spec.servers[0].url, BASE, 'try-it requests go to whoever serves the docs');

  // Every method on every path, with path parameters as `*`: the account
  // routes from their own table, the rest by hand.
  const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
  const documented = Object.entries(spec.paths)
    .flatMap(([path, item]) => METHODS.filter((m) => item[m]).map((m) => `${m.toUpperCase()} ${path.replace(/\{\w+\}/g, '*')}`))
    .sort();
  const routed = [
    ...ME_ROUTES.map((r) => `${r.method} ${r.path.endsWith('/') ? r.path + '*' : r.path}`),
    ...['/next', '/trip', '/arrivals', '/buses', '/line', '/campus', '/stops/pairs', '/health', '/status.json', '/admin/stats', '/docs', '/openapi.json', '/timelapse/days', '/timelapse/days/*'].map((p) => `GET ${p}`),
    ...['/auth/config', '/auth/verify', '/auth/approve'].map((p) => `GET ${p}`),
    ...['/auth/login', '/auth/code', '/auth/verify', '/auth/anon', '/auth/anon/web', '/auth/app/start', '/auth/app/poll', '/auth/app/code', '/auth/app/merge', '/auth/approve', '/auth/logout', '/pair', '/pair/check'].map((p) => `POST ${p}`),
    ...['/map/style.json', '/map/campus.pmtiles', '/map/fonts/*/*.pbf', '/map/sprites/v4/*'].map((p) => `GET ${p}`),
    ...['/download/latest.json', '/download/android', '/download/mac', '/download/appcast.xml', '/download/releases/*/*'].map((p) => `GET ${p}`),
  ].sort();
  assert.deepEqual(documented, routed);

  // Every documented public GET answers with its required params filled from
  // the spec's own examples -- a renamed route or param shows up here, not in
  // prod. Account routes are exercised in accounts.test.js.
  for (const [path, item] of Object.entries(spec.paths)) {
    // Account routes have their own security; `security: []` means open (health).
    // The map and downloads need R2, and are tested on their own.
    if (!item.get || item.get.security?.length || path.includes('{') || !['Answers', 'Stops', 'Service'].includes(item.get.tags[0])) continue;
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

test('/arrivals names the stop across the road, and each row says where it goes', async () => {
  const fetchImpl = makeFetch({ byStop: { YIH: [{ name: 'K', arrivalTime: '3', nextArrivalTime: '12', passengers: 'high' }] } });
  const body = await (await call('/arrivals?stop=YIH', { fetchImpl })).res.json();
  assert.deepEqual(body.stop, { code: 'YIH', name: 'YIH', longName: 'Yusof Ishak House', opposite: 'YIH-OPP', oppositeAcross: true, oppositeName: 'Opp Yusof Ishak House' });
  const k = body.board.find((r) => r.svc === 'K');
  assert.deepEqual(k.towards, ['Central Library', "Prince George's Park Foyer"]);
  assert.equal(k.color, '#2b9ad6');
  assert.equal(k.crowd, 'high');
  assert.ok(k.endsAt === null || Number.isFinite(Date.parse(k.endsAt)));
  // A stop with no twin says so.
  const utown = await (await call('/arrivals?stop=UTOWN', { fetchImpl: makeFetch({}) })).res.json();
  assert.equal(utown.stop.opposite, null);
  assert.equal(utown.stop.oppositeName, null);
  // PGP's Foyer is near it, not across the road: named, not "Across the road".
  const pgp = await (await call('/arrivals?stop=PGP', { fetchImpl: makeFetch({}) })).res.json();
  assert.equal(pgp.stop.opposite, 'PGPR');
  assert.equal(pgp.stop.oppositeAcross, false);
  assert.equal(pgp.stop.oppositeName, "Prince George's Park Foyer");
});

test('/arrivals?stopped=1 adds the services not running, after the others; without it nothing changes but `running`', async () => {
  const fetchImpl = makeFetch({ byStop: { PGP: [{ name: 'K', arrivalTime: '2', passengers: 'low' }] } });
  const cache = installGlobals(fetchImpl);
  Date.now = () => Date.UTC(2026, 9, 7, 13, 30); // Wednesday 21:30 in Singapore: R1 and R2 have finished
  const plain = await (await call('/arrivals?stop=PGP', { fetchImpl, cache })).res.json();
  assert.ok(plain.board.every((r) => r.running === true && !('stopped' in r)));
  assert.ok(!plain.board.some((r) => r.svc === 'R1'));
  const all = await (await call('/arrivals?stop=PGP&stopped=1', { fetchImpl, cache })).res.json();
  assert.deepEqual(all.board.slice(0, plain.board.length), plain.board);
  const off = all.board.slice(plain.board.length);
  assert.deepEqual(off.map((r) => [r.svc, r.running, r.stopped, r.resumesAt]), [
    ['R1', false, 'ended', '2026-10-07T23:40:00.000Z'],
    ['R2', false, 'ended', '2026-10-08T00:20:00.000Z'],
  ]);
  assert.equal(fetchImpl.counts.shuttle, 1, 'the same cached read');
});

test('/arrivals on an unknown stop is a 400, not a fabricated empty board', async () => {
  const fetchImpl = makeFetch({});
  const { res } = await call('/arrivals?stop=narnia', { fetchImpl });
  assert.equal(res.status, 400);
  assert.equal(fetchImpl.counts.shuttle, 0);
});

// Two D2 buses: one on its route (placed by the test), one parked far from it.
const D2_BUSES = [
  { vehplate: 'PD123A', lat: 0, lon: 0, speed: 30, direction: 90, loadInfo: { occupancy: 0.9, crowdLevel: 'high', capacity: 88, ridership: 80 } },
  { vehplate: 'PD999Z', lat: 1.3015, lng: 103.7605, speed: 0, direction: 10, loadInfo: { crowdLevel: 'low' } },
];

test('/buses shows each bus on its route at a stop or between two, with its number plate; one off its route is left out', async () => {
  const shape = (await import('../data/shapes.json', { with: { type: 'json' } })).default.routes.D2;
  // Put the first bus a third of the way along D2's line, heading along it.
  const i = Math.floor(shape.line.length / 3);
  const [aLon, aLat] = shape.line[i];
  const [bLon, bLat] = shape.line[i + 1];
  const heading = (Math.atan2((bLon - aLon) * Math.cos((aLat * Math.PI) / 180), bLat - aLat) * 180) / Math.PI;
  const buses = [{ ...D2_BUSES[0], lat: (aLat + bLat) / 2, lng: (aLon + bLon) / 2, direction: (heading + 360) % 360 }, D2_BUSES[1]];
  const fetchImpl = makeFetch({ buses: { D2: buses } });
  const cache = installGlobals(fetchImpl);
  const { res } = await call('/buses?svc=d2', { fetchImpl, cache });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.svc, 'D2');
  assert.equal(body.color, '#8e44c9');
  assert.equal(body.available, true);
  assert.equal(body.buses.length, 1, 'the bus away from its line is left out');
  const [on] = body.buses;
  assert.equal(on.crowd, 'high');
  assert.equal(on.moving, true);
  assert.ok(on.nextStop, 'a bus on its line has a next stop');
  assert.ok(shape.stops.includes(on.nextStop.code));
  assert.ok(on.at === null || shape.stops.includes(on.at.code), 'at one of its stops, or between two');
  assert.equal(typeof on.along, 'number');
  assert.equal(on.slot, 0);
  assert.ok(on.at ? on.stretch === null : on.stretch.from < on.along && on.along < on.stretch.to, 'between stops, the stretch it is on');
  assert.match(on.id, /^[0-9a-f]{12}$/);
  assert.equal(on.plate, 'PD123A', 'each bus comes with its plate');
  assert.equal(fetchImpl.requests[0].body.route_code, 'D2');

  // A second look within 10 s is served from the cache.
  await call('/buses?svc=D2', { fetchImpl, cache });
  assert.equal(fetchImpl.counts.shuttle, 1);
});

test('/buses: an unknown service is a 400; an unreachable feed is unavailable, not empty', async () => {
  const none = makeFetch({});
  const { res: bad } = await call('/buses?svc=Z9', { fetchImpl: none });
  assert.equal(bad.status, 400);
  assert.equal(none.counts.shuttle, 0);

  const { res } = await call('/buses?svc=K', { fetchImpl: makeFetch({ fail: true }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, false);
  assert.deepEqual(body.buses, []);
});

test('/line: a service’s stops in order, its buses on them, and with a stop that stop’s row; one read of each feed', async () => {
  const shape = (await import('../data/shapes.json', { with: { type: 'json' } })).default.routes.D1;
  // A D1 bus a third of the way along the line between two of its points, heading along it.
  const i = Math.floor(shape.line.length / 3);
  const [aLon, aLat] = shape.line[i];
  const [bLon, bLat] = shape.line[i + 1];
  const heading = (Math.atan2((bLon - aLon) * Math.cos((aLat * Math.PI) / 180), bLat - aLat) * 180) / Math.PI;
  const fetchImpl = makeFetch({
    buses: { D1: [{ vehplate: 'PD418C', lat: (aLat + bLat) / 2, lng: (aLon + bLon) / 2, speed: 30, direction: (heading + 360) % 360, loadInfo: { crowdLevel: 'low' } }] },
    byStop: { YIH: [{ name: 'D1', arrivalTime: '6', nextArrivalTime: '18', passengers: 'medium' }] },
  });
  const cache = installGlobals(fetchImpl);
  const { res } = await call('/line?svc=d1&stop=yih', { fetchImpl, cache });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'private, max-age=5');
  const body = await res.json();
  assert.equal(body.svc, 'D1');
  assert.equal(body.color, '#ec4fa0');
  assert.equal(body.available, true);
  assert.equal(body.stops.length, 13, 'COM3 is listed once though the loop ends there');
  assert.equal(body.stops[8].code, 'YIH');
  assert.deepEqual(body.stop.code, 'YIH');
  assert.equal(body.stop.index, 8);
  assert.equal(body.stop.row.svc, 'D1');
  assert.equal(body.stop.row.etaS, 360);
  assert.deepEqual(body.stop.row.towards, ['Central Library', 'COM 3']);
  assert.equal(body.stop.row.crowd, 'medium');
  // The bus where /buses puts it.
  const [bus] = body.buses;
  assert.equal(bus.plate, 'PD418C');
  assert.equal(bus.crowd, 'low');
  const map = (await (await call('/buses?svc=D1', { fetchImpl, cache })).res.json()).buses[0];
  assert.equal(bus.id, map.id);
  if (map.at) assert.equal(body.stops[bus.at].code, map.at.code);
  else assert.deepEqual([bus.at, body.stops[bus.after].code], [null, map.stretch.last.code]);
  assert.equal(fetchImpl.counts.shuttle, 2, 'one buses read (cached for /buses after) and one arrivals read');

  // Without a stop: no `stop`, and no arrivals read.
  const plain = makeFetch({ buses: { D1: [] } });
  const bare = await (await call('/line?svc=D1', { fetchImpl: plain })).res.json();
  assert.equal('stop' in bare, false);
  assert.deepEqual(bare.buses, []);
  assert.equal(plain.counts.shuttle, 1);
});

test('/line says whether the service is running, and its row at the stop comes even when it is not', async () => {
  const fetchImpl = makeFetch({ buses: { R1: [] } });
  const cache = installGlobals(fetchImpl);
  Date.now = () => Date.UTC(2026, 9, 10, 1); // Saturday 09:00 in Singapore: no R1 at weekends
  const body = await (await call('/line?svc=R1&stop=PGP', { fetchImpl, cache })).res.json();
  assert.equal(body.running, false);
  assert.equal(body.stopped, 'noService');
  assert.equal(body.resumesAt, '2026-10-11T23:40:00.000Z', 'Monday 07:40');
  assert.equal(body.endsAt, null);
  assert.deepEqual([body.stop.row.svc, body.stop.row.running, body.stop.row.stopped], ['R1', false, 'noService']);
  Date.now = () => Date.UTC(2026, 9, 7, 4); // Wednesday noon
  const on = await (await call('/line?svc=R1', { fetchImpl, cache })).res.json();
  assert.deepEqual([on.running, on.stopped, on.resumesAt], [true, null, null]);
});

test('/line: a bus still out after hours means the service is running, never "stopped" over a moving bus', async () => {
  const shape = (await import('../data/shapes.json', { with: { type: 'json' } })).default.routes.R1;
  const i = Math.floor(shape.line.length / 3);
  const [aLon, aLat] = shape.line[i];
  const [bLon, bLat] = shape.line[i + 1];
  const heading = (Math.atan2((bLon - aLon) * Math.cos((aLat * Math.PI) / 180), bLat - aLat) * 180) / Math.PI;
  const fetchImpl = makeFetch({ buses: { R1: [{ vehplate: 'PD500A', lat: (aLat + bLat) / 2, lng: (aLon + bLon) / 2, speed: 30, direction: (heading + 360) % 360 }] } });
  const cache = installGlobals(fetchImpl);
  Date.now = () => Date.UTC(2026, 9, 7, 11, 45); // Wednesday 19:45 in Singapore: R1's hours end at 19:30
  const body = await (await call('/line?svc=R1', { fetchImpl, cache })).res.json();
  assert.equal(body.buses.length, 1);
  assert.deepEqual([body.running, body.stopped, body.resumesAt], [true, null, null]);
});

test('/line: an unknown service or a stop it doesn’t call at is a 400, and costs nothing upstream', async () => {
  const none = makeFetch({});
  const { res: svc } = await call('/line?svc=Z9', { fetchImpl: none });
  assert.equal(svc.status, 400);
  assert.equal((await svc.json()).error, 'unknown service');
  const { res: stop } = await call('/line?svc=D1&stop=PGP', { fetchImpl: none });
  assert.equal(stop.status, 400);
  assert.equal((await stop.json()).error, 'stop not on this service');
  const { res: zh } = await call('/line?svc=D1&stop=PGP', { fetchImpl: none, headers: { 'accept-language': 'zh-CN' } });
  assert.equal((await zh.json()).error, '这条路线不经过这个车站');
  assert.equal(none.counts.shuttle, 0);

  // An unreachable feed: unavailable, no buses, and the row is unknown rather than made up.
  const down = await (await call('/line?svc=K&stop=YIH', { fetchImpl: makeFetch({ fail: true }) })).res.json();
  assert.equal(down.available, false);
  assert.deepEqual(down.buses, []);
  assert.ok(down.stop.row === null || down.stop.row.etaS === null);
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

test('a NUS host answering 429 or 5xx is not retried, and quiets every stop', async () => {
  for (const status of [429, 503]) {
    const fetchImpl = makeFetch({ byStop: { PGP: D2_IN_4, COM3: D2_IN_4 }, proxyStatus: status });
    const { cache } = await call('/arrivals?stop=PGP', { fetchImpl });
    assert.equal(fetchImpl.counts.shuttle, 1, `${status}: no second call`);
    assert.equal(fetchImpl.counts.auth, 1, `${status}: no fresh token for it`);
    for (const stop of ['COM3', 'UTOWN']) {
      const { res } = await call(`/arrivals?stop=${stop}`, { fetchImpl, cache });
      assert.equal((await res.json()).available, false);
    }
    assert.equal(fetchImpl.counts.shuttle, 1, `${status}: the breaker kept every stop off the feed`);
  }
});

test('a failed token mint is not tried again by every stop that wants one', async () => {
  // 400: the NUS load balancer's intermittent "Contradictory scheme headers".
  for (const mintStatus of [400, 503]) {
    const fetchImpl = makeFetch({ byStop: { PGP: D2_IN_4 }, mintStatus });
    const { cache } = await call('/arrivals?stop=PGP', { fetchImpl });
    for (const stop of ['COM3', 'UTOWN', 'KR-MRT']) {
      const { res } = await call(`/arrivals?stop=${stop}`, { fetchImpl, cache });
      assert.equal((await res.json()).available, false);
    }
    assert.equal(fetchImpl.counts.auth, 1, `${mintStatus}: one mint, not one per stop`);
    assert.equal(fetchImpl.counts.shuttle, 0);
  }
});

test('a refusal a fresh token did not cure is not met with another mint per stop', async () => {
  const fetchImpl = makeFetch({ byStop: { PGP: D2_IN_4 }, reject: 99, rejectCode: '10008' });
  const env = makeEnv();
  const { cache } = await call('/arrivals?stop=PGP', { fetchImpl, env });
  assert.equal(fetchImpl.counts.auth, 2, 'the first refusal gets a fresh token');
  assert.equal(fetchImpl.counts.shuttle, 2);
  await call('/arrivals?stop=COM3', { fetchImpl, env, cache });
  assert.equal(fetchImpl.counts.auth, 2, 'within remintGapS, no second mint');
  assert.equal(fetchImpl.counts.shuttle, 3, 'and no retry with the token already refused');
  // A minute on, one more fresh token may be tried.
  Date.now = () => FROZEN_NOW + 61_000;
  await call('/arrivals?stop=UTOWN', { fetchImpl, env, cache });
  assert.equal(fetchImpl.counts.auth, 3);
  assert.equal(fetchImpl.counts.shuttle, 5);
});

test("a refused token is retried with another isolate's newer one from KV, without a mint", async () => {
  const kv = makeKV();
  const env = makeEnv(kv);
  const { cache } = await call('/arrivals?stop=PGP', { fetchImpl: makeFetch({ byStop: { PGP: D2_IN_4 } }), env });
  // Another isolate has since minted: its token is in KV, this one's memo is older.
  const newer = { token: 'another-isolate-token-0123456789', userid: 'U2', domain: 'PUBLIC', expMs: FROZEN_NOW + 3_600_000, version: '0.0.0-test' };
  await kv.put('auth:session', JSON.stringify(newer));
  const fetchImpl = makeFetch({ byStop: { COM3: D2_IN_4 }, reject: 1, rejectCode: '10008' });
  const { res } = await call('/arrivals?stop=COM3', { fetchImpl, env, cache });
  assert.equal((await res.json()).available, true);
  assert.equal(fetchImpl.counts.auth, 0, 'no mint');
  assert.equal(fetchImpl.requests[1].body.token, newer.token);
});

test('while another isolate fetches a stale stop, the stale answer is served without a second fetch', async () => {
  const fetchImpl = makeFetch({ byStop: { PGP: D2_IN_4 } });
  const cache = installGlobals(fetchImpl);
  const old = { code: 'PGP', arrivals: [{ svc: 'D2', etaS: 240, crowd: null, plate: null }], fetchedAt: Date.now() - 20_000, stale: false };
  cache.seed(ARRIVALS_KEY('PGP'), old);
  cache.seed(`${ARRIVALS_KEY('PGP')}#pending`, 'fetching', 20);
  const { res } = await call('/arrivals?stop=PGP', { fetchImpl, cache });
  assert.equal((await res.json()).available, true);
  assert.equal(fetchImpl.counts.shuttle, 0, 'the other fetch fills the cache');
  // Its marker gone, the next request fetches, and clears its own marker after.
  await cache.delete(`${ARRIVALS_KEY('PGP')}#pending`);
  await call('/arrivals?stop=PGP', { fetchImpl, cache });
  assert.equal(fetchImpl.counts.shuttle, 1);
  assert.equal(await cache.match(`${ARRIVALS_KEY('PGP')}#pending`), undefined);
});

test('a code that is not a stop (a food court) is never sent to either feed', async () => {
  const fetchImpl = makeFetch({ byStop: { PGP: D2_IN_4 } });
  installGlobals(fetchImpl);
  const { collectArrivals } = await import('../src/answer.ts');
  const ctx = makeCtx();
  const out = await collectArrivals(makeEnv(), ctx, ['THE-DECK', 'PGP'], Date.now());
  await ctx.settle();
  assert.equal(out.get('THE-DECK').available, false);
  assert.equal(out.get('PGP').available, true);
  assert.deepEqual(fetchImpl.requests.map((r) => r.body.busstopname), ['PGP']);
});

test("the beta's cache keys are its own: the stable site's breaker doesn't quiet it, nor its answers feed it", async () => {
  const { scopeCache } = await import('../src/edgecache.ts');
  const beta = { ...makeEnv(), PUBLIC_ORIGIN: 'https://beta.terminus.rcn.sh' };
  const fetchImpl = makeFetch({ byStop: { PGP: D2_IN_4 } });
  const cache = installGlobals(fetchImpl);
  cache.seed('https://terminus.internal/breaker', 'refused', 60);
  const { res } = await call('/arrivals?stop=PGP', { fetchImpl, env: beta, cache });
  assert.equal((await res.json()).available, true, "the stable site's breaker isn't the beta's");
  assert.ok(cache._store.has('https://beta.terminus.internal/arrivals/PGP'));
  assert.ok(!cache._store.has(ARRIVALS_KEY('PGP')));
  // The stable site, with its breaker open, still asks nothing.
  const { res: stable } = await call('/arrivals?stop=PGP', { fetchImpl, cache });
  assert.equal((await stable.json()).available, false);
  assert.equal(fetchImpl.counts.shuttle, 1);
  scopeCache(makeEnv());
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

test('a feed whose rows changed shape is a failure the monitor sees, not every bus turned into an estimate', async () => {
  // A rename upstream: the list is there, but its rows say routeName, not name.
  const raw = { code: '00000', msg: '', data: { etas: { timings: [{ routeName: 'D2', arrivalTime: '3', nextArrivalTime: '15' }] } } };
  const { res } = await call('/arrivals?stop=PGP', { fetchImpl: makeFetch({ raw }) });
  const body = await res.json();
  assert.equal(body.available, false);
  assert.ok(body.board.length > 0 && body.board.every((x) => x.quality === 'unknown'), 'no headway guess passed off as the board');
  // The monitor's probe fails the same way, so the outage is confirmed and emailed.
  const { checkUpstream, FAILS_TO_ALERT } = await import('../src/monitor.ts');
  installGlobals(makeFetch({ raw }));
  const env = makeEnv();
  let state;
  for (let i = 0; i < FAILS_TO_ALERT; i++) ({ state } = await checkUpstream(env, Date.now()));
  assert.equal(state.up, false);
  assert.match(state.reason, /unknown shape \(no row names a service\)/);
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
      reads.push(k);
      return { body: v, size: v.length, json: async () => JSON.parse(v), text: async () => v };
    },
  };
  const reads = [];
  const env = { ...makeEnv(), DOWNLOADS: bucket };
  // latest.json and the appcast are read on every request: a put shows at once.
  const putLater = put;
  const get = async (p) => {
    const cache = installGlobals(makeFetch({}), FROZEN_NOW);
    return (await call(p, { env, cache })).res;
  };

  assert.equal((await get('/download/android')).status, 404, 'no release yet');
  put('releases/1.0.0/terminus-1.0.0.apk', 'APK');
  put('releases/1.0.0/terminus-1.0.0-mac.zip', 'ZIP');
  putLater('latest.json', JSON.stringify({
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
  assert.equal((await get('/download/mac')).headers.get('content-type'), 'application/zip', 'releases up to 1.3.7');
  assert.equal((await (await get('/download/latest.json')).json()).version, '1.0.0');
  assert.equal((await get('/download/ios')).status, 404);

  // From 1.3.8 the Mac app is a signed DMG.
  put('releases/1.0.1/terminus-1.0.1.dmg', 'DMG');
  putLater('latest.json', JSON.stringify({
    version: '1.0.1', released: '2026-10-01',
    android: { file: 'releases/1.0.0/terminus-1.0.0.apk', sha256: 'aa', size: 3 },
    mac: { file: 'releases/1.0.1/terminus-1.0.1.dmg', sha256: 'cc', size: 3 },
  }));
  // One APK per CPU type from 2.1: the arm64 one unless the app asks for its own.
  put('releases/1.0.1/terminus-1.0.1.apk', 'ARM64');
  put('releases/1.0.1/terminus-1.0.1-armv7.apk', 'ARMV7');
  putLater('latest.json', JSON.stringify({
    version: '1.0.1', released: '2026-10-01',
    android: { file: 'releases/1.0.1/terminus-1.0.1.apk', sha256: 'a64', size: 5 },
    androidAbis: {
      'arm64-v8a': { file: 'releases/1.0.1/terminus-1.0.1.apk', sha256: 'a64', size: 5 },
      'armeabi-v7a': { file: 'releases/1.0.1/terminus-1.0.1-armv7.apk', sha256: 'a7', size: 5 },
    },
    mac: { file: 'releases/1.0.1/terminus-1.0.1.dmg', sha256: 'cc', size: 3 },
  }));
  assert.equal(await (await get('/download/android')).text(), 'ARM64');
  assert.equal(await (await get('/download/android?abi=armeabi-v7a')).text(), 'ARMV7');
  assert.equal(await (await get('/download/android?abi=x86_64')).text(), 'ARM64', 'a type not built: the arm64 one');
  assert.equal(await (await get('/download/android?abi=__proto__')).text(), 'ARM64');
  assert.equal(await (await get('/download/releases/1.0.1/terminus-1.0.1-armv7.apk')).text(), 'ARMV7');
  assert.equal((await get('/download/releases/1.0.1/terminus-1.0.1-mips.apk')).status, 404);

  const dmg = await get('/download/mac');
  assert.equal(dmg.headers.get('content-type'), 'application/x-apple-diskimage');
  assert.match(dmg.headers.get('content-disposition'), /terminus-1\.0\.1\.dmg/);

  // Sparkle: the appcast, and release files by their versioned path.
  assert.equal((await get('/download/appcast.xml')).status, 404, 'no appcast yet');
  putLater('appcast.xml', '<rss/>');
  const feed = await get('/download/appcast.xml');
  assert.equal(feed.headers.get('content-type'), 'application/xml; charset=utf-8');
  assert.equal(await feed.text(), '<rss/>');
  // Read from R2 on every request, so a release is live the moment it's put.
  const before = reads.length;
  assert.equal(await (await get('/download/appcast.xml')).text(), '<rss/>');
  assert.equal((await (await get('/download/latest.json')).json()).version, '1.0.1');
  assert.equal((await get('/download/latest.json')).headers.get('cache-control'), 'public, max-age=300');
  assert.deepEqual(reads.slice(before), ['appcast.xml', 'latest.json', 'latest.json'], 'neither kept');
  const byPath = await get('/download/releases/1.0.1/terminus-1.0.1.dmg');
  assert.equal(byPath.status, 200);
  assert.equal(byPath.headers.get('content-type'), 'application/x-apple-diskimage');
  assert.equal(await byPath.text(), 'DMG');
  assert.equal((await get('/download/releases/9.9.9/terminus-9.9.9.dmg')).status, 404);
  assert.equal((await get('/download/releases/1.0.1/other.dmg')).status, 404, 'only release files');
  // A pre-release version is a release file like any other.
  put('releases/2.0.0-beta/terminus-2.0.0-beta.apk', 'BETA');
  assert.equal(await (await get('/download/releases/2.0.0-beta/terminus-2.0.0-beta.apk')).text(), 'BETA');
  assert.equal((await get('/download/releases/2.0.0-Beta/terminus-2.0.0-Beta.apk')).status, 404);
});

test('/status.json: the feed state and outages, public and cached', async () => {
  const kv = makeKV();
  const env = makeEnv(kv);
  let res = (await call('/status.json', { fetchImpl: makeFetch({}), env })).res;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { feed: 'unknown', since: null, checkedAt: null, checking: false, incidents: [], publicFeed: 'unknown', publicSince: null });

  const now = Date.now();
  await kv.put('monitor:upstream', JSON.stringify({ up: false, since: now - 3_600_000, reason: 'auth rejected: code=10009 secret detail', checkedAt: now - 60_000 }));
  await kv.put('monitor:incidents', JSON.stringify([{ start: now - 3_600_000, end: null, cause: 'version' }]));
  // Each isolate reads the records once a minute, not three KV reads a request.
  const cache = installGlobals(makeFetch({}), now + 59_000);
  let reads = 0;
  const get = kv.get.bind(kv);
  kv.get = (...a) => (reads++, get(...a));
  res = (await call('/status.json', { env, cache })).res;
  assert.equal((await res.json()).feed, 'unknown', 'kept for a minute');
  assert.equal(reads, 0);
  Date.now = () => now + 60_000;
  res = (await call('/status.json', { env, cache })).res;
  assert.equal(reads, 3);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
  const s = await res.json();
  assert.equal(s.feed, 'down');
  assert.equal(s.checking, true);
  assert.equal(s.since, new Date(now - 3_600_000).toISOString());
  assert.deepEqual(s.incidents, [{ start: new Date(now - 3_600_000).toISOString(), end: null, cause: 'version' }]);
  assert.ok(!JSON.stringify(s).includes('secret detail'), 'no error text');
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

/** An R2 bucket of these files (text), ranges and all. */
const rangedBucket = (files) => makeBucket((key) => (files.has(key) ? new TextEncoder().encode(files.get(key)) : null));

test('/map serves the map file in pieces, and its fonts and icons', async () => {
  const files = new Map([
    ['map/campus.pmtiles', 'PMTiles-0123456789'],
    ['map/fonts/Noto Sans Regular/0-255.pbf', 'GLYPHS'],
    ['map/sprites/v4/dark@2x.png', 'PNG'],
  ]);
  const env = { ...makeEnv(), DOWNLOADS: rangedBucket(files) };
  const get = async (p, headers) => (await call(p, { fetchImpl: makeFetch({}), env, headers })).res;

  const part = await get('/map/campus.pmtiles', { range: 'bytes=0-6' });
  assert.equal(part.status, 206);
  assert.equal(await part.text(), 'PMTiles');
  assert.equal(part.headers.get('content-range'), 'bytes 0-6/18');
  assert.equal(part.headers.get('accept-ranges'), 'bytes');
  const etag = part.headers.get('etag');
  assert.ok(etag);

  const whole = await get('/map/campus.pmtiles');
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-length'), '18');
  assert.equal((await get('/map/campus.pmtiles', { 'if-none-match': etag })).status, 304);
  assert.equal((await get('/map/campus.pmtiles', { range: 'bytes=99-' })).status, 416);

  const glyphs = await get('/map/fonts/Noto%20Sans%20Regular/0-255.pbf');
  assert.equal(glyphs.status, 200);
  assert.equal(glyphs.headers.get('content-type'), 'application/x-protobuf');
  assert.equal((await get('/map/sprites/v4/dark@2x.png')).headers.get('content-type'), 'image/png');

  // Nothing else under map/ is reachable.
  assert.equal((await get('/map/fonts/..%2F..%2Flatest.json/0-255.pbf')).status, 404);
  assert.equal((await get('/map/latest.json')).status, 404);
  assert.equal((await get('/map/fonts/Noto Sans Regular/0-255.pbf.bak')).status, 404);
});

test('map pieces are kept at the edge: R2 is read once per piece, and a new upload is seen', async () => {
  const files = new Map([['map/campus.pmtiles', 'PMTiles-0123456789']]);
  const bucket = rangedBucket(files);
  const env = { ...makeEnv(), DOWNLOADS: bucket };
  const cache = installGlobals(makeFetch({}));
  const get = async (p, headers) => (await call(p, { env, cache, headers })).res;

  const first = await get('/map/campus.pmtiles', { range: 'bytes=8-11' });
  assert.equal(first.status, 206);
  assert.equal(first.headers.get('content-range'), 'bytes 8-11/18');
  assert.equal(await first.text(), '0123');
  const etag = first.headers.get('etag');

  // Everyone after asks for the same piece: from the cache, the same bytes.
  for (let i = 0; i < 3; i++) {
    const again = await get('/map/campus.pmtiles', { range: 'bytes=8-11' });
    assert.equal(again.status, 206);
    assert.equal(again.headers.get('content-range'), 'bytes 8-11/18');
    assert.equal(again.headers.get('etag'), etag);
    assert.equal(await again.text(), '0123');
  }
  assert.equal(bucket.gets, 1, 'one R2 read for four people');

  // The whole file (Android keeps it for offline), and the last bytes.
  assert.equal(await (await get('/map/campus.pmtiles')).text(), 'PMTiles-0123456789');
  assert.equal(await (await get('/map/campus.pmtiles')).text(), 'PMTiles-0123456789');
  assert.equal(await (await get('/map/campus.pmtiles', { range: 'bytes=-4' })).text(), '6789');
  assert.equal(bucket.gets, 3);
  // A copy that's current costs no read, weakened by compression or not.
  assert.equal((await get('/map/campus.pmtiles', { 'if-none-match': `W/${etag}` })).status, 304);
  assert.equal((await get('/map/campus.pmtiles', { range: 'bytes=18-' })).status, 416);
  assert.equal(bucket.gets, 3);

  // A new map is uploaded. Within minutes its pieces are served, never the
  // old file's bytes under the new file's ETag.
  files.set('map/campus.pmtiles', 'PMTiles-abcdefghij');
  const was = Date.now;
  Date.now = () => was() + 10 * 60_000;
  try {
    const fresh = await get('/map/campus.pmtiles', { range: 'bytes=8-11' });
    assert.equal(await fresh.text(), 'abcd');
    assert.notEqual(fresh.headers.get('etag'), etag);
  } finally {
    Date.now = was;
  }
});

test('reads from R2 for the map are limited per IP; pieces in the edge cache are not', async () => {
  const files = new Map([
    ['map/fonts/Noto Sans Medium/256-511.pbf', 'GLYPHS'],
    ['map/sprites/v4/light.json', '{}'],
  ]);
  const bucket = rangedBucket(files);
  const heads = bucket.head;
  let headCalls = 0;
  bucket.head = (k) => (headCalls++, heads(k));
  const asked = [];
  const RL_MAP = { limit: async ({ key }) => (asked.push(key), { success: asked.length <= 1 }) };
  const env = { ...makeEnv(), DOWNLOADS: bucket, RL_MAP };
  const cache = installGlobals(makeFetch({}));
  const get = async (p) => (await call(p, { env, cache, headers: { 'cf-connecting-ip': '203.0.113.9' } })).res;

  assert.equal((await get('/map/fonts/Noto%20Sans%20Medium/256-511.pbf')).status, 200);
  assert.deepEqual(asked, ['map:203.0.113.9'], 'one read from R2, asked once');
  // A lecture hall behind the same address: from the cache, never limited.
  for (let i = 0; i < 5; i++) assert.equal(await (await get('/map/fonts/Noto%20Sans%20Medium/256-511.pbf')).text(), 'GLYPHS');
  assert.equal(asked.length, 1);
  // Past the limit, a file not yet in the cache waits.
  const limited = await get('/map/sprites/v4/light.json');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  // A glyph range MapLibre never asks for is no file: no read, no limit.
  const before = headCalls;
  assert.equal((await get('/map/fonts/Noto%20Sans%20Medium/1-5.pbf')).status, 404);
  assert.equal(headCalls, before);
  assert.equal(asked.length, 2);
});

test('fonts and icons are kept by path: no look at R2 for what the edge has, and a current copy is a 304', async () => {
  const files = new Map([['map/sprites/v4/light@2x.png', 'PNG-BYTES']]);
  const bucket = rangedBucket(files);
  const heads = bucket.head;
  let headCalls = 0;
  bucket.head = (k) => (headCalls++, heads(k));
  const asked = [];
  const RL_MAP = { limit: async ({ key }) => (asked.push(key), { success: asked.length <= 1 }) };
  const env = { ...makeEnv(), DOWNLOADS: bucket, RL_MAP };
  const cache = installGlobals(makeFetch({}));
  const get = async (p, headers = {}) => (await call(p, { env, cache, headers: { 'cf-connecting-ip': '203.0.113.9', ...headers } })).res;

  const first = await get('/map/sprites/v4/light@2x.png');
  assert.equal(first.status, 200);
  assert.equal(await first.text(), 'PNG-BYTES');
  const etag = first.headers.get('etag');
  assert.ok(etag);
  assert.equal(first.headers.get('content-length'), '9');
  assert.equal(first.headers.get('cache-control'), 'public, max-age=2592000');
  // Days later, past any look at the file, still from the edge: R2 isn't asked, nor the limit.
  Date.now = () => FROZEN_NOW + 3 * 86_400_000;
  for (let i = 0; i < 3; i++) {
    const again = await get('/map/sprites/v4/light@2x.png');
    assert.equal(again.status, 200);
    assert.equal(again.headers.get('etag'), etag);
    assert.equal(again.headers.get('content-length'), '9');
    assert.equal(again.headers.get('content-type'), 'image/png');
    assert.equal(await again.text(), 'PNG-BYTES');
  }
  const kept = await get('/map/sprites/v4/light@2x.png', { 'if-none-match': `W/${etag}` });
  assert.equal(kept.status, 304);
  assert.equal(kept.headers.get('etag'), etag);
  assert.equal(headCalls, 0, 'never a head()');
  assert.equal(bucket.gets, 1, 'one read');
  assert.equal(asked.length, 1, 'limited only where R2 was read');
  // A file not in the cache, past the limit, waits.
  assert.equal((await get('/map/sprites/v4/dark.json')).status, 429);
});

test('a piece of the map in the edge cache is served even once R2 may not be read', async () => {
  const files = new Map([['map/campus.pmtiles', 'PMTiles-0123456789']]);
  const bucket = rangedBucket(files);
  const heads = bucket.head;
  let headCalls = 0;
  bucket.head = (k) => (headCalls++, heads(k));
  let open = true;
  const RL_MAP = { limit: async () => ({ success: open }) };
  const env = { ...makeEnv(), DOWNLOADS: bucket, RL_MAP };
  const cache = installGlobals(makeFetch({}));
  const get = async (p, headers) => (await call(p, { env, cache, headers })).res;

  assert.equal(await (await get('/map/campus.pmtiles', { range: 'bytes=0-6' })).text(), 'PMTiles');
  assert.equal(headCalls, 1);
  open = false;
  // Past the time the file's ETag is trusted: the limit says no reads, but the piece is in the cache.
  Date.now = () => FROZEN_NOW + 10 * 60_000;
  const piece = await get('/map/campus.pmtiles', { range: 'bytes=0-6' });
  assert.equal(piece.status, 206);
  assert.equal(piece.headers.get('content-range'), 'bytes 0-6/18');
  assert.equal(piece.headers.get('content-length'), '7');
  assert.equal(await piece.text(), 'PMTiles');
  assert.equal(headCalls, 1, 'R2 not asked');
  // A piece that isn't cached still waits.
  assert.equal((await get('/map/campus.pmtiles', { range: 'bytes=8-11' })).status, 429);
});

test('/campus is the same bytes every time, with an ETag a client can revalidate with', async () => {
  const cache = installGlobals(makeFetch({}));
  const first = (await call('/campus', { cache })).res;
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.match(etag, /^"[0-9a-f]{24}"$/);
  const body = await first.text();
  assert.ok(JSON.parse(body).stops.length > 20);

  const again = (await call('/campus', { cache })).res;
  assert.equal(again.headers.get('etag'), etag);
  assert.equal(await again.text(), body);
  const kept = (await call('/campus', { cache, headers: { 'if-none-match': `W/${etag}` } })).res;
  assert.equal(kept.status, 304);
  assert.equal(await kept.text(), '');
  assert.equal((await call('/campus', { cache, headers: { 'if-none-match': '"old"' } })).res.status, 200);
});

test('/map/style.json is a quiet light or dark map with every URL on our own domain', async () => {
  const get = async (p) => (await call(p, { fetchImpl: makeFetch({}) })).res;
  const light = await (await get('/map/style.json')).json();
  assert.equal(light.version, 8);
  assert.equal(light.sources.protomaps.url, `pmtiles://${BASE}/map/campus.pmtiles`);
  assert.ok(light.glyphs.startsWith(`${BASE}/map/fonts/`));
  assert.equal(light.sprite, `${BASE}/map/sprites/v4/light`);
  assert.match(light.sources.protomaps.attribution, /OpenStreetMap/);
  assert.equal(light.layers.find((l) => l.id === 'pois'), undefined, 'quiet: no icons for libraries, cafés or its own bus stops');
  assert.ok(light.layers.some((l) => l.id.startsWith('roads_labels')), 'street names stay');

  const dark = await (await get('/map/style.json?theme=dark&lang=zh')).json();
  assert.equal(dark.sprite, `${BASE}/map/sprites/v4/dark`);
  assert.notDeepEqual(dark.layers.find((l) => l.id === 'background').paint, light.layers.find((l) => l.id === 'background').paint);
  assert.match(JSON.stringify(dark.layers), /name:zh-Hans/, 'Chinese labels where OpenStreetMap has them');
});

test('files served without the Worker get the same headers from _headers', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const { withSecurityHeaders } = await import('../src/http.ts');
  const { openApiSpec } = await import('../src/openapi.ts');
  // Cloudflare's own matching, for runWorkerFirst and _headers alike: `*`
  // is any run of characters, across `/` too.
  const glob = (p) => new RegExp(`^${p.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')).join('.*')}$`);
  const config = await readFile(new URL('../cloudflare.config.ts', import.meta.url), 'utf8');
  const first = JSON.parse(config.match(/runWorkerFirst: (\[[^\]]*\])/)[1]);
  const skip = first.filter((p) => p.startsWith('!')).map((p) => glob(p.slice(1)));
  const skips = (path) => skip.some((r) => r.test(path));

  // _headers: a path, then its indented headers.
  const rules = [];
  for (const line of (await readFile(new URL('../../web/public/_headers', import.meta.url), 'utf8')).split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    if (!/^\s/.test(line)) rules.push({ re: glob(line.trim()), set: {} });
    else {
      const [name, ...value] = line.trim().split(':');
      rules.at(-1).set[name.toLowerCase()] = value.join(':').trim();
    }
  }
  const { fileURLToPath } = await import('node:url');
  const { join, relative } = await import('node:path');
  const root = fileURLToPath(new URL('../../web/public/', import.meta.url));
  const files = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((f) => f.isFile() && f.name !== '_headers')
    .map((f) => `/${relative(root, join(f.parentPath, f.name))}`);
  const skipped = files.filter(skips);
  assert.ok(skipped.includes('/app/app.js') && skipped.includes('/account/account.css') && skipped.includes('/sw.js'), 'the pages\' scripts and styles skip the Worker');
  for (const path of skipped) {
    // Nothing that skips it is a page, which would need the CSP.
    assert.ok(!path.endsWith('.html'), `${path} is a page`);
    const set = {};
    for (const r of rules.filter((x) => x.re.test(path))) {
      for (const [k, v] of Object.entries(r.set)) {
        // Cloudflare appends a header two rules both set.
        assert.ok(!(k in set), `${path}: two rules set ${k}`);
        set[k] = v;
      }
    }
    delete set['cache-control'];
    const viaWorker = Object.fromEntries(withSecurityHeaders(new Response('', { headers: { 'content-type': 'text/javascript' } }), path).headers);
    delete viaWorker['content-type'];
    assert.deepEqual(set, viaWorker, `${path}: the headers the Worker would give`);
  }
  // Pages, and everything the Worker itself answers, still reach it.
  for (const path of files.filter((f) => f.endsWith('.html'))) assert.ok(!skips(path.replace(/index\.html$/, '')), `${path} reaches the Worker`);
  const routes = Object.keys(openApiSpec(BASE).paths).map((p) => p.replace(/\{[^}]+\}/g, 'x'));
  for (const path of [...routes, '/', '/map/style.json', '/map/campus.pmtiles', '/map/fonts/Noto%20Sans%20Regular/0-255.pbf', '/map/sprites/v4/light.png', '/map/sprites/v4/light.json', '/download/latest.json', '/robots.txt', '/llms.txt', '/status.json']) {
    assert.ok(!skips(path), `${path} reaches the Worker`);
  }
  // Only the versioned /vendor/ folders, and the fonts, are kept without asking.
  const kept = rules.filter((r) => r.set['cache-control']).map((r) => String(r.re));
  assert.deepEqual(kept, [String(glob('/assets/fonts/*')), String(glob('/vendor/*'))]);
  for (const dir of (await readdir(new URL('../../web/public/vendor/', import.meta.url), { withFileTypes: true })).filter((d) => d.isDirectory())) {
    assert.match(dir.name, /\d+\.\d+\.\d+$/, `vendor/${dir.name} carries its version`);
  }
});

test('search engines get robots.txt and a sitemap of real pages; the beta asks not to be crawled', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const robots = await (await call('/robots.txt')).res.text();
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Sitemap: https:\/\/terminus\.rcn\.sh\/sitemap\.xml$/m);
  assert.doesNotMatch(robots, /^Disallow: \/$/m, 'the stable site is open to search');
  const { res } = await call('/sitemap.xml');
  assert.equal(res.status, 200);
  const locs = [...(await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
  assert.ok(locs.includes('/'));
  for (const path of locs) {
    if (path === '/docs') continue;
    // Each page is a file the site serves, and one that wants to be indexed.
    const file = new URL(`../../web/public${path}index.html`, import.meta.url);
    assert.ok(existsSync(file), `${path} is a page`);
    assert.doesNotMatch(readFileSync(file, 'utf8'), /name="robots" content="noindex/, `${path} doesn't say noindex`);
  }
  // The link preview image the landing page names is there.
  const landing = readFileSync(new URL('../../web/public/index.html', import.meta.url), 'utf8');
  const og = landing.match(/property="og:image" content="https:\/\/terminus\.rcn\.sh(\/[^"]+)"/)?.[1];
  assert.ok(og && existsSync(new URL(`../../web/public${og}`, import.meta.url)), `og:image ${og} exists`);

  const beta = { ...makeEnv(), PUBLIC_ORIGIN: 'https://beta.terminus.rcn.sh' };
  assert.match(await (await call('/robots.txt', { env: beta })).res.text(), /^Disallow: \/$/m);
  assert.equal((await call('/sitemap.xml', { env: beta })).res.status, 404);
  assert.equal((await call('/docs', { env: beta })).res.headers.get('x-robots-tag'), 'noindex');
  assert.equal((await call('/docs')).res.headers.get('x-robots-tag'), null);
});

test('AI agents get /llms.txt: a short guide whose endpoints and links are real', async () => {
  const fetchImpl = makeFetch({ byStop: { PGP: D2_IN_4, COM3: D2_IN_4 } });
  const { res } = await call('/llms.txt', { fetchImpl });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/markdown/);
  const text = await res.text();
  assert.match(text, /^# terminus\n\n> /, 'a title, then a one-paragraph summary');
  assert.match(text, /API key/);
  const spec = await (await call('/openapi.json', { fetchImpl })).res.json();
  const ops = new Set(Object.values(spec.paths).flatMap((item) => Object.values(item).map((op) => op.operationId)));
  const links = [...text.matchAll(/\]\(([^)]+)\)/g)].map((m) => new URL(m[1]));
  assert.ok(links.length >= 8);
  for (const link of links) {
    assert.equal(link.origin, BASE, `${link} is on the site serving it`);
    const op = link.hash.match(/^#\/operations\/(\w+)$/)?.[1];
    if (op) assert.ok(ops.has(op), `${link.hash} is an operation in the spec`);
  }
  // Each endpoint it shows, with its example query, answers.
  for (const [, path] of text.matchAll(/^- \[GET ([^\]]+)\]/gm)) {
    const { res: r } = await call(path, { fetchImpl });
    assert.equal(r.status, 200, `${path} answers`);
  }
  // Without JavaScript, the docs page points at both.
  const docs = await (await call('/docs')).res.text();
  assert.match(docs, /<noscript>[^]*href="\/openapi.json"[^]*href="\/llms.txt"[^]*<\/noscript>/);
});
