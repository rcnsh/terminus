import { shapeFor } from './campus.ts';
import type { RouteShape } from './campus.ts';
import type { RawBus } from '../feeds/fms.ts';
import { haversineM } from '../geo.ts';
import { cacheBase } from '../feeds/edgecache.ts';
import type { Crowd, Graph, GraphIndex } from '../types.ts';

const ON_ROUTE_M = 50;
const HEADING_SLACK_DEG = 60;
const AT_STOP_M = 40;
const TRACK_MS = 600_000;
const TRACK_BACK_M = 50;
const TRACK_AHEAD_M = 100;
const TRACK_AHEAD_MPS = 20;
const DOUBT_FIXES = 2;
const HOLD_BACK_M = 500;
const HOLD_BACK_MS = 120_000;
const HOLD_OFF_MS = 30_000;
const STOP_SIDE_M = 30;
const STOP_SIDE_BY_M = 5;

export interface Track {
  along: number;
  at: number;
  lat: number;
  lon: number;
  seen: number;
  doubt: number;
  offSince: number | null;
  held?: boolean;
  shown?: { key: string; along: number };
}

export interface LiveBus {
  id: string;
  plate: string;
  lat: number;
  lon: number;
  along: number;
  heading: number | null;
  moving: boolean;
  crowd: Crowd | null;
  at: { code: string; name: string } | null;
  slot: number;
  stretch: { from: number; to: number; last: { code: string; name: string } } | null;
  nextStop: { code: string; name: string } | null;
  upcoming: { code: string; name: string }[];
  towards: { code: string; name: string };
}

export interface Place {
  along: number;
  lat: number;
  lon: number;
  bearing: number | null;
}

export interface Fix {
  lat: number;
  lon: number;
  heading: number | null;
}

function bearing(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = Math.PI / 180;
  const y = Math.sin((bLon - aLon) * r) * Math.cos(bLat * r);
  const x = Math.cos(aLat * r) * Math.sin(bLat * r) - Math.sin(aLat * r) * Math.cos(bLat * r) * Math.cos((bLon - aLon) * r);
  return (((Math.atan2(y, x) / r) % 360) + 360) % 360;
}

const angleBetween = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

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
  return {
    along: x,
    lat: aLat + (bLat - aLat) * t,
    lon: aLon + (bLon - aLon) * t,
    bearing: seg >= 1 ? bearing(aLat, aLon, bLat, bLon) : null,
  };
}

interface Candidate extends Place {
  i: number;
  d: number;
  fits: boolean;
}

function candidates(shape: RouteShape, fix: Fix, withinM = ON_ROUTE_M): Candidate[] {
  const { line } = shape;
  const cum = cumulative(line);
  const cosLat = Math.cos((fix.lat * Math.PI) / 180);
  const out: Candidate[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const [aLon, aLat] = line[i];
    const [bLon, bLat] = line[i + 1];
    const seg = cum[i + 1] - cum[i];
    const ax = aLon * cosLat,
      ay = aLat,
      bx = bLon * cosLat,
      by = bLat;
    const px = fix.lon * cosLat,
      py = fix.lat;
    const dx = bx - ax,
      dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const lat = aLat + (bLat - aLat) * t,
      lon = aLon + (bLon - aLon) * t;
    const d = haversineM(fix.lat, fix.lon, lat, lon);
    if (d > withinM) continue;
    const road = seg >= 1 ? bearing(aLat, aLon, bLat, bLon) : null;
    const fits = fix.heading == null || road == null || angleBetween(fix.heading, road) <= HEADING_SLACK_DEG;
    out.push({ i, along: cum[i] + seg * t, lat, lon, bearing: fits ? road : null, d, fits });
  }
  return out;
}

export function alongNear(shape: RouteShape, lat: number, lon: number, withinM: number): number[] {
  return candidates(shape, { lat, lon, heading: null }, withinM).map((c) => c.along);
}

