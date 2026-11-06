/**
 * A trip's phase: which one it's in now (`phaseAt`), and when it next
 * changes by itself (`changesAt`).
 *
 *   idle → due → heading → waiting → riding → arrived
 *                 └──────────┴──→ missed → (replanned) → due
 *            └──→ skipped
 *
 * The phase is worked out on each request, and by the Trip object when it
 * wakes to push (tripdo.ts), from the answer (its leave-by, whether you're
 * there), the trip's signal and plan (trip.ts), where the request is, and,
 * for the bus you're on, the feed, read through `Lookups` only when a rule
 * needs it. The planner (next.ts) words the answer for the phase. The
 * whole story is in internals.md, "Trips".
 */

import type { MeAnswer } from '../types.ts';
import type { TripView } from './card.ts';
import { type Phase, type Plan, type TripRecord, seenOnBus, tripEnd } from './trip.ts';
import { haversineM } from '../geo.ts';
import { GRAPH } from './graph.ts';
import { indexGraph } from './resolve.ts';
import { headwayMs } from './departures.ts';
import { HOME_BY_MIN, LATE_GRACE_MIN } from '../timetable/profile.ts';

/** Heads-up window: the trip is "due" this long before its leave-by. */
export const DUE_MS = 5 * 60_000;
/** At the stop this long before the leave-by counts as waiting for the bus. */
export const WAIT_EARLY_MS = 15 * 60_000;
/** Close enough to the boarding stop to be waiting at it. */
export const AT_STOP_M = 80;
/** After the bus you're on should have got you there, you're taken to be there. */
export const RIDE_GRACE_MS = 10 * 60_000;
/** Nobody said otherwise this long after the bus left: where you are says
 *  whether you're on it (seenOnBus), or the answer is the next way there. */
export const ASSUME_MS = 3 * 60_000;
/** How long after the second bus's time it's taken to have left with you on it. */
export const CHANGE_GRACE_MS = 30_000;
/** A trip home's bus has had this long past its arrival to get you indoors. */
export const HOME_GRACE_MS = 10 * 60_000;

/**
 * The latest the second bus of a trip that changes buses can leave: its
 * time, or a headway after it when that time is only a guess (there by
 * then, and a bus within a headway).
 */
export function secondLeavesMs(c: Plan): number | null {
  if (!c.board) return null;
  const at = Date.parse(c.board);
  if (!c.estimated) return at;
  // A bus within a headway of the guess. Not bounded by the hours: the
  // guess was made for a bus that runs, and a time pushed past the close
  // (laterChange) would otherwise wait for the next morning's.
  return at + headwayMs(GRAPH, c.svc, at);
}

/**
 * What the phase reads from the feed about the bus you're on. Each is asked
 * only when a rule needs it, so a trip costs NUS no more boards than its
 * phase does (rule 2). next.ts's reads the cached feed; tests' read fixtures.
 */
export interface Lookups {
  /** When the bus `b` (by its plate) reaches the stop you get off at, ISO, or null when the feed doesn't say. */
  liveArrival(b: Plan): Promise<string | null>;
  /** The second bus of `b`, a trip that changes buses, as the feed has it at its stop (`live`), else as planned. */
  secondBus(b: Plan): Promise<{ change: Plan; live: boolean }>;
  /** When the next bus of `b`'s service reaches the stop you get off at, ISO, or null. */
  nextArrival(b: Plan): Promise<string | null>;
}

/** Where a request is; nowhere for the Trip object's wake. */
export type At = { lat: number | null; lon: number | null };

/** The trip's answer from where you are, and the bus the trip is about (plan.ts). */
export interface TripPlan {
  /** The answer as worked out now. */
  fresh: MeAnswer;
  /** `fresh`, or the kept plan's bus in its place. */
  answer: MeAnswer;
  bus: Plan | null;
}

