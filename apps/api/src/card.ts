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

import type { Crowd, MeAnswer, Quality } from './types.ts';
import { clockAt, slackText } from './clock.ts';
import { ASSUME_MS, type Boarded, DUE_MS, type Phase, RIDE_GRACE_MS, type Ride, type TripRecord, isHomeKey, offStop, rideOf } from './trip.ts';
import { LATE_GRACE_MIN } from './profile.ts';
import type { Suggestion } from './outcomes.ts';
import { GRAPH } from './graph.ts';
import { indexGraph } from './resolve.ts';
import { targetStops } from './landmarks.ts';
import { shortStop } from './format.ts';
import { m } from './i18n.ts';

export type CardKind = 'class' | 'trip' | 'nearby' | 'rest' | 'arrived' | 'setup' | 'free';

/** A button the server decided to show. Clients render it and send `id`
 *  and `trip` back to /me/signal; they never decide which to show. */
export interface CardAction {
  id: 'boarded' | 'missed' | 'skipped' | 'arrived' | 'reset' | 'undetected' | 'away' | 'back';
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

/** "On the 9:41 D2?": no longer asked (Card.ask is always null). The shape
 *  stays for older apps. */
export interface CardAsk {
  trip: string;
  question: string;
  actions: CardAction[];
}

export interface Card {
  kind: CardKind;
  /** Dim the answer from this instant: the bus has gone, the plan has moved
   *  on, or it is 15 minutes old. Null: never on its own (setup). */
  staleAt: string | null;
  /** "Quiet" / "Filling" / "Packed", for the bus in the headline. */
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
  /** Always null: terminus no longer asks "On the 9:41 D2?". Kept for older apps. */
  ask: CardAsk | null;
  /** Always false (nothing is asked). Kept for older apps. */
  askMuted: boolean;
  /** False when the user asked for no reminders for this trip: no leave
   *  notification. The card itself is unchanged. */
  remind: boolean;
  /** "Leave one bus earlier for CS2030?", with its two buttons: send the id
   *  to /me/suggestion. Never during a trip. */
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
/** The note under an estimated leave-by. */
export const estimateNote = () => m().estimateNote;

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

const iso = (ms: number) => new Date(Math.round(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

type V2 = 'phase' | 'phaseText' | 'glance' | 'line' | 'actions' | 'warning' | 'nextChangeAt' | 'ask' | 'askMuted' | 'remind' | 'suggestion' | 'ride' | 'detected' | 'walkTo';
type V1 = Omit<Card, V2>;

export function cardFor(a: MeAnswer, h12 = false, trip: TripView = { key: null, phase: 'idle' }): Card {
  const card = v1(a, h12);
  // At the stop, there's nowhere to leave: the headline is the bus to wait for
  // ("D2 at 9:41"). Apps show it as it is, without turning it into "Leave now".
  const l = a.leave ?? null;
  if (trip.key && trip.phase === 'waiting' && l?.svc && l.board) card.leaveBy = m().busAt(l.svc, approx(l.estimated, clockAt(Date.parse(l.board), h12)));
  return { ...card, ...v2(a, card, h12, trip) };
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
    leaveVia: l?.svc && l.stop ? m().leaveVia(l.board ? est(l.board) : null, l.svc, l.stop, l.off ?? null) : null,
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
  card.catch = l.svc ? m().catchBus(l.board ? est(l.board) : null, l.svc, l.stop ?? '', l.off ?? null) : m().walkThere;
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
    card.goNow = m().goNow(svc, approx(a.quality === 'scheduled', at(a.departsAt!)), a.timing.reachAt ? at(a.timing.reachAt) : null);
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
): Pick<Card, V2> {
  const nowMs = Date.parse(a.asOf);
  const at = (t: string) => clockAt(Date.parse(t), h12);
  const short = (t: string) => shortClock(Date.parse(t), h12);
  const l = a.leave ?? null;
  const est = (iso: string) => approx(l?.estimated, at(iso));
  const svc = l?.svc ?? null;
  const phase = trip.phase;
  const detected = trip.rec?.detected === true && (phase === 'riding' || phase === 'missed');

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
      glance = svc ? `${svc} ${l.board ? short(l.board) : m().now}` : m().walkNow;
    } else if (phase === 'missed') {
      const missed = trip.rec?.missed ? m().missedThe(at(trip.rec.missed)) : m().missedIt;
      const next = svc ? `${svc}${l.board ? ` ${est(l.board)}` : ''}` : m().walk;
      line = m().missedLine(missed, next, a.timing?.status === 'late' ? a.timing.text : null);
      glance = svc ? `${svc} ${l.board ? short(l.board) : m().now}` : m().walkNow;
    }
  }
  const onBus = trip.rec?.boarded ?? (trip.assumed ? trip.plan : null);
  if (phase === 'riding' && onBus) {
    const b = onBus;
    line = `${m().onThe(b.svc)}${b.arrive ? ` · ${m().offAtTime(offStop(b) ?? a.dest?.label ?? m().yourStop, at(b.arrive))}` : ''}`;
    glance = b.arrive ? m().offGlance(short(b.arrive)) : m().onThe(b.svc);
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

  // The question ("On the 9:41 D2?") is no longer asked: always null, and
  // askMuted always false, for older apps that still read them.
  const ask: CardAsk | null = null;

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
    ask,
    askMuted: false,
    remind: trip.remind !== false,
    suggestion: trip.suggestion ?? null,
    ride: phase === 'riding' && onBus ? rideOf(onBus) : null,
    detected,
    walkTo: walkToOf(a, card.kind, phase),
  };
}
