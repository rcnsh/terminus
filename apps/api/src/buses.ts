/**
 * Live buses on the map: where each bus of a service is, how full, and the
 * stop it reaches next.
 *
 * The feed gives a position and a heading, not a stop. The bus is placed on
 * its route's road shape (data/shapes.json), and its next stop is the first
 * one further along. A route with no shape for its current stops, or a bus
 * away from its line (parked at the depot), has no next stop.
 *
 * Many routes use the same road both ways (most of D1, D2 and K), so the
 * two directions of the line are metres apart, often on the very same
 * points, and GPS can't tell them apart. What can is where the bus has been:
 * a bus drives forward along its route, so its next stop only ever moves on
 * to the stop after. Each bus has a track (its last place along the line),
 * and a new position counts only where the bus could have driven to since:
 * a little back for GPS error, or ahead at most at bus speed. The other
 * side of the road is the far end of the route, so it never counts.
 *
 * - A bus with no track yet is placed by its heading when it's moving, by
 *   the stop it's standing at when it's at one, and otherwise on the nearer
 *   side.
 * - A track that was wrong to begin with gives way when the bus is seen
 *   moving the other way DOUBT_FIXES times in a row; one odd heading doesn't
 *   move it.
 * - A bus is never put back along its line: a position a little behind its
 *   track (GPS error) leaves it where it was, and one up to HOLD_BACK_M
 *   behind (leaving a terminus by the road it came in on) holds it there
 *   for a while.
 * - A tracked bus that strays off its line for a moment (a GPS jump) stays
 *   at its last place; off it for longer (the depot, a detour), it's drawn
 *   where the feed puts it.
 *
 * Tracks live in the edge cache with the placed buses (trackedBuses), so
 * every Worker instance in a data centre draws a bus the same way and picks
 * up its track where another left it. Placing is a pure function of the
 * feed's positions, its time and the tracks, so two instances that place
 * the same update agree.
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
/** A bus's track counts for this long without an update: a bus standing at
 *  a terminus keeps its side. How far it may have gone grows with the time. */
const TRACK_MS = 600_000;
/** How far a bus can go along its line between updates: back (GPS error),
 *  and ahead, as metres plus metres a second (72 km/h, faster than a bus). */
const TRACK_BACK_M = 50;
const TRACK_AHEAD_M = 100;
const TRACK_AHEAD_MS = 20;
/** Moving fixes in a row heading against its track before the track gives way. */
const DOUBT_FIXES = 2;
/** A tracked bus whose only places on its line are behind it, by up to
 *  this, stays where it was for up to HOLD_BACK_MS. Leaving Kent Ridge Bus
 *  Terminal, A1 and A2 drive out along the road they came in by before
 *  they join the start of their line. */
const HOLD_BACK_M = 500;
const HOLD_BACK_MS = 120_000;
/** Off its line for less than this, a tracked bus stays at its last place on it. */
const HOLD_OFF_MS = 30_000;
/** Standing with no track, a bus this close to one of its stops is on that stop's side. */
const STOP_SIDE_M = 30;
/** ...when it's this much closer to that stop than to the one across the road. */
const STOP_SIDE_BY_M = 5;

/** What's kept of a bus between updates. */
export interface Track {
  /** Metres along its line where it was last placed. */
  along: number;
  /** When the feed first gave the position it was placed from (ms). The
   *  feed holds a bus's position for 15-20 s and then moves it a long way,
   *  so how far it can have gone counts from when the position changed,
   *  not from the last time it was asked. */
  at: number;
  /** That position. */
  lat: number;
  lon: number;
  /** Moving fixes in a row whose heading said the other way. */
  doubt: number;
  /** Since when it's been off its line while held at `along`; null on it. */
  offSince: number | null;
}

export interface LiveBus {
  /** Stable while the bus runs, so a client can glide it between updates.
   *  Not the plate. */
  id: string;
  lat: number;
  lon: number;
  /** Metres along the service's route line (`/campus` routes[svc].line),
   *  so a map can glide the bus along the road; null off its line. Never
   *  less than the last answer's, except round a loop's start. */
  along: number | null;
  heading: number | null;
  moving: boolean;
  crowd: Crowd | null;
  nextStop: { code: string; name: string } | null;
}

