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
import { ASSUME_MS, type Boarded, DUE_MS, type Phase, RIDE_GRACE_MS, type TripRecord } from './trip.ts';
import { LATE_GRACE_MIN } from './profile.ts';
import type { Suggestion } from './outcomes.ts';

export type CardKind = 'class' | 'trip' | 'nearby' | 'rest' | 'arrived' | 'setup' | 'free';

/** A button the server decided to show. Clients render it and send `id`
 *  and `trip` back to /me/signal; they never decide which to show. */
export interface CardAction {
  id: 'boarded' | 'missed' | 'skipped' | 'arrived' | 'reset';
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
  /** The question isn't asked: its buttons were ignored too often (phase 3). */
  askMuted?: boolean;
  /** False when the user turned reminders off for this trip. */
  remind?: boolean;
  /** Something terminus has learned and offers to change (outcomes.ts). */
  suggestion?: Suggestion | null;
}

/** "On the 9:41 D2?", asked once, at the bus's departure, in the notification
 *  that's already showing. No answer means yes. */
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
  /** "Timetable estimate", "Live data a few minutes old", "No live data". */
  quality: string | null;
  /** "Leave by ~6:36 PM". Clients say "Leave now" once `leave.at` passes. */
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
  /** The question to put in the trip's notification, from the bus's departure
   *  until the class starts, while nobody has answered it. Null otherwise. */
  ask: CardAsk | null;
  /** True when the question is no longer asked because it was ignored five
   *  trips running; a settings switch turns it back on. */
  askMuted: boolean;
  /** False when the user asked for no reminders for this trip: no leave
   *  notification. The card itself is unchanged. */
  remind: boolean;
  /** "Leave one bus earlier for CS2030?", with its two buttons: send the id
   *  to /me/suggestion. Never during a trip. */
  suggestion: Suggestion | null;
}

/** Answers older than this are dimmed even if nothing else says so. */
export const MAX_AGE_MS = 15 * 60_000;
/** A bus shown leaving at 09:42 may still be at the stop at 09:42:20. */
export const DEPARTED_GRACE_MS = 30_000;

const CROWD: Record<Crowd, string> = { low: 'Quiet', medium: 'Filling', high: 'Packed' };
const QUALITY: Partial<Record<Quality, string>> = {
  scheduled: 'Timetable estimate',
  stale: 'Live data a few minutes old',
  unknown: 'No live data',
};
export const ESTIMATE_NOTE = 'Estimated from the usual gap between buses. Live times show nearer the time.';

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

type V1 = Omit<Card, 'phase' | 'phaseText' | 'glance' | 'line' | 'actions' | 'warning' | 'nextChangeAt' | 'ask' | 'askMuted' | 'remind' | 'suggestion'>;

export function cardFor(a: MeAnswer, h12 = false, trip: TripView = { key: null, phase: 'idle' }): Card {
  const card = v1(a, h12);
  return { ...card, ...v2(a, card, h12, trip) };
}