/** What a trip's phase is worked out from (next.ts fills it in). */
export interface TripIn {
  at: At;
  rec?: TripRecord;
  /** A trip home after the day's last class: when that class ends, and
   *  when the trip's planned bus has got you home (dayState's homeBy). */
  home?: { lastEndMs: number; homeBy?: number } | null;
  /** A trip to a class: when it starts. */
  classAtMs?: number | null;
  /** The answer and its bus, worked out only when a rule needs them (once). */
  planned(): Promise<TripPlan>;
}

/** On a bus: riding it, or at the change stop of a trip that changes buses (`waiting`). */
export type Aboard = { phase: 'riding'; b: Plan; live: boolean; ends?: string } | { phase: 'waiting'; b: Plan; live: boolean };

/** On a bus, still at the change stop once the second bus has gone (`missed`), or there by now (null). */
export type OnBus = Aboard | 'missed' | null;

/** Which rule a trip's phase came from, with what the planner needs to word it. */
export type Verdict =
  /** A trip home with no location, long enough after the last class to be home. */
  | { kind: 'home' }
  /** Said to be on a bus. */
  | { kind: 'aboard'; on: OnBus }
  /** At the class's stop before it starts. */
  | { kind: 'there' }
  /** A trip home while the last class is still on. */
  | { kind: 'held' }
  /** At the stop after the plan's bus left. */
  | { kind: 'missed' }
  /** Seen on the plan's bus by a location, now (`seenNow`) or earlier. */
  | { kind: 'seen'; on: Aboard; seenNow: boolean }
  /** The plan's bus left and nothing says whether you're on it. */
  | { kind: 'gone'; phase: Phase }
  /** The plan, by its leave-by and the signal. */
  | { kind: 'plan'; phase: Phase };

/** The phase a verdict shows. */
export function phaseOf(v: Verdict): Phase {
  switch (v.kind) {
    case 'home':
    case 'held':
      return 'idle';
    case 'aboard':
      return v.on === null ? 'arrived' : v.on === 'missed' ? 'missed' : v.on.phase;
    case 'there':
      return 'arrived';
    case 'missed':
      return 'missed';
    case 'seen':
      return v.on.phase;
    case 'gone':
    case 'plan':
      return v.phase;
  }
}

/**
 * The trip's phase at `nowMs`. The rules in order; the first that holds
 * decides. A signal wins over the clock: once you say you're on the bus, it
 * doesn't matter that the leave-by passed.
 */
export async function phaseAt(t: TripIn, nowMs: number, look: Lookups): Promise<Verdict> {
  const { lat, lon } = t.at;
  // No location, and long enough since the last class to be home by now:
  // its planned bus has got you there, or with none planned, HOME_BY_MIN.
  if (t.home && lat === null && nowMs >= (t.home.homeBy ?? t.home.lastEndMs + HOME_BY_MIN * 60_000)) return { kind: 'home' };
  if (t.rec?.kind === 'boarded' && t.rec.boarded) return { kind: 'aboard', on: await onBus(t.rec.boarded, t.at, nowMs, look) };

  const { fresh, answer, bus } = await t.planned();
  // Seen at the class's stop before it starts.
  if (fresh.arrived && t.classAtMs != null && nowMs < t.classAtMs) return { kind: 'there' };
  // Still in the day's last class: the way home is the answer, but that trip
  // hasn't started ("Time to get going" in the middle of a lecture), and
  // nothing about its bus is assumed until the class ends.
  if (t.home && !t.rec && nowMs < t.home.lastEndMs) return { kind: 'held' };

  // Nobody said what happened and the bus left a while ago. Only where you
  // are can say whether you caught it; never assumed without that, or
  // someone still at the stop (with no fix, or a rough one) is told they're
  // on a bus. Nothing is asked either.
  if (!t.rec && bus && !answer.arrived && nowMs >= Date.parse(bus.board!) + ASSUME_MS) {
    // Still at the stop now (this request's location), not just earlier: missed.
    if (phaseFor(answer, undefined, nowMs, t.at) === 'waiting') return { kind: 'missed' };
    // Seen on it, now or by an earlier request (noted on the plan, so a
    // device without a location follows the phone).
    // On a trip that changes buses, on the second bus's road once it has left.
    const onSecond = (b: Plan) => Boolean(b.change?.board && nowMs >= Date.parse(b.change.board) && seenOnBus(b.change, lat!, lon!, nowMs));
    const seenNow = !bus.seen && lat !== null && lon !== null && (seenOnBus(bus, lat, lon, nowMs) || onSecond(bus));
    if (bus.seen || seenNow) {
      const on = await onBus(bus, t.at, nowMs, look);
      if (on && on !== 'missed') return { kind: 'seen', on, seenNow };
    }
    // Not known: the next way there, which is what you need if you missed
    // it, and says only that the bus has gone if you didn't. Under way
    // either way: never "Time to get going" to someone who may be on board.
    const phase = phaseFor(fresh, undefined, nowMs, t.at);
    return { kind: 'gone', phase: phase === 'idle' || phase === 'due' ? 'heading' : phase };
  }
  return { kind: 'plan', phase: phaseFor(answer, t.rec, nowMs, t.at) };
}