/** Where a bus is on its line: metres along, the point, and the road's bearing there. */
export interface Place {
  along: number;
  lat: number;
  lon: number;
  /** The way the line runs there; null when the bus isn't heading that way. */
  bearing: number | null;
}

/** One reading from the feed, as `follow` uses it. */
export interface Fix {
  lat: number;
  lon: number;
  /** Degrees; null when standing (a standing bus's heading means nothing). */
  heading: number | null;
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

/** Metres along a line at each of its points, measured once per line. */
const measured = new WeakMap<RouteShape['line'], number[]>();
function cumulative(line: RouteShape['line']): number[] {
  let cum = measured.get(line);
  if (!cum) {
    cum = [0];
    for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + haversineM(line[i - 1][1], line[i - 1][0], line[i][1], line[i][0]));
    measured.set(line, cum);
  }
  return cum;
}

/** The point [m] metres along the line, and the road's bearing there. */
export function pointAlong(shape: RouteShape, m: number): Place {
  const { line } = shape;
  const cum = cumulative(line);
  const x = Math.max(0, Math.min(cum[cum.length - 1], m));
  let i = 0;
  while (i + 2 < line.length && cum[i + 1] < x) i++;
  const [aLon, aLat] = line[i];
  const [bLon, bLat] = line[Math.min(i + 1, line.length - 1)];
  const seg = cum[Math.min(i + 1, line.length - 1)] - cum[i];
  const t = seg > 0 ? (x - cum[i]) / seg : 0;
  return { along: x, lat: aLat + (bLat - aLat) * t, lon: aLon + (bLon - aLon) * t, bearing: seg >= 1 ? bearing(aLat, aLon, bLat, bLon) : null };
}

interface Candidate extends Place {
  /** Which stretch of the line (its first point). */
  i: number;
  /** Metres from the fix. */
  d: number;
  /** The stretch runs the way the bus is heading (or it has no heading). */
  fits: boolean;
}

/** Each stretch of the line within ON_ROUTE_M of the fix, at its nearest point. */
function candidates(shape: RouteShape, fix: Fix): Candidate[] {
  const { line } = shape;
  const cum = cumulative(line);
  const cosLat = Math.cos((fix.lat * Math.PI) / 180);
  const out: Candidate[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const [aLon, aLat] = line[i];
    const [bLon, bLat] = line[i + 1];
    const seg = cum[i + 1] - cum[i];
    // Local flat projection is plenty at this scale.
    const ax = aLon * cosLat, ay = aLat, bx = bLon * cosLat, by = bLat;
    const px = fix.lon * cosLat, py = fix.lat;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const lat = aLat + (bLat - aLat) * t, lon = aLon + (bLon - aLon) * t;
    const d = haversineM(fix.lat, fix.lon, lat, lon);
    if (d > ON_ROUTE_M) continue;
    const road = seg >= 1 ? bearing(aLat, aLon, bLat, bLon) : null;
    const fits = fix.heading == null || road == null || angleBetween(fix.heading, road) <= HEADING_SLACK_DEG;
    out.push({ i, along: cum[i] + seg * t, lat, lon, bearing: fits ? road : null, d, fits });
  }
  return out;
}

/** The track after placing [fix] at [along]: the time only moves on with the position. */
const onward = (kept: Track | null, fix: Fix, along: number, now: number, doubt = 0): Track => ({
  along,
  at: kept && kept.lat === fix.lat && kept.lon === fix.lon ? kept.at : now,
  lat: fix.lat,
  lon: fix.lon,
  doubt,
  offSince: null,
});

const best = <T>(xs: T[], better: (a: T, b: T) => boolean): T | null => xs.reduce<T | null>((b, x) => (b == null || better(x, b) ? x : b), null);

/**
 * Where a bus with track [track] is, from [fix] at time [now], and its
 * track from now on. Null place: off its route. [stops]: where each of
 * shape.stops is, for a standing bus with no track. Exported for the tests.
 */
