/**
 * Upstream monitoring and housekeeping, run by the cron trigger.
 *
 * The NUS feed fails all at once when uNivUS ships a new version (code
 * 10009) or the proxy changes. Every client degrades to "live times
 * unavailable", which is honest but silent, so this emails the operator on
 * each change of state: once when it breaks, once when it recovers.
 */

import { KEEP_DAYS } from './outcomes.ts';
import type { Env } from './types.ts';
import { fetchArrivals } from './fms.ts';
import { fetchPublicArrivals, ltaConfigured } from './lta.ts';
import { GRAPH_PUBLIC } from './graph.ts';
import { KV_APP_VERSION, UpstreamRejected } from './auth.ts';
import { autoUpdateVersion, type AutoResult } from './appversion.ts';
import { calendarThrough, semesterSoon, termFrom, termName } from './calendar.ts';
import { loadCalendar, refreshCalendar } from './calendarsync.ts';
import { pruneCrowdSeen } from './crowd.ts';
import { ACCOUNT_TTL } from './accounts.ts';
import { type Notice, pushEnabled, remindUser } from './push.ts';
import { m, withLang } from './i18n.ts';
import { sgtDate, watchTrip } from './trip.ts';
import { refreshTable } from './ridetimes.ts';
import { sgt } from './config.ts';
import { isBeta } from './site.ts';
import { ensureRecorder } from './timelapse.ts';
import { logCronError } from './analytics.ts';

export interface UpstreamState {
  /** Confirmed state: it takes FAILS_TO_ALERT failed checks in a row to go down. */
  up: boolean;
  /** When the current state began, epoch ms. */
  since: number;
  /** The latest failure, when the last check failed. */
  reason: string | null;
  /** NUS's whole response to that failure, when it refused us outright. */
  detail?: string | null;
  /** What the automatic version update tried, when it could not fix it. */
  auto?: string | null;
  checkedAt: number;
  /** Failed checks in a row. */
  failures?: number;
  /** An alert that has not been delivered yet; retried every run until it is. */
  pending?: 'down' | 'up' | null;
}

const KEY = 'monitor:upstream';
const INCIDENTS_KEY = 'monitor:incidents';
/** Outages kept for the status page, newest first. */
export const INCIDENTS_KEPT = 20;

/**
 * A confirmed outage, as the public status page shows it: when, and the kind
 * of cause, never NUS's error text.
 */
export interface Incident {
  start: number;
  /** When the feed came back; null while it's still down. */
  end: number | null;
  /** 'version': NUS wants a newer uNivUS version string. 'feed': anything else. */
  cause: 'version' | 'feed';
}
const CALENDAR_KEY = 'monitor:calendar-alert';
/** The KV namespace in cloudflare.config.ts, for the fix commands in alerts
 *  (a test keeps the two in step). */
export const KV_NAMESPACE_ID = '1f88f570f6e04f78aa2888ee7aa78e6a';
export const UNIVUS_PLAY_URL = 'https://play.google.com/store/apps/details?id=sg.edu.nus.univus';
/** A stop served by several routes almost all day. */
export const PROBE_STOP = 'COM3';
/** Device tokens unused this long are expired by the cron. */
export const DEVICE_IDLE_MS = 90 * 86_400_000;
/** One bad check is often a blip (NUS answers some requests with a 400);
 *  two in a row, 15 minutes apart, is an outage. */
export const FAILS_TO_ALERT = 2;
/** Warn this long before calendar.json runs out. */
export const CALENDAR_WARN_DAYS = 45;

