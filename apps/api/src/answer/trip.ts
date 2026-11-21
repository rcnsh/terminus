import type { Env, Graph, Leave } from '../types.ts';
import type { StepTarget } from './step.ts';
import { haversineM } from '../geo.ts';
import { MAX_FIX_ACC_M, WALK, sgt } from '../config.ts';
import { sgtDate } from '../timetable/calendar.ts';
import { GRAPH, GRAPH_PUBLIC } from './graph.ts';
import { indexGraph, rideSpan, rideStops } from './resolve.ts';
import { routeColor, shapeFor } from '../map/campus.ts';
import { alongNear } from '../map/buses.ts';
import { isoSeconds, shortStop } from './format.ts';

export type Phase = 'idle' | 'due' | 'heading' | 'waiting' | 'riding' | 'missed' | 'arrived';

export const SIGNALS = ['boarded', 'missed', 'skipped', 'left', 'arrived', 'location', 'reset', 'away', 'back'] as const;
export type SignalKind = (typeof SIGNALS)[number];

export interface Plan {
  svc: string;
  stop: string;
  board: string | null;
  leave?: string;
  located?: boolean;
  arrive: string | null;
  note?: string;
  estimated?: boolean;
  off?: string;
  walkS?: number;
  rideS?: number;
  stopCode?: string;
  alightCode?: string;
  plate?: string;
  paid?: true;
  route?: string;
  seen?: true;
  change?: Plan;
  crossS?: number;
}

export function isHomeKey(key: string): boolean {
  return key.startsWith('home:') || key.startsWith('gap-home:');
}

export function leaveOf(b: Plan): Leave {
  const c = b.change;
  if (c) {
    const end = leaveOf(c);
    const { off: _off, offCode: _offCode, toStop: _toStop, ...first } = leaveOf({ ...b, change: undefined });
    return {
      ...first,
      arrive: c.arrive,
      ...(end.off ? { off: end.off } : {}),
      ...(end.offCode ? { offCode: end.offCode } : {}),
      ...(end.toStop ? { toStop: end.toStop } : {}),
      change: {
        svc: c.svc,
        from: offStop(b) ?? b.stop,
        fromCode: b.alightCode ?? '',
        stop: c.stop,
        stopCode: c.stopCode ?? '',
        ...(c.crossS ? { crossS: c.crossS } : {}),
        reach: b.arrive,
        board: c.board,
        rideS: c.rideS ?? 0,
        estimated: c.estimated === true,
      },
    };
  }
  return {
    at: b.leave ?? b.board ?? new Date(0).toISOString(),
    estimated: b.estimated === true,
    svc: b.svc,
    stop: b.stop,
    board: b.board,
    arrive: b.arrive,
    note: b.note ?? null,
    ...(b.off ? { off: b.off } : {}),
    ...(b.stopCode ? { stopCode: b.stopCode } : {}),
    ...(b.alightCode ? { offCode: b.alightCode } : {}),
    ...(b.walkS != null ? { walkS: b.walkS } : {}),
    ...(b.rideS != null ? { rideS: b.rideS } : {}),
    ...(offStop(b) ? { toStop: offStop(b)! } : {}),
    ...(b.paid ? { paid: true as const } : {}),
    ...(b.route ? { route: b.route } : {}),
  };
}

const busGraph = (b: Pick<Plan, 'paid'>): Graph => (b.paid ? GRAPH_PUBLIC : GRAPH);

export function offStop(b: Plan): string | null {
  if (b.off) return b.off;
  const s = b.alightCode ? indexGraph(busGraph(b)).byCode.get(b.alightCode) : undefined;
  return s ? shortStop(s.name) : null;
}

export const tripEnd = (b: Plan): string | null => (b.change ? b.change.arrive : b.arrive);

export function secondBusOf(l: Pick<Leave, 'change' | 'arrive' | 'off' | 'offCode' | 'toCode'>, alightCode: string): Plan | undefined {
  const c = l.change;
  if (!c) return undefined;
  return {
    svc: c.svc,
    stop: c.stop,
    board: c.board,
    arrive: l.arrive,
    ...(c.estimated ? { estimated: true } : {}),
    ...(l.off ? { off: l.off } : {}),
    stopCode: c.stopCode,
    rideS: c.rideS,
    alightCode: l.offCode ?? l.toCode ?? alightCode,
    ...(c.crossS ? { crossS: c.crossS } : {}),
  };
}

