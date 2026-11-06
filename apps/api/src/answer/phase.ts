/**
 * A trip's phase: which one it's in now, and when it next changes by itself.
 *
 *   idle → due → heading → waiting → riding → arrived
 *                 └──────────┴──→ missed → (replanned) → due
 *            └──→ skipped
 *
 * The phase is worked out on each request, and by the Trip object when it
 * wakes to push (tripdo.ts), from the answer (its leave-by, whether you're
 * there), the trip's signal and plan (trip.ts), where the request is, and,
 * for the bus you're on, the feed, read through `Lookups` only when a rule
 * needs it. The planner (next.ts) words the answer for the phase.
 *
 * The rules are `phaseAt`, in order, and every moment one compares the time
 * with goes through its `Clock`. So a transition is its condition and its
 * time at once: `tripPhase` reads the phase now from the rules, and when it
 * next changes from the same rules, at the first of those moments where
 * they say something else. The Trip object wakes then; a moment missed
 * would be a push missed. See internals.md, "The trip engine".
 */

import type { MeAnswer } from '../types.ts';
import { type Phase, type Plan, type TripRecord, seenOnBus } from './trip.ts';
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
  /** When the bus `b` (by its plate) reaches the stop you get off at, ISO,
   *  past or not, or null when the feed doesn't list it there. */
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
export type Aboard = { phase: 'riding' | 'waiting'; b: Plan; live: boolean };

/** On a bus, still at the change stop once the second bus has gone (`missed`), or there by now (null). */
export type OnBus = Aboard | 'missed' | null;

/** Which rule a trip's phase came from, with what the planner needs to word it. */
export type Verdict =
  /** A class trip LATE_GRACE_MIN after the class started: the planner has moved on to the next trip. */
  | { kind: 'past' }
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
    case 'past':
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
 * What a phone is told about a verdict: the trip (another one or none, for
 * `past` and `home`), its phase, whether the bus has gone, and which bus of
 * a trip that changes buses you're on. Two verdicts alike here are the same
 * card to push (tripdo.ts compares the trip, phase and `gone`).
 */
export function shown(v: Verdict): string {
  if (v.kind === 'past' || v.kind === 'home') return v.kind;
  const on = v.kind === 'aboard' || v.kind === 'seen' ? v.on : null;
  const bus = on && on !== 'missed' ? (on.b.change ? 'first' : 'last') : '';
  return `${phaseOf(v)}:${v.kind === 'gone' ? 'gone' : ''}:${bus}`;
}

/**
 * The time a rule is asked about, and the moments it compares that with.
 * Every comparison with the time in the rules goes through `reached`, so a
 * rule can't move the phase at a time `changesAt` doesn't know of.
 */
export interface Clock {
  readonly ms: number;
  /** Whether `atMs` has come; a later one is noted as a moment the phase
   *  can change. `leave`: it moves with the leave-by (see LEAVE_GAP_MS). */
  reached(atMs: number, leave?: boolean): boolean;
}

/** A clock at `ms`, noting each later moment it's asked about in `noted` (true when one moves with the leave-by). */
function clockAt(ms: number, noted: Map<number, boolean>): Clock {
  return {
    ms,
    reached(atMs, leave = false) {
      if (Number.isFinite(atMs) && atMs > ms) noted.set(atMs, noted.get(atMs) === true || leave);
      return ms >= atMs;
    },
  };
}

/** The next time a trip's phase changes by itself. `leave`: a leave-by's moment, which slides with it. */
export interface Change {
  at: number;
  leave: boolean;
}

/** How many moments `changesOf` tries before taking the next to be a change: far more than a day's trip has. */
const MAX_MOMENTS = 64;

/**
 * Where `decide` says something else than it does at `nowMs`: the first
 * moment it compares the time with at which the rules give another verdict,
 * trying each in turn, and the moments that one compares with. Between two
 * moments every comparison comes out the same, so nothing changes there.
 * `decide` throws at a moment it can't say without a call it didn't need
 * at `nowMs`; that moment counts as a change.
 */
async function changesOf<V>(
  decide: (c: Clock) => Promise<V>,
  nowMs: number,
  same: (a: V, b: V) => boolean,
): Promise<{ now: V; next: Change | null }> {
  const noted = new Map<number, boolean>();
  const now = await decide(clockAt(nowMs, noted));
  for (let i = 0; noted.size; i++) {
    const at = Math.min(...noted.keys());
    const next = { at, leave: noted.get(at)! };
    noted.delete(at);
    if (i >= MAX_MOMENTS) return { now, next };
    const more = new Map<number, boolean>();
    const then = await decide(clockAt(at, more)).catch(() => null);
    if (then === null || !same(now, then)) return { now, next };
    for (const [m, leave] of more) noted.set(m, noted.get(m) === true || leave);
  }
  return { now, next: null };
}

/**
 * The feed's answers as they came for `nowMs`, so a later moment is
 * worked out from the same feed, and from no more of it: a lookup not
 * asked for now is taken as the plan's times, rather than called (rule 2).
 */
