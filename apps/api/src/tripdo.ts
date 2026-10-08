/**
 * The `Trip` Durable Object: one per user, holding today's trip signals and
 * plans (trip.ts has the data and the helpers that talk to it).
 *
 * It has one alarm, used for two things:
 *
 * - **End of day:** at the next Singapore midnight everything is deleted.
 *   An object emptied early (the account was deleted) keeps only a `gone`
 *   mark until then, and refuses every write: a request already under way
 *   when the account went can't store the user's trip again.
 * - **Push (phase 3):** when the Worker has sent a card with a
 *   `nextChangeAt`, the object wakes then, works out the card again, and
 *   nudges the user's phones (push.ts) if the trip or its phase changed.
 *   It keeps waking at each new `nextChangeAt` while there's a trip and a
 *   device that takes push, and stops otherwise.
 */

import { loadCalendar } from './calendarsync.ts';
import type { Env } from './types.ts';
import { type Boarded, type DayRecord, type TripRecord, type TripUpdate, endOfDayMs, sgtDate } from './trip.ts';
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
    // Two devices' changes can arrive at once: without holding the object,
    // the second would put back a copy from before the first.
    if (req.method === 'POST') return this.state.blockConcurrencyWhile(() => this.handle(req));
    return this.handle(req);
  }

  private async handle(req: Request): Promise<Response> {
    await loadCalendar(this.env);
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/clear') {
      // deleteAll leaves the alarm (compatibility date before 2026-02-24); the
      // one set here replaces it. The mark and that alarm go at midnight.
      await this.storage.deleteAll();
      const deleteAt = endOfDayMs(Date.now());
      await this.storage.put('gone', true);
      await this.storage.put('deleteAt', deleteAt);
      await this.storage.setAlarm(deleteAt);
      return Response.json({ ok: true });
    }
    // A deleted account's object stores nothing more, and has no day to show.
    if (await this.storage.get<boolean>('gone')) {
      if (req.method === 'GET') return Response.json(null);
      if (url.pathname === '/watch') return Response.json({ ok: true });
      const { date } = (await req.json().catch(() => ({}))) as { date?: string };
      return Response.json(today(null, date ?? ''));
    }

    if (req.method === 'GET' && url.pathname === '/day') {
      const day = await this.storedDay();
      const date = url.searchParams.get('date') ?? '';
      // Yesterday's signals are never today's, even before the alarm has run.
      return Response.json(day && day.date === date ? day : null);
    }

    if (req.method === 'POST') {
      const u = updateOf(url.pathname, await req.json());
      if (u) return Response.json(await this.update(u));
    }

    return new Response('not found', { status: 404 });
  }

  /**
   * Applies every change one request carries (signals, plans, a
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
    // A storage write that throws in here resets the object, but a failed write
    // does that anyway (the output gate), and 'waking' makes the rerun wake again.
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
        } else if (next === undefined) {
          // No wake left: the day says so, and a request asks again (needsWatch)
          // rather than trusting a wake that's gone.
          const d = await this.storedDay();
          if (d?.watch !== undefined) {
            const { watch: _gone, ...rest } = d;
            await this.storage.put('day', rest);
          }
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
    // Held like a POST, and not after a /clear. The card hands them to
    // waitUntil; they're waited for here, so they land before the day is
    // read back to note the next wake. Only they are: the object is billed
    // for the time it's awake.
    const plans: Promise<unknown>[] = [];
    const savePlan = (key: string, plan: Boarded) => {
      const p = this.state.blockConcurrencyWhile(async () => {
        if (!(await this.cleared())) await this.putPlan(date, key, plan);
      });
      plans.push(p);
      return p;
    };
    const card = await tripCardFor(env, ctx, DEPS, userId, day, nowMs, savePlan);
    await Promise.allSettled(plans);
    if (!card) return stop;

    const last = (await this.storage.get<Pushed>('pushed')) ?? null;
    const now: Pushed = { key: card.key, phase: card.phase };
    // Only what was actually pushed counts: one device having fetched a card
    // says nothing about the others. Nothing to say yet is never the first push.
    const changed = last ? last.key !== now.key || last.phase !== now.phase : now.phase !== 'idle';
    if (changed) {
      // Wake the phone for what the user should see: time to go, a missed bus.
      // With reminders off too: these are what start the live notification on
      // Android, which may start it from the background only for a
      // high-priority message.
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

  /**
   * Whether /clear emptied the object (it leaves the 'gone' mark) or midnight
   * did (every stored day has its deleteAt).
   */
  private async cleared(): Promise<boolean> {
    if (await this.storage.get<boolean>('gone')) return true;
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

  /**
   * One alarm for both jobs: whichever of midnight and the next wake (or one
   * owed, see alarm) is sooner. Writes midnight and sets the alarm only when
   * they change.
   */
  private async arm(deleteAt?: number): Promise<void> {
    const stored = await this.storage.get<number>('deleteAt');
    if (deleteAt !== undefined && deleteAt !== stored) await this.storage.put('deleteAt', deleteAt);
    const del = deleteAt ?? stored;
    const wake = await this.storage.get<number>('wakeAt');
    const owed = await this.storage.get<number>('waking');
    const at = Math.min(...[del, wake, owed].filter((x): x is number => typeof x === 'number'));
    // No alarm is pending while alarm() runs, so one is always set again then.
    if (Number.isFinite(at) && (await this.storage.getAlarm()) !== at) await this.storage.setAlarm(at);
  }
}

/** Today's record: the stored one if it's today's, else a fresh one. */
function today(day: DayRecord | null, date: string): DayRecord {
  return day && day.date === date ? day : { date, trips: {} };
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
    default:
      return null;
  }
}
