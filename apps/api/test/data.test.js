/**
 * The generated data files refer to each other by stop code. The weekly
 * scrape can add or rename a stop without re-running walk_routes.py, and
 * then walks quietly fall back to straight lines. This catches it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import stops from '../data/stops.json' with { type: 'json' };
import walks from '../data/walks.json' with { type: 'json' };
import residences from '../data/residences.json' with { type: 'json' };
import rooms from '../data/rooms.json' with { type: 'json' };
import landmarks from '../data/landmarks.json' with { type: 'json' };
import venues from '../data/venues.json' with { type: 'json' };

const codes = new Set(stops.stops.map((s) => s.code));
const unknown = (list) => [...new Set(list)].filter((c) => !codes.has(c));

test('every stop code in the walking data is a real stop', () => {
  const pairCodes = Object.keys(walks.stopPairs).flatMap((k) => k.split('>'));
  assert.deepEqual(unknown([...pairCodes, ...Object.keys(walks.detour)]), [], 'walks.json: re-run scripts/walk_routes.py');
  assert.deepEqual(unknown(Object.values(residences.residences).flatMap((r) => Object.keys(r.stops))), [], 'residences.json');
  assert.deepEqual(unknown(Object.values(rooms.rooms).map((r) => r.stop)), [], 'rooms.json');
  assert.deepEqual(unknown(Object.values(landmarks.landmarks).flatMap((l) => Object.keys(l.stops))), [], 'landmarks.json');
  assert.deepEqual(unknown(Object.values(venues.venues).map((v) => v.stop)), [], 'venues.json');
});

test('every stop has a walking detour, so a new stop is not a straight line', () => {
  assert.deepEqual([...codes].filter((c) => !(c in walks.detour)), [], 're-run scripts/walk_routes.py');
});

// The public buses (data/public.json, from scrape_lta.py), which the graph
// with public buses merges in: everything it names must exist and line up.
import pub from '../data/public.json' with { type: 'json' };

test('public.json: stops are LTA codes on campus, shared shelters name real shuttle stops', () => {
  const lta = /^\d{5}$/;
  for (const s of pub.stops) {
    assert.match(s.code, lta);
    assert.ok(s.lat > 1.28 && s.lat < 1.33 && s.lon > 103.76 && s.lon < 103.83, `${s.code} at ${s.lat}, ${s.lon}`);
    assert.ok(!codes.has(s.code), `${s.code} clashes with a shuttle stop`);
  }
  for (const [ltaCode, shuttle] of Object.entries(pub.merged)) {
    assert.match(ltaCode, lta);
    assert.ok(codes.has(shuttle), `${ltaCode} merged into unknown ${shuttle}`);
  }
  // One public code per shelter.
  assert.equal(new Set(Object.values(pub.merged)).size, Object.keys(pub.merged).length);
});

test('public.json: every route runs through known stops, with a distance at each, and is described', () => {
  const known = new Set([...codes, ...pub.stops.map((s) => s.code)]);
  for (const [key, seq] of Object.entries(pub.routes)) {
    assert.ok(seq.length >= 2, `${key} has fewer than two stops`);
    for (const c of seq) assert.ok(known.has(c), `${key} calls at unknown ${c}`);
    const along = pub.along[key];
    assert.ok(Array.isArray(along) && along.length === seq.length, `${key}: ${seq.length} stops, ${along?.length} distances`);
    assert.equal(along[0], 0);
    for (let i = 1; i < along.length; i++) assert.ok(along[i] >= along[i - 1], `${key} goes backwards at ${seq[i]}`);
    const p = pub.public[key];
    assert.ok(p && p.svc && p.operator && p.origin && p.dest, `${key} is not described`);
    assert.equal(key.split('/')[0], p.svc);
    assert.equal(typeof pub.loops[key], 'boolean');
    if (pub.loops[key]) assert.equal(seq[0], seq[seq.length - 1], `loop ${key} does not close`);
  }
  // The services that matter for the campus are there.
  for (const key of ['95', '151/1', '151/2', '96']) assert.ok(pub.routes[key], key);
  // A stop of its own is called at by something.
  const used = new Set(Object.values(pub.routes).flat());
  for (const s of pub.stops) assert.ok(used.has(s.code), `${s.code} is on no route`);
});

test('public.json: hours are HH:MM windows and headways are minutes-scale seconds', () => {
  for (const [key, h] of Object.entries(pub.serviceHours)) {
    assert.ok(pub.routes[key], `hours for unknown ${key}`);
    for (const win of Object.values(h)) {
      assert.equal(win.length, 2);
      for (const t of win) assert.match(t, /^([01]\d|2[0-3]):[0-5]\d$/, `${key}: ${t}`);
    }
  }
  for (const [key, s] of Object.entries(pub.headwayS)) {
    assert.ok(pub.routes[key], `headway for unknown ${key}`);
    assert.ok(s >= 120 && s <= 3600, `${key}: ${s} s`);
  }
});
