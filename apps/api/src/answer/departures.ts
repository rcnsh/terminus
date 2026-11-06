/**
 * A service's departures from a stop: the feed's live times, then
 * estimates one headway apart, only while the service runs. Every caller
 * that needs a bus of one service at one stop (the card, the leave-by,
 * the steps between buses, Nearby, a trip's second bus) asks here, so
 * they all guess the same buses. See internals.md, "Headways are
 * measured, by the hour" and "Operating hours bound every guess".
 */

import type { Arrival, Graph, StopArrivals } from '../types.ts';
import {
  beforeOpening,
  feedFor,
  headwayFor,
  inService,
  resolveBerths,
  serviceClosedAt,
  serviceEndsAt,
  serviceResumesAt,
} from './resolve.ts';
import { isPublic } from './public.ts';

/** How far ahead of now a bus is looked for: past a day it's no bus, whatever the hours say (or don't). */
const PROJECT_MS = 86_400_000;

/** One bus of a service leaving a stop. */
export interface Departure {
  /**
   * Which bus: the live bus's plate (or its place in the feed's list), or
   * the nth estimate after its anchor (`<plate>+n`, `reach+n`, `around+n`,
   * `opens@<ms>+n`). The same for every caller asking of the same board.
   */
  id: string;
  /** A timetabled time (LTA's, or a first bus before the hours) is an estimate with its feed row. */
  kind: 'live' | 'stale' | 'estimate';
  /**
   * When it leaves, epoch ms. A time from the feed is one instant, and so
   * is an estimate stepped on from it, a headway after the bus before. An
   * estimate with no bus before it to step from is a bus due somewhere in
   * the window of a headway from when you can be at the stop (or the
   * service starts): the card shows the middle, the leave-by counts on the end.
   */
  earliest: number;
  latest: number;
  /** The feed's row, for a time from the feed. */
  arrival?: Arrival;
  /** The first bus after the service starts again: before it, you wait for the start. */
  opens?: true;
}

/** The times to look in, epoch ms. */
export interface DepartureWindow {
  /** The request's now. */
  now: number;
  /** When you can be at the stop: no bus that has gone by then. */
  from: number;
  /** No bus leaving after this; never more than a day after now. */
  until?: number;
  /** With no live time to step from, a time the estimates fall either side of (a bus already chosen). */
  around?: number;
  /** No more buses than this. */
  max?: number;
}

interface LiveBus {
  id: string;
  at: number;
  kind: Departure['kind'];
  arrival: Arrival;
}

/**
 * A service's buses at a stop: its live times, from the feed this service
 * came from (at a shelter two feeds answer for). Each time keeps what it is:
 * a public bus's timetabled one (LTA's Monitored 0) is an estimate, and one
 * from a stale feed an old reading, however exact.
 */
function liveBuses(graph: Graph, svc: string, sa: StopArrivals | undefined, nowMs: number): LiveBus[] {
  const feed = feedFor(sa, isPublic(graph, svc));
  if (!sa || !feed || feed.available === false) return [];
  return beforeOpening(graph, svc, resolveBerths(sa.arrivals.filter((a) => a.svc === svc)).usable, feed.fetchedAt, nowMs)
    .filter((a) => a.etaS != null)
    .map((a) => ({
      at: feed.fetchedAt + (a.etaS as number) * 1000,
      kind: (a.scheduled ? 'estimate' : feed.stale ? 'stale' : 'live') as Departure['kind'],
      arrival: a,
    }))
    .sort((a, b) => a.at - b.at)
    .map((b, i) => ({ ...b, id: b.arrival.plate ?? `#${i}` }));
}

/**
 * `svc`'s departures from the stop whose board is `board`, in order: the
 * live times in the window, then estimates a headway apart while the
 * service runs.
 */
