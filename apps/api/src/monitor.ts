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

export interface UpstreamState {
  up: boolean;
  /** When the current state began, epoch ms. */
  since: number;
  /** The failure, when down. */
  reason: string | null;
  checkedAt: number;
}

const KEY = 'monitor:upstream';
/** A stop served by several routes almost all day. */
export const PROBE_STOP = 'COM3';
/** Device tokens unused this long are expired by the cron. */
export const DEVICE_IDLE_MS = 90 * 86_400_000;

export async function readUpstream(env: Env): Promise<UpstreamState | null> {
  const raw = await env.NUSBUS_KV.get(KEY).catch(() => null);
  return raw ? (JSON.parse(raw) as UpstreamState) : null;
}

/**
 * Probe the feed directly (bypassing the arrivals cache, so a stale cached
 * answer can't hide an outage) and record the result. Alerts only on a
 * change of state, and not for the very first "up".
 */
export async function checkUpstream(
  env: Env,
  nowMs: number,
  probe: () => Promise<unknown> = () => fetchArrivals(env, PROBE_STOP, nowMs),
): Promise<{ state: UpstreamState; changed: boolean }> {
  let up = true;
  let reason: string | null = null;
  try {
    await probe();
  } catch (err) {
    up = false;
    reason = String((err as Error)?.message ?? err).slice(0, 300);
  }

  const prev = await readUpstream(env);
  const changed = !prev || prev.up !== up;
  const state: UpstreamState = { up, since: changed ? nowMs : prev.since, reason, checkedAt: nowMs };
  await env.NUSBUS_KV.put(KEY, JSON.stringify(state));

  if (changed && (prev || !up)) await alert(env, state).catch((e) => console.error('alert failed', String(e)));
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

async function alert(env: Env, s: UpstreamState): Promise<void> {
  if (!env.EMAIL || !env.EMAIL_FROM || !env.ALERT_EMAIL) return;
  const when = new Date(s.since).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const subject = s.up ? 'terminus: NUS bus feed recovered' : 'terminus: NUS bus feed is down';
  const text = s.up
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

export async function runCron(env: Env, nowMs: number): Promise<void> {
  await checkUpstream(env, nowMs);
  if (env.DB) await housekeeping(env.DB, nowMs);
}
