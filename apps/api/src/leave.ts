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

import type { ArriveBy, BusChange, Candidate, Graph, Leave, ScoredOption, StopArrivals } from './types.ts';
import { PUBLIC, TRANSFER, WALK } from './config.ts';
import { beforeOpening, feedFor, headwayFor, inService, legRideS, resolveBerths, serviceResumesAt } from './resolve.ts';
import { isPublic, svcName } from './public.ts';
import { ON_TIME_SLACK_S } from './profile.ts';
import { busChange, isoSeconds, shortStop } from './format.ts';
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
  /** On foot, the walk on after `walkAllS` to the place itself; 0 when the
   *  walk goes straight to the room. The class's venue walk when absent. */
  walkEndS?: number;
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
  /** A trip that changes buses: the second bus. `rideS` above is the first's ride to the change. */
  change?: {
    svc: string;
    at: { code: string; name: string };
    stop: { code: string; name: string };
    crossS: number;
    rideS: number;
    to?: { code: string; name: string };
  };
}

/** A change of bus as a leg: the scored option's, without its times. */
const changeLeg = (o: ScoredOption): Leg['change'] =>
  o.change ? { svc: o.change.svc, at: o.change.at, stop: o.change.stop, crossS: o.change.crossS, rideS: o.change.rideS, ...(o.to ? { to: o.to } : {}) } : undefined;

/** The fare on a public bus, as the time a free bus may cost instead (PUBLIC.fareWorthS). */
const fareMs = (leg: { paid?: true }) => (leg.paid ? PUBLIC.fareWorthS * 1000 : 0);
/** `paid` only on a public bus, so shuttle answers are unchanged; with it the route key a two-way service's number can't name. */
const paidOf = (leg: { svc: string; paid?: true }) => (leg.paid ? { paid: true as const, ...(leg.svc !== svcName(leg.svc) ? { route: leg.svc } : {}) } : {});

/** A leave-by with what ranked it (see leaveBy), and without. */
type Ranked = Leave & { ms: number; worth: number; opens: boolean };
const unranked = ({ ms: _ms, worth: _worth, opens: _opens, ...leave }: Ranked): Leave => leave;

/** `off` only when there is one, so answers without a crossing are unchanged; `toStop` likewise. */
const offOf = (leg: { off?: { code: string; name: string }; to?: { code: string; name: string } }) => ({
  ...(leg.off ? { off: shortStop(leg.off.name), offCode: leg.off.code } : {}),
  ...(leg.to ? { toStop: shortStop(leg.to.name), toCode: leg.to.code } : {}),
});

