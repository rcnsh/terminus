/**
 * Edges of the thresholds, where an off-by-one would go unseen: a bus
 * exactly 40 m from a stop, a fix 60 m off its line, a walk exactly two
 * minutes faster, a public loop wrapping to its first campus stop, a lesson
 * on its last date, a place visited at 23:30, and bad distances in the data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { GRAPH, GRAPH_PUBLIC } from '../src/graph.ts';
import { SHAPES } from '../src/campus.ts';
import { alongLine, sectionOf } from '../src/buses.ts';
import { walkVerdict } from '../src/format.ts';
import { WALK } from '../src/config.ts';
import { indexGraph, reach } from '../src/resolve.ts';
import { importedClassRuns } from '../src/calendar.ts';
import { DEFAULT_PROFILE, classesOn } from '../src/profile.ts';
import { rideMetres } from '../src/public.ts';

const D2 = SHAPES.D2;
const M_LAT = 111_320;

test('a bus exactly 40 m along from a stop is at it; a metre further is between two', () => {
  // A stop well away from its neighbours, so 40 m either side is still nearest to it.
  const k = D2.at.findIndex((m, i) => i > 0 && i < D2.at.length - 1 && m - D2.at[i - 1] > 200 && D2.at[i + 1] - m > 200);
  assert.ok(k > 0, 'a stop with room on both sides');
  assert.equal(D2.at[k] + 40 - D2.at[k], 40, 'exactly 40 m, no rounding');
  assert.deepEqual(sectionOf(D2, D2.at[k] + 40, false), { at: k, from: k, to: null });
  assert.deepEqual(sectionOf(D2, D2.at[k] - 40, false), { at: k, from: k, to: null });
  assert.deepEqual(sectionOf(D2, D2.at[k] + 41, false), { at: null, from: k, to: k + 1 });
  assert.deepEqual(sectionOf(D2, D2.at[k] - 41, false), { at: null, from: k - 1, to: k });
});

/** Metres from a point to the nearest stretch of a [lon, lat] line, on a flat projection. */
function offLine(line, lat, lon) {
  const k = Math.cos((lat * Math.PI) / 180) * M_LAT;
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = [line[i][0] * k, line[i][1] * M_LAT];
    const [bx, by] = [line[i + 1][0] * k, line[i + 1][1] * M_LAT];
    const [px, py] = [lon * k, lat * M_LAT];
    const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / len2)) : 0;
    best = Math.min(best, Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay))));
  }
  return best;
}

test('a fix 60 m off the line is no bus on it; 40 m off still is', () => {
  // The midpoint of the D2's longest stretch, pushed sideways off the road.
  let i = 0;
  const len = (j) => Math.hypot(D2.line[j + 1][0] - D2.line[j][0], D2.line[j + 1][1] - D2.line[j][1]);
  for (let j = 1; j + 1 < D2.line.length; j++) if (len(j) > len(i)) i = j;
  const [[aLon, aLat], [bLon, bLat]] = [D2.line[i], D2.line[i + 1]];
  const k = Math.cos((aLat * Math.PI) / 180);
  const [dx, dy] = [(bLon - aLon) * k, bLat - aLat];
  const norm = Math.hypot(dx, dy);
  const sideways = (m) => {
    // Either side: whichever is clear of the rest of the line.
    for (const s of [1, -1]) {
      const lat = (aLat + bLat) / 2 + (s * (dx / norm) * m) / M_LAT;
      const lon = (aLon + bLon) / 2 + (s * (-dy / norm) * m) / M_LAT / k;
      if (Math.abs(offLine(D2.line, lat, lon) - m) < 2) return { lat, lon };
    }
    return null;
  };
  const far = sideways(60);
  const near = sideways(40);
  assert.ok(far && near, 'a clear side of the road');
  assert.equal(alongLine(D2, far.lat, far.lon, null), null);
  assert.notEqual(alongLine(D2, near.lat, near.lon, null), null);
});