export function follow(
  shape: RouteShape,
  fix: Fix,
  track: Track | null,
  now: number,
  loop = false,
  stops: ({ lat: number; lon: number } | null)[] = [],
): { place: Place | null; track: Track | null } {
  const cum = cumulative(shape.line);
  const total = cum[cum.length - 1];
  const found = candidates(shape, fix);
  const kept = track && now - track.at < TRACK_MS && now >= track.at ? track : null;

  if (kept) {
    // The same reading again (the feed holds a position for 15-20 s): the same answer.
    if (fix.lat === kept.lat && fix.lon === kept.lon && kept.offSince == null) return { place: pointAlong(shape, kept.along), track: kept };
    const ageS = (now - kept.at) / 1000;
    // Metres driven from the track to `along`: from a little behind it
    // (GPS error) on; round a loop, everything else is ahead.
    const gone = (along: number) => {
      let g = along - kept.along;
      if (loop && total > 0) g = ((((g + TRACK_BACK_M) % total) + total) % total) - TRACK_BACK_M;
      return g;
    };
    const reach = found.filter((c) => {
      const g = gone(c.along);
      return g >= -TRACK_BACK_M && g <= TRACK_AHEAD_M + TRACK_AHEAD_MS * ageS;
    });
    if (!found.length) {
      // Off its line: a GPS jump, held for a moment; longer, it's really off.
      if (kept.offSince == null || now - kept.offSince < HOLD_OFF_MS) {
        return { place: pointAlong(shape, kept.along), track: { ...kept, offSince: kept.offSince ?? now } };
      }
      return { place: null, track: null };
    }
    if (reach.length) {
      // Stretches next to each other are one piece of road: its nearest
      // point. Between pieces (the two sides of a road, when it could have
      // reached both), heading its way first, then the least distance
      // driven: the side it was on, not one further round the route.
      const pieces: Candidate[] = [];
      let run: Candidate[] = [];
      for (const x of reach) {
        if (run.length && x.i !== run[run.length - 1].i + 1) {
          pieces.push(best(run, (a, b) => (a.fits !== b.fits ? a.fits : a.d < b.d))!);
          run = [];
        }
        run.push(x);
      }
      pieces.push(best(run, (a, b) => (a.fits !== b.fits ? a.fits : a.d < b.d))!);
      const c = best(pieces, (a, b) => (a.fits !== b.fits ? a.fits : Math.abs(gone(a.along)) < Math.abs(gone(b.along))))!;
      const against = fix.heading != null && !c.fits ? best(found.filter((x) => x.fits), (a, b) => a.d < b.d) : null;
      const doubt = against ? kept.doubt + 1 : 0;
      if (!against || doubt < DOUBT_FIXES) {
        // Never back: a little behind is GPS error, and it stays put.
        const place = gone(c.along) < 0 ? pointAlong(shape, kept.along) : c;
        return { place, track: onward(kept, fix, place.along, now, doubt) };
      }
      // Seen heading the other way again: the track was wrong.
      return { place: against, track: onward(kept, fix, against.along, now) };
    }
    // Only behind it, not far: it doesn't drive backwards, so it waits there.
    const back = (along: number) => (loop && total > 0 ? (((kept.along - along) % total) + total) % total : kept.along - along);
    if (now - kept.at < HOLD_BACK_MS && found.every((c) => back(c.along) > TRACK_BACK_M && back(c.along) <= HOLD_BACK_M)) {
      return { place: pointAlong(shape, kept.along), track: kept };
    }
    // Nowhere it could have driven to: start again from this fix.
  }

  if (!found.length) return { place: null, track: null };
  // A standing bus by one of its stops is on that stop's side of the road.
  const stopM = (c: Candidate) => {
    let m = Infinity;
    for (let k = 0; k < shape.at.length; k++) {
      const s = stops[k];
      if (s && Math.abs(shape.at[k] - c.along) <= STOP_SIDE_M * 2) m = Math.min(m, haversineM(fix.lat, fix.lon, s.lat, s.lon));
    }
    return m;
  };
  const byStop = (a: Candidate, b: Candidate) => {
    if (fix.heading != null) return 0;
    const [sa, sb] = [stopM(a), stopM(b)];
    if (Math.min(sa, sb) > STOP_SIDE_M || Math.abs(sa - sb) < STOP_SIDE_BY_M) return 0;
    return sa < sb ? 1 : -1;
  };
  const c = best(found, (a, b) => (a.fits !== b.fits ? a.fits : byStop(a, b) !== 0 ? byStop(a, b) > 0 : a.d < b.d))!;
  return { place: c, track: onward(null, fix, c.along, now) };
}

