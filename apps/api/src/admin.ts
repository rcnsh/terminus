/**
 * The operator dashboard's data (/admin/stats, shown by apps/web/public/admin).
 * Operator only: the x-health-token header holds HEALTH_TOKEN, or a session
 * from signing in with a passkey (passkey.ts).
 *
 * Counts come from D1 and KV. With ANALYTICS_TOKEN and CF_ACCOUNT_ID set it
 * also queries Analytics Engine for answers and errors per day, the daily
 * active counts and the apps' error reports; without them those parts are
 * null and the page says how to turn them on. `collect` is the switches for
 * what's collected (collect.ts), `eta` the arrival times scored (eta.ts).
 */

import type { Env } from './types.ts';
import { answering, answeringSince, readIncidents, readUpstream } from './monitor.ts';
import { BETTER_STOP, BETTER_STOP_TEXT, REASONS, summarize } from './feedback.ts';
import { sessionOk } from './passkey.ts';
import { aeSql } from './analytics.ts';
import { collectState } from './collect.ts';
import { etaSummary } from './eta.ts';

const DAY = 86_400_000;

/** HEALTH_TOKEN itself, or an operator session that hasn't run out. */
export async function isOperator(env: Env, req: Request, nowMs = Date.now()): Promise<boolean> {
  return holdsHealthToken(env, req) || (await sessionOk(env.HEALTH_TOKEN, req.headers.get('x-health-token'), nowMs));
}

/** HEALTH_TOKEN itself, which a session can't stand in for: adding a passkey needs it. */
export function holdsHealthToken(env: Env, req: Request): boolean {
  return sentToken(req, env.HEALTH_TOKEN);
}

/**
 * Whoever may read the timelapse days: the operator, or a holder of
 * TIMELAPSE_TOKEN, sent in the same header. That token opens /timelapse/*
 * and nothing else, so a machine that renders the videos (a VPS, unattended)
 * never holds the key to the dashboard, its reports and their emails.
 */
export async function canReadTimelapse(env: Env, req: Request, nowMs = Date.now()): Promise<boolean> {
  return sentToken(req, env.TIMELAPSE_TOKEN) || (await isOperator(env, req, nowMs));
}

/** The x-health-token header holds `token`; never true when the token is unset. */
function sentToken(req: Request, token: string | undefined): boolean {
  const given = req.headers.get('x-health-token');
  return Boolean(token && given && timingSafeEqual(given, token));
}

/**
 * `given` against the secret, in a time that depends only on the secret's
 * length: a wrong length is folded into the result rather than returned
 * early, so timing doesn't say how long the token is.
 */
export function timingSafeEqual(given: string, secret: string): boolean {
  let diff = given.length ^ secret.length;
  for (let i = 0; i < secret.length; i++) diff |= (given.charCodeAt(i) | 0) ^ secret.charCodeAt(i);
  return diff === 0;
}


