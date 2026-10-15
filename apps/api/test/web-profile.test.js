/**
 * The account page's card and profile helpers (apps/web/public/account/
 * preview.js and profile.js), on the real /campus answer, built from the
 * Worker's own modules and data.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { useLang, web } from './_web.mjs';
import { buildCampusMap, buildDestinations } from '../src/campus.ts';
import { GRAPH } from '../src/graph.ts';
import { haversineM } from '../src/geo.ts';
import { residenceList, residenceWalkMin as serverWalkMin } from '../src/residences.ts';
import classBus from './fixtures/answers/class-bus.json' with { type: 'json' };

const { isStale, leaveHead, leaveText } = await web('account/preview.js');
const P = await web('account/profile.js');
const { t } = await web('account/dom.js');

/** /campus as the Worker sends it (index.ts handleCampus), through JSON. */
const map = buildCampusMap(GRAPH);
const CAMPUS = JSON.parse(
  JSON.stringify({
    viewBox: map.viewBox,
    stops: map.stops,
    routes: map.routes,
    destinations: buildDestinations(GRAPH),
    residences: residenceList(),
  }),
);
P.campus.set(CAMPUS);
useLang('en');

const iso = (ms) => new Date(ms).toISOString();

test('a card is old once past its staleAt; one without staleAt never is; no card always is', () => {
  const now = Date.now();
  assert.equal(isStale({ card: { staleAt: iso(now + 60_000) } }), false);
  assert.equal(isStale({ card: { staleAt: iso(now - 1_000) } }), true);
  assert.equal(isStale({ card: { staleAt: null } }), false);
  assert.equal(isStale({ card: {} }), false);
  assert.equal(isStale({}), true);
  assert.equal(isStale(null), true);
});

test('the headline is the server\'s "Leave by" until the leave time, then "Leave now"; at the stop, always the bus', () => {
  const now = Date.now();
  const a = (at, phase = 'idle') => ({ ...classBus, leave: { ...classBus.leave, at: iso(at) }, card: { ...classBus.card, phase } });
  assert.equal(leaveHead(a(now + 60_000)), 'Leave by ~09:36');
  assert.equal(leaveText(a(now + 60_000)), 'Leave by ~09:36 · catch the ~09:42 R2 at PGP');
  assert.equal(leaveHead(a(now - 1_000)), 'Leave now');
  assert.equal(leaveText(a(now - 1_000)), 'Leave now · catch the ~09:42 R2 at PGP');
  const waiting = a(now - 60_000, 'waiting');
  waiting.card.leaveBy = 'R2 at 09:42';
  assert.equal(leaveHead(waiting), 'R2 at 09:42');
  // Nothing to add: the headline alone.
  assert.equal(leaveText({ ...a(now + 60_000), card: { ...a(now + 60_000).card, leaveVia: null } }), 'Leave by ~09:36');
  useLang('zh');
  assert.equal(leaveHead(a(now - 1_000)), t('Leave now'));
  assert.notEqual(t('Leave now'), 'Leave now');
  useLang('en');
});

test('stops nearest first, every stop once, at the distances the API works out', () => {
  for (const from of CAMPUS.stops.slice(0, 10)) {
    const near = P.stopsNear(from.lat, from.lon);
    assert.equal(near.length, CAMPUS.stops.length);
    assert.equal(new Set(near.map((x) => x.s.code)).size, CAMPUS.stops.length);
    assert.equal(near[0].d, 0, from.code);
    // Another stop on the very same spot may come first; this one is at 0 m.
    assert.ok(
      near.some((x) => x.s.code === from.code && x.d === 0),
      from.code,
    );
    for (let i = 1; i < near.length; i++) assert.ok(near[i].d >= near[i - 1].d);
    for (const { s, d } of near) assert.ok(Math.abs(d - haversineM(from.lat, from.lon, s.lat, s.lon)) < 1e-6);
  }
  // Kent Ridge MRT's exit: its stop is the nearest.
  const kr = CAMPUS.stops.find((s) => s.code === 'KR-MRT');
  assert.ok(kr);
  assert.equal(P.stopsNear(kr.lat + 0.0001, kr.lon)[0].s.code, 'KR-MRT');
});

