/**
 * What every client shows, worded once.
 *
 * The Android app and widget, the notifications, the Mac popover and the
 * account page's preview all render /me/next. Each used to build the class
 * card's lines, the crowd word, the quality note and the "old" rule for
 * itself, and they drifted. Now the server sends them in `card`; clients keep
 * only what has to tick: "Leave now" once `leave.at` passes, countdowns, and
 * dimming once `card.staleAt` passes.
 */

import type { BusLeg, Crowd, Dest, Leave, MeAnswer, Quality } from './types.ts';
import { clockAt, slackText } from './clock.ts';
import { ASSUME_MS, type Boarded, DUE_MS, type Phase, RIDE_GRACE_MS, type Ride, type TripRecord, isHomeKey, offStop, rideOf } from './trip.ts';
import { LATE_GRACE_MIN } from './profile.ts';
import type { Suggestion } from './outcomes.ts';
import { GRAPH } from './graph.ts';
import { indexGraph } from './resolve.ts';
import { targetStops } from './landmarks.ts';
import { isoSeconds as iso, mins, named, shortStop } from './format.ts';
import { routeColor } from './campus.ts';
import { WALK } from './config.ts';
import { m } from './i18n.ts';

export type CardKind = 'class' | 'trip' | 'nearby' | 'rest' | 'arrived' | 'setup' | 'free';

/** A button the server decided to show. Clients render it and send `id`
 *  and `trip` back to /me/signal; they never decide which to show. */
export interface CardAction {
  id: 'boarded' | 'missed' | 'skipped' | 'arrived' | 'reset' | 'away' | 'back';
  label: string;
  trip: string;
}

/** Where the day's trip is, for the card (trip.ts). */
export interface TripView {
  key: string | null;
  phase: Phase;
  rec?: TripRecord;
  /** A trip skipped a moment ago, so it can be undone. */
  undo?: { key: string; label: string } | null;
  /** The bus the plan says to catch, kept once the answer has moved on to riding. */
  plan?: Boarded | null;
  /** The phase is the plan's, not something anyone said (no answer to the question). */
  assumed?: boolean;
  /** The plan's bus differs from the one remembered for this trip (the caller saves it). */
  planChanged?: boolean;
  /** False when the user turned reminders off for this trip. */
  remind?: boolean;
  /** Something terminus has learned and offers to change (outcomes.ts). */
  suggestion?: Suggestion | null;
  /** Today was set to "Not on campus" (phase 8.3): offer "Back on campus". */
  away?: boolean;
  /** The phone is following this trip by location (phase 8.1): nobody is
   *  asked what happened, it's worked out. */
  followed?: boolean;
  /** A trip this request's location says is over (home, in your
   *  residence, or at the destination): the caller records it as reached. */
  reached?: string;
}

/** A bus in the journey: the service, its colour as painted on the bus, its stop and when it leaves. */
export interface JourneyBus {
  svc: string;
  color: string;
  stop: string;
  /** "4:05 PM", "~4:05 PM" for an estimate. */
  board: string;
  /** A public bus, with a fare. Absent for a shuttle. */
  paid?: true;
}

/**
 * The trip as steps, for the card styles that draw it (a line from you to
 * the destination, a ticket, a list of steps): walk to the stop, take the
 * bus, get there. On foot the whole way it's the walk alone, with no bus.
 * Every client draws the same steps from this; only the leave countdown
 * ticks on the client, from `leave.at` (and `boardAt`).
 */
export interface Journey {
  /** When to set off ("4:01 PM", "~4:01 PM"); null when it's now. */
  leave: string | null;
  /** The walk to the stop ("3 min"); null when you're at it. On foot, the
   *  whole walk there. */
  walk: string | null;
  /** The bus to catch; null on foot. */
  bus: JourneyBus | null;
  /** When the bus leaves, ISO, to count down to; null on foot. */
  boardAt: string | null;
  /** Time on the bus ("3 min"); null on foot. */
  ride: string | null;
  /** Where to get off, when that's across the road from the destination. */
  off: string | null;
  /** Where you're going ("GEA1000 @ UTown"), the stop you get off at
   *  ("UTown", short enough for the end of a line), and when you get there
   *  ("4:08 PM"): to the room or building itself when it's a walk from the stop. */
  to: string;
  toStop: string;
  arrive: string | null;
  /** The walk from `toStop` to where you're going ("2 min"): a class's room,
   *  a building searched for, a food court. Null when it's at the stop. */
  walkEnd: string | null;
  /** When the bus gets to `toStop`; the same as `arrive` with no `walkEnd`. */
  arriveStop: string | null;
  /** A class only: "3 min early", "2 min late". */
  slack: string | null;
  /** The bus's time is live, not a timetable estimate. */
  live: boolean;
  /** Another bus: the next one for a trip, the one to go now on for a class. */
  backup: JourneyBus | null;
  /** On foot: why not a bus ("D1 would be 16 min"). Null with a bus. */
  why: string | null;
}

