import type { Quality } from './types.ts';

export const TTL = {
  arrivalsMs: 15_000,
  busesMs: 5_000,
  staleMaxS: 300,
  failMemoS: 20,
  breakerS: 60,
  remintGapS: 60,
  versionMemoMs: 60_000,
  upstreamTimeoutMs: 5_000,
  staleRaceMs: 2_500,
  tokenSkewS: 60,
  tokenDefaultS: 3600,
  tokenRenewShare: 0.5,
} as const;

export const WALK = {
  speedMs: 1.3,
  maxRadiusM: 450,
  tripRadiusM: 550,
  maxCandidates: 3,
  nearStopM: 400,
  boardBufferS: 20,
  atStopM: 30,
  dwellS: 30,
  beatsBusByS: 120,
  mentionWithinS: 240,
  sunWeight: 1.5,
  atVenueM: 80,
} as const;

export const MAX_FIX_ACC_M = 200;

export const RIDE = {
  secondsPerHop: 95,
  longHopMs: 7,
} as const;

export const DEFAULT_HEADWAY_S = 12 * 60;

export const PUBLIC = {
  speedMs: 5.5,
  fareWorthS: 180,
} as const;

export const TRANSFER: {
  maxFetch: number;
  changeBufferS: number;
  worthS: number;
  mode: 'off' | 'noDirect' | 'beats';
} = {
  maxFetch: 2,
  changeBufferS: 60,
  worthS: 240,
  mode: 'noDirect',
};

export const STEP = {
  lateMaxS: 20 * 60,
  laterMaxS: 60 * 60,
  maxTrips: 20,
} as const;

export const TIMELAPSE = {
  pollMs: 30_000,
  hours: { start: '06:30', end: '00:30' },
  idleRounds: 6,
  idleSleepMs: 15 * 60_000,
  maxPollsPerDay: 17_280,
} as const;

export const MIN_POLL_MS = 15_000;

export const MAX_ETA_S = 7 * 86_400;

export const LABEL_MAX = 40;

export const SGT_MS = 8 * 3_600_000;

export function sgt(nowMs: number): { day: number; hour: number; minutes: number } {
  const d = new Date(nowMs + SGT_MS);
  return {
    day: d.getUTCDay(),
    hour: d.getUTCHours(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

export function isMeasured(q: Quality): boolean {
  return q === 'live' || q === 'stale';
}
