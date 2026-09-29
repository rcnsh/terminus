/**
 * When to set off.
 *
 * For a class, the question is not "which bus is next" but "how long can I
 * stay put and still be on time". That is the latest bus that still gets you
 * there, found among the live times first and, past them, one headway at a
 * time. Hours ahead there are no live times at all, so the answer assumes the
 * worst wait (a full headway) and says it is an estimate. Every service that
 * goes there is considered, not only the one in the headline: the next bus
 * and the one you can wait for are often different services.
 *
 * Without a class it is simply the next bus's departure minus the walk.
 */

import type { ArriveBy, Candidate, Graph, Leave, ScoredOption, StopArrivals } from './types.ts';
import { RIDE, WALK } from './config.ts';
import { headwayFor, resolveBerths } from './resolve.ts';
import { ON_TIME_SLACK_S } from './profile.ts';
import { isoSeconds, shortStop } from './format.ts';

export interface LeaveInput {
  /** Ranked options, best first. */
  options: ScoredOption[];
  /** Used when no service runs yet (before the morning's first bus). */
  candidates: Candidate[];
  byStop: Map<string, StopArrivals>;
  graph: Graph;
  arriveBy: ArriveBy | null | undefined;
  /** Seconds on foot when the answer is to walk the whole way (from home, when
   *  starting there); null otherwise. */
  walkAllS: number | null;
  nowMs: number;
}

/** Nothing worth saying: leaving within this is just "now". */
const NOW_S = 60;
const BUFFER_MS = WALK.boardBufferS * 1000;

interface Leg {
  svc: string;
  stop: { code: string; name: string };
  walkS: number;
  rideS: number;
}

export function leaveBy(f: LeaveInput): Leave | null {
  if (f.walkAllS != null) {
    // On foot: only a class gives a reason to wait.
    if (!f.arriveBy) return null;
    const at = f.arriveBy.atMs - (ON_TIME_SLACK_S + f.arriveBy.venueWalkS + f.walkAllS) * 1000;
    return { at: isoSeconds(at), estimated: false, svc: null, stop: null, board: null, arrive: isoSeconds(at + (f.walkAllS + f.arriveBy.venueWalkS) * 1000) };
  }

  if (!f.arriveBy) {
    const b = f.options[0];
    if (!b || b.quality === 'unknown') return null;
    const at = b.fetchedAt + b.boardS * 1000 - b.walkS * 1000 - BUFFER_MS;
    if (at - f.nowMs < NOW_S * 1000) return null;
    return { at: isoSeconds(at), estimated: b.quality === 'scheduled', svc: b.svc, stop: shortStop(b.stop.name), board: isoSeconds(b.fetchedAt + b.boardS * 1000), arrive: isoSeconds(b.fetchedAt + b.totalS * 1000) };
  }

  const legs: Leg[] = f.options.length
    ? f.options.map((o) => ({ svc: o.svc, stop: o.stop, walkS: o.walkS, rideS: o.rideS }))
    : fallbackLegs(f.candidates);
  let onTime: (Leave & { ms: number }) | null = null;
  let late: (Leave & { ms: number }) | null = null;
  for (const leg of legs) {
    const r = forLeg(leg, f.byStop.get(leg.stop.code), f.graph, f.arriveBy, f.nowMs);
    const out = { at: isoSeconds(r.ms), estimated: r.estimated, svc: leg.svc, stop: shortStop(leg.stop.name), board: isoSeconds(r.board), arrive: isoSeconds(r.arrive), ms: r.ms };
    // The latest on-time departure wins; if nothing is on time, the soonest.
    if (!r.late && (!onTime || r.ms > onTime.ms || (r.ms === onTime.ms && onTime.estimated && !r.estimated))) onTime = out;
    if (r.late && (!late || r.ms < late.ms)) late = out;
  }
  if (onTime) {
    const { ms: _ms, ...leave } = onTime;
    return leave;
  }
  if (!late) return null;
  // You'll be late whatever you do: the answer is to go now, for the first
  // bus you can catch. Clients show "Leave now" once `at` has passed.
  const { ms: _ms, ...leave } = late;
  return { ...leave, at: isoSeconds(Math.min(late.ms, f.nowMs)) };
}

function forLeg(leg: Leg, sa: StopArrivals | undefined, graph: Graph, arriveBy: ArriveBy, nowMs: number): { ms: number; board: number; arrive: number; estimated: boolean; late: boolean } {
  const headway = Math.max(60, headwayFor(graph, leg.svc)) * 1000;
  const walk = leg.walkS * 1000 + BUFFER_MS;
  const latestBoard = arriveBy.atMs - (ON_TIME_SLACK_S + arriveBy.venueWalkS + leg.rideS) * 1000;
  const arriveAfter = (boardMs: number) => boardMs + (leg.rideS + arriveBy.venueWalkS) * 1000;

  const live =
    sa && sa.available !== false
      ? resolveBerths(sa.arrivals.filter((a) => a.svc === leg.svc)).usable
          .filter((a) => a.etaS != null)
          .map((a) => sa.fetchedAt + (a.etaS as number) * 1000)
          .sort((a, b) => a - b)
      : [];

  if (!live.length) {
    // No live times: arrive a whole headway early and a bus is sure to come.
    const ms = latestBoard - headway - walk;
    // With no live times the bus is somewhere in that headway: this is when you reach the stop.
    return { ms, board: ms + walk, arrive: arriveAfter(latestBoard), estimated: true, late: ms < nowMs };
  }

  const earliest = nowMs + walk;
  const buses = live.filter((t) => t >= earliest).map((at) => ({ at, estimated: false }));
  // Past the last live time, one headway at a time.
  for (let t = live[live.length - 1] + headway; t <= latestBoard || !buses.length; t += headway) {
    if (t >= earliest) buses.push({ at: t, estimated: true });
  }

  const fits = buses.filter((b) => b.at <= latestBoard);
  if (fits.length) {
    const b = fits[fits.length - 1];
    return { ms: b.at - walk, board: b.at, arrive: arriveAfter(b.at), estimated: b.estimated, late: false };
  }
  // Nothing gets you there on time: the first bus you can catch.
  return { ms: buses[0].at - walk, board: buses[0].at, arrive: arriveAfter(buses[0].at), estimated: buses[0].estimated, late: true };
}

/** Every service from every candidate stop, ignoring service hours. */
function fallbackLegs(cands: Candidate[]): Leg[] {
  return cands.flatMap((c) => c.legs.map((l) => ({ svc: l.svc, stop: c.stop, walkS: c.walkS, rideS: l.hops * RIDE.secondsPerHop })));
}
