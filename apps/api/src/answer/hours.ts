import { termDay } from '../timetable/calendar.ts';
import type { DayKind, Graph, ServiceHours } from '../types.ts';
import { DEFAULT_HEADWAY_S, sgt } from '../config.ts';

export function hhmmToMin(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(v.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function mergeServiceHours(
  base: Record<string, ServiceHours> | undefined,
  hand: Record<string, unknown> | undefined,
): Record<string, ServiceHours> {
  const out: Record<string, ServiceHours> = { ...base };
  for (const [svc, value] of Object.entries(hand ?? {})) {
    if (svc.startsWith('_') || !value || typeof value !== 'object') continue;
    const src = value as Record<string, unknown>;
    const merged: ServiceHours = { ...out[svc] };
    let touched = false;
    for (const day of ['weekday', 'saturday', 'sunday'] as const) {
      if (!(day in src)) continue;
      const win = src[day];
      if (win === null || (Array.isArray(win) && win.length === 2 && win[0] === null && win[1] === null)) {
        merged[day] = null;
        touched = true;
      } else if (Array.isArray(win) && hhmmToMin(win[0]) !== null && hhmmToMin(win[1]) !== null) {
        merged[day] = [String(win[0]), String(win[1])];
        touched = true;
      }
    }
    if (touched) out[svc] = merged;
  }
  return out;
}

export function dayKindOf(ms: number): DayKind {
  return kindOn(sgt(ms).day, termDay(ms).holiday);
}

function kindOn(day: number, holiday: string | null): DayKind {
  if (day === 0 || holiday !== null) return 'sunday';
  return day === 6 ? 'saturday' : 'weekday';
}

function windowOn(hours: ServiceHours, ms: number): ServiceHours['weekday'] | undefined {
  return hours[dayKindOf(ms)];
}

function parseWindow(win: ServiceHours['weekday'] | undefined): { open: number; close: number } | null {
  if (!win) return null;
  const open = hhmmToMin(win[0]);
  const close = hhmmToMin(win[1]);
  return open === null || close === null ? null : { open, close };
}

function yesterdayRunsUntil(hours: ServiceHours, nowMs: number): number {
  const y = parseWindow(windowOn(hours, nowMs - 86_400_000));
  return y && y.close < y.open ? y.close : 0;
}

export function inService(graph: Graph, svc: string, nowMs: number): boolean {
  const hours: ServiceHours | undefined = graph.serviceHours?.[svc];
  if (!hours) return true;
  const { minutes } = sgt(nowMs);
  if (minutes < yesterdayRunsUntil(hours, nowMs)) return true;
  const win = windowOn(hours, nowMs);
  if (win === null) return false;
  if (!win) return true;
  const w = parseWindow(win);
  if (!w) return true;
  return w.close >= w.open ? minutes >= w.open && minutes < w.close : minutes >= w.open;
}

export function serviceEndsAt(graph: Graph, svc: string, nowMs: number): number | null {
  if (!inService(graph, svc, nowMs)) return null;
  const hours: ServiceHours | undefined = graph.serviceHours?.[svc];
  if (!hours) return null;
  const { minutes } = sgt(nowMs);
  const midnight = nowMs - (minutes * 60_000 + (nowMs % 60_000));
  const tail = yesterdayRunsUntil(hours, nowMs);
  if (minutes < tail) return midnight + tail * 60_000;
  const w = parseWindow(windowOn(hours, nowMs));
  if (!w) return null;
  return midnight + ((w.close >= w.open ? 0 : 1440) + w.close) * 60_000;
}

export function serviceClosedAt(graph: Graph, svc: string, ms: number): number | null {
  const hours = graph.serviceHours?.[svc];
  if (!hours) return null;
  const { minutes } = sgt(ms);
  const midnight = ms - (minutes * 60_000 + (ms % 60_000));
  for (let d = 0; d <= 1; d++) {
    const day = midnight - d * 86_400_000;
    const w = parseWindow(windowOn(hours, day));
    if (!w) continue;
    const close = day + ((w.close >= w.open ? 0 : 1440) + w.close) * 60_000;
    if (close <= ms) return close;
  }
  return null;
}

export type StoppedReason = 'ended' | 'notYet' | 'noService';

const RESUME_DAYS = 8;

export function stoppedReason(graph: Graph, svc: string, nowMs: number): StoppedReason | null {
  if (inService(graph, svc, nowMs)) return null;
  const hours = graph.serviceHours?.[svc];
  const w = hours ? parseWindow(windowOn(hours, nowMs)) : null;
  if (!w) return 'noService';
  return sgt(nowMs).minutes < w.open ? 'notYet' : 'ended';
}

export function serviceResumesAt(graph: Graph, svc: string, nowMs: number): number | null {
  const hours = graph.serviceHours?.[svc];
  if (!hours) return null;
  const { minutes } = sgt(nowMs);
  const midnight = nowMs - (minutes * 60_000 + (nowMs % 60_000));
  for (let d = 0; d <= RESUME_DAYS; d++) {
    const day = midnight + d * 86_400_000;
    const w = parseWindow(windowOn(hours, day));
    if (w && day + w.open * 60_000 > nowMs) return day + w.open * 60_000;
  }
  return null;
}

export function headwayFor(graph: Graph, svc: string, atMs?: number): number {
  const usual = graph.headwayS?.[svc] ?? DEFAULT_HEADWAY_S;
  const byTime = atMs === undefined ? undefined : graph.headwaysByTime?.[svc];
  if (!byTime || atMs === undefined) return usual;
  const { kind, holiday } = termDay(atMs);
  const period = kind === 'unknown' ? undefined : byTime[kind === 'vacation' ? 'vacation' : 'term'];
  if (!period) return Math.max(DEFAULT_HEADWAY_S, usual);
  const { day, hour } = sgt(atMs);
  const measured = period[kindOn(day, holiday)];
  return measured ? nearestHour(measured, hour) : usual;
}

function nearestHour(day: { all: number; hours: Record<string, number> }, hour: number): number {
  let best = day.all;
  let dist = Infinity;
  for (const [h, s] of Object.entries(day.hours)) {
    const d = Math.abs(Number(h) - hour);
    if (d < dist || (d === dist && s > best)) [best, dist] = [s, d];
  }
  return best;
}