/** A JSON value kept in KV, or null when it's missing, unreadable or not JSON. */
async function readKvJson(env: Env, key: string): Promise<unknown> {
  const raw = await env.KV.get(key).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function readIncidents(env: Env): Promise<Incident[]> {
  const list = await readKvJson(env, INCIDENTS_KEY);
  return Array.isArray(list) ? (list as Incident[]) : [];
}

/** Opens an incident when the feed is confirmed down, closes it when it's back. */
async function recordIncident(env: Env, state: UpstreamState, nowMs: number): Promise<void> {
  const list = await readIncidents(env);
  if (!state.up) {
    const cause = /10009/.test(state.reason ?? '') ? 'version' : 'feed';
    list.unshift({ start: nowMs, end: null, cause });
  } else if (list[0] && list[0].end === null) {
    list[0].end = nowMs;
  } else {
    return;
  }
  await env.KV.put(INCIDENTS_KEY, JSON.stringify(list.slice(0, INCIDENTS_KEPT)));
}

/** The confirmed state changes at most every 15 minutes: each isolate reads it once a minute. */
const DOWN_MEMO_MS = 60_000;
const downMemo = new WeakMap<object, { at: number; since: number | null }>();

/** When the monitor confirmed the feed down, or null while it's up (or never checked). */
export async function feedDownSince(env: Env, nowMs: number): Promise<number | null> {
  if (!env.KV) return null;
  const kept = downMemo.get(env.KV);
  if (kept && nowMs - kept.at < DOWN_MEMO_MS && nowMs >= kept.at) return kept.since;
  const u = await readUpstream(env);
  const since = u && !u.up ? u.since : null;
  downMemo.set(env.KV, { at: nowMs, since });
  return since;
}

export async function readUpstream(env: Env): Promise<UpstreamState | null> {
  return (await readKvJson(env, KEY)) as UpstreamState | null;
}

/**
 * Probe the feed directly (bypassing the arrivals cache, so a stale cached
 * answer can't hide an outage) and record the result. Alerts on a change of
 * confirmed state, and not for the very first "up". An alert that fails to
 * send stays pending and is retried on the next run.
 */
export async function checkUpstream(
  env: Env,
  nowMs: number,
  probe: () => Promise<unknown> = () => fetchArrivals(env, PROBE_STOP, nowMs),
  fixVersion: (detail: string | null) => Promise<AutoResult> = (detail) => autoUpdateVersion(env, nowMs, detail, PROBE_STOP),
): Promise<{ state: UpstreamState; changed: boolean }> {
  let ok = true;
  let reason: string | null = null;
  let detail: string | null = null;
  let auto: string | null = null;
  let refusedVersion = false;
  const run = async () => {
    try {
      await probe();
      ok = true;
      reason = detail = null;
    } catch (err) {
      ok = false;
      reason = String((err as Error)?.message ?? err).slice(0, 300);
      refusedVersion = err instanceof UpstreamRejected && err.code === '10009';
      if (err instanceof UpstreamRejected && err.detail) {
        detail = err.detail;
        // Kept in the logs too: what a refusal says is the clue to what changed.
        console.log('upstream rejected', err.code, detail);
      }
    }
  };
  await run();

  // A new uNivUS release: find its version string and switch to it, then
  // check again. Fixed here, the outage is never confirmed, so the only
  // email is the one saying what changed.
  if (refusedVersion) {
    let result: AutoResult;
    try {
      result = await fixVersion(detail);
    } catch (err) {
      result = { status: 'failed', note: `the automatic update failed: ${(err as Error)?.message ?? err}` };
    }
    if (result.status === 'switched') {
      await switchedAlert(env, result).catch((e) => console.error('alert failed', (e as Error)?.name ?? 'error'));
      await run();
      if (!ok) auto = `switched to ${result.to} automatically, but the feed still fails`;
    } else {
      auto = result.note;
    }
  }

  const prev = await readUpstream(env);
  const failures = ok ? 0 : (prev?.failures ?? 0) + 1;
  const up = ok ? true : failures >= FAILS_TO_ALERT ? false : (prev?.up ?? true);
  const changed = !prev || prev.up !== up;
  let pending = prev?.pending ?? null;
  if (changed && (prev || !up)) pending = up ? 'up' : 'down';
  const state: UpstreamState = { up, since: changed ? nowMs : prev!.since, reason, detail, auto, checkedAt: nowMs, failures, pending };

  if (pending) {
    try {
      await alert(env, state, pending);
      state.pending = null;
    } catch (e) {
      console.error('alert failed', (e as Error)?.name ?? 'error');
    }
  }
  await env.KV.put(KEY, JSON.stringify(state));
  // Only on a change of confirmed state, so a KV write per outage, not per run.
  if (changed && (prev || !up)) {
    await recordIncident(env, state, nowMs).catch((e) => console.error('incident not recorded', (e as Error)?.name ?? 'error'));
  }
  return { state, changed };
}

/** What to do about a failure, from its upstream code. */
export function adviceFor(reason: string | null): string {
  if (!reason) return '';
  if (/10009/.test(reason)) {
    return [
      'uNivUS has a new release and the old version string is refused.',
      `Find the new versionName and versionCode (the release is at ${UNIVUS_PLAY_URL}), then from apps/api:`,
      `  pnpm exec cf kv keys put ${KV_APP_VERSION} --namespace-id ${KV_NAMESPACE_ID} --body univus_android_<versionName>_<versionCode>`,
      'It takes effect within a minute, with no deploy. The NEXTBUS_APP_VERSION secret is only the fallback while that key is unset.',
    ].join('\n');
  }
  if (/10008/.test(reason)) return 'The device id no longer matches the access token. Clear auth:session in KV and let it re-mint.';
  if (/10000|Invalid API KEY/i.test(reason)) return 'The app API keys were rejected; they may have been rotated in a new uNivUS build.';
  return 'Check `pnpm exec wrangler tail` and /health?probe=1.';
}

/**
 * Emails the operator; false, sending nothing, without email set up. Alerts
 * about the NUS feed and the calendar come from the stable Worker only: the
 * beta shares both, and one email is enough.
 */
async function mailOperator(env: Env, subject: string, text: string): Promise<boolean> {
  if (!env.EMAIL || !env.EMAIL_FROM || !env.ALERT_EMAIL || isBeta(env)) return false;
  await env.EMAIL.send({ from: { email: env.EMAIL_FROM, name: 'terminus' }, to: env.ALERT_EMAIL, subject, text });
  return true;
}

async function alert(env: Env, s: UpstreamState, kind: 'up' | 'down'): Promise<void> {
  const when = new Date(s.since).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const subject = kind === 'up' ? 'terminus: NUS bus feed recovered' : 'terminus: NUS bus feed is down';
  const text = kind === 'up'
    ? `The NUS bus feed is answering again as of ${when}. Live times are back.`
    : `The NUS bus feed stopped answering at ${when}.\n\nError: ${s.reason}\n\n${s.auto ? `Tried automatically: ${s.auto}.\n\n` : ''}${adviceFor(s.reason)}\n\nUntil then every answer says "live times unavailable".${s.detail ? `\n\nNUS's full response:\n${s.detail}` : ''}`;
  await mailOperator(env, subject, text);
}

async function switchedAlert(env: Env, r: Extract<AutoResult, { status: 'switched' }>): Promise<void> {
  const name = /univus_android_(.+)_\d+$/.exec(r.to)?.[1] ?? r.to;
  await mailOperator(
    env,
    `terminus: switched to uNivUS ${name} automatically`,
    [
      `NUS started refusing ${r.from || 'the old version string'}, so a new uNivUS is out. terminus found ${r.to}, NUS accepted it, and it is now in ${KV_APP_VERSION}.`,
      'Nothing to do. To undo it, from apps/api:',
      `  pnpm exec cf kv keys delete ${KV_APP_VERSION} --namespace-id ${KV_NAMESPACE_ID}`,
    ].join('\n\n'),
  );
}

/**
 * Delete expired sign-in links and requests, pairing codes, web sessions,
 * idle devices, and anonymous accounts nobody has used for 60 days.
 */
export async function housekeeping(db: D1Database, nowMs: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM magic_links WHERE expires < ?').bind(nowMs),
    db.prepare('DELETE FROM login_requests WHERE expires < ?').bind(nowMs),
    db.prepare('DELETE FROM users WHERE email IS NULL AND last_seen < ?').bind(nowMs - ACCOUNT_TTL.anonIdleMs),
    db.prepare('DELETE FROM pair_codes WHERE expires < ?').bind(nowMs),
    db.prepare("DELETE FROM sessions WHERE kind = 'web' AND expires < ?").bind(nowMs),
    db.prepare("DELETE FROM sessions WHERE kind = 'device' AND last_seen < ?").bind(nowMs - DEVICE_IDLE_MS),
    // Trip outcomes are kept KEEP_DAYS days.
    db.prepare('DELETE FROM trip_outcomes WHERE at < ?').bind(nowMs - KEEP_DAYS * 86_400_000),
  ]);
}

