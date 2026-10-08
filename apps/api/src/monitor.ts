/**
 * Upstream monitoring and housekeeping, run by the cron trigger.
 *
 * The NUS feed fails all at once when uNivUS ships a new version (code
 * 10009) or the proxy changes. Every client degrades to "live times
 * unavailable", which is honest but silent, so this emails the operator on
 * each change of state: once when it breaks, once when it recovers.
 */

import { KEEP_DAYS } from './outcomes.ts';
import { FEEDBACK_KEEP_DAYS } from './feedback.ts';
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
import { clearTrip, sgtDate, watchTrip } from './trip.ts';
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
  /** Good checks in a row: it takes OKS_TO_RECOVER to come back up. */
  oks?: number;
  /** The first of those good checks, epoch ms: when the feed came back. */
  okSince?: number | null;
  /** An alert that has not been delivered yet; retried every run until it is. */
  pending?: 'down' | 'up' | null;
}

const KEY = 'monitor:upstream';
/** "<since> <kind>" of the last alert delivered. Its own key, as KV takes one
 *  write a second to a key, and the state was saved just before the send. */
const ALERTED_KEY = 'monitor:alerted';
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
/** And two good ones in a row to be back, so a feed that answers every other
 *  check stays down rather than emailing "down" and "up" by turns. */
export const OKS_TO_RECOVER = 2;
/** How long an operator email may take to send. */
export const MAIL_TIMEOUT_MS = 15_000;
/** Warn this long before calendar.json runs out. */
export const CALENDAR_WARN_DAYS = 45;

/** A JSON value kept in KV, or null when it's missing or not JSON. A failed
 *  read throws: the monitor must not take "KV is down" for "never checked". */