/**
 * The next class, for the card under Done for today (or no classes today):
 * when, what and where, each a line ready to show. Only what the timetable
 * says: no bus, since tomorrow's buses aren't known yet.
 */
export interface Upcoming {
  /** "Tomorrow · Tue", "Today", "Wednesday", "Mon 28 Sep". */
  when: string;
  /** "CS2030 at 10:00". */
  title: string;
  /** "At COM1 · get off at COM 3", or "At COM 3" when the room is at the stop. */
  where: string;
  /** Why today has none, when it's a break: "Recess week", a holiday. */
  off: string | null;
}

export interface Card {
  kind: CardKind;
  /** Dim the answer from this instant: the bus has gone, the plan has moved
   *  on, or it is 15 minutes old. Null: never on its own (setup). */
  staleAt: string | null;
  /** "Crowding: low" / "Crowding: medium" / "Crowding: high", for the bus in the headline. */
  crowd: string | null;
  /** "Timetable estimate", "Live times are a few minutes old", "No live data". */
  quality: string | null;
  /** "Leave by ~6:36 PM". Clients say "Leave now" once `leave.at` passes,
   *  except at the stop (phase `waiting`), where it's the bus: "D2 at 6:41 PM". */
  leaveBy: string | null;
  /** "catch the 6:38 PM D2 at PGP", after the leave-by on non-class trips. */
  leaveVia: string | null;
  /** Class only: "Catch the 6:38 PM D2 at PGP", or "Walk there". */
  catch: string | null;
  /** Class only: "Arrive 6:53 PM · 5 min early". */
  arrive: string | null;
  /** Class only: both on one line, for the widget and notifications. */
  catchLine: string | null;
  /** Class only: the arrival misses the start. */
  late: boolean;
  /** Class only: "Or go now: R2 at 6:31 PM · arrive 6:46 PM". */
  goNow: string | null;
  /** Class only: why the leave-by is earlier than it could be. */
  note: string | null;
  /** Class only, when the leave-by rests on a headway guess. */
  estimate: string | null;

  /* v2: every surface picks what fits. */
  /** Where the trip is. 'idle' when there is no trip in progress. */
  phase: Phase;
  /** A few words on the phase, above the answer: "On your way". Null when idle. */
  phaseText: string | null;
  /** 12 characters at most: a watch face, the menu bar, a tile. "D2 9:41". */
  glance: string;
  /** One line: a collapsed notification, a compact widget. */
  line: string;
  /** Buttons to show, in order. */
  actions: CardAction[];
  /** "Last D2 from UTown in 18 min". */
  warning: string | null;
  /** When this card should be expected to change by itself; refetch then. */
  nextChangeAt: string | null;
  /** False when the user asked for no reminders for this trip: no leave
   *  notification. The card itself is unchanged. */
  remind: boolean;
  /** "Leave one bus earlier for CS2030?", with its two buttons: send the id
   *  to /me/choice. Never during a trip. */
  suggestion: Suggestion | null;
  /** On the bus: the stops from boarding to getting off and the board and
   *  arrival times (the arrival live when the bus's plate is known), for a
   *  progress bar. Null otherwise. */
  ride: Ride | null;
  /** The phase was worked out from the phone's location, not tapped (phase
   *  8.1): "Looks like you're on the bus". */
  detected: boolean;
  /** Where to walk to now, for a maps app's walking directions: the stop to
   *  catch the bus at, or the destination's stop when the answer is to walk.
   *  Null on the bus, at the stop, once there, and with nothing to catch. */
  walkTo: { name: string; lat: number; lon: number } | null;
  /** "NUS's live bus times have been down since 9:14 AM": a notice above
   *  the answer while the monitor has the feed down and this answer is an
   *  estimate or has no time. Null otherwise. */
  notice: string | null;
  /** The card's times are 12-hour ("6:36 PM"), not 24-hour ("18:36"): the
   *  account's choice, else the request's. Clients write their own times
   *  (a class's start, "Updated") the same way. */
  h12: boolean;
  /** The trip as steps, when there's a bus to catch and you're not on it
   *  yet, or a walk the whole way. */
  journey: Journey | null;
  /** Rest, free and home: the next class, for its own card. Null with none
   *  coming, and on every other kind. */
  upcoming: Upcoming | null;
}