export function laterChange(c: Plan | undefined, reach: string | null | undefined, shiftMs: number): Plan | undefined {
  if (!c?.board || !reach || shiftMs <= 0) return c;
  const there = Date.parse(reach) + shiftMs;
  const by = there - Date.parse(c.board);
  if (by <= 0) return c;
  return { ...c, board: isoSeconds(there), ...(c.arrive ? { arrive: isoSeconds(Date.parse(c.arrive) + by) } : {}), estimated: true };
}

export interface Ride {
  svc: string;
  color: string;
  stops: Array<{ code: string; name: string }>;
  board: string;
  arrive: string;
  change?: { svc: string; color: string; stop: string; board: string | null; text: string };
}

export function rideOf(b: Plan): Ride | null {
  if (!b.stopCode || !b.alightCode || !b.board || !b.arrive) return null;
  const idx = indexGraph(busGraph(b));
  const codes = rideStops(idx, b.route ?? b.svc, b.stopCode, b.alightCode);
  if (!codes || codes.length < 2) return null;
  return {
    svc: b.svc,
    color: routeColor(b.svc),
    stops: codes.map((code) => ({ code, name: shortStop(idx.byCode.get(code)?.name ?? code) })),
    board: b.board,
    arrive: b.arrive,
  };
}

export function seenOnBus(b: Plan, lat: number, lon: number, nowMs: number): boolean {
  if (!b.board || !b.stopCode || !b.alightCode || b.paid) return false;
  const idx = indexGraph(GRAPH);
  const r = idx.routes.get(b.svc);
  const stop = idx.byCode.get(b.stopCode);
  const span = rideSpan(idx, b.svc, b.stopCode, b.alightCode);
  const shape = shapeFor(b.svc, GRAPH.routes?.[b.svc] ?? []);
  if (!r || !stop || !span || span.hops === 0 || !shape) return false;
  const walked = (WALK_MAX_MS * Math.max(0, nowMs - Date.parse(b.board))) / 1000 + MAX_FIX_ACC_M;
  if (haversineM(lat, lon, stop.lat, stop.lon) <= walked) return false;
  const start = shape.at[span.i];
  const lap = r.loop ? shape.at[r.seq.length] : undefined;
  const end = span.i + span.hops;
  const rideM = end < shape.at.length ? shape.at[end] - start : lap !== undefined ? lap - start + shape.at[end - r.seq.length] : null;
  if (rideM === null) return false;
  const ahead = (m: number) => (m >= start ? m - start : lap !== undefined ? lap - start + m : Infinity);
  const behind = (m: number) => (m <= start ? start - m : lap !== undefined ? start + lap - m : Infinity);
  const near = alongNear(shape, lat, lon, ON_RIDE_M);
  if (near.some((m) => ahead(m) <= walked || behind(m) <= walked)) return false;
  return near.some((m) => ahead(m) <= rideM);
}

export interface TripRecord {
  kind: Exclude<SignalKind, 'location' | 'reset' | 'away' | 'back'>;
  at: number;
  away?: boolean;
  label?: string;
  boarded?: Plan;
  missed?: string | null;
}

export interface DayRecord {
  date: string;
  trips: Record<string, TripRecord>;
  plans?: Record<string, Plan>;
  steps?: Record<string, StepTarget>;
  revs?: Record<string, number>;
  watch?: number;
}

export function needsWatch(day: DayRecord | null, atMs: number, nowMs: number): boolean {
  const w = day?.watch;
  return w === undefined || w <= nowMs || atMs < w;
}

export interface TripUpdate {
  date: string;
  deleteAt: number;
  items?: Array<{ key: string; rec: TripRecord | null }>;
  plans?: Record<string, Plan | null>;
  steps?: Record<string, StepTarget | null>;
  basis?: Record<string, number>;
  watch?: { userId: string; at: number };
  pushed?: { key: string | null; phase: string; gone?: boolean; at: number };
}

export function tripRev(day: DayRecord | null, key: string): number {
  return day?.revs?.[key] ?? 0;
}

export const ON_RIDE_M = 60;
const WALK_MAX_MS = WALK.speedMs * 1.5;
export const PLATE_WINDOW_S = 5 * 60;

export { sgtDate };

export function endOfDayMs(nowMs: number): number {
  return nowMs - (sgt(nowMs).minutes * 60_000 + (nowMs % 60_000)) + 86_400_000;
}