/**
 * Email once a week while the calendar is within CALENDAR_WARN_DAYS of
 * running out: the bundled calendar.json, or the newer copy the cron fetches
 * into KV (calendarsync.ts). Past its end imported classes fail open (every
 * week counts), which is survivable but wrong in recess and exams.
 */
export async function checkCalendar(env: Env, nowMs: number, through = calendarThrough()): Promise<boolean> {
  const daysLeft = Math.floor((Date.parse(`${through}T00:00:00Z`) - nowMs) / 86_400_000);
  if (daysLeft > CALENDAR_WARN_DAYS) return false;
  const last = Number(await env.KV.get(CALENDAR_KEY).catch(() => null)) || 0;
  if (nowMs - last < 7 * 86_400_000) return false;
  const sent = await mailOperator(
    env,
    'terminus: academic calendar data runs out soon',
    `The academic calendar covers dates up to ${through} (${daysLeft} days from now). After that, imported classes are shown every week, including recess and exams.\n\nThe Worker fetches the calendar itself every week, from NUSMods and data.gov.sg, so either NUSMods doesn't list the next academic year yet, or the fetch is failing (look for "cron calendar" in the Worker's logs).\n\nWhen NUSMods has the year, nothing else is needed. To bundle it as well:\n  python3 apps/api/scripts/fetch_calendar.py && pnpm run deploy`,
  );
  if (!sent) return false;
  await env.KV.put(CALENDAR_KEY, String(nowMs));
  return true;
}

