import { loadCalendar } from '../timetable/calendarsync.ts';
import type { Env } from '../types.ts';
import { type Plan, type DayRecord, type TripUpdate, endOfDayMs, sgtDate, tripRev } from '../answer/trip.ts';
import type { MeDeps } from '../answer/answer.ts';
import { answerWake, nudgeOf } from '../answer/rider.ts';
import { type Delivered, nudgeUser, pushAudience, retryLiveStart, updateLive } from './push.ts';
import { type LiveActivityState, apnsEnabled, liveActivityState } from './apns.ts';
import { type Lang, withLang } from '../i18n.ts';
import { logTripWake } from '../ops/analytics.ts';
import { scopeCache } from '../feeds/edgecache.ts';
import { STEP } from '../config.ts';
import { answerFor, collectArrivals } from '../answer/answer.ts';

export const MAX_DAY_TRIPS = 64;

const MIN_WAKE_GAP_MS = 30_000;
const MAX_RETRY_GAP_MS = 8 * 60_000;

interface Pushed {
  key: string | null;
  phase: string;
  at?: number;
  gone?: boolean;
  live?: string;
  started?: Started;
}

interface Started {
  key: string;
  sessions: string[];
  retry?: boolean;
}

function withStarts(s: Started, out: Delivered): Started {
  return { key: s.key, sessions: [...new Set([...s.sessions, ...(out.started ?? [])])], ...(out.startFailed ? { retry: true } : {}) };
}

interface LastWake {
  at: number;
  leaveAt: number | null;
}