export function leaveBy(f: LeaveInput): Leave | null {
  if (f.walkAllS != null) {
    // On foot: only a class gives a reason to wait.
    if (!f.arriveBy) return null;
    const walkS = f.walkAllS + (f.walkEndS ?? f.arriveBy.venueWalkS);
    const at = f.arriveBy.atMs - (ON_TIME_SLACK_S + walkS) * 1000;
    // Past that already: leave now, and get there when a walk started now
    // does, not when one started then would have (as for a bus, below).
    const from = Math.max(at, f.nowMs);
    return { at: isoSeconds(from), estimated: false, svc: null, stop: null, board: null, arrive: isoSeconds(from + walkS * 1000), note: null };
  }

  if (!f.arriveBy) {
    const b = f.options[0];
    if (!b || b.quality === 'unknown') return null;
    const at = b.fromMs + b.boardS * 1000 - b.walkS * 1000 - BUFFER_MS;
    if (at - f.nowMs < NOW_S * 1000) return null;
    const endWalkS = f.endWalk?.(b) ?? 0;
    return { at: isoSeconds(at), estimated: b.quality === 'scheduled', ...(b.quality === 'stale' ? { stale: true as const } : {}), svc: svcName(b.svc), stop: shortStop(b.stop.name), stopCode: b.stop.code, board: isoSeconds(b.fromMs + b.boardS * 1000), arrive: isoSeconds(b.fromMs + b.totalS * 1000), note: null, walkS: b.walkS, rideS: b.rideS, ...offOf(b), ...(endWalkS > 0 ? { endWalkS } : {}), ...paidOf(b), ...(b.change ? { change: busChange(b) } : {}) };
  }

  const legs: Leg[] = f.options.length
    ? f.options.map((o) => ({ svc: o.svc, stop: o.stop, walkS: o.walkS, rideS: o.rideS, off: o.off, to: o.to, ...paidOf(o), ...(o.change ? { change: changeLeg(o) } : {}) }))
    : fallbackLegs(f.candidates, f.graph);
  let onTime: Ranked | null = null;
  let late: (Ranked & { reach: number }) | null = null;
  for (const leg of legs) {
    const r = leg.change
      ? forTransfer(leg, f.byStop.get(leg.stop.code), f.byStop.get(leg.change.stop.code), f.graph, f.arriveBy, f.nowMs)
      : forLeg(leg, f.byStop.get(leg.stop.code), f.graph, f.arriveBy, f.nowMs, f.crowdRisk);
    // No bus of this service you can catch while it runs.
    if (!r) continue;
    // How late it lets you leave, less what a fare is worth: a public bus
    // must buy clearly more time at home than the free one to be the answer.
    // A change of bus likewise, by what the change is worth.
    const worth = r.ms - fareMs(leg) - (leg.change ? TRANSFER.worthS * 1000 : 0);
    const out: Ranked = { at: isoSeconds(r.ms), estimated: r.estimated, ...(r.stale ? { stale: true as const } : {}), svc: svcName(leg.svc), stop: shortStop(leg.stop.name), stopCode: leg.stop.code, board: isoSeconds(r.board), arrive: isoSeconds(r.arrive), note: r.note, walkS: leg.walkS, rideS: leg.rideS, ...offOf(leg), ...paidOf(leg), ...(r.change ? { change: r.change } : {}), ms: r.ms, worth, opens: r.opens === true };
    // The latest on-time departure wins; if nothing is on time, the soonest.
    if (!r.late && (!onTime || worth > onTime.worth || (worth === onTime.worth && onTime.estimated && !r.estimated))) onTime = out;
    // Late whatever you do: the bus that gets you there first (a fare counted
    // as for the on-time ones), not the first to leave, which on a loop can
    // be the one going the long way round.
    const reach = r.arrive + fareMs(leg) + (leg.change ? TRANSFER.worthS * 1000 : 0);
    if (r.late && (!late || reach < late.reach || (reach === late.reach && r.ms < late.ms))) late = { ...out, reach };
  }
  if (onTime) return unranked(onTime);
  if (!late) return null;
  // You'll be late whatever you do: the answer is to go now, for the first
  // bus you can catch. Clients show "Leave now" once `at` has passed. Not
  // when that bus waits for the service to start: leave for it then.
  const { reach: _reach, ...first } = late;
  return { ...unranked(first), at: isoSeconds(first.opens ? first.ms : Math.min(first.ms, f.nowMs)) };
}

interface LegLeave {
  ms: number;
  board: number;
  arrive: number;
  estimated: boolean;
  /** From a stale feed: an old reading, not a live one. */
  stale: boolean;
  late: boolean;
  note: string | null;
  /** The bus is the first after the service starts: when to leave is set by that, not by you. */
  opens?: true;
  /** A trip that changes buses: the second bus, timed. */
  change?: BusChange;
}

/** How far ahead a bus is looked for: past a day it's no bus. */
const PROJECT_MS = 86_400_000;

