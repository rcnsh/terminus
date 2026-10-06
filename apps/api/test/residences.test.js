import test from 'node:test';
import assert from 'node:assert/strict';

import { GPS_MARGIN_M, atHome, residenceAt, residenceStops } from '../src/residences.ts';
import { GRAPH } from '../src/graph.ts';
import { indexGraph } from '../src/resolve.ts';
import residences from '../data/residences.json' with { type: 'json' };

// The middle of PGP's main outline, and a point just past its edge.
const ring = residences.residences.PGP.areas[0];
const mid = [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];

test('inside PGP is PGP; far away is nowhere', () => {
  assert.equal(residenceAt(mid[0], mid[1])?.[0], 'PGP');
  assert.equal(residenceAt(1.3521, 103.8198), null); // Singapore's centre
});

test('a fix a little outside the outline still counts (phones indoors drift)', () => {
  const [lat, lon] = ring[0];
  // Nudge outwards from the middle, less than the margin.
  const k = 1 + (GPS_MARGIN_M * 0.6) / (111_320 * Math.hypot(lat - mid[0], (lon - mid[1]) * Math.cos((lat * Math.PI) / 180)));
  assert.equal(residenceAt(mid[0] + (lat - mid[0]) * k, mid[1] + (lon - mid[1]) * k)?.[0], 'PGP');
});

test('home only when one of your home stops serves the residence you are in', () => {
  assert.equal(atHome(mid[0], mid[1], ['PGP']), true);
  assert.equal(atHome(mid[0], mid[1], ['PGPR']), true);
  assert.equal(atHome(mid[0], mid[1], ['UTOWN']), false, 'a UTown resident visiting PGP is not home');
  assert.equal(atHome(null, null, ['PGP']), false);
});


test('at home, the walk to your stop is your own, and the hall\'s other stops as much further', () => {
  const { byCode } = indexGraph(GRAPH);
  const pgp = residences.residences.PGP.stops;
  const foot = (out) => Object.fromEntries(out.map((c) => [c.stop.code, Math.round(c.footM)]));
  const own = foot(residenceStops(mid[0], mid[1], byCode));
  // Six minutes at 1.3 m/s to PGP Foyer, the nearest home stop.
  const home = foot(residenceStops(mid[0], mid[1], byCode, { stops: ['PGPR', 'PGP'], m: 468 }));
  assert.equal(home.PGPR, 468);
  assert.equal(home.PGP, 468 + pgp.PGP - pgp.PGPR);
  assert.ok(home.PGPR > own.PGPR, 'longer than the outline alone says');
  // Visiting someone else's residence: the outline, as before.
  assert.deepEqual(foot(residenceStops(mid[0], mid[1], byCode, { stops: ['UTOWN'], m: 468 })), own);
});
