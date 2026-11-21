import type { Env } from '../types.ts';
import { DEFAULT_PROFILE } from '../timetable/profile.ts';
import { analyticsEnabled, logSetting, type SettingRow } from './analytics.ts';
import { collecting } from './collect.ts';
import { sgtDate } from '../timetable/calendar.ts';

const DAY = 86_400_000;
const DONE_KEY = 'settings:day';

type Count = Omit<SettingRow, 'day'>;

const onOff = (v: unknown, fallback: boolean): string => ((typeof v === 'boolean' ? v : fallback) ? 'on' : 'off');
const some = (v: unknown): string => (Array.isArray(v) && v.length > 0 ? 'some' : 'none');
const word = (v: unknown, fallback: string): string => (typeof v === 'string' && /^[a-z0-9]{1,12}$/.test(v) ? v : fallback);

export function settingsOf(p: Record<string, unknown>): [string, string][] {
  const d = DEFAULT_PROFILE;
  const home = p.home as { stops?: unknown } | null | undefined;
  return [
    ['publicBuses', onOff(p.publicBuses, d.publicBuses)],
    ['fullBusMargin', onOff(p.fullBusMargin, d.fullBusMargin)],
    ['preferBus', onOff(p.preferBus, d.preferBus)],
    ['walkPace', word(p.walkPace, d.walkPace)],
    ['lang', word(p.lang, d.lang)],
    ['clock', word(p.clock, d.clock)],
    ['gapHours', String(typeof p.gapHours === 'number' ? p.gapHours : d.gapHours)],
    ['home', some(home?.stops)],
    ['timetable', some(p.trips)],
    ['manualClasses', some(p.manual)],
    ['favourites', some(p.places)],
    ['usualTimes', some(p.usual)],
    ['pinnedStops', some(p.pinnedStops)],
  ];
}

export function countSettings(profiles: Record<string, unknown>[]): Count[] {
  const counts = new Map<string, number>();
  for (const p of profiles) for (const [k, v] of settingsOf(p)) counts.set(`${k}\u0000${v}`, (counts.get(`${k}\u0000${v}`) ?? 0) + 1);
  return [...counts].map(([key, n]) => {
    const [setting, value] = key.split('\u0000');
    return { setting, value, n, of: profiles.length };
  });
}

export async function readSettings(db: D1Database, nowMs: number): Promise<Count[]> {
  const since = nowMs - 30 * DAY;
  const [profiles, push] = await db.batch([
    db.prepare('SELECT p.json FROM profiles p JOIN users u ON u.id = p.user_id WHERE u.last_seen > ?').bind(since),
    db
      .prepare(
        `SELECT CASE WHEN kind = 'web' THEN 'web' ELSE platform END AS app, SUM(push_token IS NOT NULL) AS n, COUNT(*) AS of
           FROM sessions WHERE last_seen > ? AND (kind = 'web' OR platform IN ('android', 'ios')) GROUP BY 1`,
      )
      .bind(since),
  ]);
  const parsed = ((profiles.results ?? []) as { json: string }[]).flatMap((r) => {
    try {
      const p = JSON.parse(r.json) as unknown;
      return p && typeof p === 'object' ? [p as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
  const pushRows = ((push.results ?? []) as { app: string; n: number | null; of: number }[]).map((r) => ({
    setting: 'notifications',
    value: r.app,
    n: r.n ?? 0,
    of: r.of,
  }));
  return [...countSettings(parsed), ...pushRows];
}

export async function recordSettings(env: Env, nowMs: number): Promise<boolean> {
  if (!env.DB || !analyticsEnabled(env) || !(await collecting(env, 'settings'))) return false;
  const today = sgtDate(nowMs);
  if ((await env.KV.get(DONE_KEY)) === today) return false;
  const day = sgtDate(nowMs - DAY);
  for (const row of await readSettings(env.DB, nowMs)) logSetting(env, { ...row, day });
  await env.KV.put(DONE_KEY, today, { expirationTtl: 2 * 86_400 });
  return true;
}
