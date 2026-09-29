/**
 * Walking, as close to the real paths as the data allows.
 *
 * Straight lines undersell campus walks: roads to cross, stairs, the long way
 * round a building. `data/walks.json` (scripts/walk_routes.py, from
 * OpenStreetMap footpaths) carries routed distances between stops and, for
 * each stop, how much longer than the straight line a walk to it usually is.
 * Rooms get routed distances in `data/venues.json` from the same script.
 * Without that data every factor is 1: the old straight-line behaviour.
 */

import walksJson from '../data/walks.json' with { type: 'json' };
import type { Stop } from './types.ts';
import { WALK } from './config.ts';
import { haversineM } from './geo.ts';

const WALKS = walksJson as { detour: Record<string, number>; stopPairs: Record<string, number> };

export type Pace = 'slow' | 'normal' | 'fast';
export const PACES: readonly Pace[] = ['slow', 'normal', 'fast'];

/** Metres per second. Normal is the long-standing 1.3. */
const SPEED: Record<Pace, number> = { slow: 1.1, normal: WALK.speedMs, fast: 1.5 };

export function paceSpeed(pace: Pace | null | undefined): number {
  return SPEED[pace ?? 'normal'] ?? WALK.speedMs;
}

/** A walk to this stop from a point nearby, in metres. */
export function footM(lat: number, lon: number, stop: Stop): number {
  return haversineM(lat, lon, stop.lat, stop.lon) * (WALKS.detour[stop.code] ?? 1);
}

/** A walk from one stop to another, in metres: routed when known. */
export function stopFootM(a: Stop, b: Stop): number {
  return WALKS.stopPairs[`${a.code}>${b.code}`] ?? footM(a.lat, a.lon, b);
}
