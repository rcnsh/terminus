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
import { PUBLIC, WALK } from './config.ts';
import { feedFor, headwayFor, legRideS, resolveBerths } from './resolve.ts';
import { isPublic, svcName } from './public.ts';
import { ON_TIME_SLACK_S } from './profile.ts';
import { isoSeconds, shortStop } from './format.ts';
import { type CrowdRisk, OFTEN_PACKED } from './crowd.ts';
import { m } from './i18n.ts';

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
  /** The walk on from where an option gets you off to the place itself (a room, a food court). */
  endWalk?: (o: ScoredOption) => number;
  nowMs: number;
  /** How often a bus is packed at a stop around a time; null when unknown. */
  crowdRisk?: CrowdRisk;
}

/** Nothing worth saying: leaving within this is just "now". */
const NOW_S = 60;
const BUFFER_MS = WALK.boardBufferS * 1000;

interface Leg {
  svc: string;
  stop: { code: string; name: string };
  walkS: number;
  rideS: number;
  off?: { code: string; name: string };
  to?: { code: string; name: string };
  /** A public bus, with a fare. */
  paid?: true;
}

/** The fare on a public bus, as the time a free bus may cost instead (PUBLIC.fareWorthS). */
const fareMs = (leg: { paid?: true }) => (leg.paid ? PUBLIC.fareWorthS * 1000 : 0);
/** `paid` only on a public bus, so shuttle answers are unchanged; with it the route key a two-way service's number can't name. */
const paidOf = (leg: { svc: string; paid?: true }) => (leg.paid ? { paid: true as const, ...(leg.svc !== svcName(leg.svc) ? { route: leg.svc } : {}) } : {});

/** A leave-by with what ranked it (see leaveBy), and without. */
type Ranked = Leave & { ms: number; worth: number };
const unranked = ({ ms: _ms, worth: _worth, ...leave }: Ranked): Leave => leave;

/** `off` only when there is one, so answers without a crossing are unchanged; `toStop` likewise. */
const offOf = (leg: { off?: { code: string; name: string }; to?: { code: string; name: string } }) => ({
  ...(leg.off ? { off: shortStop(leg.off.name), offCode: leg.off.code } : {}),
  ...(leg.to ? { toStop: shortStop(leg.to.name) } : {}),
});

export function leaveBy(f: LeaveInput): Leave | null {
  if (f.walkAllS != null) {
    // On foot: only a class gives a reason to wait.
    if (!f.arriveBy) return null;
    const at = f.arriveBy.atMs - (ON_TIME_SLACK_S + f.arriveBy.venueWalkS + f.walkAllS) * 1000;
    return { at: isoSeconds(at), estimated: false, svc: null, stop: null, board: null, arrive: isoSeconds(at + (f.walkAllS + f.arriveBy.venueWalkS) * 1000), note: null };
  }

  if (!f.arriveBy) {
    const b = f.options[0];
    if (!b || b.quality === 'unknown') return null;
    const at = b.fetchedAt + b.boardS * 1000 - b.walkS * 1000 - BUFFER_MS;
    if (at - f.nowMs < NOW_S * 1000) return null;
    const endWalkS = f.endWalk?.(b) ?? 0;
    return { at: isoSeconds(at), estimated: b.quality === 'scheduled', svc: svcName(b.svc), stop: shortStop(b.stop.name), stopCode: b.stop.code, board: isoSeconds(b.fetchedAt + b.boardS * 1000), arrive: isoSeconds(b.fetchedAt + b.totalS * 1000), note: null, walkS: b.walkS, rideS: b.rideS, ...offOf(b), ...(endWalkS > 0 ? { endWalkS } : {}), ...paidOf(b) };
  }

  const legs: Leg[] = f.options.length
    ? f.options.map((o) => ({ svc: o.svc, stop: o.stop, walkS: o.walkS, rideS: o.rideS, off: o.off, to: o.to, ...paidOf(o) }))
    : fallbackLegs(f.candidates, f.graph);
  let onTime: Ranked | null = null;
  let late: Ranked | null = null;
  for (const leg of legs) {
    const r = forLeg(leg, f.byStop.get(leg.stop.code), f.graph, f.arriveBy, f.nowMs, f.crowdRisk);
    // How late it lets you leave, less what a fare is worth: a public bus
    // must buy clearly more time at home than the free one to be the answer.
    const worth = r.ms - fareMs(leg);
    const out: Ranked = { at: isoSeconds(r.ms), estimated: r.estimated, svc: svcName(leg.svc), stop: shortStop(leg.stop.name), stopCode: leg.stop.code, board: isoSeconds(r.board), arrive: isoSeconds(r.arrive), note: r.note, walkS: leg.walkS, rideS: leg.rideS, ...offOf(leg), ...paidOf(leg), ms: r.ms, worth };
    // The latest on-time departure wins; if nothing is on time, the soonest.
    if (!r.late && (!onTime || worth > onTime.worth || (worth === onTime.worth && onTime.estimated && !r.estimated))) onTime = out;
    if (r.late && (!late || r.ms < late.ms)) late = out;
  }
  if (onTime) return unranked(onTime);
  if (!late) return null;
  // You'll be late whatever you do: the answer is to go now, for the first
  // bus you can catch. Clients show "Leave now" once `at` has passed.
  return { ...unranked(late), at: isoSeconds(Math.min(late.ms, f.nowMs)) };
}

