import landmarksJson from '../../data/landmarks.json' with { type: 'json' };

export interface Landmark {
  name: string;
  kind: string;
  aliases: string[];
  stops: Record<string, number>;
}

const LANDMARKS = (landmarksJson as { landmarks: Record<string, Landmark> }).landmarks;

export function landmark(code: string): Landmark | null {
  return LANDMARKS[code.trim().toUpperCase()] ?? null;
}

export function allLandmarks(): Array<[string, Landmark]> {
  return Object.entries(LANDMARKS);
}

export function targetStops(code: string): { to: string; also: string[]; walkM: number } {
  const lm = landmark(code);
  if (!lm) return { to: code, also: [], walkM: 0 };
  const stops = Object.keys(lm.stops);
  return { to: stops[0], also: stops.slice(1), walkM: Math.min(...Object.values(lm.stops)) };
}
