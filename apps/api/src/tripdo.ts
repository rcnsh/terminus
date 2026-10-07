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
import { type Boarded, type DayRecord, type TripRecord, sgtDate } from './trip.ts';
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
/** A wake that failed is tried again after the gap, doubling each time it fails again, up to this. */
const MAX_RETRY_GAP_MS = 8 * 60_000;

/** What was last pushed, so the same card isn't pushed twice. */
interface Pushed {
  key: string | null;
  phase: string;
}

/** What a wake found: when to wake next (null: stop). */
interface Woke {
  next: number | null;
  /** The wake failed: `next` is when to try again, not the card's next change. */
  retry?: boolean;
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
    // One /me/next sends a plan and a watch at once: without holding the
    // object, the second would put back a copy from before the first.
    if (req.method === 'POST') return this.state.blockConcurrencyWhile(() => this.handle(req));
    return this.handle(req);
  }

  private async handle(req: Request): Promise<Response> {
    await loadCalendar(this.env);
    const url = new URL(req.url);
    const day = await this.storedDay();

    if (req.method === 'GET' && url.pathname === '/day') {
      const date = url.searchParams.get('date') ?? '';
      // Yesterday's signals are never today's, even before the alarm has run.
      return Response.json(day && day.date === date ? day : null);
    }

    if (req.method === 'POST' && url.pathname === '/signal') {
      // One trip's record, or several at once ("Not on campus today").
      type Item = { key: string; rec: TripRecord | null };
      const body = (await req.json()) as Partial<Item> & { items?: Item[]; date: string; deleteAt: number };
      const items = body.items ?? [{ key: body.key!, rec: body.rec ?? null }];
      const next = today(day, body.date);
      for (const { key, rec } of items) {
        // A day has a handful of trips; past this many a new one is refused,
        // so the record stays far below a stored value's size limit.
        if (rec && !(key in next.trips) && Object.keys(next.trips).length >= MAX_DAY_TRIPS) continue;
        if (rec) next.trips[key] = rec;
        else delete next.trips[key];
      }
      await this.storage.put('day', next);
      await this.arm(body.deleteAt);
      return Response.json(next);
    }

    if (req.method === 'POST' && url.pathname === '/plan') {
      const body = (await req.json()) as { date: string; key: string; plan: Boarded; deleteAt: number };
      const next = await this.putPlan(body.date, body.key, body.plan);
      await this.arm(body.deleteAt);
      return Response.json(next);
    }

    if (req.method === 'POST' && url.pathname === '/watch') {
      const body = (await req.json()) as { userId: string; date: string; at: number; deleteAt: number };
      const next = today(day, body.date);
      next.watch = body.at;
      await this.storage.put('day', next);
      await this.storage.put('userId', body.userId);
      // Only ever sooner: a device refreshing after a moment the object still
      // owes a push for (say, "due") mustn't move that wake past it.
      const pending = await this.storage.get<number>('wakeAt');
      await this.storage.put('wakeAt', pending !== undefined ? Math.min(pending, body.at) : body.at);
      await this.arm(body.deleteAt);
      return Response.json({ ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/followed') {
      const body = (await req.json()) as { date: string; at: number; deleteAt: number };
      const next = today(day, body.date);
      next.followed = body.at;
      await this.storage.put('day', next);
      await this.arm(body.deleteAt);
      return Response.json(next);
    }

    if (req.method === 'POST' && url.pathname === '/clear') {
      // Before compatibility date 2026-02-24 deleteAll leaves the alarm, which
      // would then fire once more for nothing.
      await this.storage.deleteAlarm();
      await this.storage.deleteAll();
      return Response.json({ ok: true });
    }

    return new Response('not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    const nowMs = Date.now();
    await loadCalendar(this.env, nowMs);
    const deleteAt = await this.storage.get<number>('deleteAt');
    // Midnight (or an object from before phase 3, which only knew midnight).
    if (deleteAt === undefined || nowMs >= deleteAt - 1000) {
      // The alarm first: deleteAll leaves it (see /clear), and a SQLite
      // object's deleteAll inside its alarm has failed without that.
      await this.storage.deleteAlarm();
      await this.storage.deleteAll();
      return;
    }
    // The wake owed is moved aside, not dropped, until the wake is done: a
    // /watch meanwhile starts a fresh wakeAt, and an alarm the platform
    // runs again (this one threw, or the object restarted) still wakes.
    const owed = await this.storage.get<number>('waking');
    const asked = await this.storage.get<number>('wakeAt');
    const wakeAt = owed === undefined ? asked : asked === undefined ? owed : Math.min(owed, asked);
    let woke: Woke | null = null;
    if (wakeAt !== undefined && nowMs >= wakeAt - 1000) {
      await this.storage.put('waking', wakeAt);
      await this.storage.delete('wakeAt');
      const fails = (await this.storage.get<number>('wakeFails')) ?? 0;
      try {
        woke = await this.wake(nowMs);
        if (fails) await this.storage.delete('wakeFails');
      } catch (err) {
        // D1 or the feed failing mustn't end the day's pushes: try again soon, though not too often.
        console.error('trip wake failed', err instanceof Error ? err.message : typeof err);
        await this.storage.put('wakeFails', fails + 1);
        woke = { next: nowMs + Math.min(MIN_WAKE_GAP_MS * 2 ** fails, MAX_RETRY_GAP_MS), retry: true };
      }
    }
    // Held like a POST, so a /watch or /clear that came in while this woke
    // isn't undone: an earlier wake asked for stays, and a cleared object stays empty.
    await this.state.blockConcurrencyWhile(async () => {
      if (await this.cleared()) return;
      if (woke) {
        const asked = await this.storage.get<number>('wakeAt');
        const next = woke.next === null ? asked : asked === undefined ? woke.next : Math.min(asked, woke.next);
        if (next === undefined) await this.storage.delete('wakeAt');
        else await this.storage.put('wakeAt', next);
        await this.storage.delete('waking');
        // The card's next change, as /watch records it (a retry is no change of the card's).
        if (woke.next !== null && !woke.retry && next !== undefined) {
          const d = today(await this.storedDay(), sgtDate(nowMs));
          await this.storage.put('day', { ...d, watch: next });
        }
      }
      await this.arm();
    });
  }

  /** Works out the card again and pushes it if it changed; when to wake next. */
  private async wake(nowMs: number): Promise<Woke> {
    const stop: Woke = { next: null };
    const env = this.env;
    const userId = await this.storage.get<string>('userId');
    if (!env || !userId) return stop;
    // Nobody to tell: stop waking until a request asks again.
    if ((await pushDevices(env, userId)) === 0) return stop;
    const stored = await this.storedDay();
    const date = sgtDate(nowMs);
    const day = stored && stored.date === date ? stored : null;
    const ctx = { waitUntil: (p: Promise<unknown>) => this.state.waitUntil(p), passThroughOnException() {} } as unknown as ExecutionContext;
    // Held like POST /plan, and not after a /clear.
    const savePlan = (key: string, plan: Boarded) =>
      this.state.blockConcurrencyWhile(async () => {
        if (!(await this.cleared())) await this.putPlan(date, key, plan);
      });
    const card = await tripCardFor(env, ctx, DEPS, userId, day, nowMs, savePlan);
    if (!card) return stop;

    const last = (await this.storage.get<Pushed>('pushed')) ?? null;
    const now: Pushed = { key: card.key, phase: card.phase };
    // Only what was actually pushed counts: one device having fetched a card
    // says nothing about the others. Nothing to say yet is never the first push.
    const changed = last ? last.key !== now.key || last.phase !== now.phase : now.phase !== 'idle';
    if (changed) {
      // Wake the phone for what the user should see: time to go, a missed bus.
      const urgent = now.phase === 'due' || now.phase === 'missed';
      const out = await nudgeUser(env, userId, { phase: now.phase, urgent, remind: card.remind }, nowMs);
      // Pushed once a device has it, or when none could be sent to (a quiet
      // card for a browser): not when every send failed, so a later wake tries again.
      // Saved at once, held like a POST and not after a /clear: an alarm the
      // platform runs again (the object reset before the wake was done) then
      // sees it sent, rather than pushing it again within seconds.
      if (out.sent > 0 || out.failed === 0) {
        await this.state.blockConcurrencyWhile(async () => {
          if (!(await this.cleared())) await this.storage.put('pushed', now);
        });
      }
    }
    // Keep waking while there's a trip and someone to tell.
    // A leave-by that keeps sliding (a late bus) mustn't wake it every few seconds.
    const next = card.wakeAt === null ? null : Math.max(card.wakeAt, nowMs + MIN_WAKE_GAP_MS);
    return { next: card.key ? next : null };
  }

  /** Whether /clear emptied the object (or midnight did): every stored day has its deleteAt. */
  private async cleared(): Promise<boolean> {
    return (await this.storage.get<number>('deleteAt')) === undefined;
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

  /** One alarm for both jobs: whichever of midnight and the next wake (or one owed, see alarm) is sooner. */
  private async arm(deleteAt?: number): Promise<void> {
    if (deleteAt !== undefined) await this.storage.put('deleteAt', deleteAt);
    const del = deleteAt ?? (await this.storage.get<number>('deleteAt'));
    const wake = await this.storage.get<number>('wakeAt');
    const owed = await this.storage.get<number>('waking');
    const at = Math.min(...[del, wake, owed].filter((x): x is number => typeof x === 'number'));
    if (Number.isFinite(at)) await this.storage.setAlarm(at);
  }
}

/** Today's record: the stored one if it's today's, else a fresh one. */
function today(day: DayRecord | null, date: string): DayRecord {
  return day && day.date === date ? day : { date, trips: {} };
}
