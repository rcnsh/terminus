/**
 * A service's departures from a stop: the feed's live times, then
 * estimates one headway apart, only while the service runs. Every caller
 * that needs a bus of one service at one stop (the card, the leave-by,
 * the steps between buses, Nearby, a trip's second bus) asks here, so
 * they all guess the same buses. See internals.md, "Headways are
 * measured, by the hour" and "Operating hours bound every guess".
 */

import type { Arrival, Graph, StopArrivals } from '../types.ts';
import { beforeOpening, feedFor, headwayFor, inService, resolveBerths, serviceResumesAt } from './resolve.ts';
import { isPublic } from './public.ts';

/** How far ahead a bus is looked for: past a day it's no bus. */
export const PROJECT_MS = 86_400_000;

/** One bus of a service leaving a stop. */
export interface Departure {
  /** Which bus: the live bus's plate (or its place in the feed's list), or `<anchor>+n` for an estimate. */
  id: string;
  kind: 'live' | 'stale' | 'estimate';
  /** When it leaves, epoch ms: the window it's due in. A time from the feed is one instant. */
  earliest: number;
  latest: number;
  /** The feed's row, for a time from the feed. */
  arrival?: Arrival;
  /** The first bus after the service starts: you wait for it to start. */
  opens?: true;
}

/** The times to look in, epoch ms. */
export interface DepartureWindow {
  /** The request's now. */
  now: number;
  /** When you can be at the stop: no bus that has gone by then. */
  from: number;
  /** No bus leaving after this; a day after `from` when absent. */
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
export function liveBuses(graph: Graph, svc: string, sa: StopArrivals | undefined, nowMs: number): LiveBus[] {
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
 * live times in the window, then estimates one headway apart while the
 * service runs. With no live times an estimate is a bus somewhere in a
 * headway (`earliest` to `latest`); stepped on from a live bus, it is a
 * headway after it.
 */
export function departuresFrom(graph: Graph, board: StopArrivals | undefined, svc: string, w: DepartureWindow): Departure[] {
  const until = w.until ?? w.from + PROJECT_MS;
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

  if (live.length) {
    // Past the last live time, one headway at a time, while the service runs.
    const last = live[live.length - 1];
    for (let n = 1, t = last.at + headwayAt(last.at); t <= until && t <= last.at + PROJECT_MS && out.length < max; n++) {
      if (!runs(t)) break;
      if (t >= w.from) out.push({ id: `${last.id}+${n}`, kind: 'estimate', earliest: t, latest: t });
      t += headwayAt(t);
    }
    return out;
  }

  // No live times: there by `from`, and a bus within a headway, once it runs.
  // Around a chosen bus, the windows meet at it, so it stays among them as
  // the clock moves on: back from it a headway at a time to `from`.
  let fixed: number[] = [];
  if (w.around !== undefined) {
    let b = w.around;
    if (b >= w.from) {
      fixed = [b];
      for (let x = b - headwayAt(b - headwayAt(b)); x >= w.from && fixed.length < 2000; x -= headwayAt(x - headwayAt(x))) fixed.unshift(x);
    } else {
      while (b < w.from) b += headwayAt(b);
      fixed = [b];
    }
  }
  const anchor = fixed.length ? 'around' : 'reach';
  let t = fixed.length ? fixed[0] : w.from;
  for (let n = 1, i = 0; out.length < max; n++, i++) {
    let opens = false;
    if (!runs(t)) {
      const s = serviceResumesAt(graph, svc, t);
      if (s === null || s > t + PROJECT_MS) break;
      t = s;
      opens = true;
      fixed = [];
    }
    if (t > until) break;
    const end = i + 1 < fixed.length ? fixed[i + 1] : t + headwayAt(t);
    out.push({ id: `${anchor}+${n}`, kind: 'estimate', earliest: t, latest: end, ...(opens ? { opens: true as const } : {}) });
    t = end;
  }
  return out;
}

/** The first of `svc`'s departures you can be at the stop for by `fromMs`; null when there is none within a day. */
export function nextDeparture(graph: Graph, board: StopArrivals | undefined, svc: string, fromMs: number, nowMs: number): Departure | null {
  return departuresFrom(graph, board, svc, { now: nowMs, from: fromMs, max: 1 })[0] ?? null;
}
