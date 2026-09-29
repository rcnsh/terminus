/**
 * Full buses. At peak times a packed bus can pass a stop without room for
 * you, and the leave-by time should not bet on it.
 *
 * Counted as the Worker answers, never by polling: each time a bus is about
 * to reach a stop someone asked about, its crowd level is tallied once per
 * stop and half hour (crowd_seen stops repeats). Grouped by service, stop,
 * kind of day and half hour. A group says nothing until it has MIN_SAMPLES.
 */

import type { StopArrivals } from './types.ts';
import { termDay, sgtDate } from './calendar.ts';
import { sgt } from './config.ts';

export type DayType = 'term' | 'exam' | 'break' | 'sat' | 'sun';

/** Only a bus this close to the stop: its crowd is what you'd board into. */
const NEAR_S = 120;
/** Below this many sightings a group is noise. */
export const MIN_SAMPLES = 10;
/** Packed at least this often counts as "often full". */
export const OFTEN_PACKED = 0.5;
const KEEP_SEEN_DAYS = 2;

export function dayType(nowMs: number): DayType {
  const t = termDay(nowMs);
  const day = sgt(nowMs).day;
  if (day === 0 || t.holiday) return 'sun';
  if (day === 6) return 'sat';
  if (t.kind === 'instructional') return 'term';
  if (t.kind === 'exam' || t.kind === 'reading') return 'exam';
  return 'break';
}

/** Half hours past midnight, SGT. */
export const slotOf = (ms: number) => Math.floor(sgt(ms).minutes / 30);

/** Tally the buses about to reach these stops. Never throws. */
export async function recordCrowds(db: D1Database, byStop: Map<string, StopArrivals>, nowMs: number): Promise<void> {
  try {
    const daytype = dayType(nowMs);
    const stmts: D1PreparedStatement[] = [];
    for (const [stop, sa] of byStop) {
      if (!sa.available || sa.stale) continue;
      for (const a of sa.arrivals) {
        if (!a.plate || !a.crowd || a.etaS == null || a.etaS > NEAR_S) continue;
        const at = sa.fetchedAt + a.etaS * 1000;
        const slot = slotOf(at);
        stmts.push(
          db.prepare('INSERT OR IGNORE INTO crowd_seen (plate, stop, day, slot) VALUES (?, ?, ?, ?)').bind(a.plate, stop, sgtDate(at), slot),
          // Counts only when the line above added a row: a bus already seen
          // here this half hour is not a new sighting.
          db
            .prepare(
              `INSERT INTO crowd_stats (svc, stop, daytype, slot, n, packed) SELECT ?, ?, ?, ?, 1, ? WHERE changes() = 1
               ON CONFLICT (svc, stop, daytype, slot) DO UPDATE SET n = n + 1, packed = packed + excluded.packed`,
            )
            .bind(a.svc, stop, daytype, slot, a.crowd === 'high' ? 1 : 0),
        );
      }
    }
    if (stmts.length) await db.batch(stmts);
  } catch (err) {
    // A lost tally is nothing; a failed answer would be.
    console.error('crowd tally failed', err instanceof Error ? err.name : typeof err);
  }
}

export type CrowdRisk = (svc: string, stop: string, atMs: number) => number | null;

/** Share of sightings that were packed, for today's kind of day; null when too few. */
export async function loadCrowdRisk(db: D1Database, stops: string[], nowMs: number): Promise<CrowdRisk> {
  const table = new Map<string, number>();
  const unique = [...new Set(stops)].slice(0, 8);
  if (unique.length) {
    try {
      const { results } = await db
        .prepare(`SELECT svc, stop, slot, n, packed FROM crowd_stats WHERE daytype = ? AND n >= ? AND stop IN (${unique.map(() => '?').join(', ')})`)
        .bind(dayType(nowMs), MIN_SAMPLES, ...unique)
        .all<{ svc: string; stop: string; slot: number; n: number; packed: number }>();
      for (const r of results) table.set(`${r.svc}|${r.stop}|${r.slot}`, r.packed / r.n);
    } catch (err) {
      console.error('crowd lookup failed', err instanceof Error ? err.name : typeof err);
    }
  }
  return (svc, stop, atMs) => table.get(`${svc}|${stop}|${slotOf(atMs)}`) ?? null;
}

/** Cron: drop sightings older than the dedupe window. */
export async function pruneCrowdSeen(db: D1Database, nowMs: number): Promise<void> {
  await db.prepare('DELETE FROM crowd_seen WHERE day < ?').bind(sgtDate(nowMs - KEEP_SEEN_DAYS * 86_400_000)).run();
}
