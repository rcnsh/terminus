/**
 * The account page's card and profile helpers (apps/web/public/account/
 * preview.js and profile.js), on the real /campus answer, built from the
 * Worker's own modules and data.
 */
import test from 'node:test';
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
const CAMPUS = JSON.parse(JSON.stringify({ viewBox: map.viewBox, stops: map.stops, routes: map.routes, destinations: buildDestinations(GRAPH), residences: residenceList() }));
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
    assert.ok(near.some((x) => x.s.code === from.code && x.d === 0), from.code);
    for (let i = 1; i < near.length; i++) assert.ok(near[i].d >= near[i - 1].d);
    for (const { s, d } of near) assert.ok(Math.abs(d - haversineM(from.lat, from.lon, s.lat, s.lon)) < 1e-6);
  }
  // Kent Ridge MRT's exit: its stop is the nearest.
  const kr = CAMPUS.stops.find((s) => s.code === 'KR-MRT');
  assert.ok(kr);
  assert.equal(P.stopsNear(kr.lat + 0.0001, kr.lon)[0].s.code, 'KR-MRT');
});

test("a residence is found from its home stops, in any order, and only from exactly them", () => {
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
