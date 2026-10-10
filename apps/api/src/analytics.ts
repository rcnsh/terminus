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
 *    between them. That data needs calendar time, so it is collected even
 *    though nothing reads it yet.
 *
 * Analytics Engine writes are synchronous, non-blocking and unsampled at this
 * volume. Nothing here may ever throw into a response path -- an answer that
 * fails because logging failed would be an absurd way to miss a bus.
 *
 * ---------------------------------------------------------------------------
 * POSITIONAL SCHEMA. Analytics Engine SQL addresses columns as blob1..blob20
 * and double1..double20, so these positions are the contract. APPEND ONLY --
 * never reorder, never repurpose, or every query written before the change
 * starts lying.
 *
 *   blob1   kind        'answer' | 'arrival' | 'error' | 'timelapse' | 'signal'
 *                       | 'active' | 'apperror'
 *   blob2   stop        boarding stop code; for 'error', the route (no query),
 *                       or 'cron <step>' for a cron step that failed;
 *                       for 'timelapse', the poll's outcome (see logPoll);
 *                       for 'signal', the kind of trip signal (me.ts), a count
 *                       with no account, stop or location
 *   blob3   svc         service, '' on an ended answer
 *   blob4   dest        destination stop code, '' for a bare /next
 *   blob5   quality     live | scheduled | unknown | stale | ended
 *   blob6   plate       arrival rows only
 *   blob7   crowd       low | medium | high | ''
 *   blob8   trip        unused since configured trips were removed; always ''
 *   blob9   berth       raw busStopCode, arrival rows only
 *   blob10  via         answer rows: the stop a trip changes buses at, '' on one bus
 *   blob11  svc2        answer rows: the bus after the change, '' on one bus
 *
 *   double1  etaS            arrival rows: seconds to arrival; timelapse rows: buses seen
 *   double2  boardS          answer rows: seconds until you can board
 *   double3  rideS
 *   double4  totalS
 *   double5  hops
 *   double6  walkS           to the boarding stop
 *   double7  confidence      0..1
 *   double8  ambiguousBerth  0 | 1
 *   double9  hadCoords       0 | 1
 *   double10 walkAllS        whole-way walk, -1 when unknown
 *   double11 changeWaitS     answer rows: seconds waiting for the bus after a change, -1 on one bus
 *
 *   index1  stop code (the sampling key); 'error', 'timelapse', 'signal', 'active'
 *           and 'apperror' rows use their kind
 *
 * Two kinds give the columns their own meaning:
 *
 *   'active' (usage.ts logActive), once a Singapore day, counts only:
 *     blob2 scope 'all' | 'app' | 'version';  blob3 the app (web, android,
 *     mac, ios, api, unknown) or version ("android/3.1.0"), 'all' for all;
 *     blob4 the Singapore day counted, YYYY-MM-DD;
 *     double1..3 used in the last 1, 7 and 30 days (accounts; devices for a
 *     version; keys for 'api').
 *   'apperror' (apperrors.ts), one report from an app or the website:
 *     blob2 platform;  blob3 app version;  blob4 fingerprint (the same crash
 *     gets the same one);  blob5 the error's type;  blob6 its message and
 *     blob7 its stack, both scrubbed (apperrors.ts scrub);  blob8 the OS or
 *     browser and its major version;  double1 1;  double2 1 for a crash
 *     that ended the app, 0 for an error it carried on from.
 *
 * No row holds an account, email, IP address, device or install id, or
 * coordinates. An answer row's
 * stop is the one nearest the caller when a location was sent, and its
 * destination comes from the timetable: the privacy policy says so.
 * ---------------------------------------------------------------------------
 */

import type { Answer, Env, ScoredOption } from './types.ts';

/** Arrival rows per request. Bounded so one tap cannot write a hundred rows. */
const MAX_ARRIVAL_ROWS = 8;

export function analyticsEnabled(env: Env): boolean {
  return typeof env.AE?.writeDataPoint === 'function';
}

export interface LogInput {
  answer: Answer;
  best: ScoredOption | null;
  dest: string | null;
  hadCoords: boolean;
  walkAllS: number | null;
}