const onward = (kept: Track | null, fix: Fix, along: number, now: number, doubt = 0, held = false): Track => ({
  along,
  at: kept && kept.lat === fix.lat && kept.lon === fix.lon ? kept.at : now,
  lat: fix.lat,
  lon: fix.lon,
  seen: now,
  doubt,
  offSince: null,
  held,
});

const best = <T>(xs: T[], better: (a: T, b: T) => boolean): T | null =>
  xs.reduce<T | null>((b, x) => (b == null || better(x, b) ? x : b), null);

export function follow(
  shape: RouteShape,
  fix: Fix,
  track: Track | null,
  now: number,
  loop = false,
  stops: ({ lat: number; lon: number } | null)[] = [],
): { place: Place | null; track: Track | null; kept: boolean } {
  const cum = cumulative(shape.line);
  const total = cum[cum.length - 1];
  const found = candidates(shape, fix);
  const kept = track && now - track.seen < TRACK_MS && now >= track.at ? track : null;

  if (kept) {
    if (fix.lat === kept.lat && fix.lon === kept.lon && kept.offSince == null)
      return { place: pointAlong(shape, kept.along), track: { ...kept, seen: now }, kept: true };
    const ageS = (now - kept.at) / 1000;
    const gone = (along: number) => {
      let g = along - kept.along;
      if (loop && total > 0) g = ((((g + HOLD_BACK_M) % total) + total) % total) - HOLD_BACK_M;
      return g;
    };
    const reach = found.filter((c) => {
      const g = gone(c.along);
      return g >= -TRACK_BACK_M && g <= TRACK_AHEAD_M + TRACK_AHEAD_MPS * ageS;
    });
    if (!found.length) {
      if (kept.offSince == null || now - kept.offSince < HOLD_OFF_MS) {
        return {
          place: pointAlong(shape, kept.along),
          track: { ...kept, offSince: kept.offSince ?? now, held: true, seen: now },
          kept: true,
        };
      }
      return { place: null, track: null, kept: false };
    }
    if (reach.length) {
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
      const against =
        fix.heading != null && !c.fits
          ? best(
              found.filter((x) => x.fits),
              (a, b) => a.d < b.d,
            )
          : null;
      const doubt = against ? kept.doubt + 1 : 0;
      if (!against || doubt < DOUBT_FIXES) {
        const back = gone(c.along) < 0;
        const place = back ? pointAlong(shape, kept.along) : c;
        return { place, track: onward(kept, fix, place.along, now, doubt, back), kept: true };
      }
      return { place: against, track: onward(kept, fix, against.along, now), kept: false };
    }
    const back = (along: number) => (loop && total > 0 ? (((kept.along - along) % total) + total) % total : kept.along - along);
    const atLoopEnd = loop && total > 0 && total - kept.along <= HOLD_BACK_M;
    if (
      now - kept.at < (atLoopEnd ? TRACK_MS : HOLD_BACK_MS) &&
      found.every((c) => back(c.along) > TRACK_BACK_M && back(c.along) <= HOLD_BACK_M)
    ) {
      return { place: pointAlong(shape, kept.along), track: { ...kept, held: true, seen: now }, kept: true };
    }
  }

  if (!found.length) return { place: null, track: null, kept: false };
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
  return { place: c, track: onward(null, fix, c.along, now), kept: false };
}

export function alongLine(shape: RouteShape, lat: number, lon: number, heading: number | null): number | null {
  return follow(shape, { lat, lon, heading }, null, 0).place?.along ?? null;
}

export interface Section {
  at: number | null;
  from: number;
  to: number | null;
}

export function sectionOf(shape: RouteShape, along: number, loop: boolean): Section {
  const { at } = shape;
  const last = at.length - 1;
  const total = cumulative(shape.line).at(-1) ?? 0;
  const gap = (k: number) => {
    const d = Math.abs(at[k] - along);
    return loop && total > 0 ? Math.min(d, total - d) : d;
  };
  let k = 0;
  for (let i = 1; i <= last; i++) if (gap(i) < gap(k)) k = i;
  const stopAt = (i: number): Section => ({ at: loop && i === last ? 0 : i, from: loop && i === last ? 0 : i, to: null });
  if (gap(k) <= AT_STOP_M || along <= at[0]) return stopAt(k);
  if (along >= at[last]) return stopAt(last);
  let from = 0;
  while (from + 1 < last && at[from + 1] <= along) from++;
  return { at: null, from, to: from + 1 };
}

