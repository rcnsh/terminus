/**
 * A service's departures from a stop (departures.ts): the feed's live
 * times, then estimates one headway apart while the service runs, and
 * the card and the leave-by that read them. On the real graph, with the
 * measured headways (data/headways.json), where the point is the hours.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { GRAPH } from '../src/answer/graph.ts';
import { departuresFrom } from '../src/answer/departures.ts';
import { nearbyRow, scoreLeg, scoreOptions } from '../src/answer/resolve.ts';
import { departureOf, departures, leaveBy } from '../src/answer/leave.ts';
import { withSteps } from '../src/answer/answer.ts';
import { SAME_BUS_MS } from '../src/answer/plan.ts';
import { ON_TIME_SLACK_S } from '../src/timetable/profile.ts';

/** An instant from a Singapore wall-clock time, "2026-08-27T19:40". */
const at = (sgt) => Date.parse(`${sgt}+08:00`);
const hhmmss = (ms) => new Date(ms + 8 * 3600_000).toISOString().slice(11, 19);

/** A board at `code` fetched at `fetchedAt`, with `svc`'s buses at these times. */
const board = (code, fetchedAt, svc, times, extra = {}) => ({
  code,
  fetchedAt,
  stale: false,
  available: true,
  arrivals: times.map((t, i) => ({ svc, etaS: (t - fetchedAt) / 1000, crowd: null, plate: `P${i}`, berth: null })),
  ...extra,
});

const PGP = GRAPH.stops.find((s) => s.code === 'PGP');
const leg = { svc: 'D2', hops: 5, off: undefined, to: { code: 'UTOWN', name: 'UTown' } };

// D2 on a weekday in term: every 422 s at 19:00, 654 s at 20:00.
const NOW = at('2026-08-27T19:40');
const LAST = at('2026-08-27T19:55');

test('an estimate counts the headway at the bus before it: past an hour, the card and the leave-by step alike', () => {
  const sa = board('PGP', NOW, 'D2', [LAST]);
  const [first, second] = departuresFrom(GRAPH, sa, 'D2', { now: NOW, from: LAST + 1 }).filter((d) => d.kind === 'estimate');
  assert.equal(hhmmss(first.latest), '20:02:02', 'the 19:00 headway, from the 19:55 bus');
  assert.equal(second.latest - first.latest, 654_000, 'the 20:00 headway, from the 20:02 bus');

  // The card: you can't be there for the 19:55, so the bus after it.
  const s = scoreLeg(GRAPH, { ...leg, rideS: 600 }, sa, NOW, (LAST - NOW) / 1000 + 60);
  const card = NOW + s.boardS * 1000;
  assert.ok(card >= first.earliest && card <= first.latest, hhmmss(card));

  // A class whose latest bus is at 20:10: the 20:02:02 one, not 20:05:54.
  const rideS = 600;
  const arriveBy = { atMs: at('2026-08-27T20:10') + (ON_TIME_SLACK_S + rideS) * 1000, venueWalkS: 0 };
  const option = { svc: 'D2', stop: PGP, walkS: 60, rideS, boardS: 0, totalS: 0, fromMs: NOW, quality: 'scheduled', hops: 5 };
  const l = leaveBy({
    options: [option],
    candidates: [],
    byStop: new Map([['PGP', board('PGP', NOW, 'D2', [at('2026-08-27T19:42'), LAST])]]),
    graph: GRAPH,
    arriveBy,
    walkAllS: null,
    nowMs: NOW,
  });
  assert.equal(hhmmss(Date.parse(l.arrive) - rideS * 1000), '20:02:02');
});

test('with no live times, the card and the leave-by read one window: the card its middle, the leave-by its end, by the close', () => {
  // D2 closes at 23:00 on a weekday and runs every 873 s at 22:00; the feed answered with nothing.
  const now = at('2026-08-27T22:45');
  const sa = board('PGP', now, 'D2', []);
  const from = now + 80_000;
  const [w] = departuresFrom(GRAPH, sa, 'D2', { now, from });
  assert.deepEqual([hhmmss(w.earliest), hhmmss(w.latest)], ['22:46:20', '23:00:00'], 'a bus before the close, if any');

  const s = scoreLeg(GRAPH, leg, sa, now, 80);
  assert.equal(hhmmss(now + s.boardS * 1000), '22:53:10', 'the middle of what is left');

  const rideS = 600;
  const option = { svc: 'D2', stop: PGP, walkS: 60, rideS, boardS: s.boardS, totalS: 0, fromMs: now, quality: 'scheduled', hops: 5 };
  const arriveBy = { atMs: at('2026-08-27T23:30'), venueWalkS: 0 };
  const l = leaveBy({
    options: [option],
    candidates: [],
    byStop: new Map([['PGP', sa]]),
    graph: GRAPH,
    arriveBy,
    walkAllS: null,
    nowMs: now,
  });
  assert.equal(hhmmss(Date.parse(l.board)), '22:46:20');
  assert.equal(hhmmss(Date.parse(l.arrive) - rideS * 1000), '23:00:00', 'counted on the end, not a headway past the close');
});

