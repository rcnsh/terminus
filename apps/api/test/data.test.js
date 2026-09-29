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
