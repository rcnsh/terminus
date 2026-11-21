import type { Env, FeedState } from '../types.ts';
import { isBeta } from '../origin.ts';
import { TTL } from '../config.ts';

export interface CachedOptions<T> {
  ctx: ExecutionContext;
  nowMs: number;
  key: string;
  failKey: string;
  fetch: () => Promise<T>;
  freshMs: number;
  staleMaxS: number;
  failMemoS: number;
  raceMs?: number;
  memoes?: (err: unknown) => boolean;
  breaker?: { key: string; opens: (err: unknown) => boolean; maxAgeS: number; onOpen?: (err: unknown) => Promise<void> };
  inflight: Map<string, Promise<T>>;
  onFail?: (err: unknown) => void;
}

export function cacheBase(): string {
  return beta ? 'https://beta.terminus.internal' : 'https://terminus.internal';
}

let beta = false;

export function scopeCache(env: Env): void {
  beta = isBeta(env);
}

const memo = (reason: string, maxAgeS: number) =>
  new Response(reason.slice(0, 200), { headers: { 'cache-control': `max-age=${maxAgeS}` } });

export async function flagged(key: string): Promise<boolean> {
  try {
    return Boolean(await caches.default.match(new Request(key)));
  } catch {
    return false;
  }
}

export async function flag(key: string, reason: string, maxAgeS: number): Promise<void> {
  try {
    await caches.default.put(new Request(key), memo(reason, maxAgeS));
  } catch {}
}

const PENDING_S = Math.ceil((4 * TTL.upstreamTimeoutMs) / 1000) + 10;

export async function cachedFetch<T extends { fetchedAt: number }>(o: CachedOptions<T>): Promise<T & FeedState> {
  const cache = caches.default;
  const key = new Request(o.key);

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

  const pendingKey = new Request(`${o.key}/pending`);
  if (stale && !o.inflight.has(o.key) && (await cache.match(pendingKey))) return stale;

  let job = o.inflight.get(o.key);
  if (!job) {
    const marked = cache.put(pendingKey, memo('fetching', PENDING_S)).catch(() => {});
    let writes: Promise<unknown> = Promise.resolve();
    const mine: Promise<T> = (async () => o.fetch())().then(
      (fresh) => {
        writes = cache
          .put(
            key,
            new Response(JSON.stringify(fresh), {
              headers: {
                'content-type': 'application/json',
                'cache-control': `max-age=${o.staleMaxS}`,
              },
            }),
          )
          .catch(() => {});
        return fresh;
      },
      (err) => {
        const reason = String((err as Error)?.message ?? err);
        try {
          o.onFail?.(err);
        } catch {}
        const memos: Promise<void>[] = [];
        if (o.memoes?.(err) ?? true) memos.push(cache.put(o.failKey, memo(reason, o.failMemoS)).catch(() => {}));
        if (o.breaker?.opens(err)) {
          memos.push(cache.put(o.breaker.key, memo(reason, o.breaker.maxAgeS)).catch(() => {}));
          if (o.breaker.onOpen) o.ctx.waitUntil(o.breaker.onOpen(err).catch(() => {}));
        }
        writes = Promise.all(memos);
        throw err;
      },
    );
    job = mine;
    o.inflight.set(o.key, mine);
    o.ctx.waitUntil(
      mine
        .catch(() => {})
        .then(() => Promise.all([marked, writes]))
        .then(() => {
          if (o.inflight.get(o.key) === mine) o.inflight.delete(o.key);
          return cache.delete(pendingKey).catch(() => false);
        }),
    );
  }
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