export function signalOf(day: DayRecord | null, key: string): TripRecord | undefined {
  return day?.trips[key];
}

export const HOME_GRACE_MS = 10 * 60_000;

export function dayState(day: DayRecord | null): {
  skipped: Set<string>;
  done: Set<string>;
  missed: Set<string>;
  homeBy: Map<string, number>;
  away: boolean;
} {
  const skipped = new Set<string>();
  const done = new Set<string>();
  const missed = new Set<string>();
  const homeBy = new Map<string, number>();
  let away = false;
  for (const [k, r] of Object.entries(day?.trips ?? {})) {
    if (r.kind === 'skipped') skipped.add(k);
    if (r.kind === 'arrived') done.add(k);
    if (r.kind === 'missed') missed.add(k);
    if (r.away) away = true;
  }
  for (const k of new Set([...Object.keys(day?.plans ?? {}), ...Object.keys(day?.trips ?? {})])) {
    const r = day?.trips[k];
    const boarded = r?.kind === 'boarded' && r.boarded ? tripEnd(r.boarded) : null;
    const planned = day?.plans?.[k];
    const end = boarded ?? (planned && tripEnd(planned));
    if (isHomeKey(k) && end && !missed.has(k)) homeBy.set(k, Date.parse(end) + HOME_GRACE_MS);
  }
  return { skipped, done, missed, homeBy, away };
}

function stub(env: Env, userId: string): DurableObjectStub | null {
  if (!env.TRIPS) return null;
  return env.TRIPS.get(env.TRIPS.idFromName(userId), { locationHint: 'apac' });
}

export const TRIP_TIMEOUT_MS = 3_000;

function ask(s: DurableObjectStub, path: string, init?: RequestInit): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('trip object timed out')), TRIP_TIMEOUT_MS);
  });
  return Promise.race([s.fetch(`https://trip/${path}`, init), late]).finally(() => timer && clearTimeout(timer));
}

function post(s: DurableObjectStub, path: string, body: unknown): Promise<Response> {
  return ask(s, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function loadDay(env: Env, userId: string, nowMs: number): Promise<DayRecord | null> {
  const s = stub(env, userId);
  if (!s) return null;
  try {
    const res = await ask(s, `day?date=${sgtDate(nowMs)}`);
    if (!res.ok) return null;
    const day = (await res.json()) as DayRecord | null;
    return day &&
      (Object.keys(day.trips).length ||
        Object.keys(day.plans ?? {}).length ||
        Object.keys(day.steps ?? {}).length ||
        Object.keys(day.revs ?? {}).length ||
        day.watch)
      ? day
      : null;
  } catch (err) {
    console.error('trip state unavailable', err instanceof Error ? err.name : typeof err);
    return null;
  }
}

export async function updateTrip(
  env: Env,
  userId: string,
  u: Omit<TripUpdate, 'date' | 'deleteAt'>,
  nowMs: number,
): Promise<DayRecord | null> {
  const s = stub(env, userId);
  if (!s) return null;
  const res = await post(s, 'update', { ...u, date: sgtDate(nowMs), deleteAt: endOfDayMs(nowMs) } satisfies TripUpdate);
  if (!res.ok) throw new Error(`trip update failed: ${res.status}`);
  return (await res.json()) as DayRecord;
}

export async function saveSignals(
  env: Env,
  userId: string,
  items: { key: string; rec: TripRecord | null }[],
  nowMs: number,
): Promise<DayRecord | null> {
  return updateTrip(env, userId, { items }, nowMs);
}

export async function clearTrip(env: Env, userId: string): Promise<void> {
  const s = stub(env, userId);
  if (!s) return;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await ask(s, 'clear', { method: 'POST' });
      if (!res.ok) throw new Error(`status ${res.status}`);
      return;
    } catch (err) {
      if (attempt < 2) continue;
      console.error('trip state not cleared', err instanceof Error ? err.message : typeof err);
      return;
    }
  }
}

export async function watchTrip(env: Env, userId: string, atMs: number, nowMs: number): Promise<boolean> {
  try {
    await updateTrip(env, userId, { watch: { userId, at: atMs } }, nowMs);
    return true;
  } catch (err) {
    console.error('trip watch failed', err instanceof Error ? err.message : typeof err);
    return false;
  }
}