function forLeg(leg: Leg, sa: StopArrivals | undefined, graph: Graph, arriveBy: ArriveBy, nowMs: number, risk?: CrowdRisk): LegLeave | null {
  const headway = Math.max(60, headwayFor(graph, leg.svc)) * 1000;
  const walk = leg.walkS * 1000 + BUFFER_MS;
  // On to the room from the stop this bus gets you to: a room two stops serve is further from one.
  const venueWalkS = arriveBy.walkByStopS?.[leg.to?.code ?? ''] ?? arriveBy.venueWalkS;
  const latestBoard = arriveBy.atMs - (ON_TIME_SLACK_S + venueWalkS + leg.rideS) * 1000;
  const arriveAfter = (boardMs: number) => boardMs + (leg.rideS + venueWalkS) * 1000;
  // A guessed bus only while the service runs, by its published hours.
  const runs = (ms: number) => inService(graph, leg.svc, ms);

  // The feed this service came from, at a shelter two feeds answer for.
  const feed = feedFor(sa, Boolean(leg.paid));
  // Each time keeps what it is: a public bus's timetabled one (LTA's
  // Monitored 0) is an estimate, and one from a stale feed an old reading,
  // however exact.
  const live =
    sa && feed && feed.available !== false
      ? beforeOpening(graph, leg.svc, resolveBerths(sa.arrivals.filter((a) => a.svc === leg.svc)).usable, feed.fetchedAt, nowMs)
          .filter((a) => a.etaS != null)
          .map((a) => ({ at: feed.fetchedAt + (a.etaS as number) * 1000, estimated: a.scheduled === true, stale: feed.stale && !a.scheduled }))
          .sort((a, b) => a.at - b.at)
      : [];

  if (!live.length) {
    // No live times: arrive a whole headway early and a bus is sure to come.
    // With no live times the bus is somewhere in that headway: `board` is
    // when you reach the stop. Often packed change: one more headway early.
    const crowd = crowdCheck(leg, latestBoard, arriveBy, risk);
    const back = crowd.earlier || arriveBy.oneEarlier ? 2 : 1;
    const note = crowd.note ?? (arriveBy.oneEarlier ? m().oneEarlierNote : null);
    // The latest that bus can come and still get you there: it must be running then.
    const by = latestBoard - (back - 1) * headway;
    let board = latestBoard - headway * back;
    if (board - walk >= nowMs && runs(by)) {
      // Before it starts, the first bus is the one to be there for.
      if (!runs(board)) board = serviceResumesAt(graph, leg.svc, board) ?? board;
      return { ms: board - walk, board, arrive: arriveAfter(by), estimated: true, stale: false, late: false, note };
    }
    // Too late for that, or it isn't running change: at the stop as soon as you
    // can be while it runs, never in the past, and a bus within a headway.
    board = nowMs + walk;
    const starts = runs(board) ? null : serviceResumesAt(graph, leg.svc, board);
    if (!runs(board)) {
      if (starts === null || starts > board + PROJECT_MS) return null;
      board = starts;
    }
    const arrive = arriveAfter(board + headway);
    return { ms: board - walk, board, arrive, estimated: true, stale: false, late: board + headway > latestBoard, note: null, ...(starts !== null ? { opens: true as const } : {}) };
  }

  const earliest = nowMs + walk;
  const buses = live.filter((b) => b.at >= earliest);
  // Past the last live time, one headway at a time, while the service runs.
  const last = live[live.length - 1].at;
  for (let t = last + headway; (t <= latestBoard || !buses.length) && t <= last + PROJECT_MS; t += headway) {
    if (!runs(t)) break;
    if (t >= earliest) buses.push({ at: t, estimated: true, stale: false });
  }
  if (!buses.length) return null;

  const fits = buses.filter((b) => b.at <= latestBoard);
  if (fits.length) {
    let b = fits[fits.length - 1];
    const crowd = crowdCheck(leg, b.at, arriveBy, risk);
    // Often packed, or you asked for a bus earlier: take the one before, when there is one.
    const earlier = (crowd.earlier || arriveBy.oneEarlier === true) && fits.length > 1;
    if (earlier) b = fits[fits.length - 2];
    const note = crowd.earlier && fits.length === 1 ? crowd.warnOnly : (crowd.note ?? (earlier ? m().oneEarlierNote : null));
    return { ms: b.at - walk, board: b.at, arrive: arriveAfter(b.at), estimated: b.estimated, stale: b.stale, late: false, note };
  }
  // Nothing gets you there on time: the first bus you can catch.
  const first = buses[0];
  return { ms: first.at - walk, board: first.at, arrive: arriveAfter(first.at), estimated: first.estimated, stale: first.stale, late: true, note: null };
}

/** A bus at a stop, as a leave-by plans it. With a live time all three are
 *  that time; without, the bus is somewhere in a headway. */
interface Bus {
  /** Be at the stop by. */
  atStop: number;
  /** When it leaves, as shown: with no live time, when you reach the stop. */
  board: number;
  /** The latest it can leave: what the rest of the trip counts on. */
  latest: number;
  estimated: boolean;
  stale: boolean;
  /** Waited for the service to start. */
  opens?: true;
}

/** A service's buses at a stop: its live times, each as it can be believed (see forLeg). */
function liveBuses(svc: string, paid: boolean, sa: StopArrivals | undefined, graph: Graph, nowMs: number): Array<{ at: number; estimated: boolean; stale: boolean }> {
  const feed = feedFor(sa, paid);
  if (!sa || !feed || feed.available === false) return [];
  return beforeOpening(graph, svc, resolveBerths(sa.arrivals.filter((a) => a.svc === svc)).usable, feed.fetchedAt, nowMs)
    .filter((a) => a.etaS != null)
    .map((a) => ({ at: feed.fetchedAt + (a.etaS as number) * 1000, estimated: a.scheduled === true, stale: feed.stale && !a.scheduled }))
    .sort((a, b) => a.at - b.at);
}

/** The first bus at or after `fromMs`: a live one, or one a headway on from the last, while it runs. */
function firstBus(graph: Graph, svc: string, live: ReturnType<typeof liveBuses>, fromMs: number): Bus | null {
  const headway = Math.max(60, headwayFor(graph, svc)) * 1000;
  const runs = (ms: number) => inService(graph, svc, ms);
  const b = live.find((x) => x.at >= fromMs);
  if (b) return { atStop: b.at, board: b.at, latest: b.at, estimated: b.estimated, stale: b.stale };
  if (live.length) {
    let t = live[live.length - 1].at + headway;
    if (t < fromMs) t += Math.ceil((fromMs - t) / headway) * headway;
    return runs(t) ? { atStop: t, board: t, latest: t, estimated: true, stale: false } : null;
  }
  // No live times: there by `fromMs`, and a bus within a headway, once it runs.
  let t = fromMs;
  let opens = false;
  if (!runs(t)) {
    const s = serviceResumesAt(graph, svc, t);
    if (s === null || s > t + PROJECT_MS) return null;
    t = s;
    opens = true;
  }
  return { atStop: t, board: t, latest: t + headway, estimated: true, stale: false, ...(opens ? { opens: true as const } : {}) };
}

