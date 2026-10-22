import test from 'node:test';
import assert from 'node:assert/strict';

import { venueStops, venueToStop } from '../src/nusmods.ts';
import { originOf } from '../src/next.ts';
import { candidateStops, indexGraph, walkAllTheWayS } from '../src/resolve.ts';
import { buildingStops, footM } from '../src/walk.ts';
import { GRAPH } from '../src/graph.ts';
import venuesJson from '../data/venues.json' with { type: 'json' };
import overrides from '../data/src/venue-stops.json' with { type: 'json' };

const { byCode } = indexGraph(GRAPH);
const SPEED = 1.3;

test('a building listed by hand is served by the stops students use, the first as its stop', () => {
  for (const [code, o] of Object.entries(overrides.venues)) {
    for (const s of o.stops) assert.ok(byCode.has(s), `${code}: ${s} is a stop`);
    assert.ok(o.why, `${code} says why`);
    const v = venuesJson.venues[code];
    assert.ok(v, `${code} is in venues.json: run scripts/walk_routes.py`);
    assert.equal(v.stop, o.stops[0], `${code}: venues.json is stale, run scripts/walk_routes.py`);
    assert.deepEqual(Object.keys(v.stops ?? { [v.stop]: v.m }), o.stops, `${code}: venues.json is stale`);
  }
  // LT21: University Hall is nearer on the map, but the path goes to S17 and LT27.
  assert.equal(venueToStop('LT21')?.stop, 'S17');
  assert.equal(venueToStop('LT21-0001')?.stop, 'S17');
});

test("a building's stops start with its own, never list a stop with its twin, and stay few", () => {
  for (const [code, v] of Object.entries(venuesJson.venues)) {
    if (!v.stops) continue;
    const codes = Object.keys(v.stops);
    assert.equal(codes[0], v.stop, `${code}: its own stop first`);
    assert.equal(v.stops[v.stop], v.m, `${code}: the same walk`);
    assert.ok(codes.length >= 2, `${code}: listed only when more than one`);
    if (!overrides.venues[code]) assert.ok(codes.length <= 2, `${code}: two at most`);
    for (const s of codes) {
      assert.ok(byCode.has(s), `${code}: ${s} is a stop`);
      assert.ok(!codes.includes(byCode.get(s).opposite), `${code}: ${s} and the stop across the road both listed`);
    }
  }
  const com1 = venueStops('COM1');
  assert.deepEqual([com1.to, ...com1.also], ['COM3', 'CLB']);
  assert.ok(com1.walkM.CLB > com1.walkM.COM3);
});

test('leaving LT21 without a location starts at S17 and LT27, even on a timetable saved with University Hall', () => {
  const origin = originOf({ from: 'UHALL', fromVenue: 'LT21' }, 'PGP', 5, SPEED);
  assert.equal(origin.code, 'S17');
  assert.equal(origin.walkS, Math.round(venuesJson.venues.LT21.m / SPEED));
  const cands = candidateStops(GRAPH, { lat: null, lon: null, to: 'PGP', originCode: origin.code, originWalkS: origin.walkS });
  const codes = cands.map((c) => c.stop.code);
  assert.ok(codes.includes('S17') || codes.includes('LT27'), codes.join());
  assert.ok(!codes.includes('UHALL') && !codes.includes('UHALL-OPP'), `never University Hall: ${codes}`);
});