test('before the service starts, the first bus is due within a headway of the start; a class leave-by is as it will be once it runs', () => {
  // D2 starts at 07:15 on a weekday, every 430 s at 07:00; the feed lists nothing yet.
  const now = at('2026-08-27T06:30');
  const sa = board('PGP', now, 'D2', []);
  const chain = departuresFrom(GRAPH, sa, 'D2', { now, from: now + 80_000 });
  assert.deepEqual([hhmmss(chain[0].earliest), hhmmss(chain[0].latest), chain[0].opens], ['07:15:00', '07:22:10', true]);

  // Reaching the stop after it starts: what's left of that first window, not a headway from when you get there.
  const late = at('2026-08-27T07:10');
  const s = scoreLeg(GRAPH, leg, board('PGP', late, 'D2', []), late, 600, { openBy: at('2026-08-27T08:00') });
  assert.equal(hhmmss(late + s.boardS * 1000), '07:21:05');

  // A class with its latest bus at 09:50: from 06:30, as from 07:16 once D2 runs, a whole headway ending then.
  const rideS = 600;
  const latestBoard = at('2026-08-27T09:50');
  const arriveBy = { atMs: latestBoard + (ON_TIME_SLACK_S + rideS) * 1000, venueWalkS: 0 };
  const leave = (nowMs) =>
    leaveBy({
      options: [{ svc: 'D2', stop: PGP, walkS: 60, rideS, boardS: 0, totalS: 0, fromMs: nowMs, quality: 'scheduled', hops: 5 }],
      candidates: [],
      byStop: new Map([['PGP', board('PGP', nowMs, 'D2', [])]]),
      graph: GRAPH,
      arriveBy,
      walkAllS: null,
      nowMs,
    });
  const [early, running] = [leave(now), leave(at('2026-08-27T07:16'))];
  assert.deepEqual([early.board, early.arrive], [running.board, running.arrive]);
  assert.equal(Date.parse(early.arrive) - rideS * 1000, latestBoard);
});

test('no estimate is due after the service closes: the bus before the close was the last', () => {
  // D2 closes at 23:00; the last live bus at 22:50, every 873 s at 22:00.
  const now = at('2026-08-27T22:40');
  const ds = departuresFrom(GRAPH, board('PGP', now, 'D2', [at('2026-08-27T22:50')]), 'D2', {
    now,
    from: now,
    until: at('2026-08-27T23:30'),
  });
  assert.deepEqual(
    ds.map((d) => d.kind),
    ['live'],
  );
  // Nor on Nearby, whose row would otherwise run on to tomorrow's first buses.
  const all = departuresFrom(GRAPH, board('PGP', now, 'D2', [at('2026-08-27T22:50')]), 'D2', { now, from: now });
  const r = {
    svc: 'D2',
    etaS: 600,
    quality: 'live',
    ambiguousBerth: false,
    later: [],
    color: null,
    towards: [],
    via: [],
    crowd: null,
    endsAt: new Date(at('2026-08-27T23:00')).toISOString(),
    running: true,
    eta: '10 min',
    laterText: null,
    toText: '',
  };
  assert.deepEqual(nearbyRow(r, now, all).later, []);
});

test('with its hours unknown, a service is guessed for, as far as a day ahead', () => {
  const unknown = { ...GRAPH, serviceHours: {} };
  const sa = board('PGP', NOW, 'D2', [LAST]);
  const ds = departuresFrom(unknown, sa, 'D2', { now: NOW, from: NOW, until: NOW + 3 * 86_400_000 });
  assert.ok(ds.length > 3);
  assert.ok(ds.at(-1).latest <= NOW + 86_400_000, 'not past a day');
  const empty = departuresFrom(unknown, board('PGP', NOW, 'D2', []), 'D2', { now: NOW, from: NOW, until: NOW + 3 * 86_400_000 });
  assert.ok(empty.at(-1).earliest <= NOW + 86_400_000, 'nor with no live times');

  // Nearby: the row says nothing of when the service ends, and still gets its third bus.
  const r = {
    svc: 'D2',
    etaS: (LAST - NOW) / 1000,
    quality: 'live',
    ambiguousBerth: false,
    later: [],
    color: null,
    towards: [],
    via: [],
    crowd: null,
    endsAt: null,
    running: true,
    eta: '15 min',
    laterText: null,
    toText: '',
  };
  assert.equal(nearbyRow(r, NOW, ds).later.length, 2);
});

test("the card's bus is found among the departures by which bus it is, though its time is the middle of its window", () => {
  // The feed answered with no D2 at PGP: the card's bus is half a headway in, 247 s at 16:00.
  const now = at('2026-08-27T16:00');
  const byStop = new Map([['PGP', board('PGP', now, 'D2', [])]]);
  const candidates = [{ stop: PGP, distM: 0, walkS: 60, legs: [{ svc: 'D2', hops: 5, to: { code: 'UTOWN', name: 'UTown' } }] }];
  const options = scoreOptions(GRAPH, candidates, byStop, now);
  const best = options[0];
  assert.equal(best.quality, 'scheduled');
  const f = { options, candidates, byStop, graph: GRAPH, arriveBy: null, walkAllS: null, nowMs: now };
  const departsAt = new Date(now + best.boardS * 1000).toISOString();
  const all = departures(f, now + 3600_000);
  assert.equal(departureOf(all, best), all[0]);
  assert.ok(Date.parse(departsAt) - Date.parse(all[0].board) > SAME_BUS_MS, "further from its window's start than the feed moves a bus");

  // A trip with no leave-by of its own steps from that bus.
  const s = withSteps({ departsAt, leave: null }, f, { trip: 'to:UTOWN', target: null }, false, now);
  assert.ok(s.steps?.later, 'a later bus to step to');
});

test('a chosen bus from long ago is no guide to the estimates, and costs nothing to ignore', () => {
  const now = at('2026-08-27T16:00');
  const sa = board('PGP', now, 'D2', []);
  const plain = departuresFrom(GRAPH, sa, 'D2', { now, from: now, until: now + 3600_000 });
  const started = performance.now();
  const old = departuresFrom(GRAPH, sa, 'D2', { now, from: now, until: now + 3600_000, around: Date.parse('1970-01-01T00:00:00Z') });
  assert.ok(performance.now() - started < 100, `${Math.round(performance.now() - started)} ms`);
  assert.deepEqual(old, plain);
});
