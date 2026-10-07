/**
 * The `Trip` Durable Object: one per user, holding today's trip signals and
 * plans (trip.ts has the data and the helpers that talk to it).
 *
 * It has one alarm, used for two things:
 *
 * - **End of day:** at the next Singapore midnight everything is deleted.
 * - **Push (phase 3):** when the Worker has sent a card with a
 *   `nextChangeAt`, the object wakes then, works out the card again, and
 *   nudges the user's phones (push.ts) if the phase or the question changed.
 *   It keeps waking at each new `nextChangeAt` while there's a trip and a
 *   device that takes push, and stops otherwise.
 */

import { loadCalendar } from './calendarsync.ts';
import type { Env } from './types.ts';
import { type Boarded, type DayRecord, type TripRecord, type TripUpdate, sgtDate } from './trip.ts';
import type { MeDeps } from './me.ts';
import { tripCardFor } from './me.ts';
import { nudgeUser, pushDevices } from './push.ts';
import { GRAPH } from './graph.ts';
import { scopeCache } from './edgecache.ts';
import { answerFor, collectArrivals } from './answer.ts';

/** Trip records one day keeps at most (see /signal). */
export const MAX_DAY_TRIPS = 64;

const DEPS: MeDeps = { graph: GRAPH, answerFor, collectArrivals };

/** Never wake again sooner than this after a wake. */
const MIN_WAKE_GAP_MS = 30_000;

/** What was last pushed, so the same card isn't pushed twice. */
interface Pushed {
  key: string | null;
  phase: string;
}

export class Trip {
  private readonly state: DurableObjectState;
  private readonly storage: DurableObjectStorage;
  private readonly env: Env | null;

  constructor(state: DurableObjectState, env: unknown) {
    this.state = state;
    this.storage = state.storage;
    this.env = env && typeof env === 'object' && 'DB' in env ? (env as Env) : null;
    if (this.env) scopeCache(this.env);
  }

  async fetch(req: Request): Promise<Response> {
    // A change reads the day, waits for its body, then writes the day back.
    // Two devices' changes can arrive at once: without holding the object,
    // the second would put back a copy from before the first.
    if (req.method === 'POST') return this.state.blockConcurrencyWhile(() => this.handle(req));
    return this.handle(req);
  }

  private async handle(req: Request): Promise<Response> {
    await loadCalendar(this.env);
    const url = new URL(req.url);

    if (req.method === 'GET' && url.pathname === '/day') {
      const day = await this.storedDay();
      const date = url.searchParams.get('date') ?? '';
      // Yesterday's signals are never today's, even before the alarm has run.
      return Response.json(day && day.date === date ? day : null);
    }

    if (req.method === 'POST' && url.pathname === '/clear') {
      // deleteAll takes the alarm with it.
      await this.storage.deleteAll();
      return Response.json({ ok: true });
    }

    if (req.method === 'POST') {
      const u = updateOf(url.pathname, await req.json());
      if (u) return Response.json(await this.update(u));
    }

    return new Response('not found', { status: 404 });
  }

  /**
   * Applies every change one request carries (signals, followed, plans, a
   * watch) in one read and at most one write of the day, and sets the
   * alarm only when its time moves: most requests change one thing or
   * nothing, and each write and alarm is billed.
   */
  private async update(u: TripUpdate): Promise<DayRecord> {
    const stored = await this.storedDay();
    const next = today(stored, u.date);
    let changed = next !== stored;
    for (const { key, rec } of u.items ?? []) {
      // A day has a handful of trips; past this many a new one is refused,
      // so the record stays far below a stored value's size limit.
      if (rec && !(key in next.trips) && Object.keys(next.trips).length >= MAX_DAY_TRIPS) continue;
      if (rec) next.trips[key] = rec;
      else delete next.trips[key];
      changed = true;
    }
    if (u.followed !== undefined && next.followed !== u.followed) {
      next.followed = u.followed;
      changed = true;
    }
    if (u.plans && Object.keys(u.plans).length) {
      next.plans = { ...next.plans, ...u.plans };
      changed = true;
    }
    if (u.watch) {
      if ((await this.storage.get<string>('userId')) !== u.watch.userId) await this.storage.put('userId', u.watch.userId);
      // Only ever sooner: a device refreshing after a moment the object still
      // owes a push for (say, "due") mustn't move that wake past it.
      const pending = await this.storage.get<number>('wakeAt');
      const at = pending !== undefined ? Math.min(pending, u.watch.at) : u.watch.at;
      if (at !== pending) await this.storage.put('wakeAt', at);
      // The wake actually pending, so the Worker can tell whether asking
      // again would bring it any sooner (needsWatch).
      if (next.watch !== at) {
        next.watch = at;
        changed = true;
      }
    }
    if (changed) await this.storage.put('day', next);
    await this.arm(u.deleteAt);
    return next;
  }

  async alarm(): Promise<void> {
    const nowMs = Date.now();
    await loadCalendar(this.env, nowMs);
    const deleteAt = await this.storage.get<number>('deleteAt');
    // Midnight (or an object from before phase 3, which only knew midnight).
    if (deleteAt === undefined || nowMs >= deleteAt - 1000) {
      await this.storage.deleteAll();
      return;
    }
    const wakeAt = await this.storage.get<number>('wakeAt');
    // A wake not due yet stays pending; arm() sets the alarm for it again.
    if (wakeAt !== undefined && nowMs >= wakeAt - 1000) {
      await this.storage.delete('wakeAt');
      await this.wake(nowMs);
    }
    await this.arm();
  }

