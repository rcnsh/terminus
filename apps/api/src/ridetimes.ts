/**
 * Measured ride times (phase 8.2). RIDE.secondsPerHop is a guess; rides that
 * detection saw start and end give the real time between stops.
 *
 * A ride is measured only when both ends come from the phone's location
 * (detect.ts): the bus leaving (the first fix at bus speed, less the time to
 * cover the distance from the stop) and reaching the stop you get off at. A
 * tap is minutes out either way, so "On it" and "I'm there" are never used.
 *
 * Each ride is one row: the service, the two stops, how many stops apart,
 * how long, the hour and kind of day, and the bus's plate when known. No
 * user, no device, no location. Kept RIDE_KEEP_DAYS, pruned by the cron.
 *
 * Once a day the cron turns them into seconds per stop, for each service and
 * for each hour of the day that has MIN_RIDES of its own, and keeps that in
 * KV. The planner reads it (hopSecondsFor) and falls back to the constant for
 * anything without enough rides.
 */

import type { Env, Graph } from './types.ts';
import type { Boarded } from './trip.ts';
import { sgt } from './config.ts';
import { indexGraph, rideStops } from './resolve.ts';
import { dayType } from './crowd.ts';
import { sgtDate } from './calendar.ts';

/** Below this many rides a service (or an hour of it) keeps the guess. */
export const MIN_RIDES = 10;
/** A ride this far from the guess is a mistake, not a slow bus: dropped. */
const MIN_HOP_S = 30;
const MAX_HOP_S = 300;
/** The table never moves the guess further than this either way. */
const CLAMP: [number, number] = [45, 240];
export const RIDE_KEEP_DAYS = 120;
/** The table, and when it was made (so the cron makes it once a day). */
export const TABLE_KEY = 'ride:hops';
const MADE_KEY = 'ride:hops:made';

export interface HopTable {
  made: string;
  /** Seconds per stop by service, overall and by hour of the day (SGT). */
  svcs: Record<string, { n: number; s: number; hours: Record<string, number> }>;
}

/**
 * Records a ride that detection saw start and end. Returns the seconds kept,
 * or null when the ride can't be measured or makes no sense.
 */
export async function recordRide(db: D1Database, graph: Graph, b: Boarded, arrivedMs: number): Promise<number | null> {
  const left = b.departed ? Date.parse(b.departed) : NaN;
  if (!b.stopCode || !b.alightCode || !Number.isFinite(left)) return null;
  const stops = rideStops(indexGraph(graph), b.svc, b.stopCode, b.alightCode);
  const hops = stops ? stops.length - 1 : 0;
  if (hops < 1) return null;
  const seconds = Math.round((arrivedMs - left) / 1000);
  if (seconds < hops * MIN_HOP_S || seconds > hops * MAX_HOP_S) return null;
  try {
    await db
      .prepare('INSERT INTO ride_times (svc, from_code, to_code, hops, seconds, daytype, hour, day, plate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(b.svc, b.stopCode, b.alightCode, hops, seconds, dayType(left), Math.floor(sgt(left).minutes / 60), sgtDate(left), b.plate ?? null)
      .run();
    return seconds;
  } catch (err) {
    // A lost measurement is nothing; a failed signal would be.
    console.error('ride time not saved', err instanceof Error ? err.name : typeof err);
    return null;
  }
}

/** Seconds per stop from the rides kept: each service, and each hour with enough of its own. */
export async function buildTable(db: D1Database, nowMs: number): Promise<HopTable> {
  const since = sgtDate(nowMs - RIDE_KEEP_DAYS * 86_400_000);
  const { results } = await db
    .prepare('SELECT svc, hour, COUNT(*) AS n, SUM(seconds) AS s, SUM(hops) AS h FROM ride_times WHERE day >= ? GROUP BY svc, hour')
    .bind(since)
    .all<{ svc: string; hour: number; n: number; s: number; h: number }>();
  const svcs: HopTable['svcs'] = {};
  const bySvc = new Map<string, Array<{ hour: number; n: number; s: number; h: number }>>();
  for (const r of results ?? []) bySvc.set(r.svc, [...(bySvc.get(r.svc) ?? []), r]);
  const clamp = (x: number) => Math.round(Math.min(CLAMP[1], Math.max(CLAMP[0], x)));
  for (const [svc, rows] of bySvc) {
    const n = rows.reduce((t, r) => t + r.n, 0);
    if (n < MIN_RIDES) continue;
    const s = rows.reduce((t, r) => t + r.s, 0) / rows.reduce((t, r) => t + r.h, 0);
    const hours: Record<string, number> = {};
    for (const r of rows) if (r.n >= MIN_RIDES) hours[String(r.hour)] = clamp(r.s / r.h);
    svcs[svc] = { n, s: clamp(s), hours };
  }
  return { made: new Date(nowMs).toISOString(), svcs };
}

/** The cron's part: the table once a day, and old rides pruned. */
export async function refreshTable(env: Env, nowMs: number): Promise<boolean> {
  if (!env.DB) return false;
  const today = sgtDate(nowMs);
  if ((await env.KV.get(MADE_KEY)) === today) return false;
  await env.DB.prepare('DELETE FROM ride_times WHERE day < ?').bind(sgtDate(nowMs - RIDE_KEEP_DAYS * 86_400_000)).run();
  const table = await buildTable(env.DB, nowMs);
  await env.KV.put(TABLE_KEY, JSON.stringify(table));
  await env.KV.put(MADE_KEY, today, { expirationTtl: 2 * 86_400 });
  cached = { at: nowMs, table };
  return true;
}

/** Read once in a while per isolate: it changes once a day. */
const CACHE_MS = 10 * 60_000;
let cached: { at: number; table: HopTable | null } | null = null;

/** The table from KV, or null (no rides yet, or KV unreachable). */
export async function loadTable(env: Env, nowMs: number): Promise<HopTable | null> {
  if (cached && nowMs - cached.at < CACHE_MS && nowMs >= cached.at) return cached.table;
  let table: HopTable | null = null;
  try {
    table = await env.KV.get<HopTable>(TABLE_KEY, 'json');
  } catch {
    table = null;
  }
  cached = { at: nowMs, table };
  return table;
}

/** For tests: forget the cached table. */
export function forgetTable(): void {
  cached = null;
}

/**
 * Seconds per stop on a service at this time of day, or null for the guess:
 * the hour's own figure when it has enough rides, else the service's.
 */
export function hopSecondsFor(table: HopTable | null, nowMs: number): ((svc: string) => number | null) | undefined {
  if (!table || !Object.keys(table.svcs).length) return undefined;
  const hour = String(Math.floor(sgt(nowMs).minutes / 60));
  return (svc) => {
    const t = table.svcs[svc];
    return t ? (t.hours[hour] ?? t.s) : null;
  };
}
