/**
 * Workers Analytics Engine logging.
 *
 * Two reasons this exists, and the second is the one that matters.
 *
 * 1. Nothing else measures whether the direction algorithm is RIGHT. The tile
 *    will happily send you across the road with confidence 0.97 forever and
 *    never once tell you it was wrong. Logging the decision means you can go
 *    back and check.
 *
 * 2. It is phase-2 segment travel-time collection, starting now instead of in
 *    two months. Inter-stop times are not in the feed, and the router cannot
 *    be good without them. `plate` is the join key: the same vehicle seen at
 *    two stops with two ETAs gives you the travel time between them. That data
 *    needs calendar time you do not have much of, so it collects from day one
 *    even though nothing reads it yet.
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
 *   blob1   kind        'answer' | 'arrival'
 *   blob2   stop        boarding stop code
 *   blob3   svc         service, '' on an ended answer
 *   blob4   dest        destination stop code, '' for a bare /next
 *   blob5   quality     live | scheduled | unknown | stale | ended
 *   blob6   plate       arrival rows only
 *   blob7   crowd       low | medium | high | ''
 *   blob8   trip        unused since configured trips were removed; always ''
 *   blob9   berth       raw busStopCode, arrival rows only
 *
 *   double1  etaS            arrival rows: seconds to arrival
 *   double2  boardS          answer rows: seconds until you can board
 *   double3  rideS
 *   double4  totalS
 *   double5  hops
 *   double6  walkS           to the boarding stop
 *   double7  confidence      0..1
 *   double8  ambiguousBerth  0 | 1
 *   double9  hadCoords       0 | 1
 *   double10 walkAllS        whole-way walk, -1 when unknown
 *
 *   index1  stop code (the sampling key)
 * ---------------------------------------------------------------------------
 */

import type { Answer, Arrival, Env, ScoredOption } from './types.ts';

/** Arrival rows per request. Bounded so one tap cannot write a hundred rows. */
const MAX_ARRIVAL_ROWS = 8;

export function analyticsEnabled(env: Env): boolean {
  return typeof env.NUSBUS_AE?.writeDataPoint === 'function';
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

    env.NUSBUS_AE!.writeDataPoint({
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
      ],
      indexes: [stop],
    });

    // The segment-time seed. Every arrival at the chosen stop, with its plate.
    for (const a of answer.arrivals.slice(0, MAX_ARRIVAL_ROWS)) {
      if (a.etaS == null) continue; // "no bus" carries no timing information
      env.NUSBUS_AE!.writeDataPoint({
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

/** Convenience for the arrivals of a stop we did not end up recommending. */
export function arrivalCount(arrivals: Arrival[]): number {
  return arrivals.filter((a) => a.etaS != null).length;
}
