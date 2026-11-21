import type { Arrival, BusLeg, Crowd, Dest, Leave, MeAnswer, Quality } from '../types.ts';
import { clockAt, slackText } from '../clock.ts';
import { type Plan, type Phase, type Ride, type TripRecord, isHomeKey, offStop, rideOf } from './trip.ts';
import { type Change, DUE_MS, LEAVE_GAP_MS } from './phase.ts';
import type { Suggestion } from '../accounts/outcomes.ts';
import type { StepTarget } from './step.ts';
import { GRAPH } from './graph.ts';
import { indexGraph } from './resolve.ts';
import { targetStops } from './landmarks.ts';
import { isoSeconds as iso, mins, named, shortStop } from './format.ts';
import { routeColor } from '../map/campus.ts';
import { WALK } from '../config.ts';
import { m } from '../i18n.ts';

export type CardKind = 'class' | 'trip' | 'nearby' | 'rest' | 'arrived' | 'setup' | 'free';

export interface CardAction {
  id: 'boarded' | 'missed' | 'skipped' | 'arrived' | 'reset' | 'away' | 'back';
  label: string;
  trip: string;
}

export interface CardStep {
  trip: string;
  earlier: StepTarget | null;
  later: StepTarget | null;
  moved: boolean;
  earlierLabel: string;
  laterLabel: string;
  bestLabel: string;
}

export interface TripView {
  key: string | null;
  phase: Phase;
  rec?: TripRecord;
  undo?: { key: string; label: string | null } | null;
  plan?: Plan | null;
  assumed?: boolean;
  gone?: boolean;
  seenOn?: Plan;
  planChanged?: boolean;
  planDropped?: boolean;
  changesAt?: Change | null;
  wakesAt?: Change | null;
  remind?: boolean;
  suggestion?: Suggestion | null;
  away?: boolean;
  reached?: string;
}

export interface JourneyBus {
  svc: string;
  color: string;
  stop: string;
  board: string;
  paid?: true;
}

export interface JourneyChange {
  from: string;
  stop: string;
  reach: string;
  walk: string | null;
  wait: string | null;
  bus: JourneyBus;
  boardAt: string;
  ride: string;
  firstRide: string;
  firstRideText: string;
  changeText: string;
  rideText: string;
}

export interface Journey {
  leave: string | null;
  walk: string | null;
  bus: JourneyBus | null;
  boardAt: string | null;
  ride: string | null;
  off: string | null;
  to: string;
  toStop: string;
  arrive: string | null;
  walkEnd: string | null;
  arriveStop: string | null;
  slack: string | null;
  live: boolean;
  backup: JourneyBus | null;
  why: string | null;
  change: JourneyChange | null;

  title: string;
  place: string;
  byText: string | null;
  walkText: string | null;
  rideText: string | null;
  walkEndText: string | null;
  arriveText: string | null;
  arriveWhere: string;
  backupText: string | null;
  summary: string;
}

export interface Upcoming {
  when: string;
  title: string;
  where: string;
  off: string | null;
}

export interface Card {
  kind: CardKind;
  title: string;
  heading: string | null;
  remindAt: string | null;
  staleAt: string | null;
  crowd: string | null;
  quality: string | null;
  leaveBy: string | null;
  leaveVia: string | null;
  catch: string | null;
  arrive: string | null;
  catchLine: string | null;
  late: boolean;
  goNow: string | null;
  note: string | null;
  estimate: string | null;
  fromNus?: true;
  reasons: ReportReason[];

  phase: Phase;
  phaseText: string | null;
  glance: string;
  line: string;
  actions: CardAction[];
  warning: string | null;
  nextChangeAt: string | null;
  remind: boolean;
  suggestion: Suggestion | null;
  ride: Ride | null;
  gone: boolean;
  walkTo: { name: string; lat: number; lon: number } | null;
  notice: string | null;
  h12: boolean;
  journey: Journey | null;
  upcoming: Upcoming | null;
  step: CardStep | null;
}

