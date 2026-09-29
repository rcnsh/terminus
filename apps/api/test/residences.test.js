import test from 'node:test';
import assert from 'node:assert/strict';

import { GPS_MARGIN_M, atHome, residenceAt } from '../src/residences.ts';
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

