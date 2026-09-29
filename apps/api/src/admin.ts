/**
 * The operator dashboard's data (/admin/stats, shown by apps/web/public/admin).
 * Operator only: the x-health-token header must match HEALTH_TOKEN.
 *
 * Counts come from D1 and KV. With ANALYTICS_TOKEN and CF_ACCOUNT_ID set it
 * also queries Analytics Engine for answers and errors per day; without them
 * those parts are null and the page says how to turn them on.
 */

import type { Env } from './types.ts';
import { readIncidents, readUpstream } from './monitor.ts';
import { summarize } from './feedback.ts';

const DAY = 86_400_000;

export function isOperator(env: Env, req: Request): boolean {
  const given = req.headers.get('x-health-token');
  return Boolean(env.HEALTH_TOKEN && given && timingSafeEqual(given, env.HEALTH_TOKEN));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type Count = { n: number };
const count = async (db: D1Database, sql: string, ...args: unknown[]) =>
  ((await db.prepare(sql).bind(...args).first<Count>())?.n ?? 0) as number;

export async function adminStats(env: Env, nowMs: number, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const db = env.DB;
  const [upstream, incidents, analytics] = await Promise.all([readUpstream(env), readIncidents(env), analyticsStats(env, fetchImpl)]);
  const out: Record<string, unknown> = {
    now: new Date(nowMs).toISOString(),
    feed: upstream ? { up: upstream.up, since: new Date(upstream.since).toISOString(), checkedAt: new Date(upstream.checkedAt).toISOString() } : null,
    incidents: incidents.slice(0, 5).map((i) => ({ start: new Date(i.start).toISOString(), end: i.end ? new Date(i.end).toISOString() : null, cause: i.cause })),
    analytics,
  };
  if (!db) return out;

  const d1 = nowMs - DAY;
  const d7 = nowMs - 7 * DAY;
  const d30 = nowMs - 30 * DAY;
  const [users, new7, new30, withTimetable, withHome, active1, active7, web7, keys, keysUsed7, fb7] = await Promise.all([
    count(db, 'SELECT COUNT(*) AS n FROM users'),
    count(db, 'SELECT COUNT(*) AS n FROM users WHERE created > ?', d7),
    count(db, 'SELECT COUNT(*) AS n FROM users WHERE created > ?', d30),
    count(db, "SELECT COUNT(*) AS n FROM profiles WHERE json_array_length(json, '$.trips') > 0"),
    count(db, "SELECT COUNT(*) AS n FROM profiles WHERE json_array_length(json, '$.home.stops') > 0"),
    // Active: an account with any session used in the window.
    count(db, 'SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE last_seen > ?', d1),
    count(db, 'SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE last_seen > ?', d7),
    count(db, "SELECT COUNT(*) AS n FROM sessions WHERE kind = 'web' AND last_seen > ?", d7),
    count(db, 'SELECT COUNT(*) AS n FROM api_keys'),
    count(db, 'SELECT COUNT(*) AS n FROM api_keys WHERE last_used > ?', d7),
    count(db, 'SELECT COUNT(*) AS n FROM feedback WHERE created > ?', d7),
  ]);
  const { results: devices } = await db
    .prepare(
      `SELECT COALESCE(platform, 'unknown') AS platform, COUNT(*) AS total,
              SUM(CASE WHEN last_seen > ? THEN 1 ELSE 0 END) AS active7
         FROM sessions WHERE kind = 'device' GROUP BY 1 ORDER BY total DESC`,
    )
    .bind(d7)
    .all<{ platform: string; total: number; active7: number }>();
  const { results: signups } = await db
    .prepare(
      // Per Singapore day, the last 30.
      `SELECT date((created + 8 * 3600000) / 1000, 'unixepoch') AS day, COUNT(*) AS n
         FROM users WHERE created > ? GROUP BY 1 ORDER BY 1`,
    )
    .bind(d30)
    .all<{ day: string; n: number }>();
  const { results: feedback } = await db
    .prepare(
      `SELECT f.id, f.created, f.kind, f.note, f.platform, f.app_version AS appVersion, f.context, u.email
         FROM feedback f JOIN users u ON u.id = f.user_id ORDER BY f.created DESC LIMIT 25`,
    )
    .all<{ id: string; created: number; kind: string; note: string; platform: string; appVersion: string | null; context: string | null; email: string }>();

  return {
    ...out,
    accounts: { total: users, new7d: new7, new30d: new30, withTimetable, withHome, active1d: active1, active7d: active7, webSessions7d: web7 },
    devices,
    signups,
    apiKeys: { total: keys, used7d: keysUsed7 },
    feedback: {
      last7d: fb7,
      latest: feedback.map((f) => ({
        id: f.id,
        created: new Date(f.created).toISOString(),
        kind: f.kind,
        note: f.note,
        platform: f.platform,
        appVersion: f.appVersion,
        email: f.email,
        answer: summarize(f.context),
        context: f.context ? JSON.parse(f.context) : null,
      })),
    },
  };
}

/** Answers, their quality, and errors per day for 14 days, from Analytics Engine's SQL API. */
async function analyticsStats(env: Env, fetchImpl: typeof fetch): Promise<Record<string, unknown> | null> {
  if (!env.ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) return null;
  const sql = async (q: string) => {
    const res = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.ANALYTICS_TOKEN}` },
      body: q,
    });
    if (!res.ok) throw new Error(`Analytics Engine answered ${res.status}`);
    return ((await res.json()) as { data: Record<string, unknown>[] }).data;
  };
  try {
    const [daily, quality, errors] = await Promise.all([
      // _sample_interval: each row may stand for several, at high volume.
      sql(`SELECT toDate(timestamp) AS day, blob1 AS kind, SUM(_sample_interval) AS n FROM terminus
           WHERE timestamp > NOW() - INTERVAL '14' DAY AND blob1 IN ('answer', 'error')
           GROUP BY day, kind ORDER BY day`),
      sql(`SELECT blob5 AS quality, SUM(_sample_interval) AS n FROM terminus
           WHERE timestamp > NOW() - INTERVAL '7' DAY AND blob1 = 'answer' GROUP BY quality ORDER BY n DESC`),
      sql(`SELECT blob2 AS route, SUM(_sample_interval) AS n FROM terminus
           WHERE timestamp > NOW() - INTERVAL '7' DAY AND blob1 = 'error' GROUP BY route ORDER BY n DESC LIMIT 10`),
    ]);
    return { daily, quality, errors };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
