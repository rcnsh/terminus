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
/** A ride faster than MIN_HOP_S or slower than MAX_HOP_S a stop is a mistake, not a slow bus: dropped. */
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

/** Accounts this new can't add rides: a few fresh ones can't skew everyone's times. */
export const RIDE_MIN_ACCOUNT_AGE_MS = 3 * 86_400_000;

/**
 * Whether this account's ride on `svc` may be kept: an account a few days
 * old, and one ride per service per hour. The rows hold no user, so the
 * once-an-hour mark is a short-lived KV key instead, named by a hash: the
 * key itself says nothing of who rode what, and once the account is gone
 * nothing leads back to it.
 */
export async function mayRecordRide(env: Env, db: D1Database, userId: string, svc: string, nowMs: number): Promise<boolean> {
  const user = await db.prepare('SELECT created FROM users WHERE id = ?').bind(userId).first<{ created: number }>();
  if (!user || nowMs - user.created < RIDE_MIN_ACCOUNT_AGE_MS) return false;
  const key = `ride:seen:${await sha256Hex(`${userId}:${svc}:${Math.floor(nowMs / 3_600_000)}`)}`;
  if (await env.KV.get(key).catch(() => null)) return false;
  await env.KV.put(key, '1', { expirationTtl: 3_700 }).catch(() => {});
  return true;
}

/**
 * The middle value of seconds per stop, for each group of rides (`by`):
 * the one in the middle, or the mean of the two either side of it, so a
 * handful of made-up rides can't drag it far. In SQL, so the 120 days of
 * rides stay in D1 and only a row per group comes back.
 */
const medianSql = (by: string) => `
  WITH r AS (
    SELECT svc, hour, CAST(seconds AS REAL) / hops AS x,
           ROW_NUMBER() OVER (PARTITION BY ${by} ORDER BY CAST(seconds AS REAL) / hops) AS i,
           COUNT(*) OVER (PARTITION BY ${by}) AS n
      FROM ride_times WHERE day >= ?)
  SELECT svc, hour, n, AVG(x) AS med FROM r WHERE i IN ((n + 1) / 2, (n + 2) / 2) GROUP BY ${by}`;

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Seconds per stop from the rides kept: each service, and each hour with enough of its own. */
export async function buildTable(db: D1Database, nowMs: number): Promise<HopTable> {
  const since = sgtDate(nowMs - RIDE_KEEP_DAYS * 86_400_000);
  type Row = { svc: string; hour: number; n: number; med: number };
  const [bySvc, byHour] = await db.batch<Row>([db.prepare(medianSql('svc')).bind(since), db.prepare(medianSql('svc, hour')).bind(since)]);
  const svcs: HopTable['svcs'] = {};
  const clamp = (x: number) => Math.round(Math.min(CLAMP[1], Math.max(CLAMP[0], x)));
  for (const r of bySvc.results ?? []) if (r.n >= MIN_RIDES) svcs[r.svc] = { n: r.n, s: clamp(r.med), hours: {} };
  for (const r of byHour.results ?? []) if (r.n >= MIN_RIDES && svcs[r.svc]) svcs[r.svc].hours[String(r.hour)] = clamp(r.med);
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
