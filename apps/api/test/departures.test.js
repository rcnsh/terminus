/**
 * A service's departures from a stop (departures.ts): the feed's live
 * times, then estimates one headway apart while the service runs, and
 * the card and the leave-by that read them. On the real graph, with the
 * measured headways (data/headways.json), where the point is the hours.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { GRAPH } from '../src/answer/graph.ts';
import { departuresFrom, nextDeparture } from '../src/answer/departures.ts';
import { headwayFor } from '../src/answer/hours.ts';
import { nearbyRow, readyS, scoreLeg, scoreOptions } from '../src/answer/resolve.ts';
import { departureOf, departures, leaveBy } from '../src/answer/leave.ts';
import { withSteps } from '../src/answer/answer.ts';
import { SAME_BUS_MS } from '../src/answer/plan.ts';
import { STEP } from '../src/config.ts';
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

test('with its hours unknown, a service is guessed for, as far as a day ahead unless asked further', () => {
  const unknown = { ...GRAPH, serviceHours: {} };
  const sa = board('PGP', NOW, 'D2', [LAST]);
  const ds = departuresFrom(unknown, sa, 'D2', { now: NOW, from: NOW });
  assert.ok(ds.length > 3);
  assert.ok(ds.at(-1).latest <= NOW + 86_400_000, 'not past a day');
  const empty = departuresFrom(unknown, board('PGP', NOW, 'D2', []), 'D2', { now: NOW, from: NOW });
  assert.ok(empty.at(-1).latest <= NOW + 86_400_000, 'nor with no live times');
  // A class two days off asks up to its latest board.
  const far = departuresFrom(unknown, board('PGP', NOW, 'D2', []), 'D2', { now: NOW, from: NOW, until: NOW + 2 * 86_400_000 });
  assert.ok(far.at(-1).latest > NOW + 2 * 86_400_000 - 3600_000, 'up to it');

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

test('a departure is known by its identity, not by which object it is: a copy is the same bus, and the identity stays inside', () => {
  const now = at('2026-08-27T16:00');
  const byStop = new Map([['PGP', board('PGP', now, 'D2', [])]]);
  const candidates = [{ stop: PGP, distM: 0, walkS: 60, legs: [{ svc: 'D2', hops: 5, to: { code: 'UTOWN', name: 'UTown' } }] }];
  const options = scoreOptions(GRAPH, candidates, byStop, now);
  const f = { options, candidates, byStop, graph: GRAPH, arriveBy: null, walkAllS: null, nowMs: now };
  const all = departures(f, now + 3600_000);
  const copies = all.map((l) => ({ ...l }));
  assert.deepEqual(departureOf(copies, options[0]), all[0]);

  // A chosen bus sent back is the user's: the leave-by the answer gives has no identity on it.
  const departsAt = new Date(now + options[0].boardS * 1000).toISOString();
  const later = withSteps({ departsAt, leave: null }, f, { trip: 'to:UTOWN', target: null }, false, now).steps.later;
  const s = withSteps({ departsAt, leave: null }, f, { trip: 'to:UTOWN', target: later }, false, now);
  assert.equal(s.leave.board, later.board);
  assert.ok(!('bus' in s.leave), Object.keys(s.leave).join());
});

test('a bus the feed lists twice is two departures, each its own, and so are the estimates after it', () => {
  // A loop one bus runs alone: the feed gives its next pass and the one after, both P1.
  const now = at('2026-08-27T10:00');
  const sa = { ...board('PGP', now, 'D2', [at('2026-08-27T10:05'), at('2026-08-27T10:35')]) };
  sa.arrivals = sa.arrivals.map((a) => ({ ...a, plate: 'P1' }));
  const ids = departuresFrom(GRAPH, sa, 'D2', { now, from: now, max: 4 }).map((d) => d.id);
  assert.deepEqual(ids, ['P1', 'P1@2', 'P1@2+1', 'P1@2+2']);
});

test('no departure leaves after `until`: a window that ends past it is left out, before the service starts too', () => {
  const now = at('2026-08-27T06:30');
  for (const until of [at('2026-08-27T08:30'), at('2026-08-27T07:16'), at('2026-08-27T07:15')]) {
    for (const around of [undefined, until]) {
      const ds = departuresFrom(GRAPH, board('PGP', now, 'D2', []), 'D2', {
        now,
        from: now + 80_000,
        until,
        ...(around ? { around } : {}),
      });
      for (const d of ds) assert.ok(d.latest <= until, `${hhmmss(d.earliest)}–${hhmmss(d.latest)} past ${hhmmss(until)}`);
    }
  }
  const ds = departuresFrom(GRAPH, board('PGP', now, 'D2', []), 'D2', { now, from: now, until: at('2026-08-27T08:30') });
  assert.ok(ds.length > 3 && ds.at(-1).latest > at('2026-08-27T08:30') - 3 * headwayFor(GRAPH, 'D2', now) * 1000, 'up to it');
});

test("before the service starts, the windows around a chosen bus meet the start's own, with no gap between", () => {
  // D2 starts at 07:15, every 430 s at 07:00; the windows meet at 08:30.
  const now = at('2026-08-27T06:30');
  const ds = departuresFrom(GRAPH, board('PGP', now, 'D2', []), 'D2', {
    now,
    from: now + 80_000,
    until: at('2026-08-27T08:30'),
    around: at('2026-08-27T08:30'),
  });
  assert.equal(hhmmss(ds[0].earliest), '07:15:00');
  assert.ok(ds[0].latest - ds[0].earliest >= 430_000, 'the first bus is due within it');
  for (let i = 1; i < ds.length; i++)
    assert.equal(ds[i].earliest, ds[i - 1].latest, `${hhmmss(ds[i - 1].latest)} to ${hhmmss(ds[i].earliest)}`);
  assert.equal(hhmmss(ds.at(-1).latest), '08:30:00');
});

test("tomorrow morning's class leave-by is the same whether or not the feed lists a bus tonight", () => {
  // 22:40 on a weekday; D2 closes at 23:00 and starts at 07:15. The latest you can board is 07:50 tomorrow.
  const now = at('2026-08-27T22:40');
  const rideS = 600;
  const arriveBy = { atMs: at('2026-08-28T07:50') + (ON_TIME_SLACK_S + rideS) * 1000, venueWalkS: 0 };
  const leaveFor = (times) =>
    leaveBy({
      options: [{ svc: 'D2', stop: PGP, walkS: 60, rideS, boardS: 0, totalS: 0, fromMs: now, quality: 'scheduled', hops: 5 }],
      candidates: [],
      byStop: new Map([['PGP', board('PGP', now, 'D2', times)]]),
      graph: GRAPH,
      arriveBy,
      walkAllS: null,
      nowMs: now,
    });
  const empty = leaveFor([]);
  assert.equal(hhmmss(Date.parse(empty.arrive) - rideS * 1000), '07:50:00', 'a window that ends at the latest you can board');
  assert.deepEqual(leaveFor([at('2026-08-27T22:50')]), empty);
});

test('a class a day or more ahead counts on a window that ends at the latest you can board, however far off', () => {
  // 10:00 on a Thursday with an empty feed; the class is at 14:00 tomorrow or the day after.
  const now = at('2026-08-27T10:00');
  const rideS = 600;
  for (const day of ['2026-08-28', '2026-08-29']) {
    const latest = at(`${day}T13:40`);
    const l = leaveBy({
      options: [{ svc: 'D2', stop: PGP, walkS: 60, rideS, boardS: 0, totalS: 0, fromMs: now, quality: 'scheduled', hops: 5 }],
      candidates: [],
      byStop: new Map([['PGP', board('PGP', now, 'D2', [])]]),
      graph: GRAPH,
      arriveBy: { atMs: latest + (ON_TIME_SLACK_S + rideS) * 1000, venueWalkS: 0 },
      walkAllS: null,
      nowMs: now,
    });
    assert.equal(Date.parse(l.arrive) - rideS * 1000, latest, day);
    assert.equal(latest - Date.parse(l.board), Math.max(60, headwayFor(GRAPH, 'D2', latest - 1)) * 1000, `${day}: a headway before it`);
  }

  // The days between are a headway at a time too, from each start, whatever day the windows meet at.
  const latest = at('2026-09-03T13:40');
  const ds = departuresFrom(GRAPH, board('PGP', now, 'D2', []), 'D2', { now, from: now, until: latest, around: latest });
  const friday = ds.filter((d) => d.earliest >= at('2026-08-28T07:15') && d.latest <= at('2026-08-28T23:00'));
  assert.ok(friday.length > 50, `${friday.length} on the Friday`);
  for (const d of friday)
    assert.ok(d.latest - d.earliest <= 2 * Math.max(60, headwayFor(GRAPH, 'D2', d.earliest)) * 1000, hhmmss(d.earliest));
});

test("a trip's second bus a day or more ahead is looked for from when the first gets you to it", () => {
  // P runs 08:20 to 17:25 on weekdays, about hourly; the first bus gets you to KR-MRT at 12:29:49 tomorrow.
  const now = at('2026-08-27T10:00');
  const from = at('2026-08-28T12:29:49');
  const d = nextDeparture(GRAPH, board('KR-MRT', now, 'P', []), 'P', from, now);
  assert.ok(d, 'a bus, though more than a day after now');
  assert.deepEqual([d.earliest, d.latest], [from, from + Math.max(60, headwayFor(GRAPH, 'P', from)) * 1000]);
  // The same asked before P starts today: tomorrow's bus isn't counted from today's start.
  const early = at('2026-08-27T08:10');
  assert.deepEqual(nextDeparture(GRAPH, board('KR-MRT', early, 'P', []), 'P', from, early), d);
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

test('with a bus chosen and no live times, the card\'s own bus is still the one "Later" counts from', () => {
  const now = at('2026-08-27T16:00');
  const byStop = new Map([['PGP', board('PGP', now, 'D2', [])]]);
  const candidates = [{ stop: PGP, distM: 0, walkS: 60, legs: [{ svc: 'D2', hops: 5, to: { code: 'UTOWN', name: 'UTown' } }] }];
  const options = scoreOptions(GRAPH, candidates, byStop, now);
  const f = { options, candidates, byStop, graph: GRAPH, arriveBy: null, walkAllS: null, nowMs: now };
  const departsAt = new Date(now + options[0].boardS * 1000).toISOString();
  const target = { svc: 'D2', stop: 'PGP', board: '2026-08-27T08:58:58Z' };
  const s = withSteps({ departsAt, leave: null }, f, { trip: 'to:UTOWN', target }, false, now);
  const later = s.steps?.later;
  // Never a bus you'd leave for more than STEP.laterMaxS after the card's own (leave now, 16:00).
  assert.ok(!later || Date.parse(later.board) - 80_000 <= now + STEP.laterMaxS * 1000, later?.board);
});

test('estimates long after the last live bus are the same buses as stepping a headway at a time, across the hours', () => {
  // The last live D2 at 08:00; you can be at the stop from 14:31, past six hours of changing headways.
  const now = at('2026-08-27T07:59');
  const sa = board('PGP', now, 'D2', [at('2026-08-27T08:00')]);
  const from = at('2026-08-27T14:31');
  const step = (ms) => Math.max(60, headwayFor(GRAPH, 'D2', ms)) * 1000;
  const expected = [];
  let t = at('2026-08-27T08:00') + step(at('2026-08-27T08:00'));
  for (let n = 1; expected.length < 12; n++, t += step(t)) if (t >= from) expected.push({ id: `P0+${n}`, at: t });
  assert.ok(new Set(expected.map((e) => step(e.at))).size > 1, 'the headway changes among them');
  const got = departuresFrom(GRAPH, sa, 'D2', { now, from, max: 12 }).map((d) => ({ id: d.id, at: d.earliest }));
  assert.deepEqual(got, expected);
});

test('the first bus after the start waits for it, however many headways in you reach the stop', () => {
  // D2 starts at 07:15, every 430 s at 07:00: its first window ends at 07:22:10.
  const now = at('2026-08-27T07:10');
  const sa = board('PGP', now, 'D2', []);
  for (const reach of ['07:16', '07:23']) {
    const [d] = departuresFrom(GRAPH, sa, 'D2', { now, from: at(`2026-08-27T${reach}`) });
    assert.equal(d.opens, true, reach);
    // Not for a trip that can't wait for the start; for a class, no wait once you're there after it.
    const earliestS = (at(`2026-08-27T${reach}`) - now) / 1000;
    assert.equal(scoreLeg(GRAPH, leg, sa, now, earliestS), null, reach);
    assert.equal(scoreLeg(GRAPH, leg, sa, now, earliestS, { openBy: at('2026-08-27T08:00') }).opensInS, 0);
  }
});

test('late for a class, a bus you reach after the service starts is "leave now", not a wait for the start', () => {
  // D2 starts at 07:15 and its first window ends at 07:22:10; you can be at the stop by 07:23.
  const now = at('2026-08-27T07:10');
  const rideS = 600;
  const walkS = (at('2026-08-27T07:23') - now) / 1000 - readyS({ walkS: 0 });
  const arriveBy = { atMs: at('2026-08-27T07:30'), venueWalkS: 0 };
  const l = leaveBy({
    options: [{ svc: 'D2', stop: PGP, walkS, rideS, boardS: 0, totalS: 0, fromMs: now, quality: 'scheduled', hops: 5 }],
    candidates: [],
    byStop: new Map([['PGP', board('PGP', now, 'D2', [])]]),
    graph: GRAPH,
    arriveBy,
    walkAllS: null,
    nowMs: now,
  });
  assert.equal(l.at, new Date(now).toISOString().replace('.000Z', 'Z'));
});

test('with no live times, after "Later", "Earlier" still goes back to the bus before it as the clock moves on', () => {
  // D2 every 422 s at 19:00; the feed answers with nothing.
  const answerAt = (now, target) => {
    const byStop = new Map([['PGP', board('PGP', now, 'D2', [])]]);
    const candidates = [{ stop: PGP, distM: 0, walkS: 60, legs: [{ svc: 'D2', hops: 5, to: { code: 'UTOWN', name: 'UTown' } }] }];
    const options = scoreOptions(GRAPH, candidates, byStop, now);
    const f = { options, candidates, byStop, graph: GRAPH, arriveBy: null, walkAllS: null, nowMs: now };
    const departsAt = new Date(now + options[0].boardS * 1000).toISOString();
    return withSteps({ departsAt, leave: null }, f, { trip: 'to:UTOWN', target }, false, now).steps;
  };
  const now = at('2026-08-27T19:10');
  const later = answerAt(now, null).later;
  assert.ok(later);
  for (const s of [5, 60, 300]) {
    const steps = answerAt(now + s * 1000, later);
    assert.ok(steps?.moved, `${s} s on: still the bus chosen`);
    assert.ok(steps.earlier, `${s} s on: a bus before it`);
  }
});

test('with no live times, a class less than a headway off is not counted on the part of a window left', () => {
  // D2 every 494 s at 16:00; the latest you can board is 2 min after you can be at the stop.
  const now = at('2026-08-27T16:00');
  const rideS = 600;
  const from = now + readyS({ walkS: 60 }) * 1000;
  const arriveBy = { atMs: from + 120_000 + (ON_TIME_SLACK_S + rideS) * 1000, venueWalkS: 0 };
  const l = leaveBy({
    options: [{ svc: 'D2', stop: PGP, walkS: 60, rideS, boardS: 0, totalS: 0, fromMs: now, quality: 'scheduled', hops: 5 }],
    candidates: [],
    byStop: new Map([['PGP', board('PGP', now, 'D2', [])]]),
    graph: GRAPH,
    arriveBy,
    walkAllS: null,
    nowMs: now,
  });
  assert.equal(
    Date.parse(l.arrive) - rideS * 1000,
    from + Math.max(60, headwayFor(GRAPH, 'D2', from)) * 1000,
    'a bus by the end of a headway',
  );
});

test('a chosen bus that has left lines up nothing: the steps are as if none was chosen', () => {
  // D2 every 494 s at 16:00, no live times; the chosen bus left 10 s ago.
  const now = at('2026-08-27T16:00');
  const byStop = new Map([['PGP', board('PGP', now, 'D2', [])]]);
  const candidates = [{ stop: PGP, distM: 0, walkS: 60, legs: [{ svc: 'D2', hops: 5, to: { code: 'UTOWN', name: 'UTown' } }] }];
  const options = scoreOptions(GRAPH, candidates, byStop, now);
  const f = { options, candidates, byStop, graph: GRAPH, arriveBy: null, walkAllS: null, nowMs: now };
  const gone = { svc: 'D2', stop: 'PGP', board: new Date(now - 10_000).toISOString().replace('.000Z', 'Z') };
  assert.deepEqual(departures(f, now + 3600_000, gone), departures(f, now + 3600_000, null));
  const departsAt = new Date(now + options[0].boardS * 1000).toISOString();
  const steps = (target) => withSteps({ departsAt, leave: null }, f, { trip: 'to:UTOWN', target }, false, now).steps;
  assert.deepEqual(steps(gone), steps(null));
});
