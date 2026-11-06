/**
 * A service's departures from a stop: the feed's live times, then
 * estimates one headway apart, only while the service runs. Every caller
 * that needs a bus of one service at one stop (the card, the leave-by,
 * the steps between buses, Nearby, a trip's second bus) asks here, so
 * they all guess the same buses. See internals.md, "Headways are
 * measured, by the hour" and "Operating hours bound every guess".
 */

import type { Arrival, FeedState, Graph, StopArrivals } from '../types.ts';
import { headwayFor, inService, serviceClosedAt, serviceEndsAt, serviceResumesAt } from './hours.ts';
import { isPublic } from './public.ts';

/** How far ahead of now a bus is looked for: past a day it's no bus, whatever the hours say (or don't). */
const PROJECT_MS = 86_400_000;

/**
 * The headway a guess counts at `ms`, in ms: the measured one for that
 * hour, never under a minute. Every estimate here steps by it.
 */
export const headwayMs = (graph: Graph, svc: string, ms: number): number => Math.max(60, headwayFor(graph, svc, ms)) * 1000;

/** The next hour after `ms`, when a headway can change: Singapore is a whole number of hours ahead of UTC. */
const nextHour = (ms: number) => (Math.floor(ms / 3_600_000) + 1) * 3_600_000;

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
  /**
   * Around a chosen bus, the window you reach the stop in, cut at `from`:
   * its bus may have gone before you get there, so it's a bus to step to,
   * not one a leave-by can count on.
   */
  partial?: true;
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

/**
 * How close to its time a feed time for a service that hasn't opened yet is
 * believed. Outside its hours NUS's feed still lists times hours ahead that
 * don't match the published start (an A2 at 09:16, when its hours start at
 * 07:15); this close, it is the first buses getting ready.
 */
export const FIRST_BUS_LEAD_S = 30 * 60;

/**
 * `svc`'s feed times as they can be believed (times from `fetchedAt`).
 * Outside its hours, a time at or after the service next opens is no bus on
 * the road: dropped, or kept as a timetable time when it is within
 * FIRST_BUS_LEAD_S of now. A time before the opening is a bus still out from
 * the day that just ended, and stays as it is.
 */
export function beforeOpening(graph: Graph, svc: string, rows: Arrival[], fetchedAt: number, nowMs: number): Arrival[] {
  if (!rows.length || inService(graph, svc, nowMs)) return rows;
  const opens = serviceResumesAt(graph, svc, nowMs);
  if (opens === null) return rows;
  const out: Arrival[] = [];
  for (const a of rows) {
    const at = a.etaS == null ? null : fetchedAt + a.etaS * 1000;
    if (at === null || at < opens) out.push(a);
    else if (at - nowMs <= FIRST_BUS_LEAD_S * 1000) out.push({ ...a, scheduled: true });
  }
  return out;
}

/**
 * Pick the boardable rows when one service reports under several berths.
 *
 * Returns everything unchanged for the ordinary single-berth stop. When the
 * suffix cannot tell the berths apart, says so instead of guessing: that is
 * the one case where the earliest ETA might be a bus going the wrong way.
 */
export function resolveBerths(rows: Arrival[]): { usable: Arrival[]; ambiguousBerth: boolean } {
  // Drop the run that TERMINATES here rather than preferring the one marked
  // -S: route P starts at a bare `KV` and ends at `KV-P-E`, so a start suffix
  // is not guaranteed but an end suffix is what makes a row unboardable.
  const notEnding = rows.filter((a) => !a.ends);

  // Every run terminates here and none departs. Show them, but do not pretend
  // to be confident about a bus that ends its journey as you reach it.
  if (!notEnding.length) return { usable: rows, ambiguousBerth: rows.length > 0 };

  const distinct = new Set(notEnding.map((a) => a.berth).filter((b) => b != null));
  return { usable: notEnding, ambiguousBerth: distinct.size > 1 };
}

/**
 * The state of the feed a service's arrivals came from. A shelter both the
 * shuttle and public buses call at was asked of two feeds, and one can be
 * down or stale while the other answers; a stop asked of one feed is that
 * feed's state. Undefined when the stop was never asked.
 */
export function feedFor(sa: StopArrivals | undefined, pub: boolean): FeedState | undefined {
  if (!sa) return undefined;
  return sa.feeds?.[pub ? 'public' : 'shuttle'] ?? sa;
}

interface LiveBus {
  id: string;
  at: number;
  kind: Departure['kind'];
  arrival: Arrival;
}

/**
 * What the feed says of one service at one stop, read once: everything
 * asked of that service there (its departures, how sure they are, which
 * berth) starts from this.
 */
export interface ServiceBoard {
  svc: string;
  /** When the feed this service came from was fetched; undefined when the stop was never asked. */
  fetchedAt?: number;
  /** The feed answered and this service's rows read: nothing listed is no bus, not no data. */
  available: boolean;
  stale: boolean;
  /** The service is listed under several berths here, and they can't be told apart. */
  ambiguousBerth: boolean;
  paid: boolean;
  /** Its live times, in order. */
  live: LiveBus[];
}

/**
 * `svc` as the board at its stop has it, from the feed this service came
 * from (at a shelter two feeds answer for). Each time keeps what it is: a
 * public bus's timetabled one (LTA's Monitored 0) is an estimate, and one
 * from a stale feed an old reading, however exact.
 */