/** Answers older than this are dimmed even if nothing else says so. */
export const MAX_AGE_MS = 15 * 60_000;
/** A bus shown leaving at 09:42 may still be at the stop at 09:42:20. */
export const DEPARTED_GRACE_MS = 30_000;

const CROWD: Record<Crowd, () => string> = { low: () => m().crowdLowCap, medium: () => m().crowdMediumCap, high: () => m().crowdHighCap };
const QUALITY: Partial<Record<Quality, () => string>> = {
  scheduled: () => m().qualityScheduled,
  stale: () => m().qualityStale,
  unknown: () => m().qualityUnknown,
};

function kindOf(a: MeAnswer): CardKind {
  if (a.mode === 'rest') return 'rest';
  if (a.mode === 'free') return 'free';
  if (a.arrived) return 'arrived';
  if (a.quality === 'unknown' && !a.arrivals.length && !a.stop.code && !a.leave) return 'setup';
  if (a.mode === 'nearby') return 'nearby';
  if (a.dest?.why === 'class' && a.leave && a.timing) return 'class';
  return 'trip';
}

function staleAtOf(a: MeAnswer, kind: CardKind): number | null {
  const marks: number[] = [];
  if (a.refreshAt) marks.push(Date.parse(a.refreshAt));
  // Nothing on a rest or free card depends on live times.
  if (kind !== 'rest' && kind !== 'setup' && kind !== 'free') {
    if (a.departsAt) marks.push(Date.parse(a.departsAt) + DEPARTED_GRACE_MS);
    marks.push(Date.parse(a.asOf) + MAX_AGE_MS);
  }
  return marks.length ? Math.min(...marks) : null;
}

type V2 = 'phase' | 'phaseText' | 'glance' | 'line' | 'actions' | 'warning' | 'nextChangeAt' | 'remind' | 'suggestion' | 'ride' | 'detected' | 'walkTo';
type V1 = Omit<Card, V2 | 'notice' | 'h12' | 'journey' | 'upcoming'>;

/**
 * `feedDownSince`: when the monitor confirmed NUS's feed down, or null while
 * it's up. `nowMs`: the request's now; a stale answer's `asOf` is older.
 */
export function cardFor(a: MeAnswer, h12 = false, trip: TripView = { key: null, phase: 'idle' }, feedDownSince: number | null = null, nowMs = Date.parse(a.asOf)): Card {
  const card = v1(a, h12);
  // At the stop, there's nowhere to leave: the headline is the bus to wait for
  // ("D2 at 9:41"). Apps show it as it is, without turning it into "Leave now".
  const l = a.leave ?? null;
  if (trip.key && trip.phase === 'waiting' && l?.svc && l.board) card.leaveBy = m().busAt(l.svc, approx(l.estimated, clockAt(Date.parse(l.board), h12)));
  // Only on an answer that wanted a live time and has none: the feed may be
  // back before the monitor's next check, and a day with no bus needs none.
  const notice = feedDownSince !== null && QUALITY[a.quality] ? m().feedDown(clockAt(feedDownSince, h12)) : null;
  return { ...card, ...v2(a, card, h12, trip, nowMs), notice, h12, journey: journeyOf(a, card, h12, trip.phase, nowMs), upcoming: a.upcoming ?? null };
}