async function getKvJson(env: Env, key: string): Promise<unknown> {
  const raw = await env.KV.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** The same for readers that only show it (the status page, the card): null on any failure. */
const readKvJson = (env: Env, key: string): Promise<unknown> => getKvJson(env, key).catch(() => null);

const asIncidents = (list: unknown): Incident[] => (Array.isArray(list) ? (list as Incident[]) : []);

export async function readIncidents(env: Env): Promise<Incident[]> {
  return asIncidents(await readKvJson(env, INCIDENTS_KEY));
}

/**
 * Brings the incident list in line with the confirmed state: an open
 * incident while the feed is down, none once it's back. Checked every run
 * and written only when something changes, so an earlier failed write is
 * put right on the next run. A failed read throws rather than writing over
 * the history.
 */
async function recordIncident(env: Env, state: UpstreamState, nowMs: number): Promise<void> {
  const list = asIncidents(await getKvJson(env, INCIDENTS_KEY));
  const open = list[0] && list[0].end === null ? list[0] : null;
  if (state.up) {
    if (!open) return;
    open.end = Math.max(open.start, Math.min(state.since, nowMs));
  } else {
    // The outage under way is the one that started when it was confirmed.
    if (open && open.start === state.since) return;
    // An older one left open (its close was never saved) ended by then.
    if (open) open.end = Math.max(open.start, state.since);
    const cause = /10009/.test(state.reason ?? '') ? 'version' : 'feed';
    list.unshift({ start: state.since, end: null, cause });
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

/** What /status.json and /health read: the cron's records, which change at most every 15 minutes. */
export interface StatusRecords {
  upstream: UpstreamState | null;
  incidents: Incident[];
  publicFeed: PublicFeedState | null;
}

const statusMemo = new WeakMap<object, { at: number; records: StatusRecords }>();

/**
 * The cron's records, read from KV at most once a minute per isolate (as
 * feedDownSince is): /status.json is public and polled, and three KV reads a
 * request cost more than a minute's lag behind a 15-minute check.
 */
export async function statusRecords(env: Env, nowMs: number): Promise<StatusRecords> {
  const kept = statusMemo.get(env.KV);
  if (kept && nowMs - kept.at < DOWN_MEMO_MS && nowMs >= kept.at) return kept.records;
  const [upstream, incidents, publicFeed] = await Promise.all([readUpstream(env), readIncidents(env), readPublicFeed(env)]);
  const records = { upstream, incidents, publicFeed };
  if (env.KV) statusMemo.set(env.KV, { at: nowMs, records });
  return records;
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
  // Read first, and a failed read stops the check: taken as "never checked",
  // it would close nothing, or mark the feed up in the middle of an outage.
  const prev = (await getKvJson(env, KEY)) as UpstreamState | null;
  // Unreadable, the pending alert goes again: one email too many beats none.
  const delivered = prev?.pending ? await env.KV.get(ALERTED_KEY).catch(() => null) : null;
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

  const failures = ok ? 0 : (prev?.failures ?? 0) + 1;
  const oks = ok ? (prev?.oks ?? 0) + 1 : 0;
  const okSince = ok ? (prev?.oks && prev.okSince ? prev.okSince : nowMs) : null;
  const was = prev?.up ?? true;
  const up = was ? failures < FAILS_TO_ALERT : oks >= OKS_TO_RECOVER;
  const changed = !prev || prev.up !== up;
  let pending = prev?.pending ?? null;
  if (pending && delivered === `${prev!.since} ${pending}`) pending = null;
  if (changed && (prev || !up)) pending = up ? 'up' : 'down';
  // Back up, it has been since the first of the good checks that confirmed
  // it, not the last: the outage ends there, on the status page and in the email.
  const since = !changed ? prev!.since : up && okSince ? okSince : nowMs;
  const state: UpstreamState = { up, since, reason, detail, auto, checkedAt: nowMs, failures, oks, okSince, pending };

  // Saved before the email goes, so a KV write that keeps failing can't send
  // the same email every run; it's sent once the state with it pending is kept.
  // The state is written once a run: delivery is noted under ALERTED_KEY, and
  // the next run clears pending from it.
  await env.KV.put(KEY, JSON.stringify(state));
  if (pending) {
    try {
      await alert(env, state, pending);
      state.pending = null;
    } catch (e) {
      console.error('alert failed', (e as Error)?.name ?? 'error');
    }
    // Should this write fail, the email goes once more next run: better than none.
    if (!state.pending) {
      await env.KV.put(ALERTED_KEY, `${state.since} ${pending}`, { expirationTtl: 30 * 86_400 })
        .catch((e) => console.error('alert not marked sent', (e as Error)?.name ?? 'error'));
    }
  }
  // Every run, not only on a change, so an incident whose write failed is
  // opened or closed on the next; it writes only when something changes.
  if (prev || !up) {
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
  const send = env.EMAIL.send({ from: { email: env.EMAIL_FROM, name: 'terminus' }, to: env.ALERT_EMAIL, subject, text });
  // Bounded, so a send that hangs can't hold up the rest of the cron. Timed
  // out, it counts as failed: an alert stays pending and goes again next run.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('email timed out')), MAIL_TIMEOUT_MS);
  });
  try {
    await Promise.race([send, late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
 * Delete expired sign-in links and requests and pairing codes. With `daily`,
 * also expired web sessions, idle devices, anonymous accounts nobody has
 * used for 60 days, and trip history and reports past their time. With
 * `env`, each deleted account's trip state goes too, as when an account is
 * deleted by hand, rather than at midnight.
 */
export async function housekeeping(db: D1Database, nowMs: number, daily = true, env?: Env): Promise<void> {
  // Small tables of short-lived codes: every run, so they don't pile up.
  const stmts = [
    db.prepare('DELETE FROM magic_links WHERE expires < ?').bind(nowMs),
    db.prepare('DELETE FROM login_requests WHERE expires < ?').bind(nowMs),
    db.prepare('DELETE FROM pair_codes WHERE expires < ?').bind(nowMs),
  ];
  // These read every row of large tables, and their limits are counted in
  // days, so once a day is enough. Sign-in already refuses an expired session.
  if (daily) {
    stmts.push(
      // The planner prefers the UNIQUE email index, which reads every anonymous account.
      db.prepare('DELETE FROM users INDEXED BY users_anon_idle WHERE email IS NULL AND last_seen < ? RETURNING id').bind(nowMs - ACCOUNT_TTL.anonIdleMs),
      db.prepare("DELETE FROM sessions WHERE kind = 'web' AND expires < ?").bind(nowMs),
      db.prepare("DELETE FROM sessions WHERE kind = 'device' AND last_seen < ?").bind(nowMs - DEVICE_IDLE_MS),
      // Trip outcomes are kept KEEP_DAYS days.
      db.prepare('DELETE FROM trip_outcomes WHERE at < ?').bind(nowMs - KEEP_DAYS * 86_400_000),
      // Reports are kept FEEDBACK_KEEP_DAYS.
      db.prepare('DELETE FROM feedback WHERE created < ?').bind(nowMs - FEEDBACK_KEEP_DAYS * 86_400_000),
    );
  }
  const out = await db.batch(stmts);
  if (!daily || !env) return;
  const ids = ((out[3]?.results ?? []) as Array<{ id: string }>).map((r) => r.id);
  for (let i = 0; i < ids.length; i += ARM_AT_ONCE) await Promise.all(ids.slice(i, i + ARM_AT_ONCE).map((id) => clearTrip(env, id)));
}

const SWEPT_KEY = 'housekeeping:day';

/** Whether today's (Singapore) daily cleanup is still to do. A KV failure says yes: a second sweep is harmless. */
async function sweepDue(env: Env, nowMs: number): Promise<boolean> {
  return (await env.KV.get(SWEPT_KEY).catch(() => null)) !== sgtDate(nowMs);
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
const ARM_RETRY_KEY = 'trips:retry';
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
  // Users whose Trip object didn't take the request, asked again each run
  // until it does: "<date> <id> <id> ...".
  const kept = (await env.KV.get(ARM_RETRY_KEY)) ?? '';
  const left = kept.startsWith(`${today} `) ? kept.slice(today.length + 1).split(' ') : [];
  const retry = left.slice(0, batch);
  if (mark === today && !retry.length) return 0;
  const after = mark.startsWith(`${today} `) ? mark.slice(today.length + 1) : '';
  const { results } = mark === today
    ? { results: [] as { user_id: string }[] }
    : await env.DB.prepare('SELECT DISTINCT user_id FROM sessions WHERE push_token IS NOT NULL AND user_id > ? ORDER BY user_id LIMIT ?')
        .bind(after, batch)
        .all<{ user_id: string }>();
  const users = [...retry, ...results.map((r) => r.user_id)];
  const failed: string[] = [];
  for (let i = 0; i < users.length; i += ARM_AT_ONCE) {
    const some = users.slice(i, i + ARM_AT_ONCE);
    const took = await Promise.all(some.map((id) => watchTrip(env, id, nowMs, nowMs).catch(() => false)));
    some.forEach((id, j) => took[j] || failed.push(id));
  }
  if (mark !== today) {
    // A short batch was the last one.
    const done = results.length < batch;
    await env.KV.put(ARMED_KEY, done ? today : `${today} ${results[results.length - 1].user_id}`, { expirationTtl: 2 * 86_400 });
  }
  if (failed.length || kept) {
    const keep = [...new Set([...failed, ...left.slice(batch)])].slice(0, ARM_BATCH);
    if (keep.length) await env.KV.put(ARM_RETRY_KEY, `${today} ${keep.join(' ')}`, { expirationTtl: 86_400 });
    else await env.KV.delete(ARM_RETRY_KEY);
    if (failed.length) console.error('trips not armed', failed.length);
  }
  return users.length - failed.length;
}

const REMINDED_KEY = 'term:reminded';
/** Users whose reminder reached no device, asked again on later runs:
 *  `{ term, run, users: [[user id, tries]] }`. Its own key, as KV takes one
 *  write a second to a key and the mark is written before the sends. */
const REMIND_RETRY_KEY = 'term:retry';
/** Runs a failed reminder is tried again (two hours of the cron), so push
 *  broken for a while still reaches them, and a token that never works stops. */
const REMIND_TRIES = 8;
/** A user due a reminder: id, the reminder in the language their profile asks for, tries so far. */
type Due = [string, Notice, number];
/** Retried users' profiles read at once (D1 binds at most 100 values). */
const PROFILES_AT_ONCE = 50;
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
 * The reminder a profile is due now, in the words its language setting asks
 * for (both when it follows the device), or null: no semester starting
 * within the week, no timetable, or the new one already imported. The cron
 * pushes it; GET /me/notice gives it to an app that was pushed only its kind.
 */
export function termNoticeFor(p: { trips?: unknown; term?: { acadYear: string; semester: number } | null; lang?: unknown } | null, nowMs: number): Notice | null {
  const soon = semesterSoon(nowMs);
  if (!soon || !p || !Array.isArray(p.trips) || !p.trips.length || termFrom(p.term, soon.start)) return null;
  const both = termNotice(soon.term, soon.start);
  // A language chosen in Settings wins over each device's.
  if (p.lang === 'en') return { ...both, zhTitle: both.title, zhBody: both.body };
  if (p.lang === 'zh') return { title: both.zhTitle, body: both.zhBody, zhTitle: both.zhTitle, zhBody: both.zhBody };
  return both;
}

/**
 * The week before semester 1 or 2 starts: a push to everyone with a
 * timetable from an earlier semester, to import the new one. Not to anyone
 * who has already imported it, nor to anyone with no timetable at all. Once
 * per semester, in batches like armTrips; the KV mark is "<year> <sem>" when
 * done and "<year> <sem> <last user id>" while under way, then "#<run>".
 * Users no device took are kept under REMIND_RETRY_KEY, stamped with the
 * run, and tried again on later runs.
 */
export async function remindTerm(env: Env, nowMs: number, batch = ARM_BATCH): Promise<number> {
  if (!env.DB || !pushEnabled(env)) return 0;
  const soon = semesterSoon(nowMs);
  if (!soon || new Date(nowMs + 8 * 3_600_000).getUTCHours() < REMIND_FROM_HOUR) return 0;
  const id = `${soon.term.acadYear} ${soon.term.semester}`;
  const [mark, markRun] = ((await env.KV.get(REMINDED_KEY)) ?? '').split('#');
  let retry: { term: string; run: number; users: [string, number][] } | null = null;
  try {
    retry = JSON.parse((await env.KV.get(REMIND_RETRY_KEY)) ?? 'null');
  } catch {
    retry = null;
  }
  // Only the list the last run left counts. One whose run could not save it
  // is older, and holds users that run has already reached.
  if (retry?.term !== id || !Array.isArray(retry.users) || String(retry.run) !== markRun) retry = null;
  if (mark === id && !retry) return 0;
  const after = mark.startsWith(`${id} `) ? mark.slice(id.length + 1) : '';
  const { results } = mark === id
    ? { results: [] as { user_id: string; json: string }[] }
    : await env.DB.prepare(
        'SELECT DISTINCT s.user_id AS user_id, p.json AS json FROM sessions s JOIN profiles p ON p.user_id = s.user_id WHERE s.push_token IS NOT NULL AND s.user_id > ? ORDER BY s.user_id LIMIT ?',
      )
        .bind(after, batch)
        .all<{ user_id: string; json: string }>();
  // Retried users are read again, so one who has imported the new semester
  // since, or changed language, is skipped or told in the new one.
  const triesOf = new Map(retry?.users ?? []);
  const ids = [...triesOf.keys()];
  const rows: { user_id: string; json: string; tries: number }[] = [];
  for (let i = 0; i < ids.length; i += PROFILES_AT_ONCE) {
    const some = ids.slice(i, i + PROFILES_AT_ONCE);
    const { results: got } = await env.DB.prepare(`SELECT user_id, json FROM profiles WHERE user_id IN (${some.map(() => '?').join(', ')})`)
      .bind(...some)
      .all<{ user_id: string; json: string }>();
    for (const r of got) rows.push({ ...r, tries: triesOf.get(r.user_id) ?? 0 });
  }
  for (const r of results) rows.push({ ...r, tries: 0 });
  let sent = 0;
  const due: Due[] = [];
  for (const r of rows) {
    let p: Parameters<typeof termNoticeFor>[0] = null;
    try {
      p = JSON.parse(r.json);
    } catch {
      continue;
    }
    const notice = termNoticeFor(p, nowMs);
    if (notice) due.push([r.user_id, notice, r.tries]);
  }
  // The batch is marked before it's sent, so a mark that can't be saved
  // sends nothing rather than the same batch every run. The mark moves on
  // whatever the sends do, so one user who can't be reached holds up no one.
  // Its new run stamp sets aside the retry list just read: should the one
  // this run leaves fail to save, no one tried now is sent it again.
  const done = mark === id || results.length < batch;
  await env.KV.put(REMINDED_KEY, `${done ? id : `${id} ${results[results.length - 1].user_id}`}#${nowMs}`, { expirationTtl: 30 * 86_400 });
  const failed: Due[] = [];
  for (let i = 0; i < due.length; i += ARM_AT_ONCE) {
    const some = due.slice(i, i + ARM_AT_ONCE);
    const n = await Promise.all(some.map(([userId, notice]) => remindUser(env, userId, notice, nowMs).catch(() => ({ sent: 0, failed: 1 }))));
    // Only a send that failed is worth trying again; a user with no device
    // it could go to (no usable key, every token gone) would fail every time.
    some.forEach(([userId, notice, tries], j) => {
      sent += n[j].sent;
      if (n[j].sent === 0 && n[j].failed > 0) failed.push([userId, notice, tries + 1]);
    });
  }
  // Users no device took (push itself failing, say) are tried again on the
  // next runs, up to REMIND_TRIES times, so a token that never works stops.
  const again = failed.filter(([, , tries]) => tries < REMIND_TRIES).slice(0, ARM_BATCH);
  if (failed.length) console.error('term reminders not sent', failed.length);
  if (again.length) {
    const users = again.map(([userId, , n]): [string, number] => [userId, n]);
    await env.KV.put(REMIND_RETRY_KEY, JSON.stringify({ term: id, run: nowMs, users }), { expirationTtl: 30 * 86_400 });
  } else if (retry) {
    // Left in place, the old list is set aside by the mark's run stamp anyway.
    await env.KV.delete(REMIND_RETRY_KEY).catch((e) => console.error('term retry not cleared', (e as Error)?.name ?? 'error'));
  }
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
  if (env.DB) {
    const daily = await sweepDue(env, nowMs);
    let swept = false;
    await step('housekeeping', async () => {
      await housekeeping(env.DB!, nowMs, daily, env);
      swept = daily;
    });
    if (daily) {
      // Sightings are kept in whole days, so one prune a day is enough.
      await step('crowds', () => pruneCrowdSeen(env.DB!, nowMs));
      // Only once the sweep worked: a failed one is tried again next run.
      if (swept) await step('swept', () => env.KV.put(SWEPT_KEY, sgtDate(nowMs), { expirationTtl: 2 * 86_400 }));
    }
  }
  await step('trips', () => armTrips(env, nowMs));
  // Starts the day's timelapse recorder in the morning (it runs itself after that).
  await step('timelapse', () => ensureRecorder(env, nowMs));
  await step('term', () => remindTerm(env, nowMs));
}
