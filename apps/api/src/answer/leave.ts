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

import type { ArriveBy, BusChange, Candidate, Graph, Leave, ScoredOption, StopArrivals } from '../types.ts';
import { PUBLIC, TRANSFER, WALK } from '../config.ts';
import { legRideS, readyS } from './resolve.ts';
import { type Departure, type ServiceBoard, departuresFrom, nextDeparture, serviceBoard } from './departures.ts';
import { isPublic, svcName } from './public.ts';
import { ON_TIME_SLACK_S } from '../timetable/profile.ts';
import { busChange, isoSeconds, shortStop } from './format.ts';
import { type CrowdRisk, OFTEN_PACKED } from './crowd.ts';
import { m } from '../i18n.ts';

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
  /** What a second on foot costs against one at home or at the stop (WALK.sunWeight). */
  walkWeight?: number;
  nowMs: number;
  /** How often a bus is packed at a stop around a time; null when unknown. */
  crowdRisk?: CrowdRisk;
}

/** Nothing worth saying: leaving within this is just "now". */
const NOW_S = 60;
const BUFFER_MS = WALK.boardBufferS * 1000;
/** From leaving to being ready at the stop; none when you're at it already. */
const walkMs = (leg: { walkS: number; here?: true }) => (leg.here ? 0 : leg.walkS * 1000 + BUFFER_MS);

interface Leg {
  svc: string;
  stop: { code: string; name: string };
  walkS: number;
  /** Located at the stop (readyS). */
  here?: true;
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
  o.change
    ? {
        svc: o.change.svc,
        at: o.change.at,
        stop: o.change.stop,
        crossS: o.change.crossS,
        rideS: o.change.rideS,
        ...(o.to ? { to: o.to } : {}),
      }
    : undefined;

/** A ranked option as a leg: its service, stops and walks, without its times. */
const legOf = (o: ScoredOption): Leg => ({
  svc: o.svc,
  stop: o.stop,
  walkS: o.walkS,
  ...(o.here ? { here: true as const } : {}),
  rideS: o.rideS,
  off: o.off,
  to: o.to,
  ...paidOf(o),
  ...(o.change ? { change: changeLeg(o) } : {}),
});

/** The fare on a public bus, as the time a free bus may cost instead (PUBLIC.fareWorthS). */
const fareMs = (leg: { paid?: true }) => (leg.paid ? PUBLIC.fareWorthS * 1000 : 0);
/** `paid` only on a public bus; with it the route key a two-way service's number can't name. */
const paidOf = (leg: { svc: string; paid?: true }) =>
  leg.paid ? { paid: true as const, ...(leg.svc !== svcName(leg.svc) ? { route: leg.svc } : {}) } : {};

/** On to the room from the stop a leg gets you to: a room two stops serve is further from one. */
const venueWalkOf = (arriveBy: ArriveBy, leg: Leg) => arriveBy.walkByStopS?.[(leg.change?.to ?? leg.to)?.code ?? ''] ?? arriveBy.venueWalkS;

/** A leave-by with what ranked it (see leaveBy), and without. */
type Ranked = Leave & { ms: number; worth: number; opens: boolean };
const unranked = ({ ms: _ms, worth: _worth, opens: _opens, ...leave }: Ranked): Leave => leave;

/** `off` only when there is one; `toStop` likewise. */
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
    return {
      at: isoSeconds(from),
      estimated: false,
      svc: null,
      stop: null,
      board: null,
      arrive: isoSeconds(from + walkS * 1000),
      note: null,
    };
  }

  if (!f.arriveBy) {
    const b = f.options[0];
    if (!b || b.quality === 'unknown') return null;
    const at = b.fromMs + b.boardS * 1000 - walkMs(b);
    if (at - f.nowMs < NOW_S * 1000) return null;
    const endWalkS = f.endWalk?.(b) ?? 0;
    return {
      at: isoSeconds(at),
      estimated: b.quality === 'scheduled',
      ...(b.quality === 'stale' ? { stale: true as const } : {}),
      svc: svcName(b.svc),
      stop: shortStop(b.stop.name),
      stopCode: b.stop.code,
      board: isoSeconds(b.fromMs + b.boardS * 1000),
      arrive: isoSeconds(b.fromMs + b.totalS * 1000),
      note: null,
      walkS: b.walkS,
      rideS: b.rideS,
      ...offOf(b),
      ...(endWalkS > 0 ? { endWalkS } : {}),
      ...paidOf(b),
      ...(b.change ? { change: busChange(b) } : {}),
    };
  }

  const legs: Leg[] = f.options.length ? f.options.map(legOf) : fallbackLegs(f.candidates, f.graph);
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
    // A change of bus likewise, by what the change is worth; and a longer
    // walk, to a stop further off or on from the stop to the room, by more
    // than the minutes it takes, as the options are ranked (scoreOptions).
    const extraFootMs =
      ((f.walkWeight ?? WALK.sunWeight) - 1) * (leg.walkS + (leg.change?.crossS ?? 0) + venueWalkOf(f.arriveBy, leg)) * 1000;
    const worth = r.ms - fareMs(leg) - (leg.change ? TRANSFER.worthS * 1000 : 0) - extraFootMs;
    const out: Ranked = {
      at: isoSeconds(r.ms),
      estimated: r.estimated,
      ...(r.stale ? { stale: true as const } : {}),
      svc: svcName(leg.svc),
      stop: shortStop(leg.stop.name),
      stopCode: leg.stop.code,
      board: isoSeconds(r.board),
      arrive: isoSeconds(r.arrive),
      note: r.note,
      walkS: leg.walkS,
      rideS: leg.rideS,
      ...offOf(leg),
      ...paidOf(leg),
      ...(r.change ? { change: r.change } : {}),
      ms: r.ms,
      worth,
      opens: r.opens === true,
    };
    // The latest on-time departure wins, by worth; at a tie, a live time over an estimate.
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