/** The journey (see Journey): null on the bus, once there, and with no time to give. */
export function journeyOf(a: MeAnswer, card: V1, h12: boolean, phase: Phase, nowMs = Date.parse(a.asOf)): Journey | null {
  if ((card.kind !== 'class' && card.kind !== 'trip') || !a.dest) return null;
  if (phase === 'riding' || phase === 'arrived') return null;
  const l = a.leave ?? null;
  // The leave-by's bus, which a kept plan fixes for the trip (see next.ts);
  // with no leave-by (a bus about to go), a trip's headline bus.
  const planned: BusLeg | null =
    l?.svc && l.stop && l.board
      ? {
          svc: l.svc,
          stop: l.stop,
          stopCode: l.stopCode ?? '',
          // A plan kept from before the leave-by carried these: worked out from its own times.
          walkS: l.walkS ?? Math.max(0, (Date.parse(l.board) - Date.parse(l.at)) / 1000 - WALK.boardBufferS),
          rideS: l.rideS ?? (l.arrive ? Math.max(0, (Date.parse(l.arrive) - Date.parse(l.board)) / 1000) : 0),
          board: l.board,
          arrive: l.arrive,
          estimated: l.estimated,
          ...(l.off ? { off: l.off } : {}),
          ...(l.toStop ? { toStop: l.toStop } : {}),
          ...(l.endWalkS ? { endWalkS: l.endWalkS } : {}),
          ...(l.paid ? { paid: true as const } : {}),
        }
      : null;
  // On foot the whole way, unless a kept plan still has a bus to catch.
  if (!planned && a.foot) return footJourney(a, a.dest, a.foot, card, h12, nowMs);
  const leg = planned ?? (card.kind === 'class' ? null : (a.bus ?? null));
  if (!leg?.board) return null;
  const at = (iso: string, estimated: boolean) => approx(estimated, clockAt(Date.parse(iso), h12));
  const busOf = (b: BusLeg): JourneyBus | null => (b.board ? { svc: b.svc, color: routeColor(b.svc), stop: b.stop, board: at(b.board, b.estimated), ...(b.paid ? { paid: true as const } : {}) } : null);
  // A class's backup is the headline bus when it isn't the one to wait for;
  // a trip's, the headline bus when a plan holds another, else the other bus.
  const headlineDiffers = Boolean(planned && a.bus && !(a.bus.svc === planned.svc && a.bus.stop === planned.stop && a.bus.board === planned.board));
  const other = card.kind === 'class' ? (card.goNow ? a.bus : null) : headlineDiffers ? a.bus : a.altBus;
  const classAt = a.timing ? Date.parse(a.timing.classAt) : null;
  // The walk on from the stop this bus gets you off at. A class's leave-by
  // already counts it in its arrival (it aims at the room); a bus's arrival is at the stop.
  const endS = leg.endWalkS ?? a.endWalk?.s ?? 0;
  const stopMs = leg.arrive ? Date.parse(leg.arrive) - (leg === planned && a.endWalk?.inLeave ? endS * 1000 : 0) : null;
  const thereMs = stopMs != null ? stopMs + endS * 1000 : null;
  const walkEnd = endS >= 45 ? mins(endS) : null;
  const arrive = thereMs != null ? approx(leg.estimated, clockAt(thereMs, h12)) : null;
  return {
    leave: l && Date.parse(l.at) > nowMs ? at(l.at, l.estimated) : null,
    // At the stop, or close enough that the walk is nothing.
    walk: phase === 'waiting' || leg.walkS < 45 ? null : mins(leg.walkS),
    bus: busOf(leg)!,
    boardAt: leg.board,
    ride: mins(leg.rideS),
    off: leg.off ?? null,
    to: a.dest.label,
    // Where this bus stops, which for a place with several stops may not be its first.
    toStop: leg.off ?? leg.toStop ?? stopName(targetStops(a.dest.to).to) ?? a.dest.label,
    arrive,
    walkEnd,
    arriveStop: walkEnd && stopMs != null ? approx(leg.estimated, clockAt(stopMs, h12)) : arrive,
    slack: card.kind === 'class' && classAt != null && thereMs != null ? slackText((classAt - thereMs) / 1000) : null,
    // Not a kept plan's or a stale feed's time: exact, but an older reading.
    live: a.quality === 'live' && !leg.estimated && !(leg === planned && l?.stale),
    backup: other ? busOf(other) : null,
    why: null,
  };
}

