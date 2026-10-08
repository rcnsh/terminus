/**
 * The beta's view of the feeds, from its own traffic.
 *
 * The stable Worker's cron asks NUS and LTA for one stop each, every 15
 * minutes, past the cache (monitor.ts). The beta's cron doesn't: it would
 * double that scheduled load for a site few people use. Instead, whenever a
 * request on the beta trips a feed's breaker (a refused version or key, a
 * 429 or 5xx, no answer at all), the failure is noted in the beta's KV, and
 * the beta's cron reads the note as its check. No NUS or LTA call is made
 * for it; with no traffic there is nothing to note, and the feed reads as up.
 */

import type { Env } from './types.ts';
import { UpstreamRejected } from './auth.ts';
import { isBeta } from './site.ts';

export type Feed = 'nus' | 'lta';

const KEYS: Record<Feed, string> = { nus: 'monitor:seen', lta: 'monitor:seen-public' };

/** A breaker trip, as noted for the cron. */
export interface Seen {
  at: number;
  reason: string;
  /** NUS's code, when it refused us outright. */
  code?: string;
  /** Its response, already stripped of credentials (UpstreamRejected). */
  detail?: string;
  /** The version string the refused request carried. */
  version?: string;
}

/** One note per feed per isolate per this long: a trip already quiets the
 *  feed for breakerS, and KV takes one write a second to a key. */
const NOTE_EVERY_MS = 60_000;
const noted = new Map<Feed, number>();

/** Notes a breaker trip on the beta; a no-op on the stable site, whose cron checks for itself. */
export async function noteTrip(env: Env, feed: Feed, err: unknown, nowMs: number): Promise<void> {
  if (!isBeta(env) || !env.KV) return;
  const last = noted.get(feed);
  if (last !== undefined && nowMs - last < NOTE_EVERY_MS && nowMs >= last) return;
  noted.set(feed, nowMs);
  const seen: Seen = { at: nowMs, reason: String((err as Error)?.message ?? err).slice(0, 300) };
  if (err instanceof UpstreamRejected) {
    seen.code = err.code;
    if (err.detail) seen.detail = err.detail;
    if (err.version !== undefined) seen.version = err.version;
  }
  // A lost note costs one check's worth of warning, never an answer.
  await env.KV.put(KEYS[feed], JSON.stringify(seen), { expirationTtl: 86_400 }).catch(() => {});
}

/** The latest trip noted for `feed`, or null (none, or KV unreadable: no news reads as up). */
export async function lastTrip(env: Env, feed: Feed): Promise<Seen | null> {
  try {
    const raw = await env.KV.get(KEYS[feed]);
    const seen = raw ? (JSON.parse(raw) as Seen) : null;
    return seen && typeof seen.at === 'number' ? seen : null;
  } catch {
    return null;
  }
}

/** The trip as the error it was, so the monitor treats it as it would a failed probe. */
export function tripError(seen: Seen): Error {
  if (!seen.code) return new Error(seen.reason);
  const err = new UpstreamRejected(seen.code, seen.reason, seen.detail ?? '');
  if (seen.version !== undefined) err.version = seen.version;
  return err;
}

/** For tests: forget this isolate's write throttle. */
export function resetNotes(): void {
  noted.clear();
}