export const MAX_AGE_MS = 15 * 60_000;
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
  if (kind !== 'rest' && kind !== 'setup' && kind !== 'free') {
    if (a.departsAt) marks.push(Date.parse(a.departsAt) + DEPARTED_GRACE_MS);
    marks.push(Date.parse(a.asOf) + MAX_AGE_MS);
  }
  return marks.length ? Math.min(...marks) : null;
}

type PhaseKeys =
  | 'phase'
  | 'phaseText'
  | 'glance'
  | 'line'
  | 'actions'
  | 'warning'
  | 'nextChangeAt'
  | 'remind'
  | 'suggestion'
  | 'ride'
  | 'gone'
  | 'walkTo';
type BaseCard = Omit<Card, PhaseKeys | 'notice' | 'h12' | 'journey' | 'reasons' | 'upcoming' | 'step' | 'title' | 'heading' | 'remindAt'>;

export function cardFor(
  a: MeAnswer,
  h12 = false,
  trip: TripView = { key: null, phase: 'idle' },
  feedDownSince: number | null = null,
  nowMs = Date.parse(a.asOf),
): Card {
  const card = baseCard(a, h12);
  const l = a.leave ?? null;
  if (trip.key && trip.phase === 'waiting' && l?.svc && l.board)
    card.leaveBy = m().busAt(l.svc, approx(l.estimated, clockAt(Date.parse(l.board), h12)));
  const notice = feedDownSince !== null && QUALITY[a.quality] ? m().feedDown(clockAt(feedDownSince, h12)) : null;
  const journey = journeyOf(a, card, h12, trip.phase, nowMs);
  return {
    ...card,
    ...phaseFields(a, card, h12, trip, nowMs),
    notice,
    h12,
    journey,
    ...(journey?.live && journey.bus && !journey.bus.paid && !journey.change?.bus.paid ? { fromNus: true as const } : {}),
    reasons: reasonsOf(a, card.kind, journey, trip.phase),
    upcoming: a.upcoming ?? null,
    step: stepOf(a, card.kind, trip),
    title: titleOf(a, h12),
    heading: headingOf(a),
    remindAt: remindAtOf(a, card.kind, trip, nowMs),
  };
}