export async function adminStats(env: Env, nowMs: number, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const db = env.DB;
  const [upstream, incidents, analytics, collect, eta] = await Promise.all([
    readUpstream(env),
    readIncidents(env),
    analyticsStats(env, fetchImpl),
    collectState(env),
    etaSummary(env, nowMs).catch((err) => ({ error: err instanceof Error ? err.message : String(err) })),
  ]);
  const out: Record<string, unknown> = {
    now: new Date(nowMs).toISOString(),
    feed: upstream ? { up: answering(upstream), since: new Date(answeringSince(upstream)).toISOString(), checkedAt: new Date(upstream.checkedAt).toISOString() } : null,
    incidents: incidents.slice(0, 5).map((i) => ({ start: new Date(i.start).toISOString(), end: i.end ? new Date(i.end).toISOString() : null, cause: i.cause })),
    analytics,
    collect,
    eta,
  };
  if (!db) return out;

  const d1 = nowMs - DAY;
  const d7 = nowMs - 7 * DAY;
  const d30 = nowMs - 30 * DAY;
  // One pass over each table, and every query in one round trip: the counts
  // read whole tables, so asking each its own question read them many times.
  // SUM of a comparison counts the rows where it's true (NULL counts none).
  const [u, p, s, k, f, o, dev, cli, sign, fb] = await db.batch([
    db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(created > ?1) AS new7, SUM(created > ?2) AS new30,
                SUM(email IS NULL) AS anonymous, SUM(email_added IS NOT NULL) AS upgraded,
                SUM(email_added > ?2) AS upgraded30, SUM(via = 'app' AND created > ?2) AS installs30
           FROM users`,
      )
      .bind(d7, d30),
    db.prepare(
      `SELECT SUM(json_array_length(json, '$.trips') > 0) AS withTimetable,
              SUM(json_array_length(json, '$.home.stops') > 0) AS withHome
         FROM profiles`,
    ),
    // Active: an account with any session used in the window.
    db
      .prepare(
        `SELECT COUNT(DISTINCT CASE WHEN last_seen > ?1 THEN user_id END) AS active1,
                COUNT(DISTINCT CASE WHEN last_seen > ?2 THEN user_id END) AS active7,
                SUM(kind = 'web' AND last_seen > ?2) AS web7
           FROM sessions`,
      )
      .bind(d1, d7),
    db.prepare('SELECT COUNT(*) AS total, SUM(last_used > ?) AS used7 FROM api_keys').bind(d7),
    db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE created > ?').bind(d7),
    // New installs (an app's first launch makes an account) that finished the in-app setup.
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM users u JOIN profiles p ON p.user_id = u.id
          WHERE u.via = 'app' AND u.created > ? AND EXISTS (SELECT 1 FROM json_each(p.json, '$.seen') WHERE value = 'onboarding')`,
      )
      .bind(d30),
    db
      .prepare(
        `SELECT COALESCE(platform, 'unknown') AS platform, COUNT(*) AS total,
                SUM(CASE WHEN last_seen > ? THEN 1 ELSE 0 END) AS active7
           FROM sessions WHERE kind = 'device' GROUP BY 1 ORDER BY total DESC`,
      )
      .bind(d7),
    db
      .prepare(
        // App versions in use: the x-terminus-client header of devices seen this week.
        `SELECT client, COUNT(*) AS n FROM sessions
          WHERE kind = 'device' AND client IS NOT NULL AND last_seen > ? GROUP BY 1 ORDER BY n DESC LIMIT 20`,
      )
      .bind(d7),
    db
      .prepare(
        // Per Singapore day, the last 30.
        `SELECT date((created + 8 * 3600000) / 1000, 'unixepoch') AS day, COUNT(*) AS n
           FROM users WHERE created > ? GROUP BY 1 ORDER BY 1`,
      )
      .bind(d30),
    db.prepare(
      `SELECT f.id, f.created, f.kind, f.reason, f.note, f.platform, f.app_version AS appVersion, f.context, f.reply_to AS replyTo, u.email
         FROM feedback f JOIN users u ON u.id = f.user_id ORDER BY f.created DESC LIMIT 25`,
    ),
  ]);
  const row = (r: D1Result) => (r.results?.[0] ?? {}) as Record<string, number | null>;
  const n = (v: number | null | undefined) => v ?? 0;
  const [users, profiles, sessions, apiKeys] = [row(u), row(p), row(s), row(k)];
  const devices = dev.results as Array<{ platform: string; total: number; active7: number }>;
  const clients = cli.results as Array<{ client: string; n: number }>;
  const signups = sign.results as Array<{ day: string; n: number }>;
  const feedback = fb.results as Array<{ id: string; created: number; kind: string; reason: string | null; note: string; platform: string; appVersion: string | null; context: string | null; replyTo: string | null; email: string | null }>;
  const [total, new7, new30, anonymous, upgraded, upgraded30, installs30] = [users.total, users.new7, users.new30, users.anonymous, users.upgraded, users.upgraded30, users.installs30].map(n);
  const [withTimetable, withHome] = [profiles.withTimetable, profiles.withHome].map(n);
  const [active1, active7, web7] = [sessions.active1, sessions.active7, sessions.web7].map(n);
  const [keys, keysUsed7] = [apiKeys.total, apiKeys.used7].map(n);
  const fb7 = n(row(f).n);
  const onboarded30 = n(row(o).n);

  return {
    ...out,
    accounts: { total, new7d: new7, new30d: new30, withTimetable, withHome, active1d: active1, active7d: active7, webSessions7d: web7, anonymous },
    apps: { installs30d: installs30, onboarded30d: onboarded30, addedEmail: upgraded, addedEmail30d: upgraded30 },
    devices,
    clients,
    signups,
    apiKeys: { total: keys, used7d: keysUsed7 },
    feedback: {
      last7d: fb7,
      latest: feedback.map((f) => ({
        id: f.id,
        created: new Date(f.created).toISOString(),
        kind: f.kind,
        // In words: the dashboard is the operator's, in English.
        reason: f.reason ? (f.reason === BETTER_STOP ? BETTER_STOP_TEXT : (REASONS[f.reason as keyof typeof REASONS] ?? f.reason)) : null,
        note: f.note,
        platform: f.platform,
        appVersion: f.appVersion,
        email: f.email,
        replyTo: f.replyTo,
        answer: summarize(f.context),
        context: f.context ? JSON.parse(f.context) : null,
      })),
    },
  };
}