export function nextOf(shape: RouteShape, s: Section, loop: boolean): number | null {
  if (s.at == null) return s.to;
  const k = s.at + 1;
  if (k < shape.stops.length) return k;
  return loop && shape.stops.length > 1 ? 1 : null;
}

async function idFor(svc: string, plate: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`terminus-bus:${svc}:${plate}`));
  return [...new Uint8Array(digest).slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function placeBuses(
  graph: Graph,
  svc: string,
  raw: RawBus[],
  now: number = Date.now(),
  tracks: Record<string, Track> = {},
  shape: RouteShape | null = shapeFor(svc, graph.routes?.[svc] ?? []),
): Promise<{ buses: LiveBus[]; tracks: Record<string, Track> }> {
  const seq = graph.routes?.[svc] ?? [];
  const loop = graph.loops?.[svc] ?? (seq.length > 2 && seq[0] === seq[seq.length - 1]);
  const byCode = new Map(graph.stops.map((s) => [s.code, s]));
  const stops = shape ? shape.stops.map((c) => byCode.get(c) ?? null) : [];
  const next: Record<string, Track> = {};
  for (const [id, t] of Object.entries(tracks)) if (now - t.seen < TRACK_MS) next[id] = t;
  if (!shape) return { buses: [], tracks: next };
  const total = cumulative(shape.line).at(-1) ?? 0;
  const stopOf = (k: number | null) =>
    k == null ? null : { code: shape.stops[k], name: byCode.get(shape.stops[k])?.name ?? shape.stops[k] };
  const upcomingOf = (k: number | null) => (k == null ? [] : shape.stops.slice(k).map((_, i) => stopOf(k + i)!));

  const found: { b: RawBus; id: string; along: number; section: Section; key: string; was?: Track['shown'] }[] = [];
  for (const b of raw) {
    const id = await idFor(svc, b.plate);
    const moved = follow(shape, { lat: b.lat, lon: b.lon, heading: b.speed > 0 ? b.heading : null }, tracks[id] ?? null, now, loop, stops);
    if (moved.track) next[id] = moved.track;
    else delete next[id];
    if (moved.place && moved.track) {
      const section = sectionOf(shape, moved.place.along, loop);
      const key = section.at != null ? `at ${section.at}` : `from ${section.from}`;
      found.push({ b, id, along: moved.place.along, section, key, was: tracks[id]?.shown });
    }
  }

  const groups = new Map<string, typeof found>();
  for (const f of found) groups.set(f.key, [...(groups.get(f.key) ?? []), f]);
  const order = (x: (typeof found)[number]) => (x.was?.key === x.key ? x.was.along : x.along);
  const past = (along: number, k: number) => {
    let d = along - shape.at[k];
    if (loop && total > 0) d = ((((d + total / 2) % total) + total) % total) - total / 2;
    return d;
  };
  const round = (x: number, k: number) => Math.round(x * k) / k;
  const buses: LiveBus[] = [];
  for (const group of groups.values()) {
    const { at: k, from, to } = group[0].section;
    const sorted =
      k != null
        ? [...group].sort((x, y) => past(y.along, k) - past(x.along, k) || x.id.localeCompare(y.id))
        : [...group].sort((x, y) => order(x) - order(y) || x.id.localeCompare(y.id));
    sorted.forEach((f, i) => {
      const even = k != null ? shape.at[k] : shape.at[from] + ((i + 1) / (sorted.length + 1)) * (shape.at[to!] - shape.at[from]);
      const along = k == null && f.was?.key === f.key ? Math.max(even, f.was.along) : even;
      next[f.id] = { ...next[f.id], shown: { key: f.key, along } };
      const line = pointAlong(shape, along);
      const stop = k != null ? stops[k] : null;
      buses.push({
        id: f.id,
        plate: f.b.plate,
        lat: round(stop?.lat ?? line.lat, 1e6),
        lon: round(stop?.lon ?? line.lon, 1e6),
        along: round(along, 10),
        heading: line.bearing != null ? Math.round(line.bearing) : f.b.heading == null ? null : Math.round(f.b.heading),
        moving: f.b.speed > 0,
        crowd: f.b.crowd,
        at: stopOf(k),
        slot: k != null ? i : 0,
        stretch: k == null ? { from: round(shape.at[from], 10), to: round(shape.at[to!], 10), last: stopOf(from)! } : null,
        nextStop: stopOf(nextOf(shape, f.section, loop)),
        upcoming: upcomingOf(nextOf(shape, f.section, loop)),
        towards: stopOf(shape.stops.length - 1)!,
      });
    });
  }
  const rank = new Map(found.map((f, i) => [f.id, i]));
  buses.sort((x, y) => rank.get(x.id)! - rank.get(y.id)!);
  return { buses, tracks: next };
}

export interface Placed {
  fetchedAt: number;
  buses: LiveBus[];
  tracks: Record<string, Track>;
}

const placedKey = (svc: string) => new Request(`${cacheBase()}/bus-tracks/${encodeURIComponent(svc)}`);

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
  if (kept && kept.fetchedAt >= live.fetchedAt) return kept.buses;
  const placed = await placeBuses(graph, svc, live.buses, live.fetchedAt, kept?.tracks ?? {});
  const body: Placed = { fetchedAt: live.fetchedAt, ...placed };
  ctx.waitUntil(
    cache
      .put(
        key,
        new Response(JSON.stringify(body), {
          headers: { 'content-type': 'application/json', 'cache-control': `max-age=${TRACK_MS / 1000}` },
        }),
      )
      .catch(() => {}),
  );
  return body.buses;
}