/**
 * The walk the whole way, as a journey with no bus. A class leaves at its
 * leave-by and gets to the room as the leave-by says; anything else is now,
 * for the walk the answer says.
 */
function footJourney(a: MeAnswer, dest: Dest, foot: NonNullable<MeAnswer['foot']>, card: V1, h12: boolean, nowMs: number): Journey {
  const l = a.leave ?? null;
  const fromMs = l ? Date.parse(l.at) : nowMs;
  const thereMs = l?.arrive ? Date.parse(l.arrive) : nowMs + foot.s * 1000;
  const classAt = a.timing ? Date.parse(a.timing.classAt) : null;
  const arrive = clockAt(thereMs, h12);
  return {
    leave: fromMs > nowMs ? clockAt(fromMs, h12) : null,
    walk: mins((thereMs - fromMs) / 1000),
    bus: null,
    boardAt: null,
    ride: null,
    off: null,
    to: dest.label,
    toStop: stopName(targetStops(dest.to).to) ?? dest.label,
    arrive,
    walkEnd: null,
    arriveStop: arrive,
    slack: card.kind === 'class' && classAt != null ? slackText((classAt - thereMs) / 1000) : null,
    live: false,
    backup: null,
    why: foot.why,
  };
}

function v1(a: MeAnswer, h12: boolean): V1 {
  const kind = kindOf(a);
  const at = (iso: string) => clockAt(Date.parse(iso), h12);
  const staleAt = staleAtOf(a, kind);
  const svc = a.label.split(' · ')[0];
  const crowd = a.arrivals.find((x) => x.svc === svc)?.crowd ?? null;
  const l = a.leave ?? null;
  // "~9:41" when the leave-by is an estimate.
  const est = (iso: string) => approx(l?.estimated, at(iso));

  const card: V1 = {
    kind,
    staleAt: staleAt == null ? null : iso(staleAt),
    crowd: crowd ? CROWD[crowd]() : null,
    quality: QUALITY[a.quality]?.() ?? null,
    leaveBy: l ? m().leaveBy(est(l.at)) : null,
    // "95 ($)": the fare shows in the words, for the clients that show only them (the Mac, notifications).
    leaveVia: l?.svc && l.stop ? m().leaveVia(l.board ? est(l.board) : null, named({ svc: l.svc, paid: l.paid }), l.stop, l.off ?? null) : null,
    catch: null,
    arrive: null,
    catchLine: null,
    late: false,
    goNow: null,
    note: null,
    estimate: null,
  };
  if (kind !== 'class' || !l || !a.timing) return card;

  const classAt = Date.parse(a.timing.classAt);
  // The bus stops across the road from the class's stop: say where to get off.
  card.catch = l.svc ? m().catchBus(l.board ? est(l.board) : null, named({ svc: l.svc, paid: l.paid }), l.stop ?? '', l.off ?? null) : m().walkThere;
  if (l.arrive) {
    const arrive = Date.parse(l.arrive);
    const slack = slackText((classAt - arrive) / 1000);
    card.arrive = m().arrive(est(l.arrive), slack);
    card.catchLine = m().catchLine(card.catch, est(l.arrive), slack);
    card.late = arrive > classAt;
  } else {
    card.catchLine = card.catch;
  }
  // The headline bus, when it isn't the one to wait for.
  const timed = a.departsAt && a.quality !== 'unknown' && a.quality !== 'ended';
  const same = timed && l.board && Math.abs(Date.parse(l.board) - Date.parse(a.departsAt!)) < 60_000;
  if (timed && !same) {
    card.goNow = m().goNow(a.bus?.paid ? named({ svc, paid: true }) : svc, approx(a.quality === 'scheduled', at(a.departsAt!)), a.timing.reachAt ? at(a.timing.reachAt) : null);
  }
  card.note = l.note ?? null;
  card.estimate = l.estimated ? m().estimateNote : null;
  return card;
}

/** The same, when the phone's location said so rather than a tap. */
const DETECTED_TEXT: Partial<Record<Phase, () => string>> = {
  riding: () => m().detectedRiding,
  missed: () => m().detectedMissed,
};

const PHASE_TEXT: Record<Phase, (() => string) | null> = {
  idle: null,
  due: () => m().phaseDue,
  heading: () => m().phaseHeading,
  waiting: () => m().phaseWaiting,
  riding: () => m().phaseRiding,
  missed: () => m().phaseMissed,
  arrived: null,
};