const busOf = (d: Departure): Bus => ({
  atStop: d.earliest,
  board: d.earliest,
  latest: d.latest,
  estimated: d.kind === 'estimate',
  stale: d.kind === 'stale',
  ...(d.opens ? { opens: true as const } : {}),
});

function forLeg(
  leg: Leg,
  sa: StopArrivals | undefined,
  graph: Graph,
  arriveBy: ArriveBy,
  nowMs: number,
  risk?: CrowdRisk,
): LegLeave | null {
  const walk = walkMs(leg);
  const venueWalkS = venueWalkOf(arriveBy, leg);
  const latestBoard = arriveBy.atMs - (ON_TIME_SLACK_S + venueWalkS + leg.rideS) * 1000;
  const arriveAfter = (boardMs: number) => boardMs + (leg.rideS + venueWalkS) * 1000;
  const earliest = nowMs + readyS(leg) * 1000;
  const at = (d: Departure, late: boolean, note: string | null): LegLeave => {
    const { atStop, board, latest, estimated, stale, opens } = busOf(d);
    return {
      ms: atStop - walk,
      // Be at the stop as the window opens; it gets you there by its end.
      board,
      arrive: arriveAfter(latest),
      estimated,
      stale,
      late,
      note,
      // Only late does the start set when to leave (leaveBy): on time, you leave for the bus you'd wait for.
      ...(late && opens ? { opens } : {}),
    };
  };

  // The buses that get you there on time; with no live times, windows that
  // end as late as they can, at the latest you can board.
  const sb = serviceBoard(graph, sa, leg.svc, nowMs);
  const fits = departuresFrom(graph, sb, leg.svc, { now: nowMs, from: earliest, until: latestBoard, around: latestBoard }).filter(
    (d) => !d.partial,
  );
  if (fits.length) {
    let b = fits[fits.length - 1];
    const crowd = crowdCheck(leg, b.latest, arriveBy, risk);
    // Often packed, or you asked for a bus earlier: take the one before, when there is one.
    const earlier = (crowd.earlier || arriveBy.oneEarlier === true) && fits.length > 1;
    if (earlier) b = fits[fits.length - 2];
    const note = crowd.earlier && fits.length === 1 ? crowd.warnOnly : (crowd.note ?? (earlier ? m().oneEarlierNote : null));
    return at(b, false, note);
  }
  // Nothing gets you there on time: the first bus you can catch.
  const first = nextDeparture(graph, sb, leg.svc, earliest, nowMs);
  return first ? at(first, true, null) : null;
}

/** The first bus you can be at the stop for by `fromMs`. */
function firstBus(graph: Graph, svc: string, sa: ServiceBoard, fromMs: number, nowMs: number): Bus | null {
  const d = nextDeparture(graph, sa, svc, fromMs, nowMs);
  return d ? busOf(d) : null;
}

