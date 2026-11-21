import walksJson from '../../data/walks.json' with { type: 'json' };
import venuesJson from '../../data/venues.json' with { type: 'json' };
import type { NearStop } from './residences.ts';
import type { Stop } from '../types.ts';
import { WALK } from '../config.ts';
import { haversineM } from '../geo.ts';

const WALKS = walksJson as { detour: Record<string, number>; stopPairs: Record<string, number> };

type Building = { lat: number; lon: number; out: Record<string, number> };
const BUILDINGS: Building[] = Object.values(
  (venuesJson as { venues: Record<string, { lat?: number; lon?: number; out?: Record<string, number> }> }).venues,
).flatMap((v) => (v.out && v.lat !== undefined && v.lon !== undefined ? [{ lat: v.lat, lon: v.lon, out: v.out }] : []));

export type Pace = 'slow' | 'normal' | 'fast';
export const PACES: readonly Pace[] = ['slow', 'normal', 'fast'];

const SPEED: Record<Pace, number> = { slow: 1.1, normal: WALK.speedMs, fast: 1.5 };

export function paceSpeed(pace: Pace | null | undefined): number {
  return SPEED[pace ?? 'normal'] ?? WALK.speedMs;
}

export function footM(lat: number, lon: number, stop: Stop): number {
  return haversineM(lat, lon, stop.lat, stop.lon) * (WALKS.detour[stop.code] ?? 1);
}

export function stopFootM(a: Stop, b: Stop): number {
  return WALKS.stopPairs[`${a.code}>${b.code}`] ?? footM(a.lat, a.lon, b);
}

export function buildingStops(lat: number, lon: number, byCode: Map<string, Stop>): NearStop[] | null {
  let at: Building | null = null;
  let atM: number = WALK.atVenueM;
  for (const b of BUILDINGS) {
    const d = haversineM(lat, lon, b.lat, b.lon);
    if (d <= atM) [at, atM] = [b, d];
  }
  if (!at) return null;
  for (const stop of byCode.values()) if (!stop.public && haversineM(lat, lon, stop.lat, stop.lon) < atM) return null;
  const out: NearStop[] = [];
  for (const [code, m] of Object.entries(at.out)) {
    const stop = byCode.get(code);
    if (!stop) continue;
    const distM = haversineM(lat, lon, stop.lat, stop.lon);
    out.push({ stop, distM, footM: Math.max(m, distM) });
  }
  const across: NearStop[] = [];
  for (const near of out) {
    const opp = near.stop.opposite ? byCode.get(near.stop.opposite) : undefined;
    if (opp && ![...out, ...across].some((c) => c.stop.code === opp.code)) {
      across.push({ stop: opp, distM: haversineM(lat, lon, opp.lat, opp.lon), footM: near.footM + stopFootM(near.stop, opp) });
    }
  }
  const all = [...out, ...across];
  return all.length ? all.sort((a, b) => a.footM - b.footM) : null;
}