function remembered(look: Lookups): { now: Lookups; later: Lookups } {
  const asked = new Map<string, Promise<unknown>>();
  const keep = <T>(name: string, b: Plan, ask: () => Promise<T>): Promise<T> => {
    const k = `${name}:${JSON.stringify(b)}`;
    if (!asked.has(k)) asked.set(k, ask());
    return asked.get(k) as Promise<T>;
  };
  const kept = <T>(name: string, b: Plan, otherwise: T): Promise<T> =>
    (asked.get(`${name}:${JSON.stringify(b)}`) as Promise<T> | undefined) ?? Promise.resolve(otherwise);
  return {
    now: {
      liveArrival: (b) => keep('live', b, () => look.liveArrival(b)),
      secondBus: (b) => keep('second', b, () => look.secondBus(b)),
      nextArrival: (b) => keep('next', b, () => look.nextArrival(b)),
    },
    later: {
      liveArrival: (b) => kept('live', b, null),
      secondBus: (b) => kept('second', b, { change: b.change!, live: false }),
      nextArrival: (b) => kept('next', b, null),
    },
  };
}

/**
 * A trip's phase at `nowMs` (the verdict, which the planner words), and when
 * it next changes by itself, or null when it won't.
 *
 * The change counts only what this caller can see: where it is is taken to
 * stay where it is now, so a request without a location (the Trip object's
 * wake) never counts a moment only a location makes a change (at the stop,
 * seen on the bus), and one with a location does. The feed is taken to say
 * what it says now (see `remembered`).
 */
export async function tripPhase(t: TripIn, nowMs: number, look: Lookups): Promise<{ verdict: Verdict; changesAt: Change | null }> {
  const feed = remembered(look);
  let planned: Promise<TripPlan> | undefined;
  const asNow: TripIn = { ...t, planned: () => (planned ??= t.planned()) };
  // The answer, too, stays the one for now; and isn't worked out for later if now didn't need it.
  const asLater: TripIn = { ...t, planned: () => planned ?? Promise.reject(new Error('not planned now')) };
  let first = true;
  const { now, next } = await changesOf(
    (c) => {
      const v = first ? phaseAt(asNow, c, feed.now) : phaseAt(asLater, c, feed.later);
      first = false;
      return v;
    },
    nowMs,
    (a, b) => shown(a) === shown(b),
  );
  return { verdict: now, changesAt: next };
}

/** The phase of a trip that is only its answer (the way home in the evening), and when it next changes. */
export async function answerPhase(
  a: MeAnswer,
  rec: TripRecord | undefined,
  at: At,
  nowMs: number,
): Promise<{ phase: Phase; changesAt: Change | null }> {
  const { now, next } = await changesOf(
    async (c) => phaseFor(a, rec, c, at),
    nowMs,
    (x, y) => x === y,
  );
  return { phase: now, changesAt: next };
}

/**
 * The trip's phase at the clock's time. The rules in order; the first that
 * holds decides. A signal wins over the clock: once you say you're on the
 * bus, it doesn't matter that the leave-by passed.
 */
async function phaseAt(t: TripIn, c: Clock, look: Lookups): Promise<Verdict> {
  const { lat, lon } = t.at;
  // Never at the request's own time: the planner (nextClass) has moved on by then.
  if (t.classAtMs != null && c.reached(t.classAtMs + LATE_GRACE_MIN * 60_000)) return { kind: 'past' };
  // No location, and long enough since the last class to be home by now:
  // its planned bus has got you there, or with none planned, HOME_BY_MIN.
  if (t.home && lat === null && c.ms >= (t.home.homeBy ?? t.home.lastEndMs + HOME_BY_MIN * 60_000)) return { kind: 'home' };
  if (t.rec?.kind === 'boarded' && t.rec.boarded) return { kind: 'aboard', on: await onBus(t.rec.boarded, t.at, c, look) };

  const { fresh, answer, bus } = await t.planned();
  // Seen at the class's stop before it starts.
  if (fresh.arrived && t.classAtMs != null && !c.reached(t.classAtMs)) return { kind: 'there' };
  // Still in the day's last class: the way home is the answer, but that trip
  // hasn't started ("Time to get going" in the middle of a lecture), and
  // nothing about its bus is assumed until the class ends.
  if (t.home && !t.rec && c.ms < t.home.lastEndMs) return { kind: 'held' };

  // Nobody said what happened and the bus left a while ago. Only where you
  // are can say whether you caught it; never assumed without that, or
  // someone still at the stop (with no fix, or a rough one) is told they're
  // on a bus. Nothing is asked either.
  if (!t.rec && bus?.board && !answer.arrived && c.reached(Date.parse(bus.board) + ASSUME_MS)) {
    // Still at the stop now (this request's location), not just earlier: missed.
    if (phaseFor(answer, undefined, c, t.at) === 'waiting') return { kind: 'missed' };
    // Seen on it, now or by an earlier request (noted on the plan, so a
    // device without a location follows the phone). On a trip that changes
    // buses, on the second bus's road once it has left. A location is taken
    // as it is: seenOnBus at a later moment asks whether you could have
    // walked there since, and once seen the plan says so (`seen`).
    const onSecond = (b: Plan) =>
      Boolean(b.change?.board && c.reached(Date.parse(b.change.board)) && seenOnBus(b.change, lat!, lon!, c.ms));
    const seenNow = !bus.seen && lat !== null && lon !== null && (seenOnBus(bus, lat, lon, c.ms) || onSecond(bus));
    if (bus.seen || seenNow) {
      const on = await onBus(bus, t.at, c, look);
      if (on && on !== 'missed') return { kind: 'seen', on, seenNow };
    }
    // Not known: the next way there, which is what you need if you missed
    // it, and says only that the bus has gone if you didn't. Under way
    // either way: never "Time to get going" to someone who may be on board.
    const phase = phaseFor(fresh, undefined, c, t.at);
    return { kind: 'gone', phase: phase === 'idle' || phase === 'due' ? 'heading' : phase };
  }
  return { kind: 'plan', phase: phaseFor(answer, t.rec, c, t.at) };
}

