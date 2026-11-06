/**
 * The rider's answer: /api/me/next's card worked out for a rider, what it
 * changes saved as each kind of caller should, and the rider's other
 * devices nudged with it. Routes change the day, then answer here; the Trip
 * object answers here when it wakes.
 *
 * - **request**: someone asked. Logged; everything the answer changes is
 *   saved after the response; with `nudgeFrom`, every other device is told.
 * - **wake**: the Trip object worked it out itself. Not logged; only the
 *   plans are kept, through the object's own save; every device is told.
 * - **reword**: the same answer in another language or clock, for an
 *   iPhone pushed in that one. Saves nothing.
 */

import type { Env, MeAnswer } from '../types.ts';
import { getProfile } from '../accounts/profiles.ts';
import { NO_PREFS, type TripPrefs, tripPrefs } from '../accounts/outcomes.ts';
import { type Profile, classKey, classesOn } from '../timetable/profile.ts';
import { type Ask, DAY_ASK, type Rider, nextFor } from './next.ts';
import { type DayRecord, type Plan, type TripUpdate, loadDay, updateTrip } from './trip.ts';
import { type MeDeps, unlogged } from './answer.ts';
import { GRAPH } from './graph.ts';
import type { Card } from './card.ts';
import { type AnswerIn, type Nudge, nudgeUser, pushEnabled } from '../push/push.ts';
import { withLang } from '../i18n.ts';

/** /api/me/next's body: the answer and its card. */
export type NextBody = MeAnswer & { card: Card; walkSpeedMs: number };

/** Today's trip signals, looked up only when there's a trip to track today. */
export async function tripDay(env: Env, userId: string, profile: Profile, nowMs: number): Promise<DayRecord | null> {
  if (!env.TRIPS || !classesOn(profile, nowMs).length) return null;
  return loadDay(env, userId, nowMs);
}

const outcomeFailed = (e: unknown) => console.error('trip outcome not saved', e instanceof Error ? e.message : typeof e);

/** The user's trip choices and what terminus has learned, or none if D1 can't say. */
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

/**
 * Who a request plans for: the saved profile and today's trip signals, unless
 * the request has just changed them (then those), and their trip choices.
 * Read after any outcome the request records, so the choices include it.
 */
export async function loadRider(
  env: Env,
  userId: string,
  nowMs: number,
  given: { profile?: Profile; day?: DayRecord | null } = {},
): Promise<Rider> {
  const profile = given.profile ?? (await getProfile(env.DB!, userId, GRAPH));
  const [day, prefs] = await Promise.all([
    given.day !== undefined ? given.day : tripDay(env, userId, profile, nowMs),
    prefsFor(env.DB!, userId, profile, nowMs),
  ]);
  return { userId, profile, day, prefs };
}

/** What a nudge says about one answer, whoever worked it out. */
interface Answered {
  answer: NextBody;
  /** The answer has no trip: an iPhone's Live Activity ends. */
  tripOver: boolean;
  /** The account chose 12- or 24-hour times. */
  clockChosen: boolean;
  answerIn: AnswerIn;
}

/** What only a wake knows: how loud to be, and the Live Activities it starts (tripdo.ts). */
export type WakeNudge = Pick<Nudge, 'urgent' | 'lang' | 'phaseChanged' | 'startLive' | 'startedFor'>;

/** The nudge for an answer: the one place a card becomes what the devices are pushed. A wake adds what only it knows. */
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

/**
 * A request's answer, logged, without the nudge: what it changes in the Trip
 * object (arrived, the plan, a watch) is saved after the response, so a
 * failure loses the plan or a push, not the card. `shown` is the day's card
 * as the Trip object's wake works it out (a place's or a stop's isn't), for
 * nudgeOthers to note as pushed.
 */
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
  // The day's plan, not a place or stop asked for: those have no trip key
  // either, but the day's trip goes on.
  const isPlan = !ask.place && !ask.to;
  const shown: TripUpdate['pushed'] = isPlan
    ? { key: trip.key, phase: body.card.phase, at: nowMs, ...(body.card.gone ? { gone: true } : {}) }
    : undefined;
  return { body, tripOver: isPlan && trip.key === null, shown };
}

/**
 * The answer for a request, logged, with what it changes saved after the
 * response (requestAnswer). With `nudgeFrom` (the calling session's token
 * hash), the rider's other devices are told now, not at their next refresh;
 * the calling device already has the answer.
 */
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

/**
 * A request's nudge to the rider's other devices, noted in the Trip object
 * as pushed once a device has it (or none could be sent to), as a wake notes
 * its own: the wake after the request (one the request made stale is 30 s
 * on) then doesn't push the same card again. Not time to go or a missed
 * bus: those are the wake's to push loudly, starting a Live Activity, and a
 * request's nudge is quiet. Never throws.
 */
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

/**
 * An answer worded in another language or clock, for an iPhone pushed in
 * that one (push.ts asks only then): worked out as the first was, from the
 * same moment, so its arrivals come from the edge cache, and saving nothing
 * (no plan, no watch, not logged), as the first one's caller already has.
 */
export function reword(env: Env, ctx: ExecutionContext, deps: MeDeps, rider: Rider, ask: Ask, nowMs: number): AnswerIn {
  return (l, h12) => withLang(l, () => nextFor(env, ctx, unlogged(deps), rider, { ...ask, h12 }, nowMs)).then((r) => r.body);
}

/** The card the Trip object works out when it wakes. Its phase and the rest are read from `answer`, and its nudge is nudgeOf's, so none is kept twice. */
export interface WakeCard extends Answered {
  key: string | null;
  wakeAt: number | null;
  /** The leave-by, for the wake's freshness log (tripdo.ts). */
  leaveAt: number | null;
}

/**
 * The card as a request would get it, for the Trip object when it wakes:
 * which trip, its phase, when it next changes. Not logged. Of what the card
 * changes only the plans are kept, by `savePlan` (the object's save, which
 * gives way to a step or plan saved meanwhile): a wake neither ends a trip
 * nor asks itself to watch, and only a request with a location drops a
 * plan. Worded with 12-hour times or not (`h12`) unless the account chose;
 * its rewording for other iPhones uses `rewordDeps`. Null with no class today.
 */
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
    // A wake always asks for the day's plan.
    tripOver: trip.key === null,
    clockChosen: profile.clock !== 'auto',
    answerIn: reword(env, ctx, opts.rewordDeps ?? deps, rider, ask, nowMs),
    key: trip.key,
    wakeAt,
    leaveAt: body.leave?.at ? Date.parse(body.leave.at) : null,
  };
}