test('a residence is found from its home stops, in any order, and only from exactly them', () => {
  assert.ok(CAMPUS.residences.length > 5);
  for (const r of CAMPUS.residences) {
    const found = P.residenceFor([...r.stops].reverse());
    // Several share UTOWN: the common one, else the first by name, is the answer for all of them.
    assert.deepEqual([...found.stops].sort(), [...r.stops].sort(), r.name);
    const sharing = P.residencesByName().filter((x) => [...x.stops].sort().join() === [...r.stops].sort().join());
    assert.equal(found.code, sharing[0].code, r.name);
  }
  assert.equal(P.residenceFor(['PGP', 'PGPR']).code, 'PGP');
  // PGP's stop alone is King Edward VII Hall's; its other stop alone is no one's.
  assert.equal(P.residenceFor(['PGP']).code, 'KEVII');
  assert.equal(P.residenceFor(['PGPR']), null);
  // Shared: the common residence first (UTown Residence), else by name.
  assert.equal(P.residenceFor(['UTOWN']).code, 'UTR');
  assert.equal(P.residenceFor(['BIZ2', 'HSSML-OPP']).code, 'KRH');
  assert.equal(P.residenceFor([]), null);
  assert.equal(P.residenceFor(['NOT-A-STOP']), null);
  assert.equal(P.residenceFor([...CAMPUS.residences[0].stops, 'COM3']), null);
});

test("a residence's walk in minutes is /campus's, and worked out the same way from an older answer", () => {
  for (const r of CAMPUS.residences) {
    assert.equal(P.residenceWalkMin(r), r.walkMin, r.name);
    const { walkMin: _old, ...older } = r;
    assert.equal(P.residenceWalkMin(older), serverWalkMin(r.walkM), r.name);
  }
  assert.equal(P.residenceWalkMin({ walkM: 10 }), 1);
});

test('a favourite is called what was picked, keyed from its name, one per place', () => {
  const p = { places: [] };
  assert.equal(P.withPlace(p, 'KR-MRT', 'KR MRT'), null);
  assert.deepEqual(p.places, [{ key: 'kr-mrt', label: 'KR MRT', to: 'KR-MRT' }]);
  // The same place again: the one already there, nothing added.
  assert.deepEqual(P.withPlace(p, 'KR-MRT', 'Kent Ridge'), p.places[0]);
  assert.equal(p.places.length, 1);
  // A long name is cut to 24; a key taken gets a number.
  P.withPlace(p, 'COM3', 'School of Computing, Building COM3 and more');
  assert.equal(p.places[1].label, 'School of Computing, Bui');
  assert.equal(p.places[1].key, 'school-of-computing-bui');
  P.withPlace(p, 'COM1', 'KR MRT');
  assert.match(p.places[2].key, /^kr-mrt-\d\d$/);
  assert.notEqual(p.places[2].key, p.places[0].key);
  // A name with no Latin letters still gets a key.
  P.withPlace(p, 'UTOWN', '大学城');
  assert.equal(p.places[3].key, 'place');
  assert.equal(new Set(p.places.map((x) => x.key)).size, p.places.length);
});

test("a reload while a save is on its way keeps the change, not the server's copy from before it", async () => {
  const realFetch = globalThis.fetch;
  let answerSave;
  globalThis.fetch = async (url, init) => {
    // The save waits; a reload meanwhile gets the profile from before it.
    if (init?.method === 'PUT')
      return new Promise((ok) => (answerSave = () => ok(new Response(init.body, { headers: { 'content-type': 'application/json' } }))));
    return new Response(JSON.stringify({ walkPace: 'normal' }), { headers: { 'content-type': 'application/json' } });
  };
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    P.profile.set({ walkPace: 'normal' });
    P.toastText.set(null);
    P.edit((p) => (p.walkPace = 'fast'));
    // The edit's save sets off, and is still on its way when the reload comes back.
    mock.timers.tick(400);
    for (let i = 0; i < 50 && !answerSave; i++) await new Promise((ok) => setImmediate(ok));
    await P.reloadProfile();
    assert.equal(P.profile.get().walkPace, 'fast');
    answerSave();
    for (let i = 0; i < 50 && P.toastText.get()?.text !== 'Saved'; i++) await new Promise((ok) => setImmediate(ok));
    assert.equal(P.profile.get().walkPace, 'fast');
    await P.reloadProfile();
    assert.equal(P.profile.get().walkPace, 'normal', 'once it has landed, a reload reads the server again');
  } finally {
    mock.timers.reset();
    globalThis.fetch = realFetch;
  }
});

