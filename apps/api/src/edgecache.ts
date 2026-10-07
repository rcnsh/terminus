/**
 * Fetch-on-demand through the edge cache, quiet under failure.
 *
 * Every live answer (a stop's arrivals from NUS, a service's buses, a stop's
 * public buses from LTA) is fetched the same way: one upstream call per key
 * per freshness window however many clients ask, concurrent misses in one
 * isolate sharing a single fetch, and under failure less noise rather than
 * more. A failed key is not asked again for a while; a failure that says the
 * upstream will refuse everything trips a breaker shared by every key of
 * that feed; and a stale answer on hand is served while the fresh one is
 * fetched in the background, or when the fetch fails.
 *
 * Keyed on what the answer is for (the stop code, the service), never the
 * request URL: a client's coordinates jitter on every call and would never
 * hit.
 *
 * The cache is one data centre's, shared by every isolate there, while the
 * in-flight map is one isolate's. So that a key going stale doesn't send
 * every isolate in a busy data centre to the feed at once, the one fetching
 * leaves a marker (`#pending`); the others serve their stale answer until
 * it's done. Without a stale answer they fetch too: a cold key has nothing
 * else to give.
 */

import type { Env, FeedState } from './types.ts';
import { isBeta } from './site.ts';
import { TTL } from './config.ts';

export interface CachedOptions<T> {
  ctx: ExecutionContext;
  nowMs: number;
  /** Where the answer lives in the cache, a URL on a private host. */
  key: string;
  /** Where "this key failed a moment ago" lives. */
  failKey: string;
  fetch: () => Promise<T>;
  /** How long a cached answer is fresh. */
  freshMs: number;
  /** How long a stale answer stays usable as a fallback. */
  staleMaxS: number;
  /** After a failure, how long before the key is asked for again. */
  failMemoS: number;
  /**
   * With a stale answer on hand, how long to wait for the fresh one before
   * serving the stale. Absent: wait for the fetch (a client that polls every
   * few seconds, like the map, is better served by a wait than a stale jump).
   */
  raceMs?: number;
  /** The feed's breaker: tripped by a failure that `trips`, it quiets every key that names it. */
  breaker?: { key: string; trips: (err: unknown) => boolean; maxAgeS: number };
  /** One in-flight fetch per key per isolate. The caller owns the map, so each feed has its own. */
  inflight: Map<string, Promise<T>>;
}

/**
 * The host every edge-cache key lives on. Never fetched; only matched. The
 * cache may be the zone's rather than the Worker's, and the stable site and
 * the beta share a zone, so the beta's keys live on a host of their own:
 * a beta refused for its version must not trip the stable
 * site's breaker, nor feed it answers in a shape it doesn't know.
 */
export function cacheBase(): string {
  return beta ? 'https://beta.terminus.internal' : 'https://terminus.internal';
}

let beta = false;

/** Which site's keys: set from the Worker's env on every request, cron run
 *  and Durable Object, before anything reads the cache. */
export function scopeCache(env: Env): void {
  beta = isBeta(env);
}

const memo = (reason: string, maxAgeS: number) =>
  new Response(reason.slice(0, 200), { headers: { 'cache-control': `max-age=${maxAgeS}` } });

/** Whether a memo is set at `key` (a breaker, a failure): false without a cache. */
export async function flagged(key: string): Promise<boolean> {
  try {
    return Boolean(await caches.default.match(new Request(key)));
  } catch {
    return false;
  }
}

/** Sets a memo at `key` for `maxAgeS`; a failed write is shrugged off. */
export async function flag(key: string, reason: string, maxAgeS: number): Promise<void> {
  try {
    await caches.default.put(new Request(key), memo(reason, maxAgeS));
  } catch {
    // A lost memo only means one more call later, never a failed answer.
  }
}

/** How long a fetch's marker lasts if it never clears it: past the slowest
 *  fetch, a mint, a call, a re-mint and a second call, each up to its
 *  timeout, with room for the KV and cache reads between them. Shorter, and
 *  the marker would lapse mid-fetch and let the other isolates fetch too. */
const PENDING_S = Math.ceil((4 * TTL.upstreamTimeoutMs) / 1000) + 10;

/**
 * The answer for `key`: cached and fresh, else fetched, else stale, in that
 * order. Throws only with nothing to serve. `stale` and `available` on the
 * result say which it was.
 */
export async function cachedFetch<T extends { fetchedAt: number }>(o: CachedOptions<T>): Promise<T & FeedState> {
  const cache = caches.default;
  const key = new Request(o.key);

  // LANDMINE: a Response body is single-use. Parse it ONCE, here, into a
  // variable. Reading `hit` again on the catch path below would turn
  // "upstream is down" into "the Worker is down" at the worst possible moment.
  let cached: T | null = null;
  const hit = await cache.match(key);
  if (hit) {
    try {
      cached = (await hit.json()) as T;
    } catch {
      cached = null;
    }
  }

  if (cached && o.nowMs - cached.fetchedAt < o.freshMs) {
    return { ...cached, stale: false, available: true };
  }
  const stale: (T & FeedState) | null = cached ? { ...cached, stale: true, available: true } : null;

  const quiet = (o.breaker ? await cache.match(o.breaker.key) : undefined) ?? (await cache.match(o.failKey));
  if (quiet) {
    if (stale) return stale;
    throw new Error(`upstream recently failed: ${(await quiet.text()).slice(0, 120)}`);
  }

  // Another isolate here is fetching it already: its answer will be in the
  // cache in a moment, and the stale one does until then.
  const pendingKey = new Request(`${o.key}#pending`);
  if (stale && !o.inflight.has(o.key) && (await cache.match(pendingKey))) return stale;

  let job = o.inflight.get(o.key);
  if (!job) {
    job = (async () => {
      await cache.put(pendingKey, memo('fetching', PENDING_S)).catch(() => {});
      return o.fetch();
    })()
      .then(async (fresh) => {
        // A failed write loses the cache, not the answer: it's still good,
        // and turning it into a failure would quiet the key for failMemoS.
        await cache.put(key, new Response(JSON.stringify(fresh), {
          headers: {
            'content-type': 'application/json',
            // Long max-age so the stale fallback survives; freshness is
            // decided above from fetchedAt, not by the cache.
            'cache-control': `max-age=${o.staleMaxS}`,
          },
        })).catch(() => {});
        return fresh;
      }, async (err) => {
        const reason = String((err as Error)?.message ?? err);
        await cache.put(o.failKey, memo(reason, o.failMemoS)).catch(() => {});
        if (o.breaker?.trips(err)) await cache.put(o.breaker.key, memo(reason, o.breaker.maxAgeS)).catch(() => {});
        throw err;
      })
      .finally(() => {
        o.inflight.delete(o.key);
        o.ctx.waitUntil(cache.delete(pendingKey).catch(() => false));
      });
    o.inflight.set(o.key, job);
  }
  // The fetch finishes (and fills the cache) even when this request stops
  // waiting for it.
  o.ctx.waitUntil(job.catch(() => {}));

  const fresh = (v: T): T & FeedState => ({ ...v, stale: false, available: true });
  try {
    if (!stale || o.raceMs === undefined) return fresh(await job);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const slow = new Promise<null>((r) => (timer = setTimeout(() => r(null), o.raceMs)));
    try {
      const won = await Promise.race([job, slow]);
      return won ? fresh(won) : stale;
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (err) {
    if (stale) return stale;
    throw err;
  }
}