export function serviceBoard(graph: Graph, sa: StopArrivals | undefined, svc: string, nowMs: number): ServiceBoard {
  const paid = isPublic(graph, svc);
  const feed = feedFor(sa, paid);
  // At a terminus the feed splits one service into two berths: COM3-D2-S
  // is the run STARTING here, COM3-D2-E is a run ENDING here. Only the
  // first is boardable.
  const { usable, ambiguousBerth } = resolveBerths((sa?.arrivals ?? []).filter((a) => a.svc === svc));
  const answered = sa !== undefined && feed !== undefined && feed.available !== false;
  const live =
    answered && feed
      ? beforeOpening(graph, svc, usable, feed.fetchedAt, nowMs)
          .filter((a) => a.etaS != null)
          .map((a) => ({
            at: feed.fetchedAt + (a.etaS as number) * 1000,
            kind: (a.scheduled ? 'estimate' : feed.stale ? 'stale' : 'live') as Departure['kind'],
            arrival: a,
          }))
          .sort((a, b) => a.at - b.at)
          .map((b, i) => ({ ...b, id: b.arrival.plate ?? `#${i}` }))
      : [];
  return {
    svc,
    ...(feed ? { fetchedAt: feed.fetchedAt } : {}),
    // A service whose rows didn't read has no data, though the rest of the board does.
    available: answered && !sa?.unread?.includes(svc),
    stale: feed?.stale === true,
    ambiguousBerth,
    paid,
    live,
  };
}

/** A service's board as given: one already read, or read from its stop's now. */
const boardOf = (graph: Graph, board: StopArrivals | ServiceBoard | undefined, svc: string, nowMs: number): ServiceBoard =>
  board && 'live' in board ? board : serviceBoard(graph, board, svc, nowMs);

/**
 * `svc`'s departures from the stop whose board is `board`, in order: the
 * live times in the window, then estimates a headway apart while the
 * service runs. Pass a `serviceBoard` when asking of it more than once.
 */
export function departuresFrom(graph: Graph, board: StopArrivals | ServiceBoard | undefined, svc: string, w: DepartureWindow): Departure[] {
  const until = Math.min(w.until ?? Infinity, w.now + PROJECT_MS);
  const max = w.max ?? Infinity;
  // Each estimate counts the headway in force at the bus before it, so the
  // card, the leave-by and Nearby step the same way across an hour.
  const headwayAt = (ms: number) => headwayMs(graph, svc, ms);
  const runs = (ms: number) => inService(graph, svc, ms);
  const live = boardOf(graph, board, svc, w.now).live;
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
    if (t < w.from) {
      // None to catch yet: as many headways at once as stay within the
      // hour (the headway is the same through it), before the close and
      // short of `from`, so a bus hours after the last live one costs a
      // step an hour, the same buses as one a headway.
      const h = headwayAt(t);
      const k = Math.ceil((Math.min(w.from, nextHour(t), serviceEndsAt(graph, svc, t) ?? Infinity) - t) / h);
      [t, n] = [t + k * h, n + k - 1];
      continue;
    }
    out.push({ id: `${last.id}+${n}`, kind: 'estimate', earliest: t, latest: t });
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
  let partial = false;
  // A chosen bus more than a day off (a step target kept, or sent, from
  // long ago) says nothing of today's buses, and walking to it a headway
  // at a time would take millions of steps.
  if (!last && w.around !== undefined && Math.abs(w.around - w.now) <= PROJECT_MS) {
    let b = w.around;
    // Closed by then, after running: the windows meet at the close, so the
    // last one before it is a whole headway, and a bus sure to come.
    const closed = runs(b) ? null : serviceClosedAt(graph, svc, b);
    if (closed !== null && closed > w.from) b = closed;
    // Back, or on, to the window `from` falls in: its bus may still be one you can catch.
    if (b >= w.from) {
      fixed = [b];
      while (fixed[0] > w.from && fixed.length < 2000) fixed.unshift(fixed[0] - headwayAt(fixed[0] - headwayAt(fixed[0])));
    } else {
      let before = b;
      while (b < w.from) [before, b] = [b, b + headwayAt(b)];
      fixed = b > w.from ? [before, b] : [b];
    }
    partial = fixed[0] < w.from;
    t = Math.max(fixed[0], w.from);
  }
  let anchor = fixed.length ? 'around' : 'reach';
  let opens = false;
  // The windows around a chosen bus to carry on with after the start's own.
  let resume: number[] = [];
  const startAt = (s: number) => {
    resume = fixed.filter((f) => f >= s + headwayAt(s));
    [t, fixed, anchor, opens, partial] = [s, [], `opens@${s}`, true, false];
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
    const cut = partial;
    partial = false;
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
        ...(cut ? { partial: true as const } : {}),
      });
      // Only once one is pushed: reaching the stop after the start's own
      // window, the first you can catch still waits for the start.
      opens = false;
    }
    t = end;
    if (resume.length) [t, fixed, i, resume] = [resume[0], resume, -1, []];
  }
  return out;
}

/** The first of `svc`'s departures you can be at the stop for by `fromMs`; null when there is none within a day. */
export function nextDeparture(
  graph: Graph,
  board: StopArrivals | ServiceBoard | undefined,
  svc: string,
  fromMs: number,
  nowMs: number,
): Departure | null {
  return departuresFrom(graph, board, svc, { now: nowMs, from: fromMs, max: 1 })[0] ?? null;
}