interface Woke {
  next: number | null;
  retry?: boolean;
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
    if (req.method === 'POST') return this.state.blockConcurrencyWhile(() => this.handle(req));
    return this.handle(req);
  }

  private async handle(req: Request): Promise<Response> {
    await loadCalendar(this.env);
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/clear') {
      await this.storage.deleteAll();
      const deleteAt = endOfDayMs(Date.now());
      await this.storage.put('gone', true);
      await this.storage.put('deleteAt', deleteAt);
      await this.storage.setAlarm(deleteAt);
      return Response.json({ ok: true });
    }
    if (await this.storage.get<boolean>('gone')) {
      if (req.method === 'GET') return Response.json(null);
      const { date } = (await req.json().catch(() => ({}))) as { date?: string };
      return Response.json(today(null, date ?? ''));
    }

    if (req.method === 'GET' && url.pathname === '/day') {
      const day = await this.storedDay();
      const date = url.searchParams.get('date') ?? '';
      return Response.json(day && day.date === date ? day : null);
    }

    if (req.method === 'POST' && url.pathname === '/update') {
      return Response.json(await this.update((await req.json()) as TripUpdate));
    }

    return new Response('not found', { status: 404 });
  }

  private async update(u: TripUpdate): Promise<DayRecord> {
    const stored = await this.storedDay();
    const next = today(stored, u.date);
    let changed = next !== stored;
    const fresh = (key: string) => typeof u.basis?.[key] !== 'number' || tripRev(next, key) === u.basis[key];
    const plansIn = Object.entries(u.plans ?? {}).filter(([key]) => fresh(key));
    for (const { key, rec } of u.items ?? []) {
      if (rec && !(key in next.trips) && Object.keys(next.trips).length >= MAX_DAY_TRIPS) continue;
      if (rec) next.trips[key] = rec;
      else delete next.trips[key];
      bump(next, key);
      changed = true;
    }
    if (plansIn.length) {
      const plans = { ...next.plans };
      for (const [key, plan] of plansIn) {
        if (plan) plans[key] = plan;
        else delete plans[key];
        bump(next, key);
      }
      next.plans = plans;
      changed = true;
    }
    for (const [key, step] of Object.entries(u.steps ?? {})) {
      const steps = { ...next.steps };
      if (step && !(key in steps) && Object.keys(steps).length >= STEP.maxTrips) continue;
      if (step) steps[key] = step;
      else delete steps[key];
      next.steps = steps;
      if (next.plans?.[key]) {
        const { [key]: _old, ...plans } = next.plans;
        next.plans = plans;
      }
      bump(next, key);
      changed = true;
    }
    const refused = plansIn.length < Object.keys(u.plans ?? {}).length;
    if (u.watch && !refused) {
      if ((await this.storage.get<string>('userId')) !== u.watch.userId) await this.storage.put('userId', u.watch.userId);
      const pending = await this.storage.get<number>('wakeAt');
      const last = await this.storage.get<LastWake>('lastWake');
      const asked = last ? Math.max(u.watch.at, last.at + MIN_WAKE_GAP_MS) : u.watch.at;
      const at = pending !== undefined ? Math.min(pending, asked) : asked;
      if (at !== pending) await this.storage.put('wakeAt', at);
      if (next.watch !== at) {
        next.watch = at;
        changed = true;
      }
    }
    if (u.pushed) {
      const last = await this.storage.get<Pushed>('pushed');
      if (!(last?.at !== undefined && last.at > u.pushed.at)) {
        const now: Pushed = { ...last, key: u.pushed.key, phase: u.pushed.phase, at: u.pushed.at };
        if (u.pushed.gone) now.gone = true;
        else delete now.gone;
        await this.storage.put('pushed', now);
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
    if (deleteAt === undefined || nowMs >= deleteAt - 1000) {
      await this.storage.deleteAlarm();
      await this.storage.deleteAll();
      return;
    }
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
        console.error('trip wake failed', err instanceof Error ? err.message : typeof err);
        await this.storage.put('wakeFails', fails + 1);
        woke = { next: nowMs + Math.min(MIN_WAKE_GAP_MS * 2 ** fails, MAX_RETRY_GAP_MS), retry: true };
      }
    }
    await this.state.blockConcurrencyWhile(async () => {
      if (await this.cleared()) return;
      if (woke) {
        const asked = await this.storage.get<number>('wakeAt');
        const next = woke.next === null ? asked : asked === undefined ? woke.next : Math.min(asked, woke.next);
        if (next === undefined) await this.storage.delete('wakeAt');
        else await this.storage.put('wakeAt', next);
        await this.storage.delete('waking');
        if (woke.seen) await this.storage.put('lastWake', woke.seen);
        if (woke.next !== null && !woke.retry && next !== undefined) {
          const d = today(await this.storedDay(), sgtDate(nowMs));
          await this.storage.put('day', { ...d, watch: next });
        } else if (next === undefined) {
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

  private async wake(nowMs: number, askedAt: number): Promise<Woke> {
    const stop: Woke = { next: null };
    const env = this.env;
    const userId = await this.storage.get<string>('userId');
    if (!env || !userId) return stop;
    const audience = await pushAudience(env, userId);
    if (audience.devices === 0) return stop;
    const stored = await this.storedDay();
    const date = sgtDate(nowMs);
    const day = stored && stored.date === date ? stored : null;
    const ctx = { waitUntil: (p: Promise<unknown>) => this.state.waitUntil(p), passThroughOnException() {} } as unknown as ExecutionContext;
    const plans: Promise<unknown>[] = [];
    const revs = new Map<string, number>();
    const expected = (key: string) => revs.get(key) ?? tripRev(day, key);
    const savePlan = (key: string, plan: Plan) => {
      const p = this.state.blockConcurrencyWhile(async () => {
        if (await this.cleared()) return;
        revs.set(key, (await this.putPlan(date, key, plan, expected(key))) ?? expected(key));
      });
      plans.push(p);
      return p;
    };
    const read: number[] = [];
    const collect: MeDeps['collectArrivals'] = async (...args) => {
      const byStop = await collectArrivals(...args);
      for (const sa of byStop.values()) if (sa.available) read.push(sa.fetchedAt);
      return byStop;
    };
    const deps: MeDeps = { collectArrivals: collect, answerFor: (e, c, i, l, n) => answerFor(e, c, i, l, n, collect) };
    const lang: Lang = audience.iphoneLang ?? 'en';
    const card = await withLang(lang, () =>
      answerWake(env, ctx, deps, userId, day, nowMs, { savePlan, h12: audience.iphoneH12, rewordDeps: { answerFor, collectArrivals } }),
    );
    await Promise.allSettled(plans);
    const keys = new Set([...revs.keys(), ...(card?.key ? [card.key] : [])]);
    let stale = false;
    if (keys.size && !(await this.cleared())) {
      const stored = today(await this.storedDay(), date);
      stale = [...keys].some((k) => tripRev(stored, k) !== expected(k));
    }
    const prev = (await this.storage.get<LastWake>('lastWake')) ?? null;
    const before = prev && sgtDate(prev.at) === date ? prev : null;
    const log = (changed: boolean, phase: string, quality: string, leaveAt: number | null) =>
      logTripWake(env, {
        changed,
        phase,
        quality,
        first: !before,
        gapS: before ? Math.round((nowMs - before.at) / 1000) : 0,
        feedAgeS: read.length ? Math.max(0, Math.round((nowMs - Math.min(...read)) / 1000)) : -1,
        leaveShiftS: before?.leaveAt != null && leaveAt !== null ? Math.round((leaveAt - before.leaveAt) / 1000) : 0,
        lateS: Math.max(0, Math.round((nowMs - askedAt) / 1000)),
      });
    if (stale) {
      if (card) log(false, card.answer.card.phase, card.answer.quality, null);
      return { next: nowMs + MIN_WAKE_GAP_MS, seen: { at: nowMs, leaveAt: before?.leaveAt ?? null } };
    }
    const last = (await this.storage.get<Pushed>('pushed')) ?? null;
    const apns = apnsEnabled(env) && audience.lives > 0;
    if (!card) {
      if (apns && last?.live) {
        const out = await updateLive(env, userId, { state: JSON.parse(last.live) as LiveActivityState }, 'end', nowMs);
        if (out.sent > 0 || out.failed === 0) {
          await this.state.blockConcurrencyWhile(async () => {
            if (!(await this.cleared())) await this.storage.put('pushed', { ...last, live: undefined });
          });
        } else {
          throw new Error('live activity end not sent');
        }
      }
      return stop;
    }

    const live = liveActivityState(card.answer);
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
      phase: card.answer.card.phase,
      at: nowMs,
      ...(card.answer.card.gone ? { gone: true } : {}),
      live: JSON.stringify(live),
      ...(started ? { started } : {}),
    };
    const changed = last
      ? last.key !== now.key || last.phase !== now.phase || Boolean(last.gone) !== Boolean(now.gone)
      : now.phase !== 'idle';
    const { answerIn, clockChosen } = card;
    let unsent = false;
    if (!changed && last && now.started?.retry && (now.phase === 'due' || now.phase === 'missed') && apnsEnabled(env)) {
      const out = await retryLiveStart(
        env,
        userId,
        { answer: card.answer, lang, answerIn, clockChosen, startedFor: new Set(now.started.sessions) },
        nowMs,
      );
      now.started = withStarts(now.started, out);
      const kept = { ...last, started: now.started };
      await this.state.blockConcurrencyWhile(async () => {
        if (!(await this.cleared())) await this.storage.put('pushed', kept);
      });
    }
    if (changed) {
      const urgent = now.phase === 'due' || now.phase === 'missed';
      const startLive = urgent && apnsEnabled(env) && card.key !== null;
      const out = await nudgeUser(
        env,
        userId,
        nudgeOf(card, { urgent, lang, phaseChanged: last?.phase !== now.phase, startLive, startedFor: new Set(now.started?.sessions) }),
        nowMs,
      );
      if (startLive && now.started) now.started = withStarts(now.started, out);
      if (out.sent > 0 || out.failed === 0) {
        await this.state.blockConcurrencyWhile(async () => {
          if (!(await this.cleared())) await this.storage.put('pushed', now);
        });
      } else unsent = true;
    } else if (apns && last && last.live !== now.live) {
      const out = await updateLive(
        env,
        userId,
        { answer: card.answer, lang, answerIn, clockChosen },
        card.key === null || live.phase === 'arrived' ? 'end' : 'update',
        nowMs,
      );
      if (out.sent > 0 || out.failed === 0) {
        await this.state.blockConcurrencyWhile(async () => {
          if (!(await this.cleared())) await this.storage.put('pushed', now);
        });
      } else unsent = true;
    }
    if (unsent && !card.key) throw new Error('trip end not sent');
    log(changed, now.phase, card.answer.quality, card.leaveAt);
    const seen = { at: nowMs, leaveAt: card.leaveAt };
    const next = card.wakeAt === null ? null : Math.max(card.wakeAt, nowMs + MIN_WAKE_GAP_MS);
    return { next: card.key ? next : null, seen };
  }

  private async cleared(): Promise<boolean> {
    if (await this.storage.get<boolean>('gone')) return true;
    return (await this.storage.get<number>('deleteAt')) === undefined;
  }

  private async storedDay(): Promise<DayRecord | null> {
    return (await this.storage.get<DayRecord>('day')) ?? null;
  }

  private async putPlan(date: string, key: string, plan: Plan, rev: number): Promise<number | null> {
    const next = today(await this.storedDay(), date);
    if (tripRev(next, key) !== rev) return null;
    next.plans = { ...next.plans, [key]: plan };
    const r = bump(next, key);
    await this.storage.put('day', next);
    return r;
  }

  private async arm(deleteAt?: number): Promise<void> {
    const stored = await this.storage.get<number>('deleteAt');
    if (deleteAt !== undefined && deleteAt !== stored) await this.storage.put('deleteAt', deleteAt);
    const del = deleteAt ?? stored;
    const wake = await this.storage.get<number>('wakeAt');
    const owed = await this.storage.get<number>('waking');
    const at = Math.min(...[del, wake, owed].filter((x): x is number => typeof x === 'number'));
    if (Number.isFinite(at) && (await this.storage.getAlarm()) !== at) await this.storage.setAlarm(at);
  }
}

function bump(day: DayRecord, key: string): number {
  const r = tripRev(day, key) + 1;
  day.revs = { ...day.revs, [key]: r };
  return r;
}

function today(day: DayRecord | null, date: string): DayRecord {
  return day && day.date === date ? day : { date, trips: {} };
}