export function departuresFrom(graph: Graph, board: StopArrivals | undefined, svc: string, w: DepartureWindow): Departure[] {
  const until = Math.min(w.until ?? Infinity, w.now + PROJECT_MS);
  const max = w.max ?? Infinity;
  // Each estimate counts the headway in force at the bus before it, so the
  // card, the leave-by and Nearby step the same way across an hour.
  const headwayAt = (ms: number) => Math.max(60, headwayFor(graph, svc, ms)) * 1000;
  const runs = (ms: number) => inService(graph, svc, ms);
  const live = liveBuses(graph, svc, board, w.now);
  const out: Departure[] = [];
  for (const b of live) {
    if (out.length >= max) return out;
    if (b.at >= w.from && b.at <= until) out.push({ id: b.id, kind: b.kind, earliest: b.at, latest: b.at, arrival: b.arrival });
  }

  // Past the last live time, one headway at a time while the service
  // runs: a bus a headway after the one before it, an instant as the live
  // times are. One due after the close is no bus: that was the last.
  const last = live.at(-1);
  let t = last ? last.at + headwayAt(last.at) : w.from;
  for (let n = 1; last && out.length < max && t <= until && runs(t); n++) {
    if (t >= w.from) out.push({ id: `${last.id}+${n}`, kind: 'estimate', earliest: t, latest: t });
    t += headwayAt(t);
  }

  // With nothing to step from: a bus somewhere in the headway from when
  // you can be at the stop, the next in the headway after that, and so
  // on. Around a bus already chosen, the windows meet at it, so it stays
  // among them as the clock moves on: back from it a headway at a time to
  // `from`. Before the service starts, or after it has stopped for the
  // day, the first bus is due within a headway of the next start; after
  // that one, the windows around a chosen bus carry on as they would with
  // the service running, so a class's leave-by is the same at 06:30 as at 07:30.
  let fixed: number[] = [];
  // A chosen bus more than a day off (a step target kept, or sent, from
  // long ago) says nothing of today's buses, and walking to it a headway
  // at a time would take millions of steps.
  if (!last && w.around !== undefined && Math.abs(w.around - w.now) <= PROJECT_MS) {
    let b = w.around;
    // Closed by then, after running: the windows meet at the close, so the
    // last one before it is a whole headway, and a bus sure to come.
    const closed = runs(b) ? null : serviceClosedAt(graph, svc, b);
    if (closed !== null && closed > w.from) b = closed;
    if (b >= w.from) {
      fixed = [b];
      for (let x = b - headwayAt(b - headwayAt(b)); x >= w.from && fixed.length < 2000; x -= headwayAt(x - headwayAt(x))) fixed.unshift(x);
    } else {
      while (b < w.from) b += headwayAt(b);
      fixed = [b];
    }
    t = fixed[0];
  }
  let anchor = fixed.length ? 'around' : 'reach';
  let opens = false;
  // The windows around a chosen bus to carry on with after the start's own.
  let resume: number[] = [];
  const startAt = (s: number) => {
    resume = fixed.filter((f) => f >= s + headwayAt(s));
    [t, fixed, anchor, opens] = [s, [], `opens@${s}`, true];
  };
  // Not started yet, and starting before you get there: from its start.
  const starts = last || runs(w.now) ? null : serviceResumesAt(graph, svc, w.now);
  if (starts !== null && starts <= t) startAt(starts);
  for (let n = 1, i = 0; out.length < max && t <= until; n++, i++) {
    if (!runs(t)) {
      const s = serviceResumesAt(graph, svc, t);
      if (s === null || s > until) break;
      startAt(s);
      [n, i] = [1, 0];
    }
    // A bus may still come before the service closes, not after.
    const closes = serviceEndsAt(graph, svc, t);
    const end = Math.min(i + 1 < fixed.length ? fixed[i + 1] : t + headwayAt(t), closes ?? Infinity);
    if (end >= w.from) {
      out.push({
        id: `${anchor}+${n}`,
        kind: 'estimate',
        earliest: Math.max(t, w.from),
        latest: end,
        ...(opens ? { opens: true as const } : {}),
      });
    }
    opens = false;
    t = end;
    if (resume.length) [t, fixed, i, resume] = [resume[0], resume, -1, []];
  }
  return out;
}

/** The first of `svc`'s departures you can be at the stop for by `fromMs`; null when there is none within a day. */
export function nextDeparture(graph: Graph, board: StopArrivals | undefined, svc: string, fromMs: number, nowMs: number): Departure | null {
  return departuresFrom(graph, board, svc, { now: nowMs, from: fromMs, max: 1 })[0] ?? null;
}
