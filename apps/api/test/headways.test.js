/**
 * Measured headways: how headwayFor (resolve.ts) picks one for a time, how
 * scripts/data/measure_headways.mjs measures them from the recorder's
 * passings, and that data/headways.json is a file headwayFor can read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { GRAPH } from '../src/answer/graph.ts';
import { candidateStops, dayKindOf, headwayFor } from '../src/answer/resolve.ts';
import { departures, leaveBy } from '../src/answer/leave.ts';
import { residenceAt } from '../src/answer/residences.ts';
import { DEFAULT_HEADWAY_S } from '../src/config.ts';
import { MIN_GAPS, headwaysOf, periodOf } from '../scripts/data/measure_headways.mjs';
import headways from '../data/headways.json' with { type: 'json' };

/** An instant from a Singapore wall-clock time, "2026-08-27T09:00". */
const at = (sgt) => Date.parse(`${sgt}+08:00`);
const THU_0930 = at('2026-08-27T09:30'); // term, a weekday
const THU_2130 = at('2026-08-27T21:30');
const SAT = at('2026-08-29T12:00');
const SUN = at('2026-08-30T12:00');
const HOLIDAY = at('2026-11-09T12:00'); // Deepavali (observed), a Monday in term
const VACATION = at('2026-12-21T09:30'); // a Monday

const graph = {
  stops: [],
  routes: {},
  headwayS: { D2: 450, K: 2400 },
  headwaysByTime: {
    D2: { term: { weekday: { all: 420, hours: { 9: 340, 20: 600 } }, sunday: { all: 1200, hours: {} } } },
    K: { term: { weekday: { all: 2400, hours: {} } }, vacation: { weekday: { all: 3000, hours: {} } } },
  },
};

test('a headway for a time is that hour, else the nearest hour that day, else the usual one', () => {
  assert.equal(headwayFor(graph, 'D2', THU_0930), 340, 'the hour');
  assert.equal(headwayFor(graph, 'D2', THU_2130), 600, 'an hour without its own: the nearest, not the day’s median');
  assert.equal(headwayFor(graph, 'D2', SAT), 450, 'Saturday not measured: the usual');
  assert.equal(headwayFor(graph, 'D2', SUN), 1200, 'a day with no hours of its own: its median');
  assert.equal(headwayFor(graph, 'D2', HOLIDAY), 1200, 'a public holiday runs Sunday hours');
  assert.equal(headwayFor(graph, 'D2'), 450, 'no time: the usual');
});

test('the vacation uses its own headways; where none were measured, never shorter than term time’s or the one guess for all', () => {
  assert.equal(headwayFor(graph, 'K', VACATION), 3000);
  assert.equal(headwayFor(graph, 'D2', VACATION), DEFAULT_HEADWAY_S, 'not term time’s 7 min');
  const termOnly = { ...graph, headwaysByTime: { K: { term: graph.headwaysByTime.K.term } } };
  assert.equal(headwayFor(termOnly, 'K', VACATION), 2400, 'not 12 min for a bus every 40');
  assert.equal(headwayFor(graph, 'K', at('2035-01-01T09:00')), 2400, 'past the calendar: not the vacation’s');
  assert.equal(headwayFor(graph, 'A1', THU_0930), DEFAULT_HEADWAY_S, 'a service never measured');
});

test('the day kinds and periods are the ones the service hours use', () => {
  assert.deepEqual([THU_0930, SAT, SUN, HOLIDAY].map(dayKindOf), ['weekday', 'saturday', 'sunday', 'sunday']);
  assert.equal(periodOf(THU_0930), 'term');
  assert.equal(periodOf(VACATION), 'vacation');
  assert.equal(periodOf(at('2035-01-01T09:00')), null, 'no calendar for it');
});

/** Buses of `svc` at `stop` every `gapS` from `from`, `n` of them, plates in turn from `plates`. */
const every = (svc, stop, from, gapS, n, plates = ['A', 'B', 'C']) =>
  Array.from({ length: n }, (_, i) => ({ svc, stop, t: from + i * gapS * 1000, plate: plates[i % plates.length] }));

test('headwaysOf: the median gap between buses, by hour and day, with enough of them', () => {
  const at9 = at('2026-08-27T09:00');
  const passings = [
    // Two stops, a bus every 6 min from 09:00 for two hours.
    ...every('D2', 'PGP', at9, 360, 21),
    ...every('D2', 'UTOWN', at9 + 60_000, 360, 21),
    // Two this close are a bunch, not a headway.
    { svc: 'D2', stop: 'PGP', t: at9 + 10_000, plate: 'B' },
    // Too few on a Saturday for a median.
    ...every('D2', 'PGP', at('2026-08-29T09:00'), 600, 5),
    // In the vacation: measured on its own, and not part of the usual.
    ...every('D2', 'PGP', at('2026-12-21T09:00'), 900, 30),
  ];
  const { usualS, byTime } = headwaysOf(passings);
  assert.equal(usualS.D2, 360);
  const weekday = byTime.D2.term.weekday;
  assert.equal(weekday.all, 360);
  assert.deepEqual(weekday.hours, { 9: 360, 10: 360 });
  assert.equal(byTime.D2.term.saturday, undefined, `fewer than ${MIN_GAPS} gaps`);
  assert.equal(byTime.D2.vacation.weekday.all, 900);
});

