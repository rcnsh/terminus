import type { Env, Leave, PlaceChip, Timing } from '../types.ts';
import type { MeDeps } from '../answer/answer.ts';
import {
  GAP_RETURN_MIN,
  HOME_BY_MIN,
  LATE_GRACE_MIN,
  type Profile,
  classKey,
  classesOn,
  endOf,
  homeAfter,
  restDetail,
  restSide,
} from './profile.ts';
import type { TimetableClass } from './nusmods.ts';
import { sgt } from '../config.ts';
import { isoSeconds, named } from '../answer/format.ts';
import { clockAt } from '../clock.ts';
import { indexGraph } from '../answer/resolve.ts';
import { tripAnswer } from '../answer/next.ts';
import { unlogged } from '../answer/answer.ts';
import { GRAPH } from '../answer/graph.ts';
import { type DayRecord, dayState, leaveOf, offStop, sgtDate } from '../answer/trip.ts';
import { ASSUME_MS } from '../answer/phase.ts';
import { m } from '../i18n.ts';

export type DayStatus = 'done' | 'now' | 'next' | 'later' | 'skipped';

export interface DayItem {
  kind: 'class' | 'home';
  key: string;
  label: string;
  status: DayStatus;
  from: string | null;
  fromName: string | null;
  to: string;
  toName: string;
  startsAt: string;
  endsAt: string | null;
  venue?: string;
  leave?: Leave | null;
  onBus?: { svc: string; off: string | null; arrive: string | null } | null;
  timing?: Timing | null;
  title: string;
  line: string | null;
  removable: boolean;
}

export interface DayPlan {
  date: string;
  dayStart: string;
  dayEnd: string;
  items: DayItem[];
  note: string | null;
}

export async function dayPlan(
  env: Env,
  ctx: ExecutionContext,
  nowMs: number,
  deps: MeDeps,
  profile: Profile,
  day: DayRecord | null,
  h12: boolean,
  earlier: Set<string> = new Set(),
  here: { lat: number | null; lon: number | null } = { lat: null, lon: null },
): Promise<DayPlan> {
  const idx = indexGraph(GRAPH);
  const name = (code: string | null) => (code ? (idx.byCode.get(code)?.name ?? code) : null);
  const t = sgt(nowMs);
  const midnight = nowMs - (t.minutes * 60_000 + (nowMs % 60_000));
  const at = (min: number) => isoSeconds(midnight + min * 60_000);
  const state = dayState(day);
  const homeStop = profile.home?.stops[0] ?? null;
  const places: PlaceChip[] = [];
  const classes = classesOn(profile, nowMs);
  const quiet = unlogged(deps);

  const items: DayItem[] = [];
  let prev: TimetableClass | null = null;
  const pending: Array<Promise<void>> = [];
  let nextTaken = false;

  for (const c of classes) {
    const key = classKey(c);
    if (state.skipped.has(key)) continue;
    const longGap =
      prev &&
      homeStop &&
      homeStop !== c.to &&
      c.arriveByMin - endOf(prev) > profile.gapHours * 60 &&
      !state.skipped.has(`gap-home:${prev.to}`);
    const wentHome = prev && homeStop && !longGap ? homeAfter(prev, state, nowMs) : null;
    if (prev && longGap) {
      items.push(homeItem(`gap-home:${prev.to}`, prev, c.arriveByMin - GAP_RETURN_MIN));
    } else if (prev && wentHome) {
      items.push(homeItem(wentHome, prev, null, true));
    }
    const fromHome = longGap || wentHome || !prev;
    const from = fromHome ? homeStop : prev!.to;
    const fromVenue = fromHome ? null : prev!.venue || null;
    const done = state.done.has(key) || c.arriveByMin + LATE_GRACE_MIN <= t.minutes;
    const status: DayStatus = done ? 'done' : nextTaken ? 'later' : 'next';
    if (status === 'next') nextTaken = true;
    const rec = day?.trips[key];
    const boarded = !done && rec?.kind === 'boarded' ? rec.boarded : undefined;
    const item: DayItem = {
      kind: 'class',
      key,
      label: c.label,
      title: c.label,
      line: null,
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
    const plan = status === 'next' && rec?.kind !== 'missed' ? day?.plans?.[key] : undefined;
    const unsaid = !rec;
    const assumed =
      plan?.board && plan.seen && unsaid && nowMs >= Date.parse(plan.board) + ASSUME_MS && plan.arrive && Date.parse(plan.arrive) > nowMs;
    if (boarded) item.onBus = { svc: boarded.svc, off: offStop(boarded), arrive: boarded.arrive };
    else if (assumed) item.onBus = { svc: plan.svc, off: offStop(plan), arrive: plan.arrive };
    else if (plan?.board && (Date.parse(plan.board) > nowMs || (unsaid && nowMs < Date.parse(plan.board) + ASSUME_MS)))
      item.leave = leaveOf(plan);
    else if ((status === 'next' || status === 'later') && from) {
      const setOff = status === 'next' ? here : { lat: null, lon: null };
      pending.push(
        tripAnswer(
          env,
          ctx,
          nowMs,
          quiet,
          profile,
          { to: c.to, label: c.label, why: 'class', from, trip: c, fromVenue },
          setOff,
          places,
          h12,
          earlier.has(key),
          day?.steps?.[key] ? { trip: key, target: day.steps[key] } : undefined,
        )
          .then((a) => {
            item.leave = a.leave ?? null;
            item.timing = a.timing ?? null;
          })
          .catch((e: unknown) => console.error('day leave-by failed', e instanceof Error ? e.name : typeof e)),
      );
    }
    items.push(item);
    if (!state.missed.has(key)) prev = c;
  }
  if (prev && homeStop && !state.skipped.has(`home:${endOf(prev)}`))
    items.push(homeItem(`home:${endOf(prev)}`, prev, null, homeAfter(prev, state, nowMs) !== null));
  await Promise.all(pending);
  for (const it of items) it.line = dayLine(it, h12);

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

  function homeItem(key: string, after: TimetableClass, until: number | null, home = false): DayItem {
    const leaveMin = endOf(after);
    const done = home || state.done.has(key) || t.minutes >= (until ?? leaveMin + HOME_BY_MIN);
    const now = !done && t.minutes >= leaveMin;
    const status: DayStatus = done ? 'done' : now ? 'now' : nextTaken ? 'later' : 'next';
    if (status === 'next' || status === 'now') nextTaken = true;
    return {
      kind: 'home',
      key,
      label: m().home,
      title: name(after.to) ? m().homeFrom(name(after.to)!) : m().homeAfterClass,
      line: null,
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

export function dayLine(it: DayItem, h12: boolean): string | null {
  if (it.status === 'skipped') return m().notGoing;
  if (it.status === 'done') return null;
  const at = (iso: string) => clockAt(Date.parse(iso), h12);
  if (it.onBus) {
    const b = it.onBus;
    return [m().onThe(b.svc), b.off ? m().offAt(b.off) : null, b.arrive ? m().arriveAt(at(b.arrive)) : null].filter(Boolean).join(' · ');
  }
  const l = it.leave;
  if (!l?.at) return null;
  const by = m().leaveBy(l.estimated ? m().approx(at(l.at)) : at(l.at));
  const how = l.svc ? m().svcFrom(named({ svc: l.svc, paid: l.paid }), l.stop ?? it.fromName ?? '') : m().walk;
  return [by, how, it.timing?.status === 'late' ? it.timing.text : null].filter(Boolean).join(' · ');
}
