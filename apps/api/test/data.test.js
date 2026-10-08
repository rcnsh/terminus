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
    // A loop ends where it starts; a one-way route (151/1) ends elsewhere.
    assert.equal(pub.loops[key], seq[0] === seq[seq.length - 1], `${key}: loop ${pub.loops[key]}, from ${seq[0]} to ${seq.at(-1)}`);
  }
  assert.ok(Object.values(pub.loops).includes(true) && Object.values(pub.loops).includes(false), 'public.json has loops and one-way routes');
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
      // null: it doesn't run that day.
      if (win === null) continue;
      assert.equal(win.length, 2);
      for (const t of win) assert.match(t, /^([01]\d|2[0-3]):[0-5]\d$/, `${key}: ${t}`);
    }
  }
  for (const [key, s] of Object.entries(pub.headwayS)) {
    assert.ok(pub.routes[key], `headway for unknown ${key}`);
    assert.ok(s >= 120 && s <= 3600, `${key}: ${s} s`);
  }
});

test('stop codes are unique: in stops.json, in public.json, and between them', () => {
  const dupes = (list) => list.filter((c, i) => list.indexOf(c) !== i);
  assert.deepEqual(dupes(stops.stops.map((s) => s.code)), [], 'stops.json');
  assert.deepEqual(dupes(pub.stops.map((s) => s.code)), [], 'public.json');
  assert.deepEqual(dupes([...stops.stops, ...pub.stops].map((s) => s.code)), [], 'a public stop with a shuttle stop’s code');
});

import { ROUTE_COLORS, shapeFor } from '../src/campus.ts';
import { GRAPH } from '../src/graph.ts';
import { pointAlong } from '../src/buses.ts';
import { haversineM } from '../src/geo.ts';
import opposites from '../data/opposites.json' with { type: 'json' };

test('every shuttle service has its own colour', () => {
  for (const svc of Object.keys(stops.routes)) assert.match(ROUTE_COLORS[svc] ?? '', /^#[0-9a-f]{6}$/, `no colour for ${svc} in ROUTE_COLORS (src/campus.ts)`);
  assert.equal(new Set(Object.values(ROUTE_COLORS)).size, Object.keys(ROUTE_COLORS).length, 'two services share a colour');
});

test('a service is a loop exactly when it ends where it starts, and a loop’s line ends near its start', () => {
  // The API places buses with the loop flag, and the maps take it from
  // /campus: the line's ends needn't meet (A1's are some 40 m apart at KRB),
  // but further apart than this and a bus going round would jump.
  assert.deepEqual(Object.keys(stops.loops).sort(), Object.keys(stops.routes).sort());
  for (const [svc, seq] of Object.entries(stops.routes)) {
    assert.equal(stops.loops[svc], seq[0] === seq.at(-1), `${svc}: loop ${stops.loops[svc]}, from ${seq[0]} to ${seq.at(-1)}`);
    const line = shapeFor(svc, seq)?.line;
    if (!stops.loops[svc] || !line) continue;
    const [a, z] = [line[0], line.at(-1)];
    assert.ok(haversineM(a[1], a[0], z[1], z[0]) < 60, `${svc}'s line ends ${Math.round(haversineM(a[1], a[0], z[1], z[0]))} m from its start`);
  }
  assert.ok(Object.values(stops.loops).includes(false), 'some service (K, R1, R2) is one way');
});

test('opposites.json: each stop in one pair at most, and each pair two sides of one road', () => {
  const listed = opposites.pairs.flat();
  assert.deepEqual(unknown([...listed, ...opposites.nearby.flat()]), [], 'opposites.json names an unknown stop');
  assert.deepEqual(listed.filter((c, i) => listed.indexOf(c) !== i), [], 'a stop in two pairs');
  for (const [a, b] of [...opposites.pairs, ...opposites.nearby]) assert.notEqual(a, b);
  // Every twin the graph ends up with, scraped or listed: the buses at one
  // drive the other way from the buses at the other, never the same way.
  const ways = (code) =>
    Object.entries(GRAPH.routes).flatMap(([svc, seq]) => {
      const shape = shapeFor(svc, seq);
      return shape ? shape.stops.flatMap((c, k) => (c === code && pointAlong(shape, shape.at[k] + 5).bearing != null ? [[svc, pointAlong(shape, shape.at[k] + 5).bearing]] : [])) : [];
    });
  const apart = (x, y) => Math.min(Math.abs(x - y), 360 - Math.abs(x - y));
  let pairs = 0;
  for (const s of GRAPH.stops) {
    if (!s.opposite || s.code > s.opposite) continue;
    pairs++;
    assert.equal(GRAPH.stops.find((x) => x.code === s.opposite)?.opposite, s.code, `${s.code} and ${s.opposite} are not each other's twin`);
    for (const [p, x] of ways(s.code)) for (const [q, y] of ways(s.opposite)) assert.ok(apart(x, y) > 90, `${s.code} (${p}, ${Math.round(x)}°) and ${s.opposite} (${q}, ${Math.round(y)}°) are on the same side`);
  }
  assert.ok(pairs >= opposites.pairs.length, `${pairs} twins in the graph`);
});
