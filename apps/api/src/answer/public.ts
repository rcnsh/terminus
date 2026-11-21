import type { Graph, GraphIndex, Stop } from '../types.ts';
import { PUBLIC } from '../config.ts';

export const svcName = (key: string): string => key.split('/')[0];

export const isPublic = (graph: Graph, svc: string): boolean => Boolean(graph.public?.[svc]);

export const publicCodeOf = (stop: Stop): string | null => stop.publicCode ?? (stop.public ? stop.code : null);

export const shuttleCalls = (stop: Stop): boolean => !stop.public;

export interface PublicData {
  stops: Array<{ code: string; name: string; lat: number; lon: number }>;
  merged: Record<string, string>;
  routes: Record<string, string[]>;
  along: Record<string, number[]>;
  loops: Record<string, boolean>;
  public: Graph['public'];
  serviceHours: Graph['serviceHours'];
  headwayS: Record<string, number>;
}

export function withPublic(graph: Graph, pub: PublicData): Graph {
  const byShuttle = new Map(Object.entries(pub.merged).map(([code, shuttle]) => [shuttle, code]));
  const stops: Stop[] = [
    ...graph.stops.map((s) => (byShuttle.has(s.code) ? { ...s, publicCode: byShuttle.get(s.code)! } : s)),
    ...pub.stops.map((s) => ({ code: s.code, name: s.name, lat: s.lat, lon: s.lon, opposite: null, public: true as const })),
  ];
  return {
    ...graph,
    stops,
    routes: { ...graph.routes, ...pub.routes },
    loops: { ...graph.loops, ...pub.loops },
    serviceHours: { ...graph.serviceHours, ...pub.serviceHours },
    headwayS: { ...graph.headwayS, ...pub.headwayS },
    along: pub.along,
    public: pub.public,
  };
}

export function rideMetres(idx: GraphIndex, svc: string, from: string, to: string): number | null {
  const r = idx.routes.get(svc);
  const along = idx.graph.along?.[svc];
  if (!r || !along) return null;
  const n = r.seq.length;
  if (along.length !== (r.loop ? n + 1 : n)) return null;
  const fromAt = r.pos.get(from);
  const toAt = r.pos.get(to);
  if (!fromAt || !toAt) return from === to ? 0 : null;
  let best: { hops: number; m: number } | null = null;
  for (const i of fromAt) {
    for (const j of toAt) {
      let hops: number;
      let m: number;
      if (j >= i) {
        hops = j - i;
        m = along[j] - along[i];
      } else if (r.loop) {
        hops = j - i + n;
        m = along[n] - along[i] + along[j];
      } else continue;
      if (!best || hops < best.hops) best = { hops, m };
    }
  }
  return best ? Math.max(0, Math.round(best.m)) : null;
}

export const publicRideS = (metres: number): number => Math.round(metres / PUBLIC.speedMs);