test('an edit made while a saveNow is on its way is kept, with the saved change on it too', async () => {
  const realFetch = globalThis.fetch;
  let answerSave;
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    if (init?.method !== 'PUT') return new Response(JSON.stringify({ walkPace: 'normal', clock: '24' }), { headers: { etag: '"1"' } });
    bodies.push(JSON.parse(init.body));
    // The first save waits; its reply is the profile as it went.
    if (!answerSave)
      return new Promise((ok) => (answerSave = () => ok(new Response(init.body, { headers: { 'content-type': 'application/json' } }))));
    return new Response(init.body, { headers: { 'content-type': 'application/json' } });
  };
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await P.loadProfile();
    P.toastText.set(null);
    const saving = P.saveNow((p) => (p.clock = '12'));
    for (let i = 0; i < 50 && !answerSave; i++) await new Promise((ok) => setImmediate(ok));
    // Meanwhile, a change elsewhere on the page.
    P.edit((p) => (p.walkPace = 'fast'));
    answerSave();
    await saving;
    assert.deepEqual(P.profile.get(), { walkPace: 'fast', clock: '12' }, 'the newer edit, not the reply from before it');
    // The edit's own save carries both.
    mock.timers.tick(400);
    for (let i = 0; i < 50 && bodies.length < 2; i++) await new Promise((ok) => setImmediate(ok));
    assert.deepEqual(bodies[1], { walkPace: 'fast', clock: '12' });
  } finally {
    mock.timers.reset();
    globalThis.fetch = realFetch;
  }
});

/**
 * The API's profile, as apps/api/src/me.ts keeps it: a version in the ETag,
 * and a PUT with If-Match refused (412) if another device saved since.
 * `hold()` makes the next PUT wait until `release()`.
 */
function fakeServer(doc) {
  const s = { doc, version: 1, puts: [], held: null };
  const reply = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', etag: `"${s.version}"` } });
  s.hold = () => {
    let release;
    s.held = new Promise((ok) => (release = ok));
    return () => {
      s.held = null;
      release();
    };
  };
  /** Another device saves: the version moves on. */
  s.elsewhere = (change) => {
    s.doc = structuredClone(s.doc);
    change(s.doc);
    s.version++;
  };
  s.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    if (url === '/api/me/profile' && method === 'GET') return reply(s.doc);
    if (url === '/api/me/profile' && method === 'PUT') {
      const put = { body: JSON.parse(init.body), ifMatch: init.headers['if-match'] ?? null };
      s.puts.push(put);
      if (s.held) await s.held;
      if (put.ifMatch && put.ifMatch !== `"${s.version}"`)
        return new Response(JSON.stringify({ error: 'your settings were changed on another device; try again' }), { status: 412 });
      s.doc = put.body;
      s.version++;
      return reply(s.doc);
    }
    if (s.route) return s.route(url, init, reply);
    return new Response('{"error":"not found"}', { status: 404 });
  };
  return s;
}

/** Lets promises and fetches run until `done()`, or gives up. */
async function until(done) {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((ok) => setImmediate(ok));
  assert.ok(done(), 'waited too long');
}

/** Runs `body` against a fake server holding `doc`, with the 400 ms save wait under the test's control. */
async function withServer(doc, body) {
  const realFetch = globalThis.fetch;
  const server = fakeServer(doc);
  globalThis.fetch = server.fetch;
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await P.loadProfile();
    P.toastText.set(null);
    await body(server);
  } finally {
    mock.timers.reset();
    globalThis.fetch = realFetch;
  }
}

test('a save sends the version it was made on, and keeps what another device saved meanwhile (412, read again, the change made again)', async () => {
  await withServer({ walkPace: 'normal', clock: '24', places: [] }, async (server) => {
    P.edit((p) => (p.walkPace = 'fast'));
    // Another device sets the clock after this page loaded.
    server.elsewhere((p) => (p.clock = '12'));
    mock.timers.tick(400);
    await until(() => server.puts.length === 2 && P.toastText.get()?.text === 'Saved');
    assert.equal(server.puts[0].ifMatch, '"1"');
    assert.deepEqual(server.puts[0].body.clock, '24', 'the first try is on the copy this page had');
    // Refused: read again, and only the change made on that.
    assert.equal(server.puts[1].ifMatch, '"2"');
    assert.deepEqual(server.doc, { walkPace: 'fast', clock: '12', places: [] });
    assert.deepEqual(P.profile.get(), server.doc);
  });
});

