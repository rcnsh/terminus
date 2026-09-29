/**
 * Named places served by more than one stop: the food courts people head for
 * by name. A trip there counts every one of its stops as the destination, and
 * the router takes whichever is quicker at the time, the same way it already
 * treats the two sides of a road.
 */

import landmarksJson from '../data/landmarks.json' with { type: 'json' };

export interface Landmark {
  name: string;
  /** "Food court". */
  kind: string;
  aliases: string[];
  /** Stop code -> metres on foot from it, best first. */
  stops: Record<string, number>;
}

const LANDMARKS = (landmarksJson as { landmarks: Record<string, Landmark> }).landmarks;

export function landmark(code: string): Landmark | null {
  return LANDMARKS[code.trim().toUpperCase()] ?? null;
}

export function allLandmarks(): Array<[string, Landmark]> {
  return Object.entries(LANDMARKS);
}

/** A destination code as stops: itself for a stop, all of a landmark's. */
export function targetStops(code: string): { to: string; also: string[]; walkM: number } {
  const lm = landmark(code);
  if (!lm) return { to: code, also: [], walkM: 0 };
  const stops = Object.keys(lm.stops);
  return { to: stops[0], also: stops.slice(1), walkM: Math.min(...Object.values(lm.stops)) };
}