/** Answers, their quality, and errors per day for 14 days, the timelapse
 *  recorder's polls by what each cost NUS (logPoll), the daily active counts
 *  (usage.ts) and the apps' error reports (apperrors.ts), from Analytics
 *  Engine's SQL API. */
async function analyticsStats(env: Env, fetchImpl: typeof fetch): Promise<Record<string, unknown> | null> {
  if (!env.ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) return null;
  const sql = (q: string) => aeSql(env, q, fetchImpl);
  const dataset = env.AE_DATASET || 'terminus';
  try {
    const [daily, quality, errors, timelapse, active, appErrors, appErrorVersions] = await Promise.all([
      // _sample_interval: each row may stand for several, at high volume.
      sql(`SELECT toDate(timestamp) AS day, blob1 AS kind, SUM(_sample_interval) AS n FROM ${dataset}
           WHERE timestamp > NOW() - INTERVAL '14' DAY AND blob1 IN ('answer', 'error')
           GROUP BY day, kind ORDER BY day`),
      sql(`SELECT blob5 AS quality, SUM(_sample_interval) AS n FROM ${dataset}
           WHERE timestamp > NOW() - INTERVAL '7' DAY AND blob1 = 'answer' GROUP BY quality ORDER BY n DESC`),
      sql(`SELECT blob2 AS route, SUM(_sample_interval) AS n FROM ${dataset}
           WHERE timestamp > NOW() - INTERVAL '7' DAY AND blob1 = 'error' GROUP BY route ORDER BY n DESC LIMIT 10`),
      sql(`SELECT toDate(timestamp) AS day, blob2 AS outcome, SUM(_sample_interval) AS n FROM ${dataset}
           WHERE timestamp > NOW() - INTERVAL '14' DAY AND blob1 = 'timelapse' GROUP BY day, outcome ORDER BY day`),
      // One row per day and name: max() in case a day was ever counted twice.
      sql(`SELECT blob4 AS day, blob2 AS scope, blob3 AS name, max(double1) AS d1, max(double2) AS d7, max(double3) AS d30 FROM ${dataset}
           WHERE timestamp > NOW() - INTERVAL '31' DAY AND blob1 = 'active' GROUP BY day, scope, name ORDER BY day`),
      sql(`SELECT blob4 AS fingerprint, blob2 AS platform, blob5 AS type, blob6 AS message, blob7 AS stack,
                  SUM(_sample_interval) AS n, SUM(_sample_interval * double2) AS fatal, max(timestamp) AS last FROM ${dataset}
           WHERE timestamp > NOW() - INTERVAL '7' DAY AND blob1 = 'apperror'
           GROUP BY fingerprint, platform, type, message, stack ORDER BY n DESC LIMIT 25`),
      sql(`SELECT blob4 AS fingerprint, blob3 AS version, blob8 AS os, SUM(_sample_interval) AS n FROM ${dataset}
           WHERE timestamp > NOW() - INTERVAL '7' DAY AND blob1 = 'apperror'
           GROUP BY fingerprint, version, os ORDER BY n DESC LIMIT 200`),
    ]);
    return { daily, quality, errors, timelapse, active, appErrors: groupErrors(appErrors, appErrorVersions) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The week's error reports by fingerprint, most first: one message and
 * stack for each (the commonest, as reports of one crash vary in their
 * numbers), and the versions and systems it came from.
 */
export function groupErrors(rows: Record<string, unknown>[], versions: Record<string, unknown>[]): Record<string, unknown>[] {
  const out = new Map<string, { fingerprint: string; platform: string; type: string; message: string; stack: string; n: number; fatal: number; last: string; top: number; versions: { version: string; os: string; n: number }[] }>();
  for (const r of rows) {
    const fp = String(r.fingerprint);
    const n = Number(r.n);
    const e = out.get(fp);
    const last = String(r.last);
    if (!e) {
      out.set(fp, { fingerprint: fp, platform: String(r.platform), type: String(r.type), message: String(r.message), stack: String(r.stack), n, fatal: Number(r.fatal), last, top: n, versions: [] });
      continue;
    }
    e.n += n;
    e.fatal += Number(r.fatal);
    if (last > e.last) e.last = last;
    if (n > e.top) Object.assign(e, { message: String(r.message), stack: String(r.stack), top: n });
  }
  for (const v of versions) out.get(String(v.fingerprint))?.versions.push({ version: String(v.version), os: String(v.os), n: Number(v.n) });
  return [...out.values()].sort((a, b) => b.n - a.n).map(({ top: _top, ...e }) => e);
}