interface LegLeave {
  ms: number;
  board: number;
  arrive: number;
  estimated: boolean;
  late: boolean;
  note: string | null;
}

function forLeg(leg: Leg, sa: StopArrivals | undefined, graph: Graph, arriveBy: ArriveBy, nowMs: number, risk?: CrowdRisk): LegLeave {
  const headway = Math.max(60, headwayFor(graph, leg.svc)) * 1000;
  const walk = leg.walkS * 1000 + BUFFER_MS;
  const latestBoard = arriveBy.atMs - (ON_TIME_SLACK_S + arriveBy.venueWalkS + leg.rideS) * 1000;
  const arriveAfter = (boardMs: number) => boardMs + (leg.rideS + arriveBy.venueWalkS) * 1000;

  // The feed this service came from, at a shelter two feeds answer for.
  const feed = feedFor(sa, Boolean(leg.paid));
  // A public bus's timetabled time is a time, but not a live one: it stays estimated.
  const live =
    sa && feed && feed.available !== false
      ? resolveBerths(sa.arrivals.filter((a) => a.svc === leg.svc)).usable
          .filter((a) => a.etaS != null)
          .map((a) => ({ at: feed.fetchedAt + (a.etaS as number) * 1000, estimated: a.scheduled === true }))
          .sort((a, b) => a.at - b.at)
      : [];

  if (!live.length) {
    // No live times: arrive a whole headway early and a bus is sure to come.
    // With no live times the bus is somewhere in that headway: `board` is
    // when you reach the stop. Often packed then: one more headway early.
    const crowd = crowdCheck(leg, latestBoard, arriveBy, risk);
    const back = crowd.earlier || arriveBy.oneEarlier ? 2 : 1;
    const ms = latestBoard - headway * back - walk;
    return { ms, board: ms + walk, arrive: arriveAfter(latestBoard - (back - 1) * headway), estimated: true, late: ms < nowMs, note: crowd.note ?? (arriveBy.oneEarlier ? m().oneEarlierNote : null) };
  }

  const earliest = nowMs + walk;
  const buses = live.filter((t) => t.at >= earliest);
  // Past the last live time, one headway at a time.
  for (let t = live[live.length - 1].at + headway; t <= latestBoard || !buses.length; t += headway) {
    if (t >= earliest) buses.push({ at: t, estimated: true });
  }

  const fits = buses.filter((b) => b.at <= latestBoard);
  if (fits.length) {
    let b = fits[fits.length - 1];
    const crowd = crowdCheck(leg, b.at, arriveBy, risk);
    // Often packed, or you asked for a bus earlier: take the one before, when there is one.
    const earlier = (crowd.earlier || arriveBy.oneEarlier === true) && fits.length > 1;
    if (earlier) b = fits[fits.length - 2];
    const note = crowd.earlier && fits.length === 1 ? crowd.warnOnly : (crowd.note ?? (earlier ? m().oneEarlierNote : null));
    return { ms: b.at - walk, board: b.at, arrive: arriveAfter(b.at), estimated: b.estimated, late: false, note };
  }
  // Nothing gets you there on time: the first bus you can catch.
  return { ms: buses[0].at - walk, board: buses[0].at, arrive: arriveAfter(buses[0].at), estimated: buses[0].estimated, late: true, note: null };
}

/** Whether the bus you'd wait for is often busy, and what to say. */
function crowdCheck(leg: Leg, atMs: number, arriveBy: ArriveBy, risk?: CrowdRisk): { earlier: boolean; note: string | null; warnOnly: string | null } {
  const r = risk?.(leg.svc, leg.stop.code, atMs);
  if (r == null || r < OFTEN_PACKED) return { earlier: false, note: null, warnOnly: null };
  const where = shortStop(leg.stop.name);
  const busy = m().oftenBusy(leg.svc, where);
  // Said on its own (no earlier bus, or you'd rather not), it says what that means for you.
  const warnOnly = m().mayBeFull(busy);
  if (arriveBy.fullBusMargin === false) return { earlier: false, note: warnOnly, warnOnly };
  return { earlier: true, note: m().soOneEarlier(busy), warnOnly };
}

/** Every service from every candidate stop, ignoring service hours. */
function fallbackLegs(cands: Candidate[], graph: Graph): Leg[] {
  return cands.flatMap((c) => c.legs.map((l) => ({ svc: l.svc, stop: c.stop, walkS: c.walkS, rideS: legRideS(l), off: l.off, to: l.to, ...(isPublic(graph, l.svc) ? { paid: true as const } : {}) })));
}