const live = (totalS) => ({ quality: 'live', totalS, boardS: 120, walkS: 60, svc: 'D2', stop: { code: 'KR-MRT', name: 'KR MRT' } });

test('walking exactly beatsBusByS faster than a live bus is mentioned, not recommended', () => {
  // "Must beat the bus by this much" (config.ts): by more than it, so a tie is the bus.
  const bus = 900;
  assert.equal(walkVerdict(bus - WALK.beatsBusByS, live(bus)), 'close');
  assert.equal(walkVerdict(bus - WALK.beatsBusByS - 1, live(bus)), 'win');
  // Within mentionWithinS of the bus is still worth mentioning; at it, not.
  assert.equal(walkVerdict(bus + WALK.mentionWithinS - 1, live(bus)), 'close');
  assert.equal(walkVerdict(bus + WALK.mentionWithinS, live(bus)), 'lose');
});

test('a public loop whose interchange is off campus: wrapping to its first campus stop rides on', () => {
  const idx = indexGraph(GRAPH_PUBLIC);
  // The 96's run starts and ends at Clementi, between its last campus stop and its first.
  assert.notEqual(GRAPH_PUBLIC.public['96'].origin, idx.routes.get('96').seq[0]);
  assert.deepEqual(reach(idx, '96', 'RAFFLES', idx.routes.get('96').seq[0]), { hops: 1, through: true });
  // A shuttle loop ends at its first stop: getting off there is not riding on.
  assert.deepEqual(reach(indexGraph(GRAPH), 'D2', 'KR-MRT-OPP', 'COM3'), { hops: 3 });
});

test('a lesson given as a date range runs on its last date, and not the day after', () => {
  const weeks = { start: '2026-08-13', end: '2026-08-27' };
  const thu = (date) => Date.parse(`${date}T02:00:00Z`); // 10:00 in Singapore
  assert.equal(importedClassRuns(weeks, null, thu('2026-08-27')), true);
  assert.equal(importedClassRuns(weeks, null, thu('2026-08-13')), true, 'and on its first');
  assert.equal(importedClassRuns({ ...weeks, end: '2026-08-26' }, null, thu('2026-08-27')), false);
  assert.equal(importedClassRuns({ ...weeks, start: '2026-08-28', end: '2026-09-10' }, null, thu('2026-08-27')), false);
});

test("a place visited at 23:30 is there until midnight, not past it", () => {
  const profile = {
    ...structuredClone(DEFAULT_PROFILE),
    places: [{ key: 'gym', label: 'Gym', to: 'UTOWN' }],
    usual: [{ place: 'gym', day: 4, atMin: 23 * 60 + 30 }],
    once: [{ date: '2026-08-27', arriveByMin: 23 * 60 + 45, to: 'COM3', label: 'Late lab' }],
  };
  const trips = classesOn(profile, Date.parse('2026-08-27T01:00:00Z'));
  assert.deepEqual(trips.map((t) => [t.label, t.endMin]), [['Gym', 1440], ['Late lab', 1440]]);
  const early = classesOn({ ...profile, usual: [{ place: 'gym', day: 4, atMin: 600 }], once: [] }, Date.parse('2026-08-27T01:00:00Z'));
  assert.equal(early[0].endMin, 660, 'an hour there otherwise');
});

test('distances along a public route that do not match its stops are not used', () => {
  const stops = ['A', 'B', 'C'].map((code, i) => ({ code, name: code, lat: 1.3, lon: 103.77 + i * 0.001, opposite: null }));
  const graph = (along) => ({ stops, routes: { X: ['A', 'B', 'C'] }, loops: { X: false }, along: { X: along } });
  assert.equal(rideMetres(indexGraph(graph([0, 100, 250])), 'X', 'A', 'C'), 250);
  assert.equal(rideMetres(indexGraph(graph([0, 100])), 'X', 'A', 'C'), null, 'one short');
  assert.equal(rideMetres(indexGraph(graph([0, 100, 250, 400])), 'X', 'A', 'C'), null, 'one too many');
});