/**
 * The phase of a planned trip, from its answer and the latest signal.
 */
export function phaseFor(a: MeAnswer, rec: TripRecord | undefined, nowMs: number, at: At): Phase {
  if (a.arrived) return 'arrived';
  if (rec?.kind === 'boarded') return 'riding';
  if (rec?.kind === 'missed') return 'missed';
  if (rec?.kind === 'arrived') return 'arrived';
  const leaveAt = a.leave?.at ? Date.parse(a.leave.at) : null;
  // At the plan's boarding stop from a little before the leave-by: waiting,
  // whatever the clock says. Not hours before it (you may live by that
  // stop), and not at any other stop (riding past one is not waiting at it).
  const code = a.leave?.stopCode ?? a.stop.code;
  if (at.lat !== null && at.lon !== null && code && a.leave?.svc && (leaveAt === null || nowMs >= leaveAt - WAIT_EARLY_MS)) {
    const s = indexGraph(GRAPH).byCode.get(code);
    if (s && haversineM(at.lat, at.lon, s.lat, s.lon) <= AT_STOP_M) return 'waiting';
  }
  if (rec?.kind === 'left') return 'heading';
  if (leaveAt === null) return 'idle';
  if (nowMs >= leaveAt) return 'heading';
  if (nowMs >= leaveAt - DUE_MS) return 'due';
  return 'idle';
}

/**
 * Where a trip that changes buses is: on the first bus until it gets to the
 * change (`first`), at the change stop until the second bus has left
 * (`change`), then on the second. A trip on one bus is always `first`.
 * `firstLate`: the feed still has the first bus on its way to the change.
 * The second bus's time should be the feed's where it has one (secondBus in
 * next.ts), so a bus still due there keeps you at the change.
 */
export function rideStage(b: Plan, nowMs: number, firstLate = false): 'first' | 'change' | 'second' {
  if (!b.change) return 'first';
  if (firstLate || !b.arrive || nowMs < Date.parse(b.arrive)) return 'first';
  const leaves = secondLeavesMs(b.change);
  if (leaves === null || nowMs < leaves + CHANGE_GRACE_MS) return 'change';
  return 'second';
}

/**
 * On the bus `b` while it should still be on its way, with the feed's
 * arrival when there is one. On a trip that changes buses, the first bus,
 * then the change stop (`waiting`), then the second; `missed` when you're
 * still at the change stop once the second bus has left; null once the
 * ride is over.
 */