test('one save at a time: a change made while one is on its way goes next, on the version it saved', async () => {
  await withServer({ walkPace: 'normal', clock: '24' }, async (server) => {
    const release = server.hold();
    P.edit((p) => (p.walkPace = 'fast'));
    mock.timers.tick(400);
    await until(() => server.puts.length === 1);
    P.edit((p) => (p.clock = '12'));
    mock.timers.tick(400);
    for (let i = 0; i < 20; i++) await new Promise((ok) => setImmediate(ok));
    assert.equal(server.puts.length, 1, 'not sent while the first is on its way');
    assert.deepEqual(P.profile.get(), { walkPace: 'fast', clock: '12' });
    release();
    await until(() => server.puts.length === 2 && server.version === 3);
    assert.equal(server.puts[1].ifMatch, '"2"');
    assert.deepEqual(server.doc, { walkPace: 'fast', clock: '12' });
    await until(() => P.toastText.get()?.text === 'Saved' && P.profile.get().clock === '12');
    assert.deepEqual(P.profile.get(), { walkPace: 'fast', clock: '12' });
  });
});

test("setup's saveNow saves only its change on the server's copy, and answers once it has landed", async () => {
  await withServer({ clock: 'auto', seen: [] }, async (server) => {
    server.elsewhere((p) => (p.seen = ['tips']));
    const saved = await P.saveNow((p) => (p.seen = [...new Set([...(p.seen ?? []), 'onboarding'])]));
    assert.deepEqual(saved, { clock: 'auto', seen: ['tips', 'onboarding'] });
    assert.deepEqual(server.doc, saved);
    assert.equal(server.puts.at(-1).ifMatch, '"2"');
    // Its caller says how it went: no "Saved" of its own.
    assert.equal(P.toastText.get(), null);
  });
});

test("a save refused again and again gives up, and the profile shown is the server's", async () => {
  await withServer({ clock: '24' }, async (server) => {
    // Every try finds another device has saved since it read.
    const realFetch = server.fetch;
    globalThis.fetch = async (url, init = {}) => {
      if (init.method === 'PUT') server.elsewhere(() => {});
      return realFetch(url, init);
    };
    await assert.rejects(
      P.saveNow((p) => (p.clock = '12')),
      { status: 412 },
    );
    assert.equal(server.puts.length, 3);
    assert.equal(server.doc.clock, '24');
    assert.equal(P.profile.get().clock, '24', 'not shown as saved');
  });
});

test('a save without a version (an older page state) is still sent, and the server takes it as before', async () => {
  await withServer({ clock: '24' }, async (server) => {
    const realFetch = server.fetch;
    // A server that sends no ETag.
    globalThis.fetch = async (url, init) => {
      const res = await realFetch(url, init);
      return new Response(await res.text(), { status: res.status });
    };
    await P.loadProfile();
    await P.saveNow((p) => (p.clock = '12'));
    assert.equal(server.puts.at(-1).ifMatch, null);
    assert.equal(server.doc.clock, '12');
  });
});

test('a favourite added and taken off before the save is gone once it saves (its key is the same each time the change is made)', async () => {
  await withServer({ places: [{ key: 'kr-mrt', label: 'KR MRT', to: 'KR-MRT' }] }, async (server) => {
    // Its name's key is taken, so it gets a number: the same one when made again on the server's copy.
    const keep = {};
    P.edit((p) => P.withPlace(p, 'COM3', 'KR MRT', keep));
    const added = P.profile.get().places[1].key;
    assert.match(added, /^kr-mrt-\d\d$/);
    P.edit((p) => P.withoutPlace(p, added));
    mock.timers.tick(400);
    await until(() => server.puts.length === 1 && P.toastText.get()?.text === 'Saved');
    assert.deepEqual(server.doc.places, [{ key: 'kr-mrt', label: 'KR MRT', to: 'KR-MRT' }]);
  });
  // Made again on a copy where the key is free: the same key.
  const keep = {};
  const a = { places: [{ key: 'x', label: 'X', to: 'A' }] };
  P.withPlace(a, 'B', 'X', keep);
  for (let i = 0; i < 20; i++) {
    const b = { places: [{ key: 'x', label: 'X', to: 'A' }] };
    P.withPlace(b, 'B', 'X', keep);
    assert.equal(b.places[1].key, a.places[1].key);
  }
});
