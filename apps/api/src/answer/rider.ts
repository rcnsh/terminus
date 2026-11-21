import type { Env, MeAnswer } from '../types.ts';
import { getProfile } from '../accounts/profiles.ts';
import { NO_PREFS, type TripPrefs, tripPrefs } from '../accounts/outcomes.ts';
import { type Profile, classKey, classesOn, isResting } from '../timetable/profile.ts';
import { type Ask, DAY_ASK, type Rider, nextFor } from './next.ts';
import { type DayRecord, type Plan, type TripUpdate, loadDay, updateTrip } from './trip.ts';
import { type MeDeps, unlogged } from './answer.ts';
import { GRAPH } from './graph.ts';
import type { Card } from './card.ts';
import { type AnswerIn, type Nudge, nudgeUser, pushEnabled } from '../push/push.ts';
import { withLang } from '../i18n.ts';

export type NextBody = MeAnswer & { card: Card; walkSpeedMs: number };

export async function tripDay(env: Env, userId: string, profile: Profile, nowMs: number, asked?: Ask): Promise<DayRecord | null> {
  const tracked =
    Boolean(asked?.place || asked?.to) || classesOn(profile, nowMs).length > 0 || (profile.home !== null && isResting(profile, nowMs));
  if (!env.TRIPS || !tracked) return null;
  return loadDay(env, userId, nowMs);
}

const outcomeFailed = (e: unknown) => console.error('trip outcome not saved', e instanceof Error ? e.message : typeof e);

export async function prefsFor(db: D1Database, userId: string, profile: Profile, nowMs: number): Promise<TripPrefs> {
  const all = [...profile.trips, ...profile.manual];
  if (!all.length) return NO_PREFS;
  try {
    return await tripPrefs(db, userId, nowMs, (key) => all.find((t) => classKey(t) === key)?.label ?? null);
  } catch (err) {
    outcomeFailed(err);
    return NO_PREFS;
  }
}

export async function loadRider(
  env: Env,
  userId: string,
  nowMs: number,
  given: { profile?: Profile; day?: DayRecord | null; asked?: Ask } = {},
): Promise<Rider> {
  const profile = given.profile ?? (await getProfile(env.DB!, userId, GRAPH));
  const [day, prefs] = await Promise.all([
    given.day !== undefined ? given.day : tripDay(env, userId, profile, nowMs, given.asked),
    prefsFor(env.DB!, userId, profile, nowMs),
  ]);
  return { userId, profile, day, prefs };
}

interface Answered {
  answer: NextBody;
  tripOver: boolean;
  clockChosen: boolean;
  answerIn: AnswerIn;
}

export type WakeNudge = Pick<Nudge, 'urgent' | 'lang' | 'phaseChanged' | 'startLive' | 'startedFor'>;

export function nudgeOf(a: Answered, wake: WakeNudge = { urgent: false }): Nudge {
  return {
    phase: a.answer.card.phase,
    remind: a.answer.card.remind !== false,
    answer: a.answer,
    answerIn: a.answerIn,
    clockChosen: a.clockChosen,
    tripOver: a.tripOver,
    ...wake,
  };
}

async function requestAnswer(
  env: Env,
  ctx: ExecutionContext,
  deps: MeDeps,
  rider: Rider,
  ask: Ask,
  nowMs: number,
): Promise<{ body: NextBody; tripOver: boolean; shown: TripUpdate['pushed'] }> {
  const { body, update, trip } = await nextFor(env, ctx, deps, rider, ask, nowMs);
  if (update.items || update.plans || update.watch) {
    ctx.waitUntil(
      updateTrip(env, rider.userId, update, nowMs).then(
        () => undefined,
        (err: unknown) => console.error('trip state not saved', err instanceof Error ? err.message : typeof err),
      ),
    );
  }
  const isPlan = !ask.place && !ask.to;
  const shown: TripUpdate['pushed'] = isPlan
    ? { key: trip.key, phase: body.card.phase, at: nowMs, ...(body.card.gone ? { gone: true } : {}) }
    : undefined;
  return { body, tripOver: isPlan && trip.key === null, shown };
}

export async function answerRequest(
  env: Env,
  ctx: ExecutionContext,
  deps: MeDeps,
  rider: Rider,
  ask: Ask,
  nowMs: number,
  nudgeFrom?: string,
): Promise<NextBody> {
  const { body, tripOver, shown } = await requestAnswer(env, ctx, deps, rider, ask, nowMs);
  if (nudgeFrom !== undefined) {
    const nudge = nudgeOf({
      answer: body,
      tripOver,
      clockChosen: rider.profile.clock !== 'auto',
      answerIn: reword(env, ctx, deps, rider, ask, nowMs),
    });
    nudgeOthers(env, ctx, rider.userId, nudge, nowMs, nudgeFrom, shown);
  }
  return body;
}

function nudgeOthers(
  env: Env,
  ctx: ExecutionContext,
  userId: string,
  nudge: Nudge,
  nowMs: number,
  exceptTokenHash: string,
  shown: TripUpdate['pushed'],
): void {
  const note = shown && shown.phase !== 'due' && shown.phase !== 'missed' && pushEnabled(env) ? shown : undefined;
  ctx.waitUntil(
    nudgeUser(env, userId, nudge, nowMs, exceptTokenHash).then(async (out) => {
      if (!note || (out.sent === 0 && out.failed > 0)) return;
      await updateTrip(env, userId, { pushed: note }, nowMs).catch((err: unknown) =>
        console.error('trip push not noted', err instanceof Error ? err.message : typeof err),
      );
    }),
  );
}

export function reword(env: Env, ctx: ExecutionContext, deps: MeDeps, rider: Rider, ask: Ask, nowMs: number): AnswerIn {
  return (l, h12) => withLang(l, () => nextFor(env, ctx, unlogged(deps), rider, { ...ask, h12 }, nowMs)).then((r) => r.body);
}

export interface WakeCard extends Answered {
  key: string | null;
  wakeAt: number | null;
  leaveAt: number | null;
}

export async function answerWake(
  env: Env,
  ctx: ExecutionContext,
  deps: MeDeps,
  userId: string,
  day: DayRecord | null,
  nowMs: number,
  opts: { savePlan: (key: string, plan: Plan) => Promise<void>; h12?: boolean; rewordDeps?: MeDeps },
): Promise<WakeCard | null> {
  if (!env.DB) return null;
  const profile = await getProfile(env.DB, userId, GRAPH);
  if (!classesOn(profile, nowMs).length) return null;
  const rider = await loadRider(env, userId, nowMs, { profile, day });
  const ask = { ...DAY_ASK, h12: opts.h12 ?? false };
  const { body, trip, update, wakeAt } = await nextFor(env, ctx, unlogged(deps), rider, ask, nowMs);
  for (const [key, plan] of Object.entries(update.plans ?? {})) if (plan) ctx.waitUntil(opts.savePlan(key, plan));
  return {
    answer: body,
    tripOver: trip.key === null,
    clockChosen: profile.clock !== 'auto',
    answerIn: reword(env, ctx, opts.rewordDeps ?? deps, rider, ask, nowMs),
    key: trip.key,
    wakeAt,
    leaveAt: body.leave?.at ? Date.parse(body.leave.at) : null,
  };
}
