import residencesJson from '../../data/residences.json' with { type: 'json' };
import { haversineM } from '../geo.ts';
import { footM, stopFootM } from './walk.ts';
import type { Stop } from '../types.ts';
import { WALK } from '../config.ts';

export interface Residence {
  name: string;
  common?: boolean;
  stops: Record<string, number>;
  areas: Array<Array<[number, number]>>;
}

const RESIDENCES = (residencesJson as unknown as { residences: Record<string, Residence> }).residences;

export const GPS_MARGIN_M = 30;

export function residenceWalkMin(walkM: number): number {
  return Math.max(1, Math.round(walkM / WALK.speedMs / 60));
}

export function allResidences(): Array<[string, Residence]> {
  return Object.entries(RESIDENCES);
}

function inside(lat: number, lon: number, ring: Array<[number, number]>): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ai, oi] = ring[i];
    const [aj, oj] = ring[j];
    if (oi > lon !== oj > lon && lat < ((aj - ai) * (lon - oi)) / (oj - oi) + ai) hit = !hit;
  }
  return hit;
}

function edgeM(lat: number, lon: number, ring: Array<[number, number]>): number {
  const mLat = 111_320;
  const mLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = (ring[j][1] - lon) * mLon,
      ay = (ring[j][0] - lat) * mLat;
    const bx = (ring[i][1] - lon) * mLon,
      by = (ring[i][0] - lat) * mLat;
    const dx = bx - ax,
      dy = by - ay;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

export function residenceAt(lat: number, lon: number): [string, Residence] | null {
  for (const [code, r] of allResidences()) {
    if (!r.areas.some((a) => haversineM(lat, lon, a[0][0], a[0][1]) < 1500)) continue;
    if (r.areas.some((a) => inside(lat, lon, a) || edgeM(lat, lon, a) <= GPS_MARGIN_M)) return [code, r];
  }
  return null;
}

export function atHome(lat: number | null, lon: number | null, homeStops: string[]): boolean {
  if (lat == null || lon == null || !homeStops.length) return false;
  const r = residenceAt(lat, lon);
  return r !== null && Object.keys(r[1].stops).some((s) => homeStops.includes(s));
}

export interface NearStop {
  stop: Stop;
  distM: number;
  footM: number;
}

export interface HomeWalk {
  stops: string[];
  m: number;
}

export function residenceStops(lat: number, lon: number, byCode: Map<string, Stop>, home?: HomeWalk | null): NearStop[] | null {
  const r = residenceAt(lat, lon);
  if (!r) return null;
  const homeM = home
    ? Object.entries(r[1].stops)
        .filter(([code]) => home.stops.includes(code))
        .map(([, m]) => m)
    : [];
  const extraM = home && homeM.length ? home.m - Math.min(...homeM) : 0;
  const out: NearStop[] = [];
  for (const [code, metres] of Object.entries(r[1].stops)) {
    const stop = byCode.get(code);
    if (!stop) continue;
    const foot = Math.max(metres + extraM, footM(lat, lon, stop));
    out.push({ stop, distM: haversineM(lat, lon, stop.lat, stop.lon), footM: foot });
    const opp = stop.opposite ? byCode.get(stop.opposite) : undefined;
    if (opp && !r[1].stops[opp.code]) {
      out.push({ stop: opp, distM: haversineM(lat, lon, opp.lat, opp.lon), footM: foot + stopFootM(stop, opp) });
    }
  }
  return out.length ? out.sort((a, b) => a.footM - b.footM) : null;
}

export function residenceList() {
  return allResidences()
    .map(([code, r]) => ({
      code,
      name: r.name,
      stops: Object.keys(r.stops),
      walkM: Object.values(r.stops)[0],
      walkMin: residenceWalkMin(Object.values(r.stops)[0]),
      common: r.common === true,
    }))
    .sort((a, b) => Number(b.common) - Number(a.common) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
