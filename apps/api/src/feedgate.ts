/**
 * One upstream call per key per freshness window, across every data centre.
 *
 * The edge cache (edgecache.ts) belongs to one data centre, so on its own it
 * holds rule 2's limits per data centre: traffic spread across many of them
 * (a botnet, say) would ask NUS or LTA once per data centre per window. The
 * `FeedGate` Durable Object, one per key (a stop's arrivals, a service's
 * buses, a stop's public buses), in Asia, near the feeds, is asked only when
 * a data centre's cache has nothing fresh: the first to ask in a window may
 * call the feed and hands the answer back; anyone else in that window gets
 * that answer, or waits a moment for it, and never calls the feed.
 *
 * Unreachable or slow, the gate is skipped: the data centre's own limits
 * still hold, and a gate that failed shut would take every answer down with
 * it. Its claim and answer are kept in storage, since an idle object may be
 * dropped from memory between windows.
 */

import type { Env } from './types.ts';
import { TTL } from './config.ts';

/** No answer to share: the feed was asked in this window and failed, or the
 *  call is still running. A stale answer is served, as for any failure. */
export class GateBusy extends Error {}

/** How long a waiting caller waits for another's call: past a slow call's timeout. */
export const GATE_WAIT_MS = TTL.upstreamTimeoutMs + 1_000;

/** How long the Worker waits for the gate itself before going without it. */
const GATE_ASK_MS = GATE_WAIT_MS + 1_000;

type Claim<T> = { go: true; claimed: number } | { value: T | null };

/**
 * [fetch]'s answer, or the one another data centre fetched for [key] in the
 * last [freshMs]. Throws GateBusy when there is none to share yet.
 */
export async function throughGate<T>(env: Env, ctx: ExecutionContext, key: string, freshMs: number, fetch: () => Promise<T>): Promise<T> {
  const ns = env.FEED_GATE;
  if (!ns) return fetch();
  const gate = ns.get(ns.idFromName(key), { locationHint: 'apac' });
  const ask = (path: string, body: unknown) => gate.fetch(`https://gate.internal${path}`, { method: 'POST', body: JSON.stringify(body) });
  let claim: Claim<T>;
  try {
    claim = await within(GATE_ASK_MS, ask('/claim', { freshMs }).then((r) => (r.ok ? (r.json() as Promise<Claim<T>>) : Promise.reject(new Error(`gate ${r.status}`)))));
  } catch {
    return fetch();
  }
  if (!('go' in claim)) {
    if (claim.value) return claim.value;
    throw new GateBusy('the feed was asked for this a moment ago, elsewhere');
  }
  const { claimed } = claim;
  try {
    const value = await fetch();
    ctx.waitUntil(ask('/put', { claimed, value }).then(() => {}, () => {}));
    return value;
  } catch (err) {
    ctx.waitUntil(ask('/put', { claimed, value: null }).then(() => {}, () => {}));
    throw err;
  }
}

function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('the gate did not answer')), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer!));
}

interface Held {
  /** When the feed was last claimed (this object's clock). */
  claimed: number;
  /** Whether that call is still running. */
  pending: boolean;
  /** Its answer: null if it failed (or isn't in yet). */
  value: unknown;
}

/** The gate for one key. */
export class FeedGate {
  private readonly storage: DurableObjectStorage;
  private held: Held | null = null;
  private waiters: ((value: unknown) => void)[] = [];

  constructor(state: DurableObjectState, _env: unknown) {
    this.storage = state.storage;
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const body = (await req.json().catch(() => null)) as { freshMs?: unknown; claimed?: unknown; value?: unknown } | null;
    this.held ??= (await this.storage.get<Held>('held')) ?? null;
    const now = Date.now();
    if (path === '/claim') {
      const freshMs = typeof body?.freshMs === 'number' && body.freshMs > 0 ? body.freshMs : TTL.arrivalsMs;
      const h = this.held;
      if (!h || now - h.claimed >= freshMs) {
        // Set before anything awaits, so two claims at once can't both win.
        this.held = { claimed: now, pending: true, value: null };
        await this.storage.put('held', this.held);
        return Response.json({ go: true, claimed: now });
      }
      if (!h.pending) return Response.json({ value: h.value });
      const value = await new Promise<unknown>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(() => resolve(null), GATE_WAIT_MS);
      });
      return Response.json({ value });
    }
    if (path === '/put') {
      // Only the latest claim's answer: a call that outlived its window
      // (and lost it to a newer claim) mustn't overwrite the newer one.
      if (!this.held || body?.claimed !== this.held.claimed) return Response.json({ ok: false });
      const value = body?.value ?? null;
      this.held = { claimed: this.held.claimed, pending: false, value };
      for (const w of this.waiters.splice(0)) w(value);
      await this.storage.put('held', this.held);
      return Response.json({ ok: true });
    }
    return new Response('not found', { status: 404 });
  }
}
