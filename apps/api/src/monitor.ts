/**
 * Upstream monitoring and housekeeping, run by the cron trigger.
 *
 * The NUS feed fails all at once when uNivUS ships a new version (code
 * 10009) or the proxy changes. Every client degrades to "live times
 * unavailable", which is honest but silent, so this emails the operator on
 * each change of state: once when it breaks, once when it recovers.
 */

import type { Env } from './types.ts';
import { fetchArrivals } from './fms.ts';
import { calendarThrough } from './calendar.ts';
import { pruneCrowdSeen } from './crowd.ts';

export interface UpstreamState {
  /** Confirmed state: it takes FAILS_TO_ALERT failed checks in a row to go down. */
  up: boolean;
  /** When the current state began, epoch ms. */
  since: number;
  /** The latest failure, when the last check failed. */
  reason: string | null;
  checkedAt: number;
  /** Failed checks in a row. */
  failures?: number;
  /** An alert that has not been delivered yet; retried every run until it is. */
  pending?: 'down' | 'up' | null;
}

const KEY = 'monitor:upstream';
const CALENDAR_KEY = 'monitor:calendar-alert';
/** A stop served by several routes almost all day. */
export const PROBE_STOP = 'COM3';
/** Device tokens unused this long are expired by the cron. */
export const DEVICE_IDLE_MS = 90 * 86_400_000;
/** One bad check is often a blip (NUS answers some requests with a 400);
 *  two in a row, 15 minutes apart, is an outage. */
export const FAILS_TO_ALERT = 2;
/** Warn this long before calendar.json runs out. */
export const CALENDAR_WARN_DAYS = 45;

export async function readUpstream(env: Env): Promise<UpstreamState | null> {
  const raw = await env.NUSBUS_KV.get(KEY).catch(() => null);
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
): Promise<{ state: UpstreamState; changed: boolean }> {
  let ok = true;
  let reason: string | null = null;
  try {
    await probe();
  } catch (err) {
    ok = false;
    reason = String((err as Error)?.message ?? err).slice(0, 300);
  }

  const prev = await readUpstream(env);
  const failures = ok ? 0 : (prev?.failures ?? 0) + 1;
  const up = ok ? true : failures >= FAILS_TO_ALERT ? false : (prev?.up ?? true);
  const changed = !prev || prev.up !== up;
  let pending = prev?.pending ?? null;
  if (changed && (prev || !up)) pending = up ? 'up' : 'down';
  const state: UpstreamState = { up, since: changed ? nowMs : prev!.since, reason, checkedAt: nowMs, failures, pending };

  if (pending) {
    try {
      await alert(env, state, pending);
      state.pending = null;
    } catch (e) {
      console.error('alert failed', (e as Error)?.name ?? 'error');
    }
  }
  await env.NUSBUS_KV.put(KEY, JSON.stringify(state));
  return { state, changed };
}

/** What to do about a failure, from its upstream code. */
export function adviceFor(reason: string | null): string {
  if (!reason) return '';
  if (/10009/.test(reason)) {
    return 'uNivUS has a new release and the old version string is refused. Update it:\n  npx wrangler secret put NEXTBUS_APP_VERSION\n(format univus_android_<versionName>_<versionCode>, from the new APK).';
  }
  if (/10008/.test(reason)) return 'The device id no longer matches the access token. Clear auth:session in KV and let it re-mint.';
  if (/10000|Invalid API KEY/i.test(reason)) return 'The app API keys were rejected; they may have been rotated in a new uNivUS build.';
  return 'Check `npx wrangler tail` and /health?probe=1.';
}

async function alert(env: Env, s: UpstreamState, kind: 'up' | 'down'): Promise<void> {
  if (!env.EMAIL || !env.EMAIL_FROM || !env.ALERT_EMAIL) return;
  const when = new Date(s.since).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const subject = kind === 'up' ? 'terminus: NUS bus feed recovered' : 'terminus: NUS bus feed is down';
  const text = kind === 'up'
    ? `The NUS bus feed is answering again as of ${when}. Live times are back.`
    : `The NUS bus feed stopped answering at ${when}.\n\nError: ${s.reason}\n\n${adviceFor(s.reason)}\n\nUntil then every answer says "live times unavailable".`;
  await env.EMAIL.send({ from: { email: env.EMAIL_FROM, name: 'terminus' }, to: env.ALERT_EMAIL, subject, text });
}

/** Delete expired sign-in links, pairing codes, web sessions and idle devices. */
export async function housekeeping(db: D1Database, nowMs: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM magic_links WHERE expires < ?').bind(nowMs),
    db.prepare('DELETE FROM pair_codes WHERE expires < ?').bind(nowMs),
    db.prepare("DELETE FROM sessions WHERE kind = 'web' AND expires < ?").bind(nowMs),
    db.prepare("DELETE FROM sessions WHERE kind = 'device' AND last_seen < ?").bind(nowMs - DEVICE_IDLE_MS),
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
  const last = Number(await env.NUSBUS_KV.get(CALENDAR_KEY).catch(() => null)) || 0;
  if (nowMs - last < 7 * 86_400_000) return false;
  if (!env.EMAIL || !env.EMAIL_FROM || !env.ALERT_EMAIL) return false;
  await env.EMAIL.send({
    from: { email: env.EMAIL_FROM, name: 'terminus' },
    to: env.ALERT_EMAIL,
    subject: 'terminus: academic calendar data runs out soon',
    text: `data/calendar.json covers dates up to ${through} (${daysLeft} days from now). After that, imported classes are shown every week, including recess and exams.\n\nRefresh it and deploy:\n  python3 apps/api/scripts/fetch_calendar.py && npm run deploy`,
  });
  await env.NUSBUS_KV.put(CALENDAR_KEY, String(nowMs));
  return true;
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
}
