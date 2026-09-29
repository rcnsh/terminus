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

export type CardKind = 'class' | 'trip' | 'nearby' | 'rest' | 'arrived' | 'setup';

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
  if (a.arrived) return 'arrived';
  if (a.quality === 'unknown' && !a.arrivals.length && !a.stop.code && !a.leave) return 'setup';
  if (a.mode === 'nearby') return 'nearby';
  if (a.dest?.why === 'class' && a.leave && a.timing) return 'class';
  return 'trip';
}

function staleAtOf(a: MeAnswer, kind: CardKind): number | null {
  const marks: number[] = [];
  if (a.refreshAt) marks.push(Date.parse(a.refreshAt));
  if (kind !== 'rest' && kind !== 'setup') {
    if (a.departsAt) marks.push(Date.parse(a.departsAt) + DEPARTED_GRACE_MS);
    marks.push(Date.parse(a.asOf) + MAX_AGE_MS);
  }
  return marks.length ? Math.min(...marks) : null;
}

export function cardFor(a: MeAnswer, h12 = false): Card {
  const kind = kindOf(a);
  const at = (iso: string) => clockAt(Date.parse(iso), h12);
  const staleAt = staleAtOf(a, kind);
  const svc = a.label.split(' · ')[0];
  const crowd = a.arrivals.find((x) => x.svc === svc)?.crowd ?? null;
  const l = a.leave ?? null;
  const t = l?.estimated ? '~' : '';

  const card: Card = {
    kind,
    staleAt: staleAt == null ? null : new Date(Math.round(staleAt / 1000) * 1000).toISOString().replace('.000Z', 'Z'),
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
