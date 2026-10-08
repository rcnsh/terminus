/**
 * Tuning constants, set by hand. RIDE.secondsPerHop is a guess; the feed's
 * own predictions are the way to check it (docs/analytics.md).
 */

import type { Quality } from './types.ts';

export const TTL = {
  /** Edge cache freshness for a stop's arrivals. Every client inside this
   *  window sees the same answer and upstream sees one call. */
  arrivalsMs: 15_000,
  /** The same for one service's live bus positions on the map. The feed
   *  moves a bus every 15-20 s (scripts/probe_buses.py); polling at 5 s sees
   *  each move within 5 s, and the map glides between them. */
  busesMs: 5_000,
  /** How long a stale answer stays usable as a fallback. Beyond this the edge
   *  cache entry is allowed to expire and a dead upstream becomes an error. */
  staleMaxS: 300,
  /** After a failed fetch for a stop, don't ask again for this long. An
   *  outage must not turn every request into another call to NUS. */
  failMemoS: 20,
  /** After the feed refuses our version or keys (10009, 10000), or its host
   *  answers 429 or 5xx or not at all (a timeout), stop calling it for this long. */
  breakerS: 60,
  /** After a refused call, a fresh token is minted at most once per this in
   *  a data centre: the calls in between retry with it, or not at all. */
  remintGapS: 60,
  /** How long an isolate trusts the version strings it read from KV. A new
   *  one written to config:appVersion or config:minClient is live
   *  everywhere within this. */
  versionMemoMs: 60_000,
  /** Per upstream call. A hung NUS must not hang the widget. */
  upstreamTimeoutMs: 5_000,
  /** How long to wait for a fresh fetch when a stale answer is ready to serve. */
  staleRaceMs: 2_500,
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
  /**
   * Within this of the room or building itself (its point on the NUSMods
   * room map) you're there, however far its stop is: a lecture theatre is
   * 40 m across, and a fix indoors is 20-50 m out.
   */
  atVenueM: 80,
} as const;

/**
 * A fix the phone itself says is further out than this (`acc`, in metres,
 * its accuracy plus how far you could have walked since) is no location at
 * all: picked as "where you are", a cell-tower fix or one from ten minutes
 * ago plans the trip from the wrong side of campus. The answer then comes
 * from the timetable, which says so.
 */
export const MAX_FIX_ACC_M = 200;

export const RIDE = {
  /**
   * Seconds per inter-stop hop. THIS IS A GUESS and the ranking inherits its
   * error. It is good enough to separate a 2-hop ride from a 14-hop ride
   * (the wrong-side-of-the-road case, which is the whole point) and not good
   * enough to separate a 4-hop from a 5-hop. `stop.confidence` reports which
   * situation you are in.
   */
  secondsPerHop: 95,
  /**
   * The fastest a shuttle covers a long hop, in metres of straight line a
   * second (about 25 km/h; faster on the road, which winds). Only route P's
   * hops are long enough for this to beat secondsPerHop.
   */
  longHopMs: 7,
} as const;

/** Used when the feed returns no ETA but the service is within its hours. */
export const DEFAULT_HEADWAY_S = 12 * 60;

/** Public buses (public.ts, lta.ts). */
export const PUBLIC = {
  /**
   * Metres a second on a public bus between campus stops, the stops
   * themselves included: about 20 km/h. Public routes' stops are unevenly
   * spaced and two campus stops in a row can be a long way round the island
   * apart, so a count of stops (RIDE.secondsPerHop) would mislead.
   */
  speedMs: 5.5,
  /**
   * Seconds a public bus must save over the best free bus before it is the
   * answer rather than the alternative. A fare to save thirty seconds is a
   * worse deal than it looks, so a public bus is the headline only when it
   * clearly wins.
   */
  fareWorthS: 180,
} as const;

/**
 * The timelapse recorder (timelapse.ts, timelapsedo.ts): the ONE poller of
 * the NUS feed. Answers fetch on demand; the cron's health check and the
 * Trip objects read a stop at a time (CLAUDE.md, rule 2). It asks for each
 * service's buses through the same edge cache as the map, so a poll a user
 * already paid for costs NUS nothing, and it never asks faster than this.
 */
export const TIMELAPSE = {
  /** Each service is asked once per this, the services spread across it.
   *  Never below MIN_POLL_MS, whatever this says, and longer when there are
   *  too many services for maxPollsPerDay (pollInterval()). */
  pollMs: 30_000,
  /** The Singapore-time window it records in. It may cross midnight: the
   *  day is the date the window opened, until it closes the next morning. */
  hours: { start: '06:30', end: '00:30' },
  /** Rounds in a row with no bus on any service before it stops: for the
   *  day once it has seen buses and no service is in its hours, else for
   *  idleSleepMs (before the first bus, or a gap in service). */
  idleRounds: 6,
  idleSleepMs: 15 * 60_000,
  /** The most polls in a day, whatever stops.json lists: with more services
   *  than eight, pollInterval() lengthens the interval to keep under it. */
  maxPollsPerDay: 17_280,
} as const;

/** The floor under TIMELAPSE.pollMs, enforced in code. */
export const MIN_POLL_MS = 15_000;

/** The furthest ahead a feed's arrival time can be and still be a bus, in
 *  either feed. After midnight every shuttle time is the next morning's,
 *  about 7 h away, and a service off for a long weekend is days away; past
 *  a week it's a changed unit (seconds read as minutes) or an absolute
 *  time read as a relative one. */
export const MAX_ETA_S = 7 * 86_400;

/** Hard cap from the API contract. `format.ts` targets much shorter. */
export const LABEL_MAX = 40;

/** SGT is UTC+8, no DST: add this to an instant to read SGT off its UTC fields. */
export const SGT_MS = 8 * 3_600_000;

export function sgt(nowMs: number): { day: number; hour: number; minutes: number } {
  const d = new Date(nowMs + SGT_MS);
  return {
    day: d.getUTCDay(),
    hour: d.getUTCHours(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

/**
 * live and stale carry real numbers; scheduled and unknown are guesses.
 * Never recommend an estimate over a measurement.
 */
export function isMeasured(q: Quality): boolean {
  return q === 'live' || q === 'stale';
}