/** From this hour (Singapore) each day, the cron starts the day's trip watching. */
export const ARM_FROM_HOUR = 6;
const ARMED_KEY = 'trips:armed';
/** Users armed per cron run (every 15 minutes), so one run never runs out
 *  of time partway: the next run carries on after the last one armed. */
const ARM_BATCH = 400;
/** Trip objects asked at once within a batch. */
const ARM_AT_ONCE = 20;

/**
 * Starts every push user's Trip object watching today's trips, once a day.
 * A Trip object only wakes (and pushes) after a request asks it to, and a
 * web app on the Home Screen makes none unless it's opened; the Android app
 * does from its background refresh. Asked here each morning, it works out
 * the card, wakes at the next change (time to go, the question), and keeps
 * going for the day; on a day without classes it just stops.
 */
export async function armTrips(env: Env, nowMs: number, batch = ARM_BATCH): Promise<number> {
  if (!env.DB || !env.TRIPS || !pushEnabled(env)) return 0;
  const today = sgtDate(nowMs);
  const hour = new Date(nowMs + 8 * 3_600_000).getUTCHours();
  if (hour < ARM_FROM_HOUR) return 0;
  // "2026-10-03" when today is done; "2026-10-03 <user id>" while it's under
  // way, after that user. (Before batches it was the date alone, which still reads as done.)
  const mark = (await env.KV.get(ARMED_KEY)) ?? '';
  if (mark === today) return 0;
  const after = mark.startsWith(`${today} `) ? mark.slice(today.length + 1) : '';
  const { results } = await env.DB.prepare('SELECT DISTINCT user_id FROM sessions WHERE push_token IS NOT NULL AND user_id > ? ORDER BY user_id LIMIT ?')
    .bind(after, batch)
    .all<{ user_id: string }>();
  for (let i = 0; i < results.length; i += ARM_AT_ONCE) {
    await Promise.all(results.slice(i, i + ARM_AT_ONCE).map((r) => watchTrip(env, r.user_id, nowMs, nowMs).catch(() => {})));
  }
  // A short batch was the last one.
  const done = results.length < batch;
  await env.KV.put(ARMED_KEY, done ? today : `${today} ${results[results.length - 1].user_id}`, { expirationTtl: 2 * 86_400 });
  return results.length;
}

const REMINDED_KEY = 'term:reminded';
/** Not before 10 in the morning, Singapore time. */
const REMIND_FROM_HOUR = 10;

/** The new semester's reminder, in both languages: the app shows its own. */
export function termNotice(term: { acadYear: string; semester: number }, start: string): Notice {
  const d = new Date(`${start}T00:00:00Z`);
  const words = () => ({ title: m().termSoonTitle(termName(term), m().shortDate(d.getUTCDay(), d.getUTCDate(), d.getUTCMonth())), body: m().termSoonBody });
  const en = withLang('en', words);
  const zh = withLang('zh', words);
  return { title: en.title, body: en.body, zhTitle: zh.title, zhBody: zh.body };
}

/**
 * The week before semester 1 or 2 starts: a push to everyone with a
 * timetable from an earlier semester, to import the new one. Not to anyone
 * who has already imported it, nor to anyone with no timetable at all. Once
 * per semester, in batches like armTrips; the KV mark is "<year> <sem>" when
 * done and "<year> <sem> <last user id>" while under way.
 */