export const REPORT_REASONS = ['never-came', 'times-off', 'wrong-stop', 'walk-longer', 'wrong-class'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export function reasonsOf(a: MeAnswer, kind: CardKind, journey: Journey | null, phase: Phase): ReportReason[] {
  const toCatch = kind === 'nearby' || Boolean(a.leave?.svc) || Boolean(journey?.bus);
  const bus = toCatch || phase === 'riding';
  const trip = kind === 'class' || kind === 'trip';
  const fits: Record<ReportReason, boolean> = {
    'never-came': toCatch,
    'times-off': bus || trip,
    'wrong-stop': bus,
    'walk-longer': trip,
    'wrong-class': true,
  };
  return REPORT_REASONS.filter((r) => fits[r]);
}

export function titleOf(a: MeAnswer, h12: boolean): string {
  const l = a.leave;
  if (l?.stale && l.svc && l.board) return `${named({ svc: l.svc, paid: l.paid })} · ${m().approx(clockAt(Date.parse(l.board), h12))}`;
  if (!timedAt(a)) return a.label;
  return `${a.label.split(' · ')[0]} · ${approx(roughly(a), clockAt(Date.parse(a.departsAt!), h12))}`;
}

function stepOf(a: MeAnswer, kind: CardKind, trip: TripView): CardStep | null {
  const s = a.steps;
  if (!s || !(a.leave ? a.leave.svc : a.bus) || (kind !== 'class' && kind !== 'trip')) return null;
  if (trip.phase !== 'idle' && trip.phase !== 'due' && trip.phase !== 'heading') return null;
  if (trip.gone || trip.rec) return null;
  if (trip.phase === 'heading' && !s.later && !s.moved) return null;
  const earlier = trip.phase === 'heading' ? null : s.earlier;
  return { ...s, earlier, earlierLabel: m().earlierBus, laterLabel: m().laterBus, bestLabel: m().bestBus };
}

const timedAt = (a: MeAnswer): boolean => Boolean(a.departsAt) && a.quality !== 'unknown' && a.quality !== 'ended';

export function headingOf(a: MeAnswer): string | null {
  const d = a.dest;
  if (!d) return null;
  if (d.why === 'class') return d.place ? m().headPlace(d.label) : m().headClass(d.label);
  if (d.why === 'gap-home') return m().headGap(d.label);
  if (d.why === 'home') return m().headHome;
  return m().headPlace(d.label);
}

export function remindAtOf(a: MeAnswer, kind: CardKind, trip: TripView, nowMs = Date.parse(a.asOf)): string | null {
  const l = a.leave ?? null;
  if (!l || trip.remind === false || a.dest?.why !== 'class' || kind === 'arrived') return null;
  if (trip.phase !== 'idle' && trip.phase !== 'due') return null;
  if (a.timing && Date.parse(a.timing.classAt) <= nowMs) return null;
  return iso(Date.parse(l.at) - DUE_MS);
}

export function journeyOf(a: MeAnswer, card: BaseCard, h12: boolean, phase: Phase, nowMs = Date.parse(a.asOf)): Journey | null {
  if ((card.kind !== 'class' && card.kind !== 'trip') || !a.dest) return null;
  if (phase === 'riding' || phase === 'arrived') return null;
  const l = a.leave ?? null;
  const planned: BusLeg | null =
    l?.svc && l.stop && l.board
      ? {
          svc: l.svc,
          stop: l.stop,
          stopCode: l.stopCode ?? '',
          walkS: l.walkS ?? Math.max(0, (Date.parse(l.board) - Date.parse(l.at)) / 1000 - WALK.boardBufferS),
          rideS: l.rideS ?? (l.arrive ? Math.max(0, (Date.parse(l.arrive) - Date.parse(l.board)) / 1000) : 0),
          board: l.board,
          arrive: l.arrive,
          estimated: l.estimated,
          ...(l.off ? { off: l.off } : {}),
          ...(l.toStop ? { toStop: l.toStop } : {}),
          ...(l.endWalkS ? { endWalkS: l.endWalkS } : {}),
          ...(l.paid ? { paid: true as const } : {}),
          ...(l.change ? { change: l.change } : {}),
        }
      : null;
  if (!planned && a.foot) return footJourney(a, a.dest, a.foot, card, h12, phase, nowMs);
  const leg = planned ?? (card.kind === 'class' ? null : (a.bus ?? null));
  if (!leg?.board) return null;
  const at = (iso: string, estimated: boolean) => approx(estimated, clockAt(Date.parse(iso), h12));
  const busOf = (b: BusLeg): JourneyBus | null =>
    b.board
      ? { svc: b.svc, color: routeColor(b.svc), stop: b.stop, board: at(b.board, b.estimated), ...(b.paid ? { paid: true as const } : {}) }
      : null;
  const headlineDiffers = Boolean(
    planned && a.bus && !(a.bus.svc === planned.svc && a.bus.stop === planned.stop && a.bus.board === planned.board),
  );
  const other = card.kind === 'class' ? (card.goNow ? a.bus : null) : headlineDiffers ? a.bus : a.altBus;
  const classAt = a.timing ? Date.parse(a.timing.classAt) : null;
  const endS = leg.endWalkS ?? a.endWalk?.s ?? 0;
  const stopMs = leg.arrive ? Date.parse(leg.arrive) - (leg === planned && a.endWalk?.inLeave ? endS * 1000 : 0) : null;
  const thereMs = stopMs != null ? stopMs + endS * 1000 : null;
  const walkEnd = endS >= 45 ? mins(endS) : null;
  const arrive = thereMs != null ? approx(leg.estimated, clockAt(thereMs, h12)) : null;
  const ch = leg.change?.board && leg.change.reach ? leg.change : null;
  const change: ChangeSteps | null = ch
    ? {
        from: ch.from,
        stop: ch.stop,
        reach: at(ch.reach!, leg.estimated),
        walk: ch.crossS ? mins(ch.crossS) : null,
        wait: waitOf((Date.parse(ch.board!) - Date.parse(ch.reach!)) / 1000 - (ch.crossS ?? 0)),
        bus: { svc: ch.svc, color: routeColor(ch.svc), stop: ch.stop, board: at(ch.board!, ch.estimated) },
        boardAt: ch.board!,
        ride: mins(ch.rideS),
        firstRide: mins(leg.rideS),
      }
    : null;
  return worded(a, card, h12, phase, {
    leave: l && Date.parse(l.at) > nowMs ? at(l.at, l.estimated) : null,
    walk: phase === 'waiting' || leg.walkS < 45 ? null : mins(leg.walkS),
    bus: busOf(leg)!,
    boardAt: leg.board,
    ride: mins(leg.rideS),
    off: leg.off ?? null,
    to: a.dest.label,
    toStop: leg.off ?? leg.toStop ?? stopName(targetStops(a.dest.to).to) ?? a.dest.label,
    arrive,
    walkEnd,
    arriveStop: walkEnd && stopMs != null ? approx(leg.estimated, clockAt(stopMs, h12)) : arrive,
    slack: card.kind === 'class' && classAt != null && thereMs != null ? slackText((classAt - thereMs) / 1000) : null,
    live: a.quality === 'live' && !leg.estimated && !(leg === planned && l?.stale) && !ch?.estimated,
    backup: other ? busOf(other) : null,
    why: null,
    change,
  });
}

type ChangeSteps = Omit<JourneyChange, 'firstRideText' | 'changeText' | 'rideText'>;

const waitOf = (s: number): string | null => (s >= 60 ? mins(s) : null);

type Steps = Omit<
  Journey,
  | 'title'
  | 'place'
  | 'byText'
  | 'walkText'
  | 'rideText'
  | 'walkEndText'
  | 'arriveText'
  | 'arriveWhere'
  | 'backupText'
  | 'summary'
  | 'change'
> & { change: ChangeSteps | null };

const goNowOff = (a: MeAnswer): string | null => (a.bus?.change ? null : (a.bus?.off ?? null));

const busName = (b: JourneyBus) => named({ svc: b.svc, paid: b.paid });

function worded(a: MeAnswer, card: BaseCard, h12: boolean, phase: Phase, j: Steps): Journey {
  const isClass = card.kind === 'class';
  const starts = isClass && a.timing ? (a.dest?.place ? m().thereBy : m().startsShort)(clockAt(Date.parse(a.timing.classAt), h12)) : null;
  const arriveText = j.arrive ? [m().arriveCap(j.arrive), j.slack].filter(Boolean).join(' · ') : null;
  const backupText = !j.bus
    ? j.why
    : j.backup
      ? isClass
        ? m().orGoNowFrom(busName(j.backup), j.backup.board, j.backup.stop, goNowOff(a))
        : m().orBusFrom(busName(j.backup), j.backup.board, j.backup.stop)
      : null;
  const c = j.change;
  const offText = j.off ? m().offAt(j.off) : null;
  const change: JourneyChange | null = c
    ? {
        ...c,
        firstRideText: [m().rideFor(c.firstRide), m().offAt(c.from)].join(' · '),
        changeText: [m().changeCap(c.from), c.walk ? m().crossRoad : null, c.wait ? m().waitFor(c.wait) : null].filter(Boolean).join(' · '),
        rideText: [m().rideFor(c.ride), offText].filter(Boolean).join(' · '),
      }
    : null;
  return {
    ...j,
    ...(c ? { ride: m().rideThen(c.firstRide, busName(c.bus)) } : {}),
    change,
    title: [m().journeyTo(j.to), starts].filter(Boolean).join(' · '),
    place: j.to.split(' @ ')[0],
    byText: phase !== 'waiting' && j.leave ? m().byTime(j.leave) : null,
    walkText: j.walk ? m().walkToStop(j.walk) : null,
    rideText: c
      ? [m().rideFor(c.firstRide), m().changeLine(c.from, busName(c.bus), c.bus.board), m().rideFor(c.ride), offText]
          .filter(Boolean)
          .join(' · ')
      : j.ride
        ? [m().rideFor(j.ride), offText].filter(Boolean).join(' · ')
        : null,
    walkEndText: j.walkEnd ? m().walkToStop(j.walkEnd) : null,
    arriveText,
    arriveWhere: j.walkEnd ? m().walkFrom(j.walkEnd, j.toStop) : m().atStop(j.toStop),
    backupText,
    summary: summaryOf(j, isClass),
  };
}

function summaryOf(j: Steps, isClass: boolean): string {
  const b = j.bus;
  if (!b)
    return [isClass && j.arrive ? m().arriveAt(j.arrive) : null, j.walk ? m().walkToStop(j.walk) : null, j.why].filter(Boolean).join(' · ');
  const change = j.change ? ` · ${m().changeTo(j.change.from, busName(j.change.bus))}` : '';
  if (isClass && j.arrive) return `${m().arriveAt(j.arrive)} · ${m().svcAtStop(busName(b), b.board, b.stop)}${change}`;
  if (j.walk) return `${m().walkToPlace(b.stop)} · ${m().busTime(busName(b), b.board)}${change}`;
  return `${m().svcAtStop(busName(b), b.board, b.stop)}${change}`;
}

function footJourney(
  a: MeAnswer,
  dest: Dest,
  foot: NonNullable<MeAnswer['foot']>,
  card: BaseCard,
  h12: boolean,
  phase: Phase,
  nowMs: number,
): Journey {
  const l = a.leave ?? null;
  const fromMs = l ? Date.parse(l.at) : nowMs;
  const thereMs = l?.arrive ? Date.parse(l.arrive) : nowMs + foot.s * 1000;
  const classAt = a.timing ? Date.parse(a.timing.classAt) : null;
  const arrive = clockAt(thereMs, h12);
  return worded(a, card, h12, phase, {
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
    change: null,
  });
}

function headlineRow(a: MeAnswer, svc: string): Arrival | undefined {
  const rows = a.arrivals.filter((x) => x.svc === svc);
  const departs = a.departsAt ? Date.parse(a.departsAt) : NaN;
  if (Number.isNaN(departs)) return rows[0];
  const asOf = Date.parse(a.asOf);
  const off = (x: Arrival) => (x.etaS === null ? Infinity : Math.abs(asOf + x.etaS * 1000 - departs));
  return rows.reduce<Arrival | undefined>((best, x) => (best === undefined || off(x) < off(best) ? x : best), undefined);
}

function baseCard(a: MeAnswer, h12: boolean): BaseCard {
  const kind = kindOf(a);
  const at = (iso: string) => clockAt(Date.parse(iso), h12);
  const staleAt = staleAtOf(a, kind);
  const svc = a.label.split(' · ')[0];
  const crowd = headlineRow(a, svc)?.crowd ?? null;
  const l = a.leave ?? null;
  const est = (iso: string) => approx(l?.estimated, at(iso));

  const card: BaseCard = {
    kind,
    staleAt: staleAt == null ? null : iso(staleAt),
    crowd: crowd ? CROWD[crowd]() : null,
    quality: QUALITY[a.quality]?.() ?? null,
    leaveBy: l ? m().leaveBy(est(l.at)) : null,
    leaveVia:
      l?.svc && l.stop
        ? m().leaveVia(l.board ? est(l.board) : null, named({ svc: l.svc, paid: l.paid }), l.stop, l.off ?? null) + andChange(l)
        : null,
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
  card.catch = l.svc
    ? m().catchBus(l.board ? est(l.board) : null, named({ svc: l.svc, paid: l.paid }), l.stop ?? '', l.off ?? null) + andChange(l)
    : m().walkThere;
  if (l.arrive) {
    const arrive = Date.parse(l.arrive);
    const slack = slackText((classAt - arrive) / 1000);
    card.arrive = m().arrive(est(l.arrive), slack);
    card.catchLine = m().catchLine(card.catch, est(l.arrive), slack);
    card.late = arrive > classAt;
  } else {
    card.catchLine = card.catch;
  }
  const timed = a.departsAt && a.quality !== 'unknown' && a.quality !== 'ended';
  const same = timed && l.board && Math.abs(Date.parse(l.board) - Date.parse(a.departsAt!)) < 60_000;
  const sooner =
    timed &&
    (a.timing.reachAt && l.arrive
      ? Date.parse(a.timing.reachAt) < Date.parse(l.arrive)
      : !l.board || Date.parse(a.departsAt!) < Date.parse(l.board));
  if (timed && !same && sooner) {
    card.goNow = m().goNow(
      a.bus?.paid ? named({ svc, paid: true }) : svc,
      approx(roughly(a), at(a.departsAt!)),
      goNowOff(a),
      a.timing.reachAt ? approx(roughly(a), at(a.timing.reachAt)) : null,
    );
  }
  card.note = l.note ?? null;
  card.estimate = l.estimated ? m().estimateNote : null;
  return card;
}

const andChange = (l: Leave): string => (l.change ? m().andChange(l.change.from, l.change.svc) : '');

const PHASE_TEXT: Record<Phase, (() => string) | null> = {
  idle: null,
  due: () => m().phaseDue,
  heading: () => m().phaseHeading,
  waiting: () => m().phaseWaiting,
  riding: () => m().phaseRiding,
  missed: () => m().phaseMissed,
  arrived: null,
};

const approx = (estimated: boolean | undefined, clock: string) => (estimated ? m().approx(clock) : clock);

const roughly = (a: MeAnswer): boolean => a.quality === 'scheduled' || a.quality === 'stale';

function slotOf(text: string, make: (t: string) => string): string | null {
  const [pre, post] = make('\u0000').split('\u0000');
  return text.length > pre.length + post.length && text.startsWith(pre) && text.endsWith(post)
    ? text.slice(pre.length, text.length - post.length)
    : null;
}

const stopName = (code: string | null | undefined) => {
  const s = code ? indexGraph(GRAPH).byCode.get(code) : undefined;
  return s ? shortStop(s.name) : null;
};

function walkToOf(a: MeAnswer, kind: CardKind, phase: Phase): Card['walkTo'] {
  if (kind === 'rest' || kind === 'free' || kind === 'setup' || kind === 'arrived' || kind === 'nearby') return null;
  if (phase === 'riding' || phase === 'waiting' || phase === 'arrived') return null;
  const l = a.leave ?? null;
  const code = l?.svc ? (l.stopCode ?? a.stop.code) : l ? (a.dest?.to ? targetStops(a.dest.to).to : null) : null;
  const s = code ? indexGraph(GRAPH).byCode.get(code) : undefined;
  if (!s) return null;
  return { name: l?.svc && l.stop ? l.stop : shortStop(s.name), lat: s.lat, lon: s.lon };
}

function rideWithChange(b: Plan, h12: boolean): Ride | null {
  const r = rideOf(b);
  const c = b.change;
  if (!r || !c) return r;
  const board = c.board ? approx(c.estimated, clockAt(Date.parse(c.board), h12)) : null;
  return {
    ...r,
    change: {
      svc: c.svc,
      color: routeColor(c.svc),
      stop: c.stop,
      board: c.board,
      text: board ? m().thenAt(c.svc, board, c.stop) : m().thenFrom(c.svc, c.stop),
    },
  };
}

function shortClock(ms: number, h12: boolean): string {
  const c = clockAt(ms, h12);
  return h12 ? c.replace(/[ \u00a0]([AaPp])[Mm]$/, (_m, x: string) => x.toLowerCase()) : c;
}

function phaseFields(a: MeAnswer, card: BaseCard, h12: boolean, trip: TripView, nowMs: number): Pick<Card, PhaseKeys> {
  const at = (t: string) => clockAt(Date.parse(t), h12);
  const short = (t: string) => shortClock(Date.parse(t), h12);
  const l = a.leave ?? null;
  const est = (iso: string) => approx(l?.estimated, at(iso));
  const svc = l?.svc ?? null;
  const phase = trip.phase;
  const busGlance = (leave: Leave) => (svc ? `${svc} ${leave.board ? short(leave.board) : m().now}` : m().walkNow);

  const goneAt = trip.gone && phase === 'heading' && trip.key && l ? (trip.plan?.board ?? null) : null;
  let line = a.detail ? `${a.label} · ${a.detail.split(' · ')[0]}` : a.label;
  let glance = timedAt(a)
    ? `${a.label.split(' · ')[0]} ${approx(roughly(a), short(a.departsAt!))}`
    : (a.quality === 'ended' && a.foot ? m().walkLabel(mins(a.foot.s)) : a.label).replace(' · ', ' ');
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
      if (l.change) line += ` · ${m().changeTo(l.change.from, l.change.svc)}`;
      if (card.arrive && l.arrive && a.timing)
        line += ` · ${m().arriveLower(est(l.arrive), slackText((Date.parse(a.timing.classAt) - Date.parse(l.arrive)) / 1000))}`;
      glance = busGlance(l);
    } else if (phase === 'missed') {
      const missed = trip.rec?.missed ? m().missedThe(at(trip.rec.missed)) : m().missedIt;
      const next = svc ? `${svc}${l.board ? ` ${est(l.board)}` : ''}` : m().walk;
      line = m().missedLine(missed, next, a.timing?.status === 'late' ? a.timing.text : null);
      glance = busGlance(l);
    }
    if (goneAt) {
      const next = svc ? `${svc}${l.board ? ` ${est(l.board)}` : ''}` : m().walk;
      line = m().missedLine(m().busLeft(at(goneAt)), next, a.timing?.status === 'late' ? a.timing.text : null);
    }
  }
  const onBus = trip.rec?.boarded ?? (trip.assumed ? trip.plan : null);
  if (phase === 'riding' && onBus) {
    const c = onBus.change;
    const where = offStop(onBus) ?? (c ? c.stop : (a.dest?.label ?? m().yourStop));
    line = `${m().onThe(onBus.svc)}${onBus.arrive ? ` · ${c ? m().changeAtTime(where, approx(roughly(a), at(onBus.arrive)), c.svc) : m().offAtTime(where, approx(roughly(a), at(onBus.arrive)))}` : ''}`;
    glance = onBus.arrive ? m().offGlance(short(onBus.arrive)) : m().onThe(onBus.svc);
  }
  glance = glance.slice(0, 12);

  const actions: CardAction[] = [];
  const key = trip.key;
  if (key) {
    if (a.dest?.why === 'class' && phase !== 'arrived' && phase !== 'riding' && trip.rec?.kind !== 'boarded')
      actions.push({ id: 'skipped', label: m().notGoing, trip: key });
    if (a.dest?.why === 'class' && phase === 'idle') actions.push({ id: 'away', label: m().notOnCampus, trip: key });
  }
  if (trip.away) actions.push({ id: 'back', label: m().backOnCampus, trip: 'day' });
  if (trip.undo) {
    actions.push({
      id: 'reset',
      label: isHomeKey(trip.undo.key) ? m().undoHome : trip.undo.label ? m().undoTo(trip.undo.label) : m().undoTrip,
      trip: trip.undo.key,
    });
  }

  const c = trip.changesAt;
  const phaseAt = c ? (c.leave ? Math.min(Math.max(c.at, nowMs + LEAVE_GAP_MS), c.firm ?? Infinity) : c.at) : null;
  const next = [phaseAt, card.staleAt ? Date.parse(card.staleAt) : null]
    .filter((m): m is number => m !== null && m > nowMs)
    .sort((x, y) => x - y)[0];

  return {
    phase,
    phaseText: goneAt
      ? m().phaseGone
      : phase === 'waiting' && trip.rec?.boarded?.change
        ? m().phaseChange
        : (PHASE_TEXT[phase]?.() ?? null),
    glance,
    line,
    actions,
    warning: a.warning ?? null,
    nextChangeAt: next === undefined ? null : iso(next),
    remind: trip.remind !== false,
    suggestion: trip.suggestion ?? null,
    ride: phase === 'riding' && onBus ? rideWithChange(onBus, h12) : null,
    gone: goneAt !== null,
    walkTo: walkToOf(a, card.kind, phase),
  };
}