/** The latest bus leaving by `byMs` that you can be at the stop for by `fromMs`. */
function lastBus(graph: Graph, svc: string, sa: ServiceBoard, fromMs: number, byMs: number, nowMs: number): Bus | null {
  const b = departuresFrom(graph, sa, svc, { now: nowMs, from: fromMs, until: byMs, around: byMs })
    .filter((d) => !d.partial)
    .at(-1);
  return b ? busOf(b) : null;
}

/** The second bus of a trip that changes buses, timed: the first gets you to the change at `reachMs`. */
const changeOf = (t: NonNullable<Leg['change']>, reachMs: number, b2: Bus): BusChange => ({
  svc: svcName(t.svc),
  from: shortStop(t.at.name),
  fromCode: t.at.code,
  stop: shortStop(t.stop.name),
  stopCode: t.stop.code,
  ...(t.crossS > 0 ? { crossS: t.crossS } : {}),
  reach: isoSeconds(reachMs),
  board: isoSeconds(b2.board),
  rideS: t.rideS,
  estimated: b2.estimated || b2.stale,
});

/**
 * A trip that changes buses, for a class: the latest second bus that gets
 * you there on time, then the latest first bus that gets you to it, and
 * the arrival worked out forwards from that first bus (with live times the
 * second bus can be sooner than the latest that would do). Late whatever
 * you do: the first bus you can catch, and the first after it.
 */
function forTransfer(
  leg: Leg,
  sa1: StopArrivals | undefined,
  sa2: StopArrivals | undefined,
  graph: Graph,
  arriveBy: ArriveBy,
  nowMs: number,
): LegLeave | null {
  const t = leg.change!;
  const venueWalkS = venueWalkOf(arriveBy, leg);
  const walk = walkMs(leg);
  const ride1 = leg.rideS * 1000;
  const change = (t.crossS + TRANSFER.changeBufferS) * 1000;
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
    change: changeOf(t, b1.latest + ride1, b2),
  });

  // Each board read once, for every bus asked of it.
  const sb1 = serviceBoard(graph, sa1, leg.svc, nowMs);
  const sb2 = serviceBoard(graph, sa2, t.svc, nowMs);
  const earliest1 = nowMs + readyS(leg) * 1000;
  const by2 = arriveBy.atMs - (ON_TIME_SLACK_S + venueWalkS + t.rideS) * 1000;
  const last2 = lastBus(graph, t.svc, sb2, earliest1 + ride1 + change, by2, nowMs);
  const last1 = last2 && lastBus(graph, leg.svc, sb1, earliest1, last2.atStop - change - ride1, nowMs);
  if (last1) {
    const b2 = firstBus(graph, t.svc, sb2, last1.latest + ride1 + change, nowMs);
    if (b2) return done(last1, b2, false);
  }
  const b1 = firstBus(graph, leg.svc, sb1, earliest1, nowMs);
  const b2 = b1 && firstBus(graph, t.svc, sb2, b1.latest + ride1 + change, nowMs);
  if (!b1 || !b2) return null;
  return done(b1, b2, after(b2) > arriveBy.atMs - ON_TIME_SLACK_S * 1000);
}

/**
 * A leave-by among `departures`, with which bus it is for: its service,
 * stops and departure (departures.ts `id`), so the card's bus and the
 * steps are told apart by identity, not by time. Internal: `publicLeave`
 * drops it before a leave-by goes out.
 */
export type Departing = Leave & { bus: string };
const busKey = (svc: string, stop: string, change: { svc: string; stop: { code: string } } | undefined, bus: string) =>
  [svc, stop, change?.svc ?? '', change?.stop.code ?? '', bus].join('|');

/** A leave-by as the answer sends it: without `departures`' `bus`. */
export const publicLeave = ({ bus: _bus, ...l }: Leave & { bus?: string }): Leave => l;

/** The bus a ranked option is for, among `departures`: the same departure of that service from that stop. */
export function departureOf(all: Departing[], o: ScoredOption): Departing | null {
  if (o.bus === undefined) return null;
  const key = busKey(o.svc, o.stop.code, o.change, o.bus);
  return all.find((l) => l.bus === key) ?? null;
}

/** Past this many buses of one service from one stop, `departures` stops counting: a day's worth. */
const MAX_DEPARTURES = 150;