test('headwaysOf: one bus running alone comes round again a lap later, and that lap is the headway', () => {
  const passings = every('K', 'PGP', at('2026-08-29T08:00'), 2400, 25, ['X']);
  assert.equal(headwaysOf(passings).byTime.K.term.saturday.all, 2400);
});

test('headwaysOf: a gap over two hours is a break in service, not a headway', () => {
  const passings = every('K', 'PGP', at('2026-08-27T08:00'), 3 * 3600, 40);
  assert.deepEqual(headwaysOf(passings), { usualS: {}, byTime: {} });
});

test('data/headways.json is in the graph, for shuttles only, at minutes-scale', () => {
  const shuttles = new Set(Object.keys(GRAPH.routes));
  const ok = (s, where) => assert.ok(Number.isInteger(s) && s >= 60 && s <= 2 * 3600, `${where}: ${s}`);
  assert.ok(Object.keys(headways.usualS).length > 0);
  for (const [svc, s] of Object.entries(headways.usualS)) {
    assert.ok(shuttles.has(svc), `${svc} is a shuttle`);
    ok(s, svc);
    assert.equal(GRAPH.headwayS[svc], s);
  }
  for (const [svc, periods] of Object.entries(headways.byTime)) {
    assert.ok(shuttles.has(svc), `${svc} is a shuttle`);
    for (const [period, days] of Object.entries(periods)) {
      assert.ok(['term', 'vacation'].includes(period), period);
      for (const [day, { all, hours }] of Object.entries(days)) {
        assert.ok(['weekday', 'saturday', 'sunday'].includes(day), day);
        ok(all, `${svc} ${period} ${day}`);
        for (const [hour, s] of Object.entries(hours)) {
          assert.match(hour, /^(\d|1\d|2[0-3])$/);
          ok(s, `${svc} ${period} ${day} ${hour}:00`);
        }
      }
    }
  }
  assert.deepEqual(GRAPH.headwaysByTime, headways.byTime);
});

/** D2 every 10 min at 08:00, 5 at 09:00, 7 at 10:00, on a weekday in term. */
const hourly = {
  stops: [],
  routes: {},
  headwayS: { D2: 420 },
  headwaysByTime: { D2: { term: { weekday: { all: 420, hours: { 8: 600, 9: 300, 10: 420 } } } } },
};
const scheduled = (nowMs, stop = { code: 'PGP', name: 'PGP', lat: 0, lon: 0 }) => ({
  svc: 'D2',
  stop,
  walkS: 60,
  rideS: 600,
  boardS: 300,
  totalS: 900,
  fromMs: nowMs,
  quality: 'scheduled',
  hops: 5,
});

test('with no live times, the chosen bus stays among the departures though the headway changes by the hour', () => {
  const now = at('2026-08-27T08:40');
  const chosen = at('2026-08-27T10:10');
  const input = { options: [scheduled(now)], candidates: [], byStop: new Map(), graph: hourly, arriveBy: null, walkAllS: null, nowMs: now };
  const boards = departures(input, at('2026-08-27T11:00'), { svc: 'D2', stop: 'PGP', board: new Date(chosen).toISOString() });
  assert.ok(
    boards.some((l) => Date.parse(l.board) === chosen),
    boards.map((l) => l.board),
  );
});

test("a class's leave-by with no live times is a headway early by the hour the bus is caught, not the class's", () => {
  // A 10:05 class: the bus is caught before 09:52, at 09:00's headway, not 10:00's.
  const now = at('2026-08-27T07:00');
  const arriveBy = { atMs: at('2026-08-27T10:05'), venueWalkS: 0 };
  const b = scheduled(now);
  const sa = { code: 'PGP', arrivals: [], fetchedAt: now, stale: false, available: true };
  const l = leaveBy({ options: [b], candidates: [], byStop: new Map([['PGP', sa]]), graph: hourly, arriveBy, walkAllS: null, nowMs: now });
  const latestBoard = Date.parse(l.arrive) - b.rideS * 1000;
  assert.equal(latestBoard - Date.parse(l.board), 300_000);
});

test('in a residence that is not yours, standing at its stop is being at the stop, whatever your home stops are', () => {
  const krb = GRAPH.stops.find((s) => s.code === 'KRB');
  assert.ok(residenceAt(krb.lat, krb.lon), 'KRB is inside a residence');
  // A home stop across the road from another residence's: not this one's.
  const input = { lat: krb.lat, lon: krb.lon, to: 'COM3', preferStops: ['NUSS-OPP'], homeWalkS: 120 };
  const c = candidateStops(GRAPH, input, { any: true }).find((x) => x.stop.code === 'KRB');
  assert.equal(c.here, true);
  assert.equal(c.walkS, 0);
});
