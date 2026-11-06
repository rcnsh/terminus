/**
 * Workers Analytics Engine logging.
 *
 * Two reasons this exists, and the second is the one that matters.
 *
 * 1. Nothing else measures whether the direction algorithm is RIGHT. The app
 *    will happily send you across the road with confidence 0.97 forever and
 *    never once tell you it was wrong. Logging the decision means you can go
 *    back and check.
 *
 * 2. It collects segment travel times. Inter-stop times are not in the feed,
 *    and the router cannot be good without them. `plate` is the join key: the
 *    same vehicle seen at two stops with two ETAs gives you the travel time
 *    between them.
 *
 * Analytics Engine writes are synchronous, non-blocking and unsampled at this
 * volume. Nothing here may ever throw into a response path -- an answer that
 * fails because logging failed would be an absurd way to miss a bus.
 *
 * Each kind's columns are declared once, in ROWS (analytics-rows.ts), and
 * written by name through writeRow there. What each kind means, and what
 * the rows hold about people, is in docs/analytics.md.
 */

import type { Answer, Env, ScoredOption, StopArrivals } from '../types.ts';
import { collectingMemo } from './collect.ts';
import { analyticsEnabled, writeRow } from '../analytics-rows.ts';
import type { RowFields } from '../analytics-rows.ts';

export { analyticsEnabled };

/** Arrival rows per request. Bounded so one tap cannot write a hundred rows. */
const MAX_ARRIVAL_ROWS = 8;

export interface LogInput {
  answer: Answer;
  best: ScoredOption | null;
  dest: string | null;
  hadCoords: boolean;
  walkAllS: number | null;
}

export function logAnswer(env: Env, input: LogInput): void {
  // writeRow checks too; this saves building rows nobody keeps.
  if (!analyticsEnabled(env)) return;
  const { answer, best } = input;
  const stop = answer.stop.code || 'none';
  const hadCoords = input.hadCoords ? 1 : 0;

  writeRow(env, 'answer', {
    stop,
    svc: best?.svc ?? '',
    dest: input.dest ?? '',
    quality: answer.quality,
    crowd: best?.arrival?.crowd ?? '',
    berth: best?.arrival?.berth ?? '',
    via: best?.change?.stop.code ?? '',
    svc2: best?.change?.svc ?? '',
    boardS: best?.boardS ?? -1,
    rideS: best?.rideS ?? -1,
    totalS: best?.totalS ?? -1,
    hops: best?.hops ?? -1,
    walkS: best?.walkS ?? -1,
    confidence: answer.stop.confidence,
    ambiguousBerth: best?.ambiguousBerth ? 1 : 0,
    hadCoords,
    walkAllS: input.walkAllS ?? -1,
    changeWaitS: best?.change ? best.change.boardS - best.change.reachS - best.change.crossS : -1,
  });

  // The segment-time seed. Every arrival at the chosen stop, with its plate.
  for (const a of answer.arrivals.slice(0, MAX_ARRIVAL_ROWS)) {
    if (a.etaS == null) continue; // "no bus" carries no timing information
    writeRow(env, 'arrival', {
      stop,
      svc: a.svc,
      dest: input.dest ?? '',
      quality: answer.quality,
      plate: a.plate ?? '',
      crowd: a.crowd ?? '',
      berth: a.berth ?? '',
      etaS: a.etaS,
      // The answer's own columns, which an arrival doesn't have: -1 as an answer without a bus writes them.
      boardS: -1,
      rideS: -1,
      totalS: -1,
      hops: -1,
      walkS: -1,
      confidence: answer.stop.confidence,
      ambiguousBerth: 0,
      hadCoords,
      walkAllS: -1,
    });
  }
}

/**
 * Rows per board: two buses a service, for the most services a stop has.
 * Eight boards (/api/me/stops at most) and an answer's rows stay under
 * Analytics Engine's 250 writes per invocation.
 */
const MAX_BOARD_ROWS = 16;

/**
 * A shuttle board just fetched from NUS, as 'board' rows, when the operator
 * collects `eta`: the arrival model's questions (eta.ts predictionsFor), at
 * every stop the Worker asks about. Called once per call to NUS, so a
 * cached copy read again adds nothing. Each time counts from when the row
 * is written, so a few hundred ms of fetch and switch read don't make the
 * bus look late. No destination, request or location.
 */
export async function logBoard(env: Env, sa: StopArrivals): Promise<void> {
  if (!analyticsEnabled(env) || !(await collectingMemo(env, 'eta'))) return;
  const lagS = Math.max(0, (Date.now() - sa.fetchedAt) / 1000);
  let n = 0;
  for (const a of sa.arrivals) {
    // A board's "no bus" and a timetabled first bus aren't a bus on the road to check.
    if (a.etaS == null || !a.plate || a.scheduled) continue;
    if (++n > MAX_BOARD_ROWS) break;
    writeRow(env, 'board', {
      stop: sa.code,
      svc: a.svc,
      dest: '',
      quality: 'live',
      plate: a.plate,
      crowd: a.crowd ?? '',
      berth: a.berth ?? '',
      etaS: Math.max(0, a.etaS - lagS),
    });
  }
}

/**
 * One /api/me/next answered, and how long it took: from the request
 * reaching the Worker to its answer built, D1, the Trip object and the
 * feeds included (not the trip to and from the Worker). A row for every
 * answer, a bus in it or not, so its quantiles are what opening the app costs.
 */
export function logNextTook(env: Env, tookMs: number): void {
  writeRow(env, 'next', { tookMs: Math.max(0, Math.round(tookMs)) });
}

/**
 * An unhandled error, for the dashboard's error count: the route only, since
 * a query string can hold coordinates. Nothing else is filled in.
 */