  /** Works out the card again; pushes it if it changed; wakes again at its next change. */
  private async wake(nowMs: number): Promise<void> {
    const next = await this.cardWake(nowMs);
    // The day says when the object next wakes, or that it won't: a request
    // then asks again (needsWatch), instead of trusting a wake that's gone.
    const date = sgtDate(nowMs);
    const d = await this.storedDay();
    if (next !== null) {
      await this.storage.put('wakeAt', next);
      await this.storage.put('day', { ...today(d, date), watch: next });
    } else if (d?.watch !== undefined) {
      const { watch: _gone, ...rest } = d;
      await this.storage.put('day', rest);
    }
  }

  /** The card's work for wake(): when to wake next, or null to stop. */
  private async cardWake(nowMs: number): Promise<number | null> {
    const env = this.env;
    const userId = await this.storage.get<string>('userId');
    if (!env || !userId) return null;
    // Nobody to tell: stop waking until a request asks again.
    if ((await pushDevices(env, userId)) === 0) return null;
    const stored = await this.storedDay();
    const date = sgtDate(nowMs);
    const day = stored && stored.date === date ? stored : null;
    // Plans are written before wake() reads the day back to note its next
    // wake, so that write can't put back a day from before them. Only they
    // are waited for: the object is billed for the time it's awake.
    const plans: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => this.state.waitUntil(p), passThroughOnException() {} } as unknown as ExecutionContext;
    const card = await tripCardFor(env, ctx, DEPS, userId, day, nowMs, (key, plan) => {
      const p = this.putPlan(date, key, plan).then(() => undefined);
      plans.push(p);
      return p;
    });
    await Promise.allSettled(plans);
    if (!card) return null;

    const last = (await this.storage.get<Pushed>('pushed')) ?? null;
    const now: Pushed = { key: card.key, phase: card.phase };
    // Only what was actually pushed counts: one device having fetched a card
    // says nothing about the others. Nothing to say yet is never the first push.
    const changed = last ? last.key !== now.key || last.phase !== now.phase : now.phase !== 'idle';
    if (changed) {
      // Wake the phone for what the user should see: time to go, a missed bus.
      const urgent = now.phase === 'due' || now.phase === 'missed';
      await nudgeUser(env, userId, { phase: now.phase, urgent, remind: card.remind }, nowMs);
      await this.storage.put('pushed', now);
    }
    // Keep waking while there's a trip and someone to tell.
    // A leave-by that keeps sliding (a late bus) mustn't wake it every few seconds.
    if (!card.key || card.wakeAt === null) return null;
    return Math.max(card.wakeAt, nowMs + MIN_WAKE_GAP_MS);
  }

  private async storedDay(): Promise<DayRecord | null> {
    return (await this.storage.get<DayRecord>('day')) ?? null;
  }

  private async putPlan(date: string, key: string, plan: Boarded): Promise<DayRecord> {
    const next = today(await this.storedDay(), date);
    next.plans = { ...next.plans, [key]: plan };
    await this.storage.put('day', next);
    return next;
  }

  /**
   * One alarm for both jobs: whichever of midnight and the next wake is
   * sooner. Writes midnight and sets the alarm only when they change.
   */
  private async arm(deleteAt?: number): Promise<void> {
    const stored = await this.storage.get<number>('deleteAt');
    if (deleteAt !== undefined && deleteAt !== stored) await this.storage.put('deleteAt', deleteAt);
    const del = deleteAt ?? stored;
    const wake = await this.storage.get<number>('wakeAt');
    const at = Math.min(...[del, wake].filter((x): x is number => typeof x === 'number'));
    // No alarm is pending while alarm() runs, so one is always set again then.
    if (Number.isFinite(at) && (await this.storage.getAlarm()) !== at) await this.storage.setAlarm(at);
  }
}

/**
 * The update a request asks for: /update carries any of the changes; the
 * single-purpose paths are what a Worker from before it sends, still taken
 * while a deploy rolls out.
 */
function updateOf(path: string, body: unknown): TripUpdate | null {
  const b = (body ?? {}) as Record<string, unknown> & { date: string; deleteAt: number };
  const base = { date: b.date, deleteAt: b.deleteAt };
  switch (path) {
    case '/update':
      return b as unknown as TripUpdate;
    case '/signal':
      return { ...base, items: (b.items as TripUpdate['items']) ?? [{ key: b.key as string, rec: (b.rec as TripRecord | null) ?? null }] };
    case '/plan':
      return { ...base, plans: { [b.key as string]: b.plan as Boarded } };
    case '/watch':
      return { ...base, watch: { userId: b.userId as string, at: b.at as number } };
    case '/followed':
      return { ...base, followed: b.at as number };
    default:
      return null;
  }
}

/** Today's record: the stored one if it's today's, else a fresh one. */
function today(day: DayRecord | null, date: string): DayRecord {
  return day && day.date === date ? day : { date, trips: {} };
}