export function logAnswer(env: Env, input: LogInput): void {
  if (!analyticsEnabled(env)) return;
  try {
    const { answer, best } = input;
    const stop = answer.stop.code || 'none';

    env.AE!.writeDataPoint({
      blobs: [
        'answer',
        stop,
        best?.svc ?? '',
        input.dest ?? '',
        answer.quality,
        '',
        best?.arrival?.crowd ?? '',
        '', // was the trip key, never set; the column stays so the others don't shift
        best?.arrival?.berth ?? '',
        best?.change?.stop.code ?? '',
        best?.change?.svc ?? '',
      ],
      doubles: [
        0,
        best?.boardS ?? -1,
        best?.rideS ?? -1,
        best?.totalS ?? -1,
        best?.hops ?? -1,
        best?.walkS ?? -1,
        answer.stop.confidence,
        best?.ambiguousBerth ? 1 : 0,
        input.hadCoords ? 1 : 0,
        input.walkAllS ?? -1,
        best?.change ? best.change.boardS - best.change.reachS - best.change.crossS : -1,
      ],
      indexes: [stop],
    });

    // The segment-time seed. Every arrival at the chosen stop, with its plate.
    for (const a of answer.arrivals.slice(0, MAX_ARRIVAL_ROWS)) {
      if (a.etaS == null) continue; // "no bus" carries no timing information
      env.AE!.writeDataPoint({
        blobs: [
          'arrival',
          stop,
          a.svc,
          input.dest ?? '',
          answer.quality,
          a.plate ?? '',
          a.crowd ?? '',
          '', // was the trip key, never set; the column stays so the others don't shift
          a.berth ?? '',
        ],
        doubles: [a.etaS, -1, -1, -1, -1, -1, answer.stop.confidence, 0, input.hadCoords ? 1 : 0, -1],
        indexes: [stop],
      });
    }
  } catch {
    // Deliberately swallowed. Losing a metric is not worth losing an answer.
  }
}

/**
 * An unhandled error, for the dashboard's error count: the route only, since
 * a query string can hold coordinates. Nothing else is filled in.
 */
export function logError(env: Env, path: string): void {
  if (!analyticsEnabled(env)) return;
  try {
    // /api/me/devices/abc123 is one route, not one per device.
    const parts = path.split('/');
    const route = parts.slice(0, parts[1] === 'api' ? 4 : 3).join('/') || '/';
    env.AE!.writeDataPoint({ blobs: ['error', route], doubles: [], indexes: ['error'] });
  } catch {
    // Same rule as above: logging never breaks a response.
  }
}

/**
 * A cron step that failed (monitor.ts runCron), counted with the errors on
 * the dashboard as the route 'cron <step>'. No email: the logs say why.
 */
export function logCronError(env: Env, step: string): void {
  if (!analyticsEnabled(env)) return;
  try {
    env.AE!.writeDataPoint({ blobs: ['error', `cron ${step}`], doubles: [], indexes: ['error'] });
  } catch {
    // Same rule as above: a lost count never stops the cron.
  }
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
  if (!analyticsEnabled(env)) return;
  try {
    env.AE!.writeDataPoint({ blobs: ['timelapse', outcome, svc], doubles: [buses], indexes: ['timelapse'] });
  } catch {
    // Same rule as above: a lost count never stops a poll.
  }
}

/** One row of the daily active counts (usage.ts). */
export interface ActiveRow {
  scope: 'all' | 'app' | 'version';
  name: string;
  day: string;
  d1: number;
  d7: number;
  d30: number;
}

export function logActive(env: Env, row: ActiveRow): void {
  if (!analyticsEnabled(env)) return;
  try {
    env.AE!.writeDataPoint({ blobs: ['active', row.scope, row.name, row.day], doubles: [row.d1, row.d7, row.d30], indexes: ['active'] });
  } catch {
    // Same rule as above: a lost count never stops the cron.
  }
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
  if (!analyticsEnabled(env)) return;
  try {
    env.AE!.writeDataPoint({ blobs: ['apperror', r.platform, r.version, r.fingerprint, r.type, r.message, r.stack, r.os], doubles: [1, r.fatal ? 1 : 0], indexes: ['apperror'] });
  } catch {
    // Same rule as above.
  }
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