/** The phase of a planned trip, from its answer and the latest signal. */
function phaseFor(a: MeAnswer, rec: TripRecord | undefined, c: Clock, at: At): Phase {
  if (a.arrived) return 'arrived';
  if (rec?.kind === 'boarded') return 'riding';
  if (rec?.kind === 'missed') return 'missed';
  if (rec?.kind === 'arrived') return 'arrived';
  const leaveAt = a.leave?.at ? Date.parse(a.leave.at) : null;
  // At the plan's boarding stop from a little before the leave-by: waiting,
  // whatever the clock says. Not hours before it (you may live by that
  // stop), and not at any other stop (riding past one is not waiting at it).
  const code = a.leave?.stopCode ?? a.stop.code;
  if (at.lat !== null && at.lon !== null && code && a.leave?.svc && (leaveAt === null || c.reached(leaveAt - WAIT_EARLY_MS, true))) {
    const s = indexGraph(GRAPH).byCode.get(code);
    if (s && haversineM(at.lat, at.lon, s.lat, s.lon) <= AT_STOP_M) return 'waiting';
  }
  if (rec?.kind === 'left') return 'heading';
  if (leaveAt === null) return 'idle';
  if (c.reached(leaveAt, true)) return 'heading';
  if (c.reached(leaveAt - DUE_MS, true)) return 'due';
  return 'idle';
}

/**
 * On the bus `b` while it should still be on its way, with the feed's
 * arrival when there is one. On a trip that changes buses: the first bus
 * until it gets to the change, then the change stop (`waiting`) until the
 * second bus has left, by the feed at the change stop where it has the bus
 * (so a bus still due there keeps you at the change), then the second.
 * `missed` when you're still at the change stop once the second bus has
 * left; null once the ride is over.
 */
async function onBus(b: Plan, at: At, c: Clock, look: Lookups): Promise<OnBus> {
  const second = b.change;
  if (second) {
    // Before the second bus leaves, the feed can say the first is still on its way to the change.
    const leaves = secondLeavesMs(second);
    const before = leaves === null || !c.reached(leaves + CHANGE_GRACE_MS);
    const live = before ? await liveBy(b, c, look) : null;
    if (live !== null || !b.arrive || !c.reached(Date.parse(b.arrive)))
      return { phase: 'riding', b: live ? { ...b, arrive: live } : b, live: live !== null };
    // Off the first bus: the feed at the change stop says whether the
    // second bus has left, not the plan's time alone.
    const fed = await look.secondBus(b);
    const cur = { ...b, change: fed.change };
    const gone = secondLeavesMs(fed.change);
    if (gone === null || !c.reached(gone + CHANGE_GRACE_MS)) return { phase: 'waiting', b: cur, live: fed.live };
    const s = second.stopCode ? indexGraph(GRAPH).byCode.get(second.stopCode) : undefined;
    if (s && at.lat !== null && at.lon !== null && haversineM(at.lat, at.lon, s.lat, s.lon) <= AT_STOP_M && c.reached(gone + ASSUME_MS))
      return 'missed';
    return onBus(fed.change, at, c, look);
  }
  const live = await liveBy(b, c, look);
  const arrive = live ?? b.arrive;
  if (arrive === null || !c.reached(Date.parse(arrive)))
    return { phase: 'riding', b: live ? { ...b, arrive: live } : b, live: live !== null };
  if (c.reached(Date.parse(arrive) + RIDE_GRACE_MS)) return null;
  // That arrival has passed and nothing says you're there: you caught the
  // bus after it, or it's running late. A time in the past is no answer,
  // so the next bus of the service due at your stop is the guess, marked
  // as one; with nothing due, the card says only where to get off.
  return { phase: 'riding', b: { ...b, arrive: await look.nextArrival(b) }, live: false };
}

/** The feed's arrival for the bus you're on, while it's still to come. */
async function liveBy(b: Plan, c: Clock, look: Lookups): Promise<string | null> {
  const live = await look.liveArrival(b);
  return live !== null && !c.reached(Date.parse(live)) ? live : null;
}