export async function remindTerm(env: Env, nowMs: number, batch = ARM_BATCH): Promise<number> {
  if (!env.DB || !pushEnabled(env)) return 0;
  const soon = semesterSoon(nowMs);
  if (!soon || new Date(nowMs + 8 * 3_600_000).getUTCHours() < REMIND_FROM_HOUR) return 0;
  const id = `${soon.term.acadYear} ${soon.term.semester}`;
  const mark = (await env.KV.get(REMINDED_KEY)) ?? '';
  if (mark === id) return 0;
  const after = mark.startsWith(`${id} `) ? mark.slice(id.length + 1) : '';
  const { results } = await env.DB.prepare(
    'SELECT DISTINCT s.user_id AS user_id, p.json AS json FROM sessions s JOIN profiles p ON p.user_id = s.user_id WHERE s.push_token IS NOT NULL AND s.user_id > ? ORDER BY s.user_id LIMIT ?',
  )
    .bind(after, batch)
    .all<{ user_id: string; json: string }>();
  const both = termNotice(soon.term, soon.start);
  // A language chosen in Settings wins over each device's.
  const en: Notice = { ...both, zhTitle: both.title, zhBody: both.body };
  const zh: Notice = { title: both.zhTitle, body: both.zhBody, zhTitle: both.zhTitle, zhBody: both.zhBody };
  let sent = 0;
  const due: { userId: string; notice: Notice }[] = [];
  for (const r of results) {
    let p: { trips?: unknown[]; term?: { acadYear: string; semester: number } | null; lang?: string } = {};
    try {
      p = JSON.parse(r.json);
    } catch {
      continue;
    }
    if (!Array.isArray(p.trips) || !p.trips.length || termFrom(p.term, soon.start)) continue;
    due.push({ userId: r.user_id, notice: p.lang === 'en' ? en : p.lang === 'zh' ? zh : both });
  }
  for (let i = 0; i < due.length; i += ARM_AT_ONCE) {
    const n = await Promise.all(due.slice(i, i + ARM_AT_ONCE).map((u) => remindUser(env, u.userId, u.notice, nowMs).catch(() => 0)));
    sent += n.reduce((x, y) => x + y, 0);
  }
  const done = results.length < batch;
  await env.KV.put(REMINDED_KEY, done ? id : `${id} ${results[results.length - 1].user_id}`, { expirationTtl: 30 * 86_400 });
  return sent;
}

/** The public feed's state, as the cron last saw it. No alerts: the shuttle is the product; this is extra. */
export interface PublicFeedState {
  up: boolean;
  since: number;
  reason: string | null;
  checkedAt: number;
}

const PUBLIC_KEY = 'monitor:public';
/** The Central Library's shelter, which the 95 and 151 call at all day. */
export const PUBLIC_PROBE: [string, string] = ['CLB', '16181'];

export async function readPublicFeed(env: Env): Promise<PublicFeedState | null> {
  return (await readKvJson(env, PUBLIC_KEY)) as PublicFeedState | null;
}

/**
 * Probe LTA DataMall directly (past the cache) and record whether it
 * answered, for /status.json and /health. Nothing is done without the key.
 */
export async function checkPublicFeed(
  env: Env,
  nowMs: number,
  probe: () => Promise<unknown> = () => fetchPublicArrivals(env, GRAPH_PUBLIC, PUBLIC_PROBE[0], PUBLIC_PROBE[1], nowMs),
): Promise<PublicFeedState | null> {
  if (!ltaConfigured(env)) return null;
  let up = true;
  let reason: string | null = null;
  try {
    await probe();
  } catch (err) {
    up = false;
    reason = String((err as Error)?.message ?? err).slice(0, 300);
  }
  const prev = await readPublicFeed(env);
  const state: PublicFeedState = { up, since: prev && prev.up === up ? prev.since : nowMs, reason, checkedAt: nowMs };
  await env.KV.put(PUBLIC_KEY, JSON.stringify(state));
  if (!up) console.log('public feed down', reason);
  return state;
}

/** Each step on its own: a KV failure must not stop D1 cleanup, and the reverse. */
export async function runCron(env: Env, nowMs: number): Promise<void> {
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      console.error('cron', name, err instanceof Error ? err.message : String(err));
      // On the dashboard too, where a step that fails every run shows.
      logCronError(env, name);
    }
  };
  await step('upstream', () => checkUpstream(env, nowMs));
  await step('public feed', () => checkPublicFeed(env, nowMs));
  await step('calendar', async () => {
    await loadCalendar(env, nowMs);
    try {
      await refreshCalendar(env, nowMs);
    } finally {
      // Whether or not the refresh worked, warn if the calendar runs out soon.
      await checkCalendar(env, nowMs);
    }
  });
  if (env.DB) await step('housekeeping', () => housekeeping(env.DB!, nowMs));
  if (env.DB) await step('crowds', () => pruneCrowdSeen(env.DB!, nowMs));
  await step('trips', () => armTrips(env, nowMs));
  // Starts the day's timelapse recorder in the morning (it runs itself after that).
  await step('timelapse', () => ensureRecorder(env, nowMs));
  await step('term', () => remindTerm(env, nowMs));
  // Measured ride times: once a day, early, before the day's trips.
  if (env.DB && sgt(nowMs).minutes >= 4 * 60) await step('ride times', () => refreshTable(env, nowMs));
}
