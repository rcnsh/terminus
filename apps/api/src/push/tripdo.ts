/**
 * The `Trip` Durable Object: one per user, holding today's trip signals and
 * plans (trip.ts has the data and the helpers that talk to it).
 *
 * It has one alarm, used for two things:
 *
 * - **End of day:** at the next Singapore midnight everything is deleted.
 *   An object emptied early (the account was deleted) keeps only a
 *   deleted mark (stored as 'gone', not the card's `gone`) until then, and
 *   refuses every write: a request already under way when the account went
 *   can't store the user's trip again.
 * - **Push:** when the Worker has worked out a card, the object wakes at
 *   its next phase change (`nextPhaseAt`, not the card's `nextChangeAt`,
 *   which also counts going stale), works out the card again, and nudges
 *   the user's phones (push.ts) if the trip or its phase changed, starting
 *   an iPhone's Live Activity when it's due or missed. It keeps
 *   waking at each new one while there's a trip and a device that takes
 *   push, and stops otherwise.
 */

import { loadCalendar } from '../timetable/calendarsync.ts';
import type { Env } from '../types.ts';
import { type Plan, type DayRecord, type TripUpdate, endOfDayMs, sgtDate } from '../answer/trip.ts';
import type { MeDeps } from '../accounts/me.ts';
import { tripCardFor } from '../accounts/me.ts';
import { type Delivered, nudgeUser, pushAudience, retryLiveStart, updateLive } from './push.ts';
import { type LiveActivityState, apnsEnabled, liveActivityState } from './apns.ts';
import { type Lang, withLang } from '../i18n.ts';
import { logTripWake } from '../ops/analytics.ts';
import { scopeCache } from '../feeds/edgecache.ts';
import { answerFor, collectArrivals } from '../answer/answer.ts';

/** Trip records one day keeps at most (see update). */
export const MAX_DAY_TRIPS = 64;

/** Never wake again sooner than this after a wake. */
const MIN_WAKE_GAP_MS = 30_000;
/** A wake that failed is tried again after the gap, doubling each time it fails again, up to this. */
const MAX_RETRY_GAP_MS = 8 * 60_000;

/** What was last pushed, so the same card isn't pushed twice. */
interface Pushed {
  key: string | null;
  phase: string;
  /** The card's `gone`: the phase stays `heading` when the bus leaves, but
   *  the phones' "Leave now" must give way to it. */
  gone?: boolean;
  /** What iPhones' Live Activities were last sent (apns.ts), as JSON. */
  live?: string;
  /**
   * The trip iPhones' Live Activities were last started by push for, or seen
   * running for, and the sessions they were on. Started once per trip and
   * phone only: again, it would bring back one the user ended. `retry`: a
   * start didn't go (Apple out of reach), so later wakes try it again while
   * the trip is due or missed.
   */
  started?: Started;
}

interface Started {
  key: string;
  sessions: string[];
  retry?: boolean;
}

/** `started` with what a delivery's starts did: the sessions they reached, and whether any is left to try again. */
function withStarts(s: Started, out: Delivered): Started {
  return { key: s.key, sessions: [...new Set([...s.sessions, ...(out.started ?? [])])], ...(out.startFailed ? { retry: true } : {}) };
}

/** This object's last wake today, for the freshness log (analytics.ts logTripWake). */
interface LastWake {
  at: number;
  leaveAt: number | null;
}