async function onBus(b: Plan, at: At, nowMs: number, look: Lookups): Promise<OnBus> {
  const c = b.change;
  if (c) {
    // Before the second bus leaves, the feed can say the first is still on its way.
    const leaves = secondLeavesMs(c);
    const before = leaves === null || nowMs < leaves + CHANGE_GRACE_MS;
    const live = before ? await look.liveArrival(b) : null;
    if (rideStage(b, nowMs, live !== null) === 'first') {
      const cur = live ? { ...b, arrive: live } : b;
      return { phase: 'riding', b: cur, live: live !== null };
    }
    // Off the first bus: the feed at the change stop says whether the
    // second bus has left, not the plan's time alone.
    const second = await look.secondBus(b);
    const cur = { ...b, change: second.change };
    if (rideStage(cur, nowMs) === 'change') return { phase: 'waiting', b: cur, live: second.live };
    const gone = secondLeavesMs(cur.change);
    const s = c.stopCode ? indexGraph(GRAPH).byCode.get(c.stopCode) : undefined;
    if (
      s &&
      gone !== null &&
      at.lat !== null &&
      at.lon !== null &&
      haversineM(at.lat, at.lon, s.lat, s.lon) <= AT_STOP_M &&
      nowMs >= gone + ASSUME_MS
    )
      return 'missed';
    return onBus(cur.change, at, nowMs, look);
  }
  const live = await look.liveArrival(b);
  const cur = live ? { ...b, arrive: live } : b;
  const arrive = cur.arrive ? Date.parse(cur.arrive) : null;
  if (arrive === null || nowMs < arrive) return { phase: 'riding', b: cur, live: live !== null };
  if (nowMs >= arrive + RIDE_GRACE_MS) return null;
  // That arrival has passed and nothing says you're there: you caught the
  // bus after it, or it's running late. A time in the past is no answer,
  // so the next bus of the service due at your stop is the guess, marked
  // as one; with nothing due, the card says only where to get off.
  // The ride still ends RIDE_GRACE_MS after the arrival that passed (`ends`), not the guess's.
  const later = await look.nextArrival(b);
  return { phase: 'riding', b: { ...b, arrive: later }, live: false, ends: cur.arrive! };
}

/**
 * When the trip's phase next changes by itself: due, the leave-by, the
 * planned bus taken to have gone (ASSUME_MS after it left, when nothing
 * said otherwise), the class starting, the ride ending. Null outside a trip. The Trip object
 * wakes at this to push; the card's nextChangeAt also counts going stale.
 */
export function changesAt(a: MeAnswer, trip: TripView, nowMs: number, leaveGapMs = 0): number | null {
  if (!trip.key) return null;
  const marks: number[] = [];
  const l = a.leave ?? null;
  const plan = trip.plan ?? null;
  // Not as the bus leaves: nothing changes then (`gone` is ASSUME_MS on).
  if (plan?.board && !trip.rec) marks.push(Date.parse(plan.board) + ASSUME_MS);
  // A trip that changes buses: at the change, once the second bus has left
  // (with you on it, or still at the stop: missed), and the trip's end.
  const twoBus = trip.rec?.boarded ?? plan;
  const c = twoBus?.change;
  if (twoBus && c) {
    if (twoBus.arrive) marks.push(Date.parse(twoBus.arrive));
    const leaves = secondLeavesMs(c);
    if (leaves !== null) marks.push(leaves + CHANGE_GRACE_MS, leaves + ASSUME_MS);
    const end = tripEnd(twoBus);
    if (end) marks.push(Date.parse(end) + RIDE_GRACE_MS);
  }
  // The leave-by's marks, no sooner than `leaveGapMs` from now (see LEAVE_GAP_MS).
  if (l?.at) for (const t of [Date.parse(l.at) - DUE_MS, Date.parse(l.at)]) if (t > nowMs) marks.push(Math.max(t, nowMs + leaveGapMs));
  if (a.timing?.classAt) marks.push(Date.parse(a.timing.classAt) + LATE_GRACE_MIN * 60_000);
  const onBus = trip.rec?.boarded ?? (trip.assumed ? plan : null);
  const rideEnd = trip.rideEnd ?? onBus?.arrive;
  if (trip.phase === 'riding' && onBus && rideEnd) marks.push(Date.parse(rideEnd) + RIDE_GRACE_MS);
  return marks.filter((m) => m > nowMs).sort((x, y) => x - y)[0] ?? null;
}
