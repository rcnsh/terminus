/**
 * THE PERSONALISATION SURFACE.
 *
 * The premise of this project is that Jacob has three recurring trips, not a
 * general routing problem. Hardcoding them is what removes the tap. Everything
 * outside this file is machinery.
 *
 * Edit the trips and priors; leave the tuning constants alone until phase 2
 * (segment travel-time logging) gives them real values.
 */

import type { Quality } from './types.ts';

export interface Trip {
  key: string;
  /** Destination stop code. */
  to: string;
  /** Origin stop code, used when the client sends no coordinates. */
  from: string;
  /** Human name for the destination, used in `detail`. Keep it short. */
  label: string;
}

export const TRIPS: Trip[] = [
  { key: 'utown', to: 'UTOWN', from: 'PGP', label: 'UTown' },
  { key: 'mrt', to: 'KR-MRT', from: 'PGP', label: 'KR MRT' },
  { key: 'home', to: 'PGP', from: 'UTOWN', label: 'PGP' },
];

// Note on the codes above: they are real, from the live route graph. PGP to
// COM3 is deliberately NOT here -- on the real topology that trip is beaten
// outright on foot (651 m against thirteen stops round the D2 loop), so it
// would only ever return "Walk · 8 min". Replace all three with yours.

/**
 * Time-of-day priors. First match wins. Hours are SGT, [fromH, toH) on a
 * 24h clock. `days`: 'weekday' = Mon-Fri, 'weekend' = Sat/Sun, 'any' = both.
 */
export interface Prior {
  days: 'weekday' | 'weekend' | 'any';
  fromH: number;
  toH: number;
  trip: string;
}

export const PRIORS: Prior[] = [
  { days: 'weekday', fromH: 6, toH: 18, trip: 'utown' },
  { days: 'weekday', fromH: 18, toH: 24, trip: 'home' },
  { days: 'weekend', fromH: 9, toH: 24, trip: 'utown' },
];

/** Which trip the morning cron push is about. */
export const PUSH_TRIP = 'utown';

export const TTL = {
  /** Edge cache freshness for a stop's arrivals. Every client inside this
   *  window sees the same answer and upstream sees one call. */
  arrivalsMs: 15_000,
  /** How long a stale answer stays usable as a fallback. Beyond this the edge
   *  cache entry is allowed to expire and a dead upstream becomes an error. */
  staleMaxS: 300,
  /** Safety margin subtracted from a token's advertised lifetime. */
  tokenSkewS: 60,
  /** Fallback token lifetime when the auth response omits expires_in. */
  tokenDefaultS: 3600,
} as const;

export const WALK = {
  speedMs: 1.3,
  /** Stops further than this are not considered, unless nothing is closer. */
  maxRadiusM: 450,
  /** At most this many stops get an upstream fetch per request. */
  maxCandidates: 3,
  /** Do not claim you can catch a bus arriving this soon after you get there. */
  boardBufferS: 20,
  /**
   * Walking must beat the bus by this much before we say "just walk". Several
   * trips on this campus are genuinely faster on foot, and an engine that will
   * not say so is lying by omission -- but not for the sake of thirty seconds.
   */
  beatsBusByS: 120,
  /** Within this much of the bus, walking is worth mentioning, not recommending. */
  mentionWithinS: 240,
} as const;

export const RIDE = {
  /**
   * Seconds per inter-stop hop. THIS IS A GUESS and the ranking inherits its
   * error. It is good enough to separate a 2-hop ride from a 14-hop ride
   * (the wrong-side-of-the-road case, which is the whole point) and not good
   * enough to separate a 4-hop from a 5-hop. `stop.confidence` reports which
   * situation you are in. Phase 2 replaces this with a measured table.
   */
  secondsPerHop: 95,
} as const;

/** Used when the feed returns no ETA but the service is within its hours. */
export const DEFAULT_HEADWAY_S = 12 * 60;

/** Hard cap from the API contract. `format.ts` targets much shorter. */
export const LABEL_MAX = 40;

/**
 * live and stale carry real numbers; scheduled and unknown are guesses.
 * Never recommend an estimate over a measurement.
 */
export function isMeasured(q: Quality): boolean {
  return q === 'live' || q === 'stale';
}

export function tripByKey(key: string | null): Trip | null {
  if (!key) return null;
  return TRIPS.find((t) => t.key === key) ?? null;
}

/** SGT is UTC+8, no DST. */
export function sgt(nowMs: number): { day: number; hour: number; minutes: number } {
  const d = new Date(nowMs + 8 * 3600_000);
  return {
    day: d.getUTCDay(),
    hour: d.getUTCHours(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

/** The trip a bare `/next` is about at this moment. Null outside all priors. */
export function tripForTime(nowMs: number): Trip | null {
  const { day, hour } = sgt(nowMs);
  const weekend = day === 0 || day === 6;
  for (const p of PRIORS) {
    if (p.days === 'weekday' && weekend) continue;
    if (p.days === 'weekend' && !weekend) continue;
    if (hour >= p.fromH && hour < p.toH) return tripByKey(p.trip);
  }
  return null;
}