function v1(a: MeAnswer, h12: boolean): V1 {
  const kind = kindOf(a);
  const at = (iso: string) => clockAt(Date.parse(iso), h12);
  const staleAt = staleAtOf(a, kind);
  const svc = a.label.split(' · ')[0];
  const crowd = a.arrivals.find((x) => x.svc === svc)?.crowd ?? null;
  const l = a.leave ?? null;
  const t = l?.estimated ? '~' : '';

  const card: V1 = {
    kind,
    staleAt: staleAt == null ? null : iso(staleAt),
    crowd: crowd ? CROWD[crowd] : null,
    quality: QUALITY[a.quality] ?? null,
    leaveBy: l ? `Leave by ${t}${at(l.at)}` : null,
    leaveVia: l?.svc ? `catch the ${l.board ? `${t}${at(l.board)} ` : ''}${l.svc} at ${l.stop}${l.off ? `, off at ${l.off}` : ''}` : null,
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
  const off = l.off ? `, off at ${l.off}` : '';
  card.catch = l.svc ? (l.board ? `Catch the ${t}${at(l.board)} ${l.svc} at ${l.stop}${off}` : `Catch the ${l.svc} at ${l.stop}${off}`) : 'Walk there';
  if (l.arrive) {
    const arrive = Date.parse(l.arrive);
    const slack = slackText((classAt - arrive) / 1000);
    card.arrive = `Arrive ${t}${at(l.arrive)} · ${slack}`;
    card.catchLine = `${card.catch} · arrive ${t}${at(l.arrive)}, ${slack}`;
    card.late = arrive > classAt;
  } else {
    card.catchLine = card.catch;
  }
  // The headline bus, when it isn't the one to wait for.
  const timed = a.departsAt && a.quality !== 'unknown' && a.quality !== 'ended';
  const same = timed && l.board && Math.abs(Date.parse(l.board) - Date.parse(a.departsAt!)) < 60_000;
  if (timed && !same) {
    const reach = a.timing.reachAt ? ` · arrive ${at(a.timing.reachAt)}` : '';
    card.goNow = `Or go now: ${svc} at ${a.quality === 'scheduled' ? '~' : ''}${at(a.departsAt!)}${reach}`;
  }
  card.note = l.note ?? null;
  card.estimate = l.estimated ? ESTIMATE_NOTE : null;
  return card;
}

const PHASE_TEXT: Record<Phase, string | null> = {
  idle: null,
  due: 'Time to get going',
  heading: 'On your way',
  waiting: 'At the stop',
  riding: 'On the bus',
  missed: 'Missed it: here is the next way there',
  arrived: null,
};

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
  if (plan?.board && !trip.rec) marks.push(Date.parse(plan.board), Date.parse(plan.board) + ASSUME_MS);
  if (l?.at) marks.push(Date.parse(l.at) - DUE_MS, Date.parse(l.at));
  if (a.timing?.classAt) marks.push(Date.parse(a.timing.classAt) + LATE_GRACE_MIN * 60_000);
  const onBus = trip.rec?.boarded ?? (trip.assumed ? plan : null);
  if (trip.phase === 'riding' && onBus?.arrive) marks.push(Date.parse(onBus.arrive) + RIDE_GRACE_MS);
  return marks.filter((m) => m > nowMs).sort((x, y) => x - y)[0] ?? null;
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
): Pick<Card, 'phase' | 'phaseText' | 'glance' | 'line' | 'actions' | 'warning' | 'nextChangeAt' | 'ask' | 'askMuted' | 'remind' | 'suggestion'> {
  const nowMs = Date.parse(a.asOf);
  const at = (t: string) => clockAt(Date.parse(t), h12);
  const short = (t: string) => shortClock(Date.parse(t), h12);
  const l = a.leave ?? null;
  const est = l?.estimated ? '~' : '';
  const svc = l?.svc ?? null;
  const phase = trip.phase;

  // One line and a glance per phase; outside a trip, the answer's own words.
  let line = a.detail ? `${a.label} · ${a.detail.split(' · ')[0]}` : a.label;
  let glance = a.label.replace(' · ', ' ');
  if (card.kind === 'rest') glance = a.label.startsWith('Day starts ') ? a.label.replace('Day starts ', 'From ') : 'Done today';
  if (card.kind === 'free') glance = a.label === 'No timetable yet' ? 'Set up' : 'No classes';
  if (card.kind === 'setup') glance = 'Set up';
  if (card.kind === 'arrived' || phase === 'arrived') glance = a.dest?.why === 'home' ? 'Home' : "You're there";
  if (trip.key && l) {
    if (phase === 'idle' || phase === 'due') {
      line = `${card.leaveBy ?? 'Leave now'} · ${svc ? `${svc} from ${l.stop}` : 'walk'}`;
      glance = `Leave ${shortClock(Date.parse(l.at), h12)}`;
    } else if (phase === 'heading' || phase === 'waiting') {
      line = svc ? `${svc} ${l.board ? `${est}${at(l.board)} ` : ''}at ${l.stop}` : 'Walk there now';
      if (card.arrive) line += ` · ${card.arrive.replace(/^Arrive /, 'arrive ')}`;
      glance = svc ? `${svc} ${l.board ? short(l.board) : 'now'}` : 'Walk now';
    } else if (phase === 'missed') {
      const missed = trip.rec?.missed ? `Missed the ${at(trip.rec.missed)}` : 'Missed it';
      const next = svc ? `${svc}${l.board ? ` ${est}${at(l.board)}` : ''}` : 'walk';
      line = `${missed} · next ${next}${a.timing?.status === 'late' ? `, ${a.timing.text}` : ''}`;
      glance = svc ? `${svc} ${l.board ? short(l.board) : 'now'}` : 'Walk now';
    }
  }
  const onBus = trip.rec?.boarded ?? (trip.assumed ? trip.plan : null);
  if (phase === 'riding' && onBus) {
    const b = onBus;
    line = `On the ${b.svc}${b.arrive ? ` · off at ${b.off ?? a.dest?.label ?? 'your stop'} ${at(b.arrive)}` : ''}`;
    glance = b.arrive ? `Off ${short(b.arrive)}` : `On the ${b.svc}`;
  }
  glance = glance.slice(0, 12);

  // Buttons: only for a planned trip, and only those that change what's shown.
  const actions: CardAction[] = [];
  const key = trip.key;
  if (key) {
    const onIt: CardAction | null = svc ? { id: 'boarded', label: `On the ${svc}`, trip: key } : null;
    if (phase === 'due' || phase === 'heading' || phase === 'waiting') {
      if (onIt) actions.push(onIt, { id: 'missed', label: 'Missed it', trip: key });
      else actions.push({ id: 'arrived', label: "I'm there", trip: key });
    } else if (phase === 'missed') {
      if (onIt) actions.push(onIt);
    } else if (phase === 'riding') {
      actions.push({ id: 'arrived', label: "I'm there", trip: key });
    }
    if (a.dest?.why === 'class' && phase !== 'arrived' && phase !== 'riding') actions.push({ id: 'skipped', label: 'Not going', trip: key });
  }
  if (trip.undo) actions.push({ id: 'reset', label: `Undo: going to ${trip.undo.label}`, trip: trip.undo.key });

  // "On the 9:41 D2?": from the departure until the class starts (or the bus
  // should have got you there), unless someone already said.
  const plan = trip.plan ?? null;
  let ask: CardAsk | null = null;
  if (key && plan?.board && !trip.rec && !trip.askMuted) {
    const board = Date.parse(plan.board);
    const until = a.timing?.classAt
      ? Date.parse(a.timing.classAt) + LATE_GRACE_MIN * 60_000
      : plan.arrive
        ? Date.parse(plan.arrive) + RIDE_GRACE_MS
        : board + 30 * 60_000;
    if (nowMs >= board && nowMs < until) {
      ask = {
        trip: key,
        question: `On the ${at(plan.board)} ${plan.svc}?`,
        actions: [
          { id: 'boarded', label: 'On it', trip: key },
          { id: 'missed', label: 'Missed it', trip: key },
          ...(a.dest?.why === 'class' ? [{ id: 'skipped' as const, label: 'Not going', trip: key }] : []),
        ],
      };
    }
  }

  // The next moment this card changes by itself: the trip's next phase, or
  // the answer going stale, whichever is sooner.
  const phaseAt = nextPhaseAt(a, trip, nowMs);
  const next = [phaseAt, card.staleAt ? Date.parse(card.staleAt) : null].filter((m): m is number => m !== null && m > nowMs).sort((x, y) => x - y)[0];

  return {
    phase,
    phaseText: PHASE_TEXT[phase],
    glance,
    line,
    actions,
    warning: a.warning ?? null,
    nextChangeAt: next === undefined ? null : iso(next),
    ask,
    askMuted: Boolean(trip.askMuted),
    remind: trip.remind !== false,
    suggestion: trip.suggestion ?? null,
  };
}
