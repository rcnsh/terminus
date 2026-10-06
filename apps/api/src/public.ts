/**
 * Public buses in the stop graph (data/public.json, from scripts/scrape_lta.py).
 *
 * They are services like any other once in the graph: the resolver pairs
 * stops, checks the route goes where you're going and scores by time the
 * same way. Three things are their own. A two-way service is two routes,
 * `151/1` and `151/2`, and shows as `151`; ride time comes from metres along
 * the route rather than a count of stops; and a fare counts against them.
 */

import type { Graph, GraphIndex, Stop } from './types.ts';
import { PUBLIC } from './config.ts';

/** What's painted on the bus: the route key without its direction (`151/1` -> `151`). */
export const svcName = (key: string): string => key.split('/')[0];

/** A public bus service (with a fare), by route key. */
export const isPublic = (graph: Graph, svc: string): boolean => Boolean(graph.public?.[svc]);

/** Whether public buses call at this stop: a shelter they share with the shuttle, or a stop of their own. */
export const publicCodeOf = (stop: Stop): string | null => stop.publicCode ?? (stop.public ? stop.code : null);

/** Whether the shuttle calls at this stop (every stop but a public-only one). */
export const shuttleCalls = (stop: Stop): boolean => !stop.public;

/** The shape of data/public.json. */
export interface PublicData {
  stops: Array<{ code: string; name: string; lat: number; lon: number }>;
  /** LTA code -> the shuttle stop on the same shelter. */
  merged: Record<string, string>;
  routes: Record<string, string[]>;
  along: Record<string, number[]>;
  loops: Record<string, boolean>;
  public: Graph['public'];
  serviceHours: Graph['serviceHours'];
  headwayS: Record<string, number>;
}

/**
 * The stop graph with the public buses in it. The shuttle stops are the
 * same objects' worth of data (so stop codes, pairs and residences hold);
 * a shared shelter gains its LTA code, and public-only stops join the list.
 */
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

/**
 * Metres ridden on `svc` from `from` to `to`, the same way round as reach()
 * counts the hops (the fewest, wrapping on a loop). Null when the graph has
 * no distances for the route, or `to` isn't downstream.
 */
export function rideMetres(idx: GraphIndex, svc: string, from: string, to: string): number | null {
  const r = idx.routes.get(svc);
  const along = idx.graph.along?.[svc];
  if (!r || !along) return null;
  const n = r.seq.length;
  // A loop's distances include the way back round to its first stop.
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

/** Seconds on a public bus for a ride of `metres`, stops included. */
export const publicRideS = (metres: number): number => Math.round(metres / PUBLIC.speedMs);