/** "~9:41" for an estimate, "9:41" otherwise. */
const approx = (estimated: boolean | undefined, clock: string) => (estimated ? m().approx(clock) : clock);

/** The time in a message made by `make(time)`, or null when `text` isn't one: "Day starts 09:00" -> "09:00". */
function slotOf(text: string, make: (t: string) => string): string | null {
  const [pre, post] = make('\u0000').split('\u0000');
  return text.length > pre.length + post.length && text.startsWith(pre) && text.endsWith(post) ? text.slice(pre.length, text.length - post.length) : null;
}

/**
 * When the trip's phase or its question next changes by itself: due, the
 * leave-by, the bus leaving (the question), "no answer means on it", the
 * class starting, the ride ending. Null outside a trip. The Trip object
 * wakes at this to push; the card's nextChangeAt also counts going stale.
 */
export function nextPhaseAt(a: MeAnswer, trip: TripView, nowMs: number): number | null {
  if (!trip.key) return null;
  const marks: number[] = [];
  const l = a.leave ?? null;
  const plan = trip.plan ?? null;
  if (plan?.board && !answered(trip)) marks.push(Date.parse(plan.board), Date.parse(plan.board) + ASSUME_MS);
  if (l?.at) marks.push(Date.parse(l.at) - DUE_MS, Date.parse(l.at));
  if (a.timing?.classAt) marks.push(Date.parse(a.timing.classAt) + LATE_GRACE_MIN * 60_000);
  const onBus = trip.rec?.boarded ?? (trip.assumed ? plan : null);
  if (trip.phase === 'riding' && onBus?.arrive) marks.push(Date.parse(onBus.arrive) + RIDE_GRACE_MS);
  return marks.filter((m) => m > nowMs).sort((x, y) => x - y)[0] ?? null;
}

/** Someone said what happened (or detection did); having been at the stop isn't that. */
const answered = (trip: TripView) => trip.rec !== undefined && trip.rec.kind !== 'waiting';

/** A stop's short name, from its code. */
const stopName = (code: string | null | undefined) => {
  const s = code ? indexGraph(GRAPH).byCode.get(code) : undefined;
  return s ? shortStop(s.name) : null;
};

/** The stop to walk to (see Card.walkTo). */
function walkToOf(a: MeAnswer, kind: CardKind, phase: Phase): Card['walkTo'] {
  if (kind === 'rest' || kind === 'free' || kind === 'setup' || kind === 'arrived' || kind === 'nearby') return null;
  if (phase === 'riding' || phase === 'waiting' || phase === 'arrived') return null;
  const l = a.leave ?? null;
  // The bus's stop; on foot, the destination's (a food court's nearest stop).
  const code = l?.svc ? (l.stopCode ?? a.stop.code) : l ? (a.dest?.to ? targetStops(a.dest.to).to : null) : null;
  const s = code ? indexGraph(GRAPH).byCode.get(code) : undefined;
  if (!s) return null;
  return { name: l?.svc && l.stop ? l.stop : shortStop(s.name), lat: s.lat, lon: s.lon };
}

/** "9:38" or "9:38p": clocks short enough for a glance. */
function shortClock(ms: number, h12: boolean): string {
  const c = clockAt(ms, h12);
  return h12 ? c.replace(/ ([AaPp])[Mm]$/, (_m, x: string) => x.toLowerCase()) : c;
}