export function logError(env: Env, path: string): void {
  // /api/me/devices/abc123 is one route, not one per device.
  const parts = path.split('/');
  const route = parts.slice(0, parts[1] === 'api' ? 4 : 3).join('/') || '/';
  writeRow(env, 'error', { route });
}

/**
 * A cron step that failed (monitor.ts runCron), counted with the errors on
 * the dashboard as the route 'cron <step>'. No email: the logs say why.
 */
export function logCronError(env: Env, step: string): void {
  writeRow(env, 'error', { route: `cron ${step}` });
}

/**
 * What one poll of the timelapse recorder cost NUS, for the dashboard:
 *
 * - `upstream`: it went to the feed (a real request to NUS) and got an answer;
 * - `error`: it went to the feed and the request failed (still a request);
 * - `hit`: the edge cache had a fresh answer (a user's request paid for it);
 * - `stale`: the feed was failing and an older answer was all there was;
 * - `failed`: nothing to record, without asking (it failed a moment ago);
 * - `skipped`: the breaker was open, so it didn't ask at all;
 * - `retry`: one more request inside a poll (a fresh token, a second call),
 *   logged alongside the poll's own outcome.
 *
 * Requests to NUS are `upstream` plus `error` plus `retry`.
 */
export type PollOutcome = 'upstream' | 'error' | 'hit' | 'stale' | 'failed' | 'skipped' | 'retry';

export function logPoll(env: Env, outcome: PollOutcome, svc: string, buses: number): void {
  writeRow(env, 'timelapse', { outcome, svc, buses });
}

/**
 * One Trip object wake (tripdo.ts), to see how stale pushed cards get and
 * why: the wake schedule or the cache. No user, trip or stop in it.
 *
 * - `changed`: the card was pushed (its trip, phase or gone moved);
 * - `gapS`: seconds since this object's last wake today (0 for the first);
 * - `feedAgeS`: how old the oldest arrivals reading it used was (-1: none);
 * - `leaveShiftS`: how far the leave-by moved since the last wake (0 when
 *   either had none), which a sooner wake would have caught sooner;
 * - `lateS`: how long after its asked-for time the alarm ran.
 */
export interface WakeRow {
  changed: boolean;
  phase: string;
  quality: string;
  first: boolean;
  gapS: number;
  feedAgeS: number;
  leaveShiftS: number;
  lateS: number;
}

export function logTripWake(env: Env, r: WakeRow): void {
  writeRow(env, 'tripwake', {
    changed: r.changed ? 'pushed' : 'same',
    phase: r.phase,
    quality: r.quality,
    first: r.first ? 'first' : 'again',
    gapS: r.gapS,
    feedAgeS: r.feedAgeS,
    leaveShiftS: r.leaveShiftS,
    lateS: r.lateS,
  });
}

/** One row of the daily active counts (usage.ts): ROWS.active's fields, its scope one of three. */
export type ActiveRow = RowFields<'active'> & { scope: 'all' | 'app' | 'version' };

export function logActive(env: Env, row: ActiveRow): void {
  writeRow(env, 'active', row);
}

/** One request that used something on its way out (legacy.ts). */
export interface LegacyRow {
  what: 'address' | 'path' | 'outdated';
  client: string;
  route: string;
}

export function logLegacy(env: Env, r: LegacyRow): void {
  writeRow(env, 'legacy', { what: r.what, client: r.client, route: r.route, n: 1 });
}

/** One setting's value and how many accounts have it, on a day (settings.ts): ROWS.settings's fields. */
export type SettingRow = RowFields<'settings'>;

export function logSetting(env: Env, r: SettingRow): void {
  writeRow(env, 'settings', r);
}

/** One request made with an API key (keyuse.ts). */
export interface KeyUseRow {
  keyId: string;
  route: string;
  outcome: 'ok' | 'limited';
}

export function logKeyUse(env: Env, r: KeyUseRow): void {
  // Indexed by key (ROWS.apikey), so Analytics Engine samples each key apart: a busy one never thins out a quiet one's counts.
  writeRow(env, 'apikey', { keyId: r.keyId, route: r.route, outcome: r.outcome, n: 1 });
}

/** One error report, already scrubbed (apperrors.ts). */
export interface AppErrorRow {
  platform: string;
  version: string;
  fingerprint: string;
  type: string;
  message: string;
  stack: string;
  os: string;
  /** It ended the app (an uncaught crash), not one caught and carried on from. */
  fatal: boolean;
}

export function logAppError(env: Env, r: AppErrorRow): void {
  writeRow(env, 'apperror', { ...r, n: 1, fatal: r.fatal ? 1 : 0 });
}

/** One trip signal (me.ts): which signals people send, never who or where. */
export function logSignal(env: Env, signal: string): void {
  writeRow(env, 'signal', { signal, n: 1 });
}

/**
 * A step between buses (me.ts), by direction and the kind of trip: whether
 * people step later after a class (a trip home starts from one) says
 * whether classes end when ENDS_EARLY_MIN assumes. Never the account or the class.
 */
export function logStep(env: Env, dir: 'earlier' | 'later' | 'best', trip: string): void {
  const kind = /^(gap-)?home:/.test(trip) ? 'home' : /^(place|to):/.test(trip) ? 'place' : 'class';
  writeRow(env, 'step', { dir, trip: kind, n: 1 });
}

/** Rows from Analytics Engine's SQL API; needs ANALYTICS_TOKEN and CF_ACCOUNT_ID. Throws when it refuses. */
export async function aeSql(env: Env, q: string, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>[]> {
  const res = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.ANALYTICS_TOKEN}` },
    body: q,
  });
  if (!res.ok) throw new Error(`Analytics Engine answered ${res.status}`);
  return ((await res.json()) as { data: Record<string, unknown>[] }).data;
}
