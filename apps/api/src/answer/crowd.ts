import type { StopArrivals } from '../types.ts';
import { termDay, sgtDate } from '../timetable/calendar.ts';
import { sgt } from '../config.ts';
import { Lru, perScope } from '../memo.ts';

export type DayType = 'term' | 'exam' | 'break' | 'sat' | 'sun';

const NEAR_S = 120;
export const MIN_SAMPLES = 10;
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

export const slotOf = (ms: number) => Math.floor(sgt(ms).minutes / 30);

const sentFrom = perScope(() => new Lru<string, true>(5_000));

export async function recordCrowds(db: D1Database, byStop: Map<string, StopArrivals>, nowMs: number): Promise<void> {
  try {
    const sent = sentFrom(db);
    const daytype = dayType(nowMs);
    const stmts: D1PreparedStatement[] = [];
    const keys: string[] = [];
    for (const [stop, sa] of byStop) {
      if (!sa.available || sa.stale) continue;
      for (const a of sa.arrivals) {
        if (!a.plate || !a.crowd || a.etaS == null || a.etaS > NEAR_S) continue;
        const at = sa.fetchedAt + a.etaS * 1000;
        const slot = slotOf(at);
        const key = `${a.plate}|${stop}|${sgtDate(at)}|${slot}`;
        if (sent.get(key) || keys.includes(key)) continue;
        keys.push(key);
        stmts.push(
          db
            .prepare('INSERT OR IGNORE INTO crowd_seen (plate, stop, day, slot) VALUES (?, ?, ?, ?)')
            .bind(a.plate, stop, sgtDate(at), slot),
          db
            .prepare(
              `INSERT INTO crowd_stats (svc, stop, daytype, slot, n, packed) SELECT ?, ?, ?, ?, 1, ? WHERE changes() = 1
               ON CONFLICT (svc, stop, daytype, slot) DO UPDATE SET n = n + 1, packed = packed + excluded.packed`,
            )
            .bind(a.svc, stop, daytype, slot, a.crowd === 'high' ? 1 : 0),
        );
      }
    }
    if (!stmts.length) return;
    await db.batch(stmts);
    for (const k of keys) sent.set(k, true);
  } catch (err) {
    console.error('crowd tally failed', err instanceof Error ? err.name : typeof err);
  }
}

export type CrowdRisk = (svc: string, stop: string, atMs: number) => number | null;

export async function loadCrowdRisk(db: D1Database, stops: string[], nowMs: number): Promise<CrowdRisk> {
  const table = new Map<string, number>();
  const unique = [...new Set(stops)].slice(0, 8);
  if (unique.length) {
    try {
      const { results } = await db
        .prepare(
          `SELECT svc, stop, slot, n, packed FROM crowd_stats WHERE daytype = ? AND n >= ? AND stop IN (${unique.map(() => '?').join(', ')})`,
        )
        .bind(dayType(nowMs), MIN_SAMPLES, ...unique)
        .all<{ svc: string; stop: string; slot: number; n: number; packed: number }>();
      for (const r of results) table.set(`${r.svc}|${r.stop}|${r.slot}`, r.packed / r.n);
    } catch (err) {
      console.error('crowd lookup failed', err instanceof Error ? err.name : typeof err);
    }
  }
  return (svc, stop, atMs) => table.get(`${svc}|${stop}|${slotOf(atMs)}`) ?? null;
}

export async function pruneCrowdSeen(db: D1Database, nowMs: number): Promise<void> {
  await db
    .prepare('DELETE FROM crowd_seen WHERE day < ?')
    .bind(sgtDate(nowMs - KEEP_SEEN_DAYS * 86_400_000))
    .run();
}
