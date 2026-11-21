import type { Env } from '../types.ts';
import { TTL } from '../config.ts';

export class GateBusy extends Error {}

export const GATE_WAIT_MS = TTL.upstreamTimeoutMs + 1_000;

const GATE_ASK_MS = GATE_WAIT_MS + 1_000;

type Claim<T> = { go: true; claimed: number } | { value: T | null };

export async function throughGate<T>(env: Env, ctx: ExecutionContext, key: string, freshMs: number, fetch: () => Promise<T>): Promise<T> {
  const ns = env.FEED_GATE;
  if (!ns) return fetch();
  const gate = ns.get(ns.idFromName(key), { locationHint: 'apac' });
  const ask = (path: string, body: unknown) => gate.fetch(`https://gate.internal${path}`, { method: 'POST', body: JSON.stringify(body) });
  let claim: Claim<T>;
  try {
    claim = await within(
      GATE_ASK_MS,
      ask('/claim', { freshMs, askedAt: Date.now() }).then((r) =>
        r.ok ? (r.json() as Promise<Claim<T>>) : Promise.reject(new Error(`gate ${r.status}`)),
      ),
    );
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
    ctx.waitUntil(
      ask('/put', { claimed, value }).then(
        () => {},
        () => {},
      ),
    );
    return value;
  } catch (err) {
    ctx.waitUntil(
      ask('/put', { claimed, value: null }).then(
        () => {},
        () => {},
      ),
    );
    throw err;
  }
}

function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('the gate did not answer')), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer!));
}

interface Held {
  claimed: number;
  pending: boolean;
  value: unknown;
}

export class FeedGate {
  private readonly storage: DurableObjectStorage;
  private held: Held | null = null;
  private waiters: ((value: unknown) => void)[] = [];

  constructor(state: DurableObjectState, _env: unknown) {
    this.storage = state.storage;
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const body = (await req.json().catch(() => null)) as {
      freshMs?: unknown;
      askedAt?: unknown;
      claimed?: unknown;
      value?: unknown;
    } | null;
    this.held ??= (await this.storage.get<Held>('held')) ?? null;
    const now = Date.now();
    if (path === '/claim') {
      const freshMs = typeof body?.freshMs === 'number' && body.freshMs > 0 ? body.freshMs : TTL.arrivalsMs;
      if (typeof body?.askedAt === 'number' && now - body.askedAt > GATE_ASK_MS) return Response.json({ value: null });
      const h = this.held;
      if (!h || now - h.claimed >= freshMs) {
        this.held = { claimed: now, pending: true, value: null };
        await this.storage.put('held', this.held);
        return Response.json({ go: true, claimed: now });
      }
      if (!h.pending) return Response.json({ value: h.value });
      const value = await new Promise<unknown>((resolve) => {
        const timer = setTimeout(() => resolve(null), GATE_WAIT_MS);
        this.waiters.push((v) => {
          clearTimeout(timer);
          resolve(v);
        });
      });
      return Response.json({ value });
    }
    if (path === '/put') {
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