/** Metres along the shape for a bus with no track, or null off its line. */
export function alongLine(shape: RouteShape, lat: number, lon: number, heading: number | null): number | null {
  return follow(shape, { lat, lon, heading }, null, 0).place?.along ?? null;
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

/**
 * A service's buses from the feed's [raw] positions at [now], each placed
 * from its track in [tracks], and the tracks to place the next update from.
 * A bus missing from this update keeps its track while it counts.
 */
export async function placeBuses(
  graph: Graph,
  svc: string,
  raw: RawBus[],
  now: number = Date.now(),
  tracks: Record<string, Track> = {},
): Promise<{ buses: LiveBus[]; tracks: Record<string, Track> }> {
  const seq = graph.routes?.[svc] ?? [];
  const shape = shapeFor(svc, seq);
  const loop = graph.loops?.[svc] ?? (seq.length > 2 && seq[0] === seq[seq.length - 1]);
  const byCode = new Map(graph.stops.map((s) => [s.code, s]));
  const stops = shape ? shape.stops.map((c) => byCode.get(c) ?? null) : [];
  const next: Record<string, Track> = {};
  for (const [id, t] of Object.entries(tracks)) if (now - t.at < TRACK_MS) next[id] = t;
  const buses = await Promise.all(
    raw.map(async (b) => {
      const id = await idFor(svc, b.plate);
      let nextStop: LiveBus['nextStop'] = null;
      let { lat, lon, heading } = b;
      let along: number | null = null;
      if (shape) {
        const moved = follow(shape, { lat: b.lat, lon: b.lon, heading: b.speed > 0 ? b.heading : null }, tracks[id] ?? null, now, loop, stops);
        if (moved.track) next[id] = moved.track;
        else delete next[id];
        const place = moved.place;
        if (place) {
          along = place.along;
          // On its line, pointing along the road.
          lat = place.lat;
          lon = place.lon;
          if (heading != null && place.bearing != null) heading = place.bearing;
          const k = nextStopIndex(shape, place.along, loop);
          if (k != null) {
            const code = shape.stops[k];
            nextStop = { code, name: byCode.get(code)?.name ?? code };
          }
        }
      }
      return {
        id,
        lat: Math.round(lat * 1e6) / 1e6,
        lon: Math.round(lon * 1e6) / 1e6,
        along: along == null ? null : Math.round(along * 10) / 10,
        heading: heading == null ? null : Math.round(heading),
        moving: b.speed > 0,
        crowd: b.crowd,
        nextStop,
      };
    }),
  );
  return { buses, tracks: next };
}

/** One service's placed buses and tracks, as kept in the edge cache. */
interface Placed {
  fetchedAt: number;
  buses: LiveBus[];
  tracks: Record<string, Track>;
}

const placedKey = (svc: string) => new Request(`https://terminus.internal/bus-tracks/${encodeURIComponent(svc)}`);

/**
 * The service's buses for the feed update [live], placed once per update
 * per data centre: the edge cache keeps the placed buses with their tracks,
 * so every instance answers the same and the next update is placed from
 * these tracks wherever it lands.
 */
export async function trackedBuses(
  graph: Graph,
  svc: string,
  live: { buses: RawBus[]; fetchedAt: number },
  ctx: { waitUntil(p: Promise<unknown>): void },
): Promise<LiveBus[]> {
  const cache = caches.default;
  const key = placedKey(svc);
  let kept: Placed | null = null;
  try {
    const hit = await cache.match(key);
    if (hit) kept = (await hit.json()) as Placed;
  } catch {
    kept = null;
  }
  // This update, or a newer one, placed already.
  if (kept && kept.fetchedAt >= live.fetchedAt) return kept.buses;
  const placed = await placeBuses(graph, svc, live.buses, live.fetchedAt, kept?.tracks ?? {});
  const body: Placed = { fetchedAt: live.fetchedAt, ...placed };
  ctx.waitUntil(
    cache
      .put(key, new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${TRACK_MS / 1000}` } }))
      .catch(() => {}),
  );
  return placed.buses;
}
