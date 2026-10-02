/**
 * Live buses on the map: where each bus of a service is, how full, and the
 * stop it reaches next.
 *
 * The feed gives a position and a heading, not a stop. The next stop comes
 * from the route's road shape (data/shapes.json): the bus is placed on the
 * nearest stretch of its line that runs the way it is heading, and the next
 * stop is the first one further along. A route with no shape for its current
 * stops, or a bus away from its line (parked at the depot), has no next stop.
 */

import { shapeFor } from './campus.ts';
import type { RouteShape } from './campus.ts';
import type { RawBus } from './fms.ts';
import { haversineM } from './geo.ts';
import type { Crowd, Graph } from './types.ts';

/** Further than this from its line, a bus is not on its route. */
const ON_ROUTE_M = 50;
/** A stretch of road counts as "the way it's heading" within this angle. */
const HEADING_SLACK_DEG = 60;
/** Within this of a stop, the bus is at it: the next stop is the one after. */
const AT_STOP_M = 15;

export interface LiveBus {
  /** Stable while the bus runs, so a client can glide it between updates.
   *  Not the plate. */
  id: string;
  lat: number;
  lon: number;
  heading: number | null;
  moving: boolean;
  crowd: Crowd | null;
  nextStop: { code: string; name: string } | null;
}

function bearing(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = Math.PI / 180;
  const y = Math.sin((bLon - aLon) * r) * Math.cos(bLat * r);
  const x = Math.cos(aLat * r) * Math.sin(bLat * r) - Math.sin(aLat * r) * Math.cos(bLat * r) * Math.cos((bLon - aLon) * r);
  return ((Math.atan2(y, x) / r) % 360 + 360) % 360;
}

const angleBetween = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/**
 * Metres along the shape where the bus is, or null when it is off its line.
 * Exported for the tests.
 */
export function alongLine(shape: RouteShape, lat: number, lon: number, heading: number | null): number | null {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  let best: { d: number; along: number; fits: boolean } | null = null;
  let walked = 0;
  for (let i = 0; i + 1 < shape.line.length; i++) {
    const [aLon, aLat] = shape.line[i];
    const [bLon, bLat] = shape.line[i + 1];
    const seg = haversineM(aLat, aLon, bLat, bLon);
    // Local flat projection is plenty at this scale.
    const ax = aLon * cosLat, ay = aLat, bx = bLon * cosLat, by = bLat;
    const px = lon * cosLat, py = lat;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const d = haversineM(lat, lon, aLat + (bLat - aLat) * t, aLon + (bLon - aLon) * t);
    const fits = heading == null || seg < 1 || angleBetween(heading, bearing(aLat, aLon, bLat, bLon)) <= HEADING_SLACK_DEG;
    // A stretch running the right way beats a nearer one running the other
    // way: the two sides of a road are metres apart.
    if (d <= ON_ROUTE_M && (!best || (fits && !best.fits) || (fits === best.fits && d < best.d))) {
      best = { d, along: walked + seg * t, fits };
    }
    walked += seg;
  }
  return best ? best.along : null;
}

/** The stop the bus reaches next, as an index into shape.stops. */
export function nextStopIndex(shape: RouteShape, along: number, loop: boolean): number | null {
  for (let k = 0; k < shape.at.length; k++) {
    if (shape.at[k] > along + AT_STOP_M) return k;
  }
  // Past the last stop: a loop starts again (its first stop is its last).
  return loop && shape.stops.length > 1 ? 1 : null;
}

async function idFor(svc: string, plate: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`terminus-bus:${svc}:${plate}`));
  return [...new Uint8Array(digest).slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function placeBuses(graph: Graph, svc: string, raw: RawBus[]): Promise<LiveBus[]> {
  const seq = graph.routes?.[svc] ?? [];
  const shape = shapeFor(svc, seq);
  const loop = graph.loops?.[svc] ?? (seq.length > 2 && seq[0] === seq[seq.length - 1]);
  const names = new Map(graph.stops.map((s) => [s.code, s.name]));
  return Promise.all(
    raw.map(async (b) => {
      let nextStop: LiveBus['nextStop'] = null;
      if (shape) {
        const along = alongLine(shape, b.lat, b.lon, b.speed > 0 ? b.heading : null);
        const k = along == null ? null : nextStopIndex(shape, along, loop);
        if (k != null) {
          const code = shape.stops[k];
          nextStop = { code, name: names.get(code) ?? code };
        }
      }
      return {
        id: await idFor(svc, b.plate),
        lat: Math.round(b.lat * 1e6) / 1e6,
        lon: Math.round(b.lon * 1e6) / 1e6,
        heading: b.heading == null ? null : Math.round(b.heading),
        moving: b.speed > 0,
        crowd: b.crowd,
        nextStop,
      };
    }),
  );
}
