/**
 * GET /me/day: today's timeline, worked out with the planner /me/next uses.
 * Each class with where you set off from and its leave-by, the trips home in
 * long gaps and after the last class, and where each stands now. Clients
 * cache it, so they have the day's shape offline or between refreshes; the
 * leave-by of a class hours away is an estimate, and says so.
 */

import type { Env, Leave, PlaceChip, Timing } from './types.ts';
import type { MeDeps } from './me.ts';
import {
  GAP_RETURN_MIN,
  HOME_BY_MIN,
  LATE_GRACE_MIN,
  type Profile,
  classKey,
  classesOn,
  endOf,
  restDetail,
  restSide,
} from './profile.ts';
import type { ImportedTrip } from './nusmods.ts';
import { sgt } from './config.ts';
import { isoSeconds } from './format.ts';
import { indexGraph } from './resolve.ts';
import { tripAnswer } from './next.ts';
import { type DayRecord, dayState, leaveOf, offStop, sgtDate } from './trip.ts';
import { m } from './i18n.ts';

export type DayStatus = 'done' | 'now' | 'next' | 'later' | 'skipped';

export interface DayItem {
  kind: 'class' | 'home';
  /** The trip's key, for /me/signal ("Not going", "Undo"). */
  key: string;
  label: string;
  status: DayStatus;
  /** Where you set off from, a stop code; null when unknown. */
  from: string | null;
  fromName: string | null;
  /** The destination stop. */
  to: string;
  toName: string;
  /** Class: when it starts and ends. Home: from when (the class before ends). ISO. */
  startsAt: string;
  endsAt: string | null;
  venue?: string;
  /** Upcoming classes: when to leave and how. Estimated hours ahead. */
  leave?: Leave | null;
  /** On the bus to it (a "boarded" signal): the bus, where to get off and
   *  when it gets there (ISO), in place of a leave-by. */
  onBus?: { svc: string; off: string | null; arrive: string | null } | null;
  timing?: Timing | null;
  /** Can be taken off today (send `skipped` with `key`; `reset` puts it
   *  back): anything not done yet. Removed entries aren't listed. */
  removable: boolean;
}

export interface DayPlan {
  date: string;
  /** When the day's answers start and stop, ISO: outside it they rest. */
  dayStart: string;
  dayEnd: string;
  items: DayItem[];
  /** A day with no classes: why, and what's next. */
  note: string | null;
}

export async function dayPlan(env: Env, ctx: ExecutionContext, nowMs: number, deps: MeDeps, profile: Profile, day: DayRecord | null, h12: boolean, earlier: Set<string> = new Set()): Promise<DayPlan> {
  const idx = indexGraph(deps.graph);
  const name = (code: string | null) => (code ? (idx.byCode.get(code)?.name ?? code) : null);
  const t = sgt(nowMs);
  const midnight = nowMs - (t.minutes * 60_000 + (nowMs % 60_000));
  const at = (min: number) => isoSeconds(midnight + min * 60_000);
  const state = dayState(day);
  const homeStop = profile.home?.stops[0] ?? null;
  const places: PlaceChip[] = [];
  const classes = classesOn(profile, nowMs);

  const items: DayItem[] = [];
  let prev: ImportedTrip | null = null;
  const pending: Array<Promise<void>> = [];
  let nextTaken = false;

  for (const c of classes) {
    const key = classKey(c);
    // Taken off today (from here or "Not going"): not listed, and no gap
    // around it either; the next class's gap is measured from the one before.
    if (state.skipped.has(key)) continue;
    // A long gap: home in between, back an hour before the next class.
    // Unless that trip home was taken off today: then you stay, and go from there.
    const longGap = prev && homeStop && homeStop !== c.to && c.arriveByMin - endOf(prev) > profile.gapHours * 60 && !state.skipped.has(`gap-home:${prev.to}`);
    if (prev && longGap) {
      items.push(homeItem(`gap-home:${prev.to}`, prev, c.arriveByMin - GAP_RETURN_MIN));
    }
    const from = longGap || !prev ? homeStop : prev.to;
    const fromVenue = longGap || !prev ? null : prev.venue || null;
    const done = state.done.has(key) || c.arriveByMin + LATE_GRACE_MIN <= t.minutes;
    const status: DayStatus = done ? 'done' : nextTaken ? 'later' : 'next';
    if (status === 'next') nextTaken = true;
    const rec = day?.trips[key];
    const boarded = !done && rec?.kind === 'boarded' ? rec.boarded : undefined;
    const item: DayItem = {
      kind: 'class',
      key,
      label: c.label,
      status,
      from,
      fromName: name(from),
      to: c.to,
      toName: name(c.to) ?? c.to,
      startsAt: at(c.arriveByMin),
      endsAt: at(endOf(c)),
      venue: c.venue || undefined,
      removable: status === 'next' || status === 'later',
    };
    // The next class's bus, once a device has planned it from where the
    // phone is (or it's due): the same bus the card and the notifications say.
    const plan = status === 'next' && rec?.kind !== 'missed' ? day?.plans?.[key] : undefined;
    if (boarded) item.onBus = { svc: boarded.svc, off: offStop(boarded), arrive: boarded.arrive };
    else if (plan?.board && Date.parse(plan.board) > nowMs) item.leave = leaveOf(plan);
    // Upcoming classes get a leave-by, from where you'll be then.
    else if ((status === 'next' || status === 'later') && from) {
      pending.push(
        tripAnswer(env, ctx, nowMs, deps, profile, { to: c.to, label: c.label, why: 'class', from, trip: c, fromVenue }, { lat: null, lon: null }, places, h12, earlier.has(classKey(c)))
          .then((a) => {
            item.leave = a.leave ?? null;
            item.timing = a.timing ?? null;
          })
          .catch(() => {}),
      );
    }
    items.push(item);
    // A class whose bus was missed (and that nothing since says you reached)
    // is not where you go on from (see planFor).
    if (!state.missed.has(key)) prev = c;
  }
  if (prev && homeStop && !state.skipped.has(`home:${endOf(prev)}`)) items.push(homeItem(`home:${endOf(prev)}`, prev, null));
  await Promise.all(pending);

  // The day's hours, stretched for early and late classes (as /me/next rests).
  const r = restSide(profile, nowMs);
  const startMin = r?.startMin ?? Math.max(0, Math.min(profile.dayStartMin, ...classes.map((x) => x.arriveByMin - 90)));
  const endMin = Math.max(profile.dayEndMin, ...classes.map((x) => endOf(x) + 45));

  return {
    date: sgtDate(nowMs),
    dayStart: at(startMin),
    dayEnd: at(Math.min(endMin, 1440)),
    items,
    note: classes.length ? null : restDetail(profile, nowMs, h12),
  };

  function homeItem(key: string, after: ImportedTrip, until: number | null): DayItem {
    const leaveMin = endOf(after);
    const done = state.done.has(key) || t.minutes >= (until ?? leaveMin + HOME_BY_MIN);
    const now = !done && t.minutes >= leaveMin;
    const status: DayStatus = done ? 'done' : now ? 'now' : nextTaken ? 'later' : 'next';
    if (status === 'next' || status === 'now') nextTaken = true;
    return {
      kind: 'home',
      key,
      label: m().home,
      status,
      from: after.to,
      fromName: name(after.to),
      to: homeStop!,
      toName: name(homeStop) ?? homeStop!,
      startsAt: at(leaveMin),
      endsAt: until === null ? null : at(until),
      removable: status !== 'done',
    };
  }
}