/** What a wake found: when to wake next (null: stop). */
interface Woke {
  next: number | null;
  /** The wake failed: `next` is when to try again, not the card's next change. */
  retry?: boolean;
  /** A card was worked out: kept as the last wake. */
  seen?: LastWake;
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
      const { date } = (await req.json().catch(() => ({}))) as { date?: string };
      return Response.json(today(null, date ?? ''));
    }

    if (req.method === 'GET' && url.pathname === '/day') {
      const day = await this.storedDay();
      const date = url.searchParams.get('date') ?? '';
      // Yesterday's signals are never today's, even before the alarm has run.
      return Response.json(day && day.date === date ? day : null);
    }

    if (req.method === 'POST' && url.pathname === '/update') {
      return Response.json(await this.update((await req.json()) as TripUpdate));
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
    // Midnight (or an object with no deleteAt, from before it was kept, whose
    // only alarm was midnight).
    if (deleteAt === undefined || nowMs >= deleteAt - 1000) {
      // The alarm first: deleteAll leaves it (see /clear), and a SQLite
      // object's deleteAll inside its alarm has failed without that.
      await this.storage.deleteAlarm();
      await this.storage.deleteAll();
      return;
    }
    // The wake owed is moved aside, not dropped, until the wake is done: a
    // watch meanwhile starts a fresh wakeAt, and an alarm the platform
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
        woke = await this.wake(nowMs, wakeAt);
        if (fails) await this.storage.delete('wakeFails');
      } catch (err) {
        // D1, the feed or a Live Activity's end failing mustn't end the day's pushes: try again soon, though not too often.
        console.error('trip wake failed', err instanceof Error ? err.message : typeof err);
        await this.storage.put('wakeFails', fails + 1);
        woke = { next: nowMs + Math.min(MIN_WAKE_GAP_MS * 2 ** fails, MAX_RETRY_GAP_MS), retry: true };
      }
    }
    // Held like a POST, so a watch or /clear that came in while this woke
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
        if (woke.seen) await this.storage.put('lastWake', woke.seen);
        // The card's next change, as a watch records it (a retry is no change of the card's).
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
  private async wake(nowMs: number, askedAt: number): Promise<Woke> {
    const stop: Woke = { next: null };
    const env = this.env;
    const userId = await this.storage.get<string>('userId');
    if (!env || !userId) return stop;
    // Nobody to tell: stop waking until a request asks again. (An iPhone
    // counts only with APNs on.) The same read says whether there's an iPhone
    // to word things for, and a Live Activity to update.
    const audience = await pushAudience(env, userId);
    if (audience.devices === 0) return stop;
    const stored = await this.storedDay();
    const date = sgtDate(nowMs);
    const day = stored && stored.date === date ? stored : null;
    const ctx = { waitUntil: (p: Promise<unknown>) => this.state.waitUntil(p), passThroughOnException() {} } as unknown as ExecutionContext;
    // Held like a POST, and not after a /clear. The card hands them to
    // waitUntil; they're waited for here, so they land before the day is
    // read back to note the next wake. Only they are: the object is billed
    // for the time it's awake.
    const plans: Promise<unknown>[] = [];
    const savePlan = (key: string, plan: Plan) => {
      const p = this.state.blockConcurrencyWhile(async () => {
        if (!(await this.cleared())) await this.putPlan(date, key, plan);
      });
      plans.push(p);
      return p;
    };
    // The arrivals it reads, so the log can say how old they were.
    const read: number[] = [];
    const collect: MeDeps['collectArrivals'] = async (...args) => {
      const byStop = await collectArrivals(...args);
      for (const sa of byStop.values()) if (sa.available) read.push(sa.fetchedAt);
      return byStop;
    };
    const deps: MeDeps = { collectArrivals: collect, answerFor: (e, c, i, l, n) => answerFor(e, c, i, l, n, collect) };
    // Worded for the iPhones (their notifications and Live Activities): in
    // the account's language, or the latest iPhone's when it follows each
    // device. Another iPhone in the other language gets the card worded
    // again for it (answerIn), without saving plans a second time.
    const lang: Lang = audience.iphoneLang ?? 'en';
    const card = await withLang(lang, () => tripCardFor(env, ctx, deps, userId, day, nowMs, savePlan));
    await Promise.allSettled(plans);
    const last = (await this.storage.get<Pushed>('pushed')) ?? null;
    const apns = apnsEnabled(env) && audience.lives > 0;
    if (!card) {
      // No classes today (any more): a Live Activity still showing the trip ends.
      if (apns && last?.live) {
        const out = await updateLive(env, userId, { state: JSON.parse(last.live) as LiveActivityState }, 'end', nowMs);
        if (out.sent > 0 || out.failed === 0) {
          await this.state.blockConcurrencyWhile(async () => {
            if (!(await this.cleared())) await this.storage.put('pushed', { ...last, live: undefined });
          });
        } else {
          // Not ended (APNs paused or out of reach): the Lock Screen would keep
          // the finished trip, so the wake is tried again, as a failed one is.
          throw new Error('live activity end not sent');
        }
      }
      return stop;
    }

    const live = liveActivityState(card.answer);
    // The phones that have shown this trip: started for it, or running one now.
    const shown = typeof last?.started === 'object' && last.started.key === card.key ? last.started : null;
    const started: Started | undefined = card.key
      ? {
          key: card.key,
          sessions: [...new Set([...(shown?.sessions ?? []), ...audience.liveSessions])],
          ...(shown?.retry ? { retry: true } : {}),
        }
      : last?.started;
    const now: Pushed = {
      key: card.key,
      phase: card.phase,
      ...(card.gone ? { gone: true } : {}),
      live: JSON.stringify(live),
      ...(started ? { started } : {}),
    };
    // Only what was actually pushed counts: one device having fetched a card
    // says nothing about the others. Nothing to say yet is never the first push.
    const changed = last
      ? last.key !== now.key || last.phase !== now.phase || Boolean(last.gone) !== Boolean(now.gone)
      : now.phase !== 'idle';
    // The card worded again for an iPhone in the other language (plans aren't saved twice).
    const answerIn = (l: Lang) =>
      withLang(l, () => tripCardFor(env, ctx, { answerFor, collectArrivals }, userId, day, nowMs, async () => {})).then(
        (c) => c?.answer ?? null,
      );
    // A push due that reached no device: tried again at the next wake.
    let unsent = false;
    // A Live Activity's start that didn't go, tried again on its own while
    // the trip is due or missed: the leave alert that went with it did go.
    if (!changed && last && now.started?.retry && (now.phase === 'due' || now.phase === 'missed') && apnsEnabled(env)) {
      const out = await retryLiveStart(
        env,
        userId,
        { answer: card.answer, lang, answerIn, startedFor: new Set(now.started.sessions) },
        nowMs,
      );
      now.started = withStarts(now.started, out);
      const kept = { ...last, started: now.started };
      await this.state.blockConcurrencyWhile(async () => {
        if (!(await this.cleared())) await this.storage.put('pushed', kept);
      });
    }
    if (changed) {
      // Wake the phone for what the user should see: time to go, a missed bus.
      // With reminders off too: these are what start the live notification on
      // Android, which may start it from the background only for a
      // high-priority message.
      const urgent = now.phase === 'due' || now.phase === 'missed';
      // The same moments start an iPhone's Live Activity where none runs (push.ts).
      const startLive = urgent && apnsEnabled(env) && card.key !== null;
      const out = await nudgeUser(
        env,
        userId,
        {
          phase: now.phase,
          urgent,
          remind: card.remind,
          answer: card.answer,
          lang,
          answerIn,
          tripOver: card.key === null,
          phaseChanged: last?.phase !== now.phase,
          startLive,
          startedFor: new Set(now.started?.sessions),
        },
        nowMs,
      );
      if (startLive && now.started) now.started = withStarts(now.started, out);
      // Pushed once a device has it, or when none could be sent to (a quiet
      // card for a browser): not when every send failed, so a later wake tries again.
      // Saved at once, held like a POST and not after a /clear: an alarm the
      // platform runs again (the object reset before the wake was done) then
      // sees it sent, rather than pushing it again within seconds.
      if (out.sent > 0 || out.failed === 0) {
        await this.state.blockConcurrencyWhile(async () => {
          if (!(await this.cleared())) await this.storage.put('pushed', now);
        });
      } else unsent = true;
    } else if (apns && last && last.live !== now.live) {
      // The same phase, but what a Live Activity shows moved (a later bus):
      // only the iPhones running one are told, each in its own language.
      const out = await updateLive(
        env,
        userId,
        { answer: card.answer, lang, answerIn },
        card.key === null || live.phase === 'arrived' ? 'end' : 'update',
        nowMs,
      );
      if (out.sent > 0 || out.failed === 0) {
        await this.state.blockConcurrencyWhile(async () => {
          if (!(await this.cleared())) await this.storage.put('pushed', now);
        });
      } else unsent = true;
    }
    // The trip is over but its end didn't go: with no next change to wake
    // for, the wake is tried again, as a failed one is.
    if (unsent && !card.key) throw new Error('trip end not sent');
    const prev = (await this.storage.get<LastWake>('lastWake')) ?? null;
    const before = prev && sgtDate(prev.at) === date ? prev : null;
    logTripWake(env, {
      changed,
      phase: now.phase,
      quality: card.quality,
      first: !before,
      gapS: before ? Math.round((nowMs - before.at) / 1000) : 0,
      feedAgeS: read.length ? Math.max(0, Math.round((nowMs - Math.min(...read)) / 1000)) : -1,
      leaveShiftS: before?.leaveAt != null && card.leaveAt !== null ? Math.round((card.leaveAt - before.leaveAt) / 1000) : 0,
      lateS: Math.max(0, Math.round((nowMs - askedAt) / 1000)),
    });
    const seen = { at: nowMs, leaveAt: card.leaveAt };
    // Keep waking while there's a trip and someone to tell.
    // A leave-by that keeps sliding (a late bus) mustn't wake it every few seconds.
    const next = card.wakeAt === null ? null : Math.max(card.wakeAt, nowMs + MIN_WAKE_GAP_MS);
    return { next: card.key ? next : null, seen };
  }

  /**
   * Whether /clear emptied the object (it leaves the deleted mark) or midnight
   * did (every stored day has its deleteAt).
   */
  private async cleared(): Promise<boolean> {
    if (await this.storage.get<boolean>('gone')) return true;
    return (await this.storage.get<number>('deleteAt')) === undefined;
  }

  private async storedDay(): Promise<DayRecord | null> {
    return (await this.storage.get<DayRecord>('day')) ?? null;
  }

  private async putPlan(date: string, key: string, plan: Plan): Promise<DayRecord> {
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