/**
 * Every bus that gets you there, leaving from now until `untilMs`: each
 * service from each stop, its live times and then one headway at a time
 * while it runs, for stepping from one bus to the next (step.ts). A trip
 * that changes buses steps by its first bus, with the first second bus
 * after it. With no live times a bus is somewhere in a headway, as for the
 * leave-by: be at the stop by `board`, and `arrive` counts the whole
 * headway. Those buses fall a headway apart from `anchor` when it's the
 * same service from the same stop, so a bus chosen among them stays put as
 * the clock moves on.
 */
export function departures(f: LeaveInput, untilMs: number, anchor?: { svc: string; stop: string; board: string } | null): Departing[] {
  // Without a class there's nothing to fall back on: only the options.
  const legs: Array<{ leg: Leg; endS: number }> = f.options.length
    ? f.options.map((o) => ({ leg: legOf(o), endS: f.endWalk?.(o) ?? 0 }))
    : f.arriveBy
      ? fallbackLegs(f.candidates, f.graph).map((leg) => ({ leg, endS: 0 }))
      : [];
  const out: Departing[] = [];
  for (const { leg, endS } of legs) {
    const sa = f.byStop.get(leg.stop.code);
    const t = leg.change;
    // Each board read once: the change stop's is asked again for every first bus.
    const sb = serviceBoard(f.graph, sa, leg.svc, f.nowMs);
    const sb2 = t ? serviceBoard(f.graph, f.byStop.get(t.stop.code), t.svc, f.nowMs) : null;
    const walk = walkMs(leg);
    // A class's arrival is at the room; any other trip's at the stop, with the walk on beside it.
    const onS = f.arriveBy ? venueWalkOf(f.arriveBy, leg) : 0;
    const from = f.nowMs + readyS(leg) * 1000;
    // With no live times, the estimates fall either side of the chosen bus,
    // so it stays among them. One that has left is no longer a choice
    // (stepFrom), and lines up nothing.
    const chosenMs = anchor && anchor.svc === leg.svc && anchor.stop === leg.stop.code ? Date.parse(anchor.board) : undefined;
    const chosen = chosenMs !== undefined && chosenMs > f.nowMs ? chosenMs : undefined;
    const buses = departuresFrom(f.graph, sb, leg.svc, {
      now: f.nowMs,
      from,
      until: untilMs,
      max: MAX_DEPARTURES,
      ...(chosen !== undefined ? { around: chosen } : {}),
    });
    let prev: number | null = null;
    for (const d of buses) {
      // Two live times at the same instant are one bus.
      if (d.earliest === prev) continue;
      prev = d.earliest;
      const b = busOf(d);
      const b2 =
        t && sb2 ? firstBus(f.graph, t.svc, sb2, b.latest + leg.rideS * 1000 + (t.crossS + TRANSFER.changeBufferS) * 1000, f.nowMs) : null;
      if (t && !b2) break;
      out.push({
        at: isoSeconds(b.atStop - walk),
        estimated: b.estimated || Boolean(b2?.estimated),
        ...(b.stale || b2?.stale ? { stale: true as const } : {}),
        svc: svcName(leg.svc),
        stop: shortStop(leg.stop.name),
        stopCode: leg.stop.code,
        board: isoSeconds(b.board),
        arrive: isoSeconds(t && b2 ? b2.latest + (t.rideS + onS) * 1000 : b.latest + (leg.rideS + onS) * 1000),
        note: null,
        walkS: leg.walkS,
        rideS: leg.rideS,
        ...offOf(leg),
        ...(!f.arriveBy && endS > 0 ? { endWalkS: endS } : {}),
        ...paidOf(leg),
        ...(t && b2 ? { change: changeOf(t, b.latest + leg.rideS * 1000, b2) } : {}),
        bus: busKey(leg.svc, leg.stop.code, leg.change, d.id),
      });
    }
  }
  return out;
}

/** Whether the bus you'd wait for is often busy, and what to say. */
function crowdCheck(
  leg: Leg,
  atMs: number,
  arriveBy: ArriveBy,
  risk?: CrowdRisk,
): { earlier: boolean; note: string | null; warnOnly: string | null } {
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
  return cands.flatMap((c) =>
    c.legs.map((l) => ({
      svc: l.svc,
      stop: c.stop,
      walkS: c.walkS,
      ...(c.here ? { here: true as const } : {}),
      rideS: legRideS(l),
      off: l.off,
      to: l.to,
      ...(isPublic(graph, l.svc) ? { paid: true as const } : {}),
    })),
  );
}
