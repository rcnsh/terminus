/**
 * When a service runs and how often: its operating hours on each kind of
 * day (Sunday's on a public holiday) and its measured headway by the hour.
 * See internals.md, "Operating hours bound every guess" and "Headways are
 * measured, by the hour".
 */

import { termDay } from '../timetable/calendar.ts';
import type { DayKind, Graph, ServiceHours } from '../types.ts';
import { DEFAULT_HEADWAY_S, sgt } from '../config.ts';

/** Minutes past midnight, or null if this is not an HH:MM string. */
export function hhmmToMin(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(v.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Merge hand-maintained hours over whatever the scraper produced.
 *
 * Only well-formed entries win, so a half-filled template cannot clobber real
 * data with `["", ""]`.
 */
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
      // [null, null] is how the file says it too: closed at both ends.
      if (win === null || (Array.isArray(win) && win.length === 2 && win[0] === null && win[1] === null)) {
        merged[day] = null; // an explicit "does not run"
        touched = true;
      } else if (Array.isArray(win) && hhmmToMin(win[0]) !== null && hhmmToMin(win[1]) !== null) {
        merged[day] = [String(win[0]), String(win[1])];
        touched = true;
      }
      // Anything else -- ["", ""], a typo, a number -- is left unset, which
      // reads downstream as "hours unknown, assume running".
    }
    if (touched) out[svc] = merged;
  }
  return out;
}

/** The timetable the SGT day `ms` falls on runs: Sunday's on public holidays. */
export function dayKindOf(ms: number): DayKind {
  return kindOn(sgt(ms).day, termDay(ms).holiday);
}

function kindOn(day: number, holiday: string | null): DayKind {
  // NUS runs the Sunday timetable on public holidays. Without this a holiday
  // morning gets a headway guess for services that are not running.
  if (day === 0 || holiday !== null) return 'sunday';
  return day === 6 ? 'saturday' : 'weekday';
}

/** The window `hours` gives the SGT day `ms` falls on: Sunday hours on public holidays. */
function windowOn(hours: ServiceHours, ms: number): ServiceHours['weekday'] | undefined {
  return hours[dayKindOf(ms)];
}

/** A window's open and close in minutes, or null when it isn't a usable window. */
function parseWindow(win: ServiceHours['weekday'] | undefined): { open: number; close: number } | null {
  if (!win) return null;
  const open = hhmmToMin(win[0]);
  const close = hhmmToMin(win[1]);
  return open === null || close === null ? null : { open, close };
}

/**
 * Minutes into today that yesterday's window still runs, when it crosses
 * midnight (Fri 07:00 -> 01:00 runs until 01:00 on Saturday). 0 otherwise.
 */
function yesterdayRunsUntil(hours: ServiceHours, nowMs: number): number {
  const y = parseWindow(windowOn(hours, nowMs - 86_400_000));
  return y && y.close < y.open ? y.close : 0;
}

/** Is `svc` inside its published operating window right now (SGT)? */
export function inService(graph: Graph, svc: string, nowMs: number): boolean {
  const hours: ServiceHours | undefined = graph.serviceHours?.[svc];
  if (!hours) return true; // unknown hours: assume running, let the feed decide
  const { minutes } = sgt(nowMs);
  // Just past midnight: still yesterday's service, by yesterday's hours.
  if (minutes < yesterdayRunsUntil(hours, nowMs)) return true;
  const win = windowOn(hours, nowMs);
  if (win === null) return false; // explicitly does not run today
  if (!win) return true; // hours unknown: assume running, let the feed decide
  const w = parseWindow(win);
  // An unparseable window is unknown, NOT "ended all day". Getting this
  // backwards would turn a half-filled template into a Worker that reports no
  // buses ever, which is a far worse failure than reporting them at 3am.
  if (!w) return true;
  // A window that crosses midnight runs from its open to the end of today;
  // the rest belongs to tomorrow (above).
  return w.close >= w.open ? minutes >= w.open && minutes < w.close : minutes >= w.open;
}

/**
 * When `svc` stops running (SGT), epoch ms: the close of the window it's in
 * now. Null when the hours are unknown or it isn't running now. A window
 * that crosses midnight closes tomorrow.
 */
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

/**
 * When `svc` last stopped running at or before `ms` (SGT), epoch ms: the
 * close of the most recent window ending by then, today's or yesterday's.
 * Null when the hours are unknown, or neither day has a window closing by `ms`.
 */
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

/** Why a service isn't running now: it has finished for today, it starts
 *  later today, or it doesn't run today at all. */
export type StoppedReason = 'ended' | 'notYet' | 'noService';

/** How far ahead serviceResumesAt looks: past a week, so a service off for a weekend and a holiday still has a next start. */
const RESUME_DAYS = 8;

/**
 * Why `svc` isn't running now (SGT), or null when it is, by inService's
 * rules: unknown hours count as running, Sunday hours on public holidays.
 */
export function stoppedReason(graph: Graph, svc: string, nowMs: number): StoppedReason | null {
  if (inService(graph, svc, nowMs)) return null;
  const hours = graph.serviceHours?.[svc];
  const w = hours ? parseWindow(windowOn(hours, nowMs)) : null;
  if (!w) return 'noService';
  return sgt(nowMs).minutes < w.open ? 'notYet' : 'ended';
}

/**
 * When `svc` next starts running (SGT), epoch ms: the first opening after
 * now, today or up to RESUME_DAYS ahead, by each day's hours (Sunday's on a
 * public holiday). Null when the hours are unknown or none open in that time.
 */
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

/**
 * The gap between `svc`'s buses, s: the headway a guess counts in. At
 * `atMs`, the measured one for that hour, day kind and period
 * (data/headways.json), else the nearest hour measured that day, else the
 * service's usual one. In a period nothing was recorded in (the vacation
 * runs its own timetable), or past the calendar, never shorter than
 * DEFAULT_HEADWAY_S or term time's: too short a headway tells someone to
 * leave too late. Without a time (a route's cost before any fetch), the
 * usual one.
 */
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

/**
 * That hour's headway, or the nearest hour's: the hours too quiet to measure
 * are the early and late ones, which run like their neighbours, not like the
 * day's median. On a tie, the longer.
 */
function nearestHour(day: { all: number; hours: Record<string, number> }, hour: number): number {
  let best = day.all;
  let dist = Infinity;
  for (const [h, s] of Object.entries(day.hours)) {
    const d = Math.abs(Number(h) - hour);
    if (d < dist || (d === dist && s > best)) [best, dist] = [s, d];
  }
  return best;
}
