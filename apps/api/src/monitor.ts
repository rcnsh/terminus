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
import { KV_APP_VERSION, UpstreamRejected } from './auth.ts';
import { autoUpdateVersion, type AutoResult } from './appversion.ts';
import { calendarThrough } from './calendar.ts';
import { pruneCrowdSeen } from './crowd.ts';
import { ACCOUNT_TTL } from './accounts.ts';
import { pushEnabled } from './push.ts';
import { sgtDate, watchTrip } from './trip.ts';

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

export async function readIncidents(env: Env): Promise<Incident[]> {
  const raw = await env.KV.get(INCIDENTS_KEY).catch(() => null);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? (list as Incident[]) : [];
  } catch {
    return [];
  }
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

export async function readUpstream(env: Env): Promise<UpstreamState | null> {
  const raw = await env.KV.get(KEY).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UpstreamState;
  } catch {
    return null;
  }
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

async function alert(env: Env, s: UpstreamState, kind: 'up' | 'down'): Promise<void> {
  if (!env.EMAIL || !env.EMAIL_FROM || !env.ALERT_EMAIL) return;
  const when = new Date(s.since).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const subject = kind === 'up' ? 'terminus: NUS bus feed recovered' : 'terminus: NUS bus feed is down';
  const text = kind === 'up'
    ? `The NUS bus feed is answering again as of ${when}. Live times are back.`
    : `The NUS bus feed stopped answering at ${when}.\n\nError: ${s.reason}\n\n${s.auto ? `Tried automatically: ${s.auto}.\n\n` : ''}${adviceFor(s.reason)}\n\nUntil then every answer says "live times unavailable".${s.detail ? `\n\nNUS's full response:\n${s.detail}` : ''}`;
  await env.EMAIL.send({ from: { email: env.EMAIL_FROM, name: 'terminus' }, to: env.ALERT_EMAIL, subject, text });
}

async function switchedAlert(env: Env, r: Extract<AutoResult, { status: 'switched' }>): Promise<void> {
  if (!env.EMAIL || !env.EMAIL_FROM || !env.ALERT_EMAIL) return;
  const name = /univus_android_(.+)_\d+$/.exec(r.to)?.[1] ?? r.to;
  await env.EMAIL.send({
    from: { email: env.EMAIL_FROM, name: 'terminus' },
    to: env.ALERT_EMAIL,
    subject: `terminus: switched to uNivUS ${name} automatically`,
    text: [
      `NUS started refusing ${r.from || 'the old version string'}, so a new uNivUS is out. terminus found ${r.to}, NUS accepted it, and it is now in ${KV_APP_VERSION}.`,
      'Nothing to do. To undo it, from apps/api:',
      `  pnpm exec cf kv keys delete ${KV_APP_VERSION} --namespace-id ${KV_NAMESPACE_ID}`,
    ].join('\n\n'),
  });
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
    // Trip outcomes (phase 3) are kept 35 days.
    db.prepare('DELETE FROM trip_outcomes WHERE at < ?').bind(nowMs - KEEP_DAYS * 86_400_000),
  ]);
}

/**
 * Email once a week while calendar.json is within CALENDAR_WARN_DAYS of
 * running out. Past its end imported classes fail open (every week counts),
 * which is survivable but wrong in recess and exams.
 */
export async function checkCalendar(env: Env, nowMs: number, through = calendarThrough()): Promise<boolean> {
  const daysLeft = Math.floor((Date.parse(`${through}T00:00:00Z`) - nowMs) / 86_400_000);
  if (daysLeft > CALENDAR_WARN_DAYS) return false;
  const last = Number(await env.KV.get(CALENDAR_KEY).catch(() => null)) || 0;
  if (nowMs - last < 7 * 86_400_000) return false;
  if (!env.EMAIL || !env.EMAIL_FROM || !env.ALERT_EMAIL) return false;
  await env.EMAIL.send({
    from: { email: env.EMAIL_FROM, name: 'terminus' },
    to: env.ALERT_EMAIL,
    subject: 'terminus: academic calendar data runs out soon',
    text: `data/calendar.json covers dates up to ${through} (${daysLeft} days from now). After that, imported classes are shown every week, including recess and exams.\n\nRefresh it and deploy:\n  python3 apps/api/scripts/fetch_calendar.py && pnpm run deploy`,
  });
  await env.KV.put(CALENDAR_KEY, String(nowMs));
  return true;
}

/** From this hour (Singapore) each day, the cron starts the day's trip watching. */
export const ARM_FROM_HOUR = 6;
const ARMED_KEY = 'trips:armed';
/** Users armed per day at most; more than this and push needs a queue. */
const ARM_MAX = 2000;

/**
 * Starts every push user's Trip object watching today's trips, once a day.
 * A Trip object only wakes (and pushes) after a request asks it to, and a
 * web app on the Home Screen makes none unless it's opened; the Android app
 * does from its background refresh. Asked here each morning, it works out
 * the card, wakes at the next change (time to go, the question), and keeps
 * going for the day; on a day without classes it just stops.
 */
export async function armTrips(env: Env, nowMs: number): Promise<number> {
  if (!env.DB || !env.TRIPS || !pushEnabled(env)) return 0;
  const today = sgtDate(nowMs);
  const hour = new Date(nowMs + 8 * 3_600_000).getUTCHours();
  if (hour < ARM_FROM_HOUR || (await env.KV.get(ARMED_KEY)) === today) return 0;
  const { results } = await env.DB.prepare('SELECT DISTINCT user_id FROM sessions WHERE push_token IS NOT NULL LIMIT ?').bind(ARM_MAX).all<{ user_id: string }>();
  for (const r of results) await watchTrip(env, r.user_id, nowMs, nowMs);
  await env.KV.put(ARMED_KEY, today, { expirationTtl: 2 * 86_400 });
  return results.length;
}

/** Each step on its own: a KV failure must not stop D1 cleanup, and the reverse. */
export async function runCron(env: Env, nowMs: number): Promise<void> {
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      console.error('cron', name, err instanceof Error ? err.message : String(err));
    }
  };
  await step('upstream', () => checkUpstream(env, nowMs));
  await step('calendar', () => checkCalendar(env, nowMs));
  if (env.DB) await step('housekeeping', () => housekeeping(env.DB!, nowMs));
  if (env.DB) await step('crowds', () => pruneCrowdSeen(env.DB!, nowMs));
  await step('trips', () => armTrips(env, nowMs));
}
