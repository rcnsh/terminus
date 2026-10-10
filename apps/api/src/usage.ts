/**
 * How many accounts use terminus, day by day, for the dashboard: once a
 * Singapore day the cron counts the accounts whose sessions were used in
 * the last 1, 7 and 30 days, in all, by app and by app version, and writes
 * the numbers to Analytics Engine (analytics.ts logActive).
 *
 * Nothing new is kept about anyone: the counts come from `last_seen` on the
 * sessions D1 already has (rewritten at most hourly, accounts.ts touchMs),
 * and only the totals leave D1. No install id, nothing per person, so a day
 * can't be joined to the next. D1 alone can only say "now"; the rows are
 * what lets the dashboard draw the last month.
 *
 * Off unless the operator turns `active` on (collect.ts).
 */

import type { Env } from './types.ts';
import { collecting } from './collect.ts';
import { analyticsEnabled, logActive, type ActiveRow } from './analytics.ts';
import { sgtDate } from './calendar.ts';

const DAY = 86_400_000;
const DONE_KEY = 'usage:day';
/** Versions counted, most used first: more is noise. */
const MAX_VERSIONS = 20;

type Counts = { d1: number | null; d7: number | null; d30: number | null };

/** The counts at [nowMs], from D1: one row in all, then per app, then per version. */
export async function countActive(db: D1Database, nowMs: number): Promise<Omit<ActiveRow, 'day'>[]> {
  const [d1, d7, d30] = [nowMs - DAY, nowMs - 7 * DAY, nowMs - 30 * DAY];
  // The app a session is: the website, or the platform a device said it is.
  const app = `CASE WHEN kind = 'web' THEN 'web' ELSE COALESCE(platform, 'unknown') END`;
  const windows = `COUNT(DISTINCT CASE WHEN last_seen > ?1 THEN user_id END) AS d1,
                   COUNT(DISTINCT CASE WHEN last_seen > ?2 THEN user_id END) AS d7,
                   COUNT(DISTINCT CASE WHEN last_seen > ?3 THEN user_id END) AS d30`;
  const [all, apps, keys, versions] = await db.batch([
    db.prepare(`SELECT ${windows} FROM sessions WHERE last_seen > ?3`).bind(d1, d7, d30),
    db.prepare(`SELECT ${app} AS name, ${windows} FROM sessions WHERE last_seen > ?3 GROUP BY 1`).bind(d1, d7, d30),
    // API keys are their own way in; counted as keys used, not accounts.
    db.prepare('SELECT SUM(last_used > ?1) AS d1, SUM(last_used > ?2) AS d7, SUM(last_used > ?3) AS d30 FROM api_keys').bind(d1, d7, d30),
    // Devices, not accounts: one account can run two versions at once.
    db
      .prepare(
        `SELECT client AS name, SUM(last_seen > ?1) AS d1, SUM(last_seen > ?2) AS d7, COUNT(*) AS d30 FROM sessions
          WHERE kind = 'device' AND client IS NOT NULL AND last_seen > ?3 GROUP BY 1 ORDER BY d7 DESC LIMIT ${MAX_VERSIONS}`,
      )
      .bind(d1, d7, d30),
  ]);
  const n = (c: Counts) => ({ d1: c.d1 ?? 0, d7: c.d7 ?? 0, d30: c.d30 ?? 0 });
  const rows = (r: D1Result) => (r.results ?? []) as Array<Counts & { name: string }>;
  const key = n((keys.results?.[0] ?? {}) as Counts);
  return [
    { scope: 'all', name: 'all', ...n((all.results?.[0] ?? {}) as Counts) },
    ...rows(apps).map((r) => ({ scope: 'app' as const, name: r.name, ...n(r) })),
    ...(key.d30 ? [{ scope: 'app' as const, name: 'api', ...key }] : []),
    ...rows(versions).map((r) => ({ scope: 'version' as const, name: r.name, ...n(r) })),
  ];
}

/**
 * The cron's step: once a Singapore day, the first run after midnight, the
 * counts for the day just ended. A failed run tries again next time; one
 * that worked marks the day, so a day is never counted twice.
 */
export async function recordActive(env: Env, nowMs: number): Promise<boolean> {
  if (!env.DB || !analyticsEnabled(env) || !(await collecting(env, 'active'))) return false;
  const today = sgtDate(nowMs);
  if ((await env.KV.get(DONE_KEY)) === today) return false;
  // Named after the day the last 24 hours mostly were.
  const day = sgtDate(nowMs - DAY);
  for (const row of await countActive(env.DB, nowMs)) logActive(env, { ...row, day });
  await env.KV.put(DONE_KEY, today, { expirationTtl: 2 * 86_400 });
  return true;
}