test("leaving a room two stops serve: both are starting points, each with the room's own walk to it", () => {
  const origin = originOf({ from: 'COM3', fromVenue: 'COM1-0208' }, 'PGP', 5, SPEED);
  // A room uNivUS lists on its own: its building's stops, walked from the room.
  const walks = venueStops('COM1-0208').walkM;
  assert.deepEqual(Object.keys(walks), ['COM3', 'CLB']);
  assert.equal(origin.code, 'COM3');
  assert.deepEqual(origin.also, ['CLB']);
  assert.deepEqual(origin.walkByStopS, { COM3: Math.round(walks.COM3 / SPEED), CLB: Math.round(walks.CLB / SPEED) });

  const input = {
    lat: null,
    lon: null,
    to: 'UTOWN',
    originCode: origin.code,
    originAlso: origin.also,
    originWalkByStopS: origin.walkByStopS,
    originWalkS: origin.walkS,
  };
  const cands = candidateStops(GRAPH, input);
  const walkAt = Object.fromEntries(cands.map((c) => [c.stop.code, c.walkS]));
  assert.equal(walkAt.CLB, origin.walkByStopS.CLB, 'CLB is walked to from the room, not from COM3');
  // The far side of CLB's road is a crossing further than CLB.
  if (walkAt.IT !== undefined) assert.ok(walkAt.IT > walkAt.CLB);

  // Walking all the way goes out by whichever stop makes it shortest.
  const viaCom3 = walkAllTheWayS(GRAPH, { ...input, originAlso: [], originWalkByStopS: undefined }, byCode.get('COM3'));
  assert.ok(walkAllTheWayS(GRAPH, input, byCode.get('COM3')) <= viaCom3);
});

test('a room no table knows starts at its trip stop with no walk; home is the home stop and its walk', () => {
  assert.deepEqual(originOf({ from: 'COM3', fromVenue: 'NOWHERE-9' }, 'PGP', 5, SPEED), { code: 'COM3', also: [], walkS: 0 });
  assert.deepEqual(originOf({ from: 'PGP', fromVenue: null }, 'PGP', 5, SPEED), { code: 'PGP', also: [], walkS: 300 });
});

test("a building's way out lists its stops in reach, and only the hand-kept ones where it has them", () => {
  for (const [code, v] of Object.entries(venuesJson.venues)) {
    if (!v.out) continue;
    for (const s of Object.keys(v.out)) assert.ok(byCode.has(s), `${code}: ${s} is a stop`);
    if (overrides.venues[code]) assert.deepEqual(Object.keys(v.out), overrides.venues[code].stops, `${code}: venues.json is stale`);
  }
  assert.deepEqual(Object.keys(venuesJson.venues.LT21.out), ['S17']);
});

test('in LT21, home to PGP is the walk out by S17, not the 400 m across the hill', () => {
  const { lat, lon } = venuesJson.venues.LT21;
  const pgp = byCode.get('PGP');
  // In a straight line PGP is near enough to look like a short walk.
  assert.ok(footM(lat, lon, pgp) < 500);
  const walkS = walkAllTheWayS(GRAPH, { lat, lon, to: 'PGP', walkSpeedMs: SPEED }, null);
  assert.ok(walkS >= Math.round(venuesJson.venues.LT21.out.S17 / SPEED) + 600, `${walkS} s`);
  // The bus is caught at S17 or across the road at LT27, never University Hall.
  const codes = candidateStops(GRAPH, { lat, lon, to: 'PGP', walkSpeedMs: SPEED }).map((c) => c.stop.code);
  assert.ok(codes.includes('S17') || codes.includes('LT27'), codes.join());
  assert.ok(!codes.includes('UHALL') && !codes.includes('UHALL-OPP'), `never University Hall: ${codes}`);
});

test('in a building, the walk to a stop in reach follows the paths from it', () => {
  const { lat, lon, out } = venuesJson.venues.MD6;
  const pgp = byCode.get('PGP');
  // The straight line with PGP's usual detour undersells this walk.
  assert.ok(out.PGP > footM(lat, lon, pgp) + 100);
  assert.equal(walkAllTheWayS(GRAPH, { lat, lon, to: 'PGP', walkSpeedMs: SPEED }, null), Math.round(out.PGP / SPEED));
  const inside = buildingStops(lat, lon, byCode);
  assert.equal(inside.find((c) => c.stop.code === 'PGP')?.footM, out.PGP);
  // Nearest on foot first.
  for (let i = 1; i < inside.length; i++) assert.ok(inside[i].footM >= inside[i - 1].footM);
});

test('at a stop beside a building you are at the stop, not in the building', () => {
  const s17 = byCode.get('S17');
  assert.equal(buildingStops(s17.lat, s17.lon, byCode), null);
  // Away from every building: the straight line, as before.
  assert.equal(buildingStops(1.3, 103.79, byCode), null);
});