/** The latest bus leaving by `byMs` that you can be at the stop for by `fromMs`. */
function lastBus(graph: Graph, svc: string, live: ReturnType<typeof liveBuses>, fromMs: number, byMs: number): Bus | null {
  const headway = Math.max(60, headwayFor(graph, svc)) * 1000;
  const runs = (ms: number) => inService(graph, svc, ms);
  if (live.length) {
    const buses = live.filter((b) => b.at >= fromMs && b.at <= byMs);
    for (let t = live[live.length - 1].at + headway; t <= byMs && runs(t); t += headway) if (t >= fromMs) buses.push({ at: t, estimated: true, stale: false });
    const b = buses[buses.length - 1];
    return b ? { atStop: b.at, board: b.at, latest: b.at, estimated: b.estimated, stale: b.stale } : null;
  }
  // No live times: a whole headway early, and one is sure to come in time.
  const at = byMs - headway;
  return at >= fromMs && runs(byMs) ? { atStop: at, board: at, latest: byMs, estimated: true, stale: false } : null;
}

/**
 * A trip that changes buses, for a class: the latest second bus that gets
 * you there on time, then the latest first bus that gets you to it, and
 * the arrival worked out forwards from that first bus (with live times the
 * second bus can be sooner than the latest that would do). Late whatever
 * you do: the first bus you can catch, and the first after it.
 */
function forTransfer(leg: Leg, sa1: StopArrivals | undefined, sa2: StopArrivals | undefined, graph: Graph, arriveBy: ArriveBy, nowMs: number): LegLeave | null {
  const t = leg.change!;
  const venueWalkS = arriveBy.walkByStopS?.[t.to?.code ?? ''] ?? arriveBy.venueWalkS;
  const walk = leg.walkS * 1000 + BUFFER_MS;
  const ride1 = leg.rideS * 1000;
  const change = (t.crossS + TRANSFER.changeBufferS) * 1000;
  const live1 = liveBuses(leg.svc, false, sa1, graph, nowMs);
  const live2 = liveBuses(t.svc, false, sa2, graph, nowMs);
  const after = (b2: Bus) => b2.latest + (t.rideS + venueWalkS) * 1000;

  const done = (b1: Bus, b2: Bus, late: boolean): LegLeave => ({
    ms: b1.atStop - walk,
    board: b1.board,
    arrive: after(b2),
    estimated: b1.estimated || b2.estimated,
    stale: b1.stale || b2.stale,
    late,
    note: null,
    ...(b1.opens ? { opens: true as const } : {}),
    change: {
      svc: svcName(t.svc),
      from: shortStop(t.at.name),
      fromCode: t.at.code,
      stop: shortStop(t.stop.name),
      stopCode: t.stop.code,
      ...(t.crossS > 0 ? { crossS: t.crossS } : {}),
      reach: isoSeconds(b1.latest + ride1),
      board: isoSeconds(b2.board),
      rideS: t.rideS,
      estimated: b2.estimated || b2.stale,
    },
  });

  const earliest1 = nowMs + walk;
  const by2 = arriveBy.atMs - (ON_TIME_SLACK_S + venueWalkS + t.rideS) * 1000;
  const last2 = lastBus(graph, t.svc, live2, earliest1 + ride1 + change, by2);
  const last1 = last2 && lastBus(graph, leg.svc, live1, earliest1, last2.atStop - change - ride1);
  if (last1) {
    const b2 = firstBus(graph, t.svc, live2, last1.latest + ride1 + change);
    if (b2) return done(last1, b2, false);
  }
  const b1 = firstBus(graph, leg.svc, live1, earliest1);
  const b2 = b1 && firstBus(graph, t.svc, live2, b1.latest + ride1 + change);
  if (!b1 || !b2) return null;
  return done(b1, b2, after(b2) > arriveBy.atMs - ON_TIME_SLACK_S * 1000);
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

/** Every service from every candidate stop, running now or not; forLeg keeps each to its hours. */
function fallbackLegs(cands: Candidate[], graph: Graph): Leg[] {
  return cands.flatMap((c) => c.legs.map((l) => ({ svc: l.svc, stop: c.stop, walkS: c.walkS, rideS: legRideS(l), off: l.off, to: l.to, ...(isPublic(graph, l.svc) ? { paid: true as const } : {}) })));
}