export interface LineStop {
  code: string;
  name: string;
  longName: string;
  services: string[];
}

export function lineStops(idx: GraphIndex, svc: string): LineStop[] {
  const route = idx.routes.get(svc);
  if (!route) return [];
  const seq = route.loop && route.seq.length > 1 ? [...route.seq, route.seq[0]] : route.seq;
  return seq.map((code) => ({
    code,
    name: idx.byCode.get(code)?.name ?? code,
    longName: idx.byCode.get(code)?.longName ?? idx.byCode.get(code)?.name ?? code,
    services: (idx.servingStop.get(code) ?? []).filter((s) => s !== svc),
  }));
}

export interface LineBus {
  id: string;
  plate: string;
  crowd: Crowd | null;
  at: number | null;
  after: number | null;
}

export function indexOnLine(
  seq: string[],
  loop: boolean,
  bus: Pick<LiveBus, 'at' | 'stretch' | 'nextStop'>,
): { at: number | null; after: number | null } | null {
  const after = (i: number): string | null => (i + 1 < seq.length ? seq[i + 1] : loop ? seq[0] : null);
  const find = (code: string): number | null => {
    const hits = seq.flatMap((c, i) => (c === code ? [i] : []));
    return hits.find((i) => bus.nextStop != null && after(i) === bus.nextStop.code) ?? hits[0] ?? null;
  };
  if (bus.at) {
    const i = find(bus.at.code);
    return i === null ? null : { at: i, after: null };
  }
  if (!bus.stretch) return null;
  const i = find(bus.stretch.last.code);
  if (i === null) return null;
  return after(i) === null ? { at: i, after: null } : { at: null, after: i };
}

export function busesOnLine(seq: string[], loop: boolean, buses: LiveBus[]): LineBus[] {
  return buses.flatMap((b) => {
    const where = indexOnLine(seq, loop, b);
    return where ? [{ id: b.id, plate: b.plate, crowd: b.crowd, ...where }] : [];
  });
}
