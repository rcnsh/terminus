import type { Env } from '../types.ts';
import { UpstreamRejected } from './auth.ts';
import { isBeta } from '../origin.ts';

export type Feed = 'nus' | 'lta';

const KEYS: Record<Feed, string> = { nus: 'monitor:seen', lta: 'monitor:seen-public' };

export interface Seen {
  at: number;
  reason: string;
  code?: string;
  detail?: string;
  version?: string;
}

const NOTE_EVERY_MS = 60_000;
const noted = new Map<Feed, number>();

export async function noteBreakerOpen(env: Env, feed: Feed, err: unknown, nowMs: number): Promise<void> {
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
  await env.KV.put(KEYS[feed], JSON.stringify(seen), { expirationTtl: 86_400 }).catch(() => {});
}

export async function lastBreakerOpen(env: Env, feed: Feed): Promise<Seen | null> {
  try {
    const raw = await env.KV.get(KEYS[feed]);
    const seen = raw ? (JSON.parse(raw) as Seen) : null;
    return seen && typeof seen.at === 'number' ? seen : null;
  } catch {
    return null;
  }
}

export function breakerError(seen: Seen): Error {
  if (!seen.code) return new Error(seen.reason);
  const err = new UpstreamRejected(seen.code, seen.reason, seen.detail ?? '');
  if (seen.version !== undefined) err.version = seen.version;
  return err;
}

export function resetNotes(): void {
  noted.clear();
}
