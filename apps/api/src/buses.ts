/**
 * Live buses on the map: where each bus of a service is, how full, and the
 * stop it reaches next.
 *
 * The feed gives a position and a heading, not a stop. The next stop comes
 * from the route's road shape (data/shapes.json): the bus is placed on the
 * nearest stretch of its line that runs the way it is heading, and the next
 * stop is the first one further along. A route with no shape for its current
 * stops, or a bus away from its line (parked at the depot), has no next stop.
 *
 * Many routes use the same road both ways (most of D1, D2 and K), so the
 * two directions of the line are metres apart, and a standing bus has no
 * heading to choose between them. Each bus's last place on its line is kept,
 * and the next match is the one a bus could have driven to since: a little
 * back for GPS error, or ahead at most at bus speed.
 *
 * The bus is drawn at that place on its line, pointing along the road, so
 * GPS drift doesn't put it beside its route (or in a building); a bus
 * further than ON_ROUTE_M off its line (the depot, a detour) is drawn
 * where the feed puts it.
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
/** A bus's last place on its line counts for this long. */
const TRACK_MS = 120_000;
/** How far a bus can go along its line between updates: back (GPS error),
 *  and ahead, as metres plus metres a second (72 km/h, faster than a bus). */
const TRACK_BACK_M = 50;
const TRACK_AHEAD_M = 100;
const TRACK_AHEAD_MS = 20;

/** Each bus's last place on its line, by id. Per Worker instance: a fresh
 *  one starts without, and matches by heading as before. */
const lastPlace = new Map<string, { along: number; at: number }>();

/** Where a bus was last placed, for [alongLine]. */
export interface Prior {
  along: number;
  /** Seconds since. */
  ageS: number;
}

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
 * A stretch running the way the bus is heading beats one running the other
 * way; then, with [prior], a place it could have driven to since beats one
 * it couldn't (this decides for a standing bus, which has no heading); then
 * the nearest. Heading first, so a wrong first match doesn't stick once the
 * bus moves. Exported for the tests.
 */
export function alongLine(
  shape: RouteShape,
  lat: number,
  lon: number,
  heading: number | null,
  prior: Prior | null = null,
  loop = false,
): number | null {
  return placeOnLine(shape, lat, lon, heading, prior, loop)?.along ?? null;
}

/** Where a bus is on its line: metres along, the point, and the road's bearing there. */
export interface Place {
  along: number;
  lat: number;
  lon: number;
  /** The way the line runs there; null when no stretch runs the way the bus is heading. */
  bearing: number | null;
}

/** As [alongLine], with the point on the line. Exported for the tests. */
export function placeOnLine(
  shape: RouteShape,
  lat: number,
  lon: number,
  heading: number | null,
  prior: Prior | null = null,
  loop = false,
): Place | null {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const found: (Place & { d: number; fits: boolean })[] = [];
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
    if (d <= ON_ROUTE_M) {
      found.push({
        d,
        fits,
        along: walked + seg * t,
        lat: aLat + (bLat - aLat) * t,
        lon: aLon + (bLon - aLon) * t,
        bearing: fits && seg >= 1 ? bearing(aLat, aLon, bLat, bLon) : null,
      });
    }
    walked += seg;
  }
  const total = walked;
  const reachable = (along: number) => {
    if (!prior) return false;
    let gone = along - prior.along;
    // A loop's bus can pass its start.
    if (loop && total > 0 && gone < -total / 2) gone += total;
    return gone >= -TRACK_BACK_M && gone <= TRACK_AHEAD_M + TRACK_AHEAD_MS * prior.ageS;
  };
  let best: (Place & { d: number; fits: boolean; reach: boolean }) | null = null;
  for (const c of found) {
    const x = { ...c, reach: reachable(c.along) };
    // The two sides of a road are metres apart: which way it's heading, then
    // where it could be, decide before distance.
    if (!best || (x.fits !== best.fits ? x.fits : x.reach !== best.reach ? x.reach : x.d < best.d)) best = x;
  }
  return best && { along: best.along, lat: best.lat, lon: best.lon, bearing: best.bearing };
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
  const now = Date.now();
  for (const [id, p] of lastPlace) if (now - p.at > TRACK_MS) lastPlace.delete(id);
  return Promise.all(
    raw.map(async (b) => {
      const id = await idFor(svc, b.plate);
      let nextStop: LiveBus['nextStop'] = null;
      let { lat, lon, heading } = b;
      if (shape) {
        const last = lastPlace.get(id);
        const prior = last && now - last.at < TRACK_MS ? { along: last.along, ageS: Math.max(0, now - last.at) / 1000 } : null;
        const place = placeOnLine(shape, b.lat, b.lon, b.speed > 0 ? b.heading : null, prior, loop);
        if (place) {
          lastPlace.set(id, { along: place.along, at: now });
          // On its line, pointing along the road.
          lat = place.lat;
          lon = place.lon;
          if (heading != null && place.bearing != null) heading = place.bearing;
        }
        const k = place == null ? null : nextStopIndex(shape, place.along, loop);
        if (k != null) {
          const code = shape.stops[k];
          nextStop = { code, name: names.get(code) ?? code };
        }
      }
      return {
        id,
        lat: Math.round(lat * 1e6) / 1e6,
        lon: Math.round(lon * 1e6) / 1e6,
        heading: heading == null ? null : Math.round(heading),
        moving: b.speed > 0,
        crowd: b.crowd,
        nextStop,
      };
    }),
  );
}