function v2(
  a: MeAnswer,
  card: V1,
  h12: boolean,
  trip: TripView,
  nowMs: number,
): Pick<Card, V2> {
  const at = (t: string) => clockAt(Date.parse(t), h12);
  const short = (t: string) => shortClock(Date.parse(t), h12);
  const l = a.leave ?? null;
  const est = (iso: string) => approx(l?.estimated, at(iso));
  const svc = l?.svc ?? null;
  const phase = trip.phase;
  const detected = trip.rec?.detected === true && (phase === 'riding' || phase === 'missed');
  // "D2 9:41", or the walk when there's no bus.
  const busGlance = (leave: Leave) => (svc ? `${svc} ${leave.board ? short(leave.board) : m().now}` : m().walkNow);

  // One line and a glance per phase; outside a trip, the answer's own words.
  let line = a.detail ? `${a.label} · ${a.detail.split(' · ')[0]}` : a.label;
  let glance = a.label.replace(' · ', ' ');
  if (card.kind === 'rest') {
    const from = slotOf(a.label, m().dayStarts);
    glance = from ? m().fromGlance(from) : m().doneToday;
  }
  if (card.kind === 'free') glance = a.label === m().noTimetableYet ? m().setUp : m().noClasses;
  if (card.kind === 'setup') glance = m().setUp;
  if (card.kind === 'arrived' || phase === 'arrived') glance = a.dest?.why === 'home' ? m().home : m().youreThere;
  if (trip.key && l) {
    if (phase === 'idle' || phase === 'due') {
      line = `${card.leaveBy ?? m().leaveNow} · ${svc && l.stop ? m().svcFrom(svc, l.stop) : m().walk}`;
      glance = m().leaveGlance(shortClock(Date.parse(l.at), h12));
    } else if (phase === 'heading' || phase === 'waiting') {
      line = svc ? m().svcAtStop(svc, l.board ? est(l.board) : null, l.stop ?? '') : m().walkThereNow;
      if (card.arrive && l.arrive && a.timing) line += ` · ${m().arriveLower(est(l.arrive), slackText((Date.parse(a.timing.classAt) - Date.parse(l.arrive)) / 1000))}`;
      glance = busGlance(l);
    } else if (phase === 'missed') {
      const missed = trip.rec?.missed ? m().missedThe(at(trip.rec.missed)) : m().missedIt;
      const next = svc ? `${svc}${l.board ? ` ${est(l.board)}` : ''}` : m().walk;
      line = m().missedLine(missed, next, a.timing?.status === 'late' ? a.timing.text : null);
      glance = busGlance(l);
    }
  }
  const onBus = trip.rec?.boarded ?? (trip.assumed ? trip.plan : null);
  if (phase === 'riding' && onBus) {
    line = `${m().onThe(onBus.svc)}${onBus.arrive ? ` · ${m().offAtTime(offStop(onBus) ?? a.dest?.label ?? m().yourStop, at(onBus.arrive))}` : ''}`;
    glance = onBus.arrive ? m().offGlance(short(onBus.arrive)) : m().onThe(onBus.svc);
  }
  glance = glance.slice(0, 12);

  // Buttons: only for a planned trip, and only those that change what's shown.
  const actions: CardAction[] = [];
  const key = trip.key;
  if (key) {
    // Nothing asks what happened (on the bus, missed it, there): the trip
    // follows the plan and, when the phone says, where you are. Only plans.
    if (a.dest?.why === 'class' && phase !== 'arrived' && phase !== 'riding') actions.push({ id: 'skipped', label: m().notGoing, trip: key });
    // Before the trip starts: the whole day off campus, every trip at once (phase 8.3).
    if (a.dest?.why === 'class' && phase === 'idle') actions.push({ id: 'away', label: m().notOnCampus, trip: key });
  }
  if (trip.away) actions.push({ id: 'back', label: m().backOnCampus, trip: 'day' });
  if (trip.undo) {
    actions.push({ id: 'reset', label: isHomeKey(trip.undo.key) ? m().undoHome : m().undoTo(trip.undo.label), trip: trip.undo.key });
  }

  // The next moment this card changes by itself: the trip's next phase, or
  // the answer going stale, whichever is sooner.
  const phaseAt = nextPhaseAt(a, trip, nowMs);
  const next = [phaseAt, card.staleAt ? Date.parse(card.staleAt) : null].filter((m): m is number => m !== null && m > nowMs).sort((x, y) => x - y)[0];

  return {
    phase,
    phaseText: ((detected ? DETECTED_TEXT[phase] : null) ?? PHASE_TEXT[phase])?.() ?? null,
    glance,
    line,
    actions,
    warning: a.warning ?? null,
    nextChangeAt: next === undefined ? null : iso(next),
    remind: trip.remind !== false,
    suggestion: trip.suggestion ?? null,
    ride: phase === 'riding' && onBus ? rideOf(onBus) : null,
    detected,
    walkTo: walkToOf(a, card.kind, phase),
  };
}
