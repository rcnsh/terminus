/**
 * Static campus data for the Map and Plan tabs: a real-coordinate projection
 * of every stop and route for the map, and a flat search index for the trip
 * planner's destination field.
 *
 * Deliberately NOT a metro-schematic (idealized 45/90-degree lines): that
 * look needs hand-curated coordinates that go stale the moment the weekly
 * scrape changes a stop, which fights the "static graph, never hand-touched"
 * architecture the rest of this project is built on. This projects the real
 * lat/lon instead, so a scraped change just appears in the right place.
 *
 * Pre-rendered here, not in the client, for the same reason /next pre-renders
 * label/detail: one place computes it, every client (today just the page,
 * later anything else) draws it without redoing geometry.
 */

import venuesJson from '../data/venues.json' with { type: 'json' };
import roomsJson from '../data/rooms.json' with { type: 'json' };
import shapesJson from '../data/shapes.json' with { type: 'json' };
import { allLandmarks } from './landmarks.ts';
import type { Graph, Stop } from './types.ts';

const VENUES = venuesJson as { venues: Record<string, { stop: string; m: number }> };
const ROOMS = roomsJson as { rooms: Record<string, { name: string; stop: string; m: number }> };

/** A service's path along the roads (scripts/route_shapes.py). */
export interface RouteShape {
  /** The stop sequence it was routed for. */
  stops: string[];
  /** [lon, lat] points, GeoJSON order. */
  line: [number, number][];
  /** Metres along `line` at each of `stops`. */
  at: number[];
}

export const SHAPES = (shapesJson as unknown as { routes: Record<string, RouteShape> }).routes;

/* ------------------------------------------------------------------ */
/* Projection                                                          */
/* ------------------------------------------------------------------ */

export interface ProjectedStop {
  code: string;
  name: string;
  longName: string;
  opposite: string | null;
  x: number;
  y: number;
  lat: number;
  lon: number;
  /** The services that stop here, in route order. */
  services: string[];
  /** False for a small number of real stops that sit far off the dense
   *  campus cluster (P's excursion to Botanic Gardens MRT is the current
   *  case) -- scaling the map to fit them too would shrink the other ~30
   *  stops to illegibility. Off-core stops still carry a real projected x/y
   *  and are still fully functional (search, tap-for-arrivals); the client
   *  just lists them separately instead of plotting a misleading position. */
  core: boolean;
}

export interface ProjectedRoute {
  seq: string[];
  loop: boolean;
  color: string;
  /** The path to draw, [lon, lat] (GeoJSON LineString coordinates). */
  line: [number, number][];
  /** True when `line` follows the roads; false when it is straight lines
   *  between stops, because the stops changed since the shapes were made. */
  shaped: boolean;
}

export interface CampusMap {
  viewBox: string;
  stops: ProjectedStop[];
  routes: Record<string, ProjectedRoute>;
}

/**
 * Each service's colour, as NUS paints it on the buses and stop signs (as
 * students know them; D1 and P chosen to stay distinct). Every client takes
 * these from /campus rather than keeping its own copy.
 */
export const ROUTE_COLORS: Record<string, string> = {
  A1: '#e53935', // red
  A2: '#d9a000', // yellow, deep enough for white text
  D1: '#ec4fa0', // pink
  D2: '#8e44c9', // purple
  K: '#2b9ad6', // light blue, deep enough for white text
  P: '#8a939c', // grey
  R1: '#f57c1f', // orange
  R2: '#34a853', // green
};

/** A service's colour, grey for one NUS hasn't painted. */
export const routeColor = (svc: string): string => ROUTE_COLORS[svc] ?? '#8b98a6';

const VIEW_W = 1000;
const PAD = 60;
const METERS_PER_DEG_LAT = 111_320;
/** A stop beyond this many times the median distance-from-centroid is a real
 *  outlier, not just a stop on the edge of campus. Picked from the actual
 *  data: NUS's 30 core stops sit within ~1.1km of the campus centroid; the
 *  3 that ride P out to Botanic Gardens MRT sit at ~5.3km+ -- a clean gap,
 *  not a borderline call, so a factor of 3 never misclassifies either group. */
const CORE_RADIUS_FACTOR = 3;

function median(nums: number[]): number {
  const s = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function buildCampusMap(graph: Graph): CampusMap {
  const stops = graph.stops;
  const meanLatRad = (median(stops.map((s) => s.lat)) * Math.PI) / 180;
  const metersPerDegLonAll = METERS_PER_DEG_LAT * Math.cos(meanLatRad);

  // Classify core vs. outlier from distance to the median center, in real
  // meters -- independent of whatever bounding box ends up driving the
  // projection scale below.
  const clat = median(stops.map((s) => s.lat));
  const clon = median(stops.map((s) => s.lon));
  const distFromCenter = new Map<string, number>();
  for (const s of stops) {
    const dx = (s.lon - clon) * metersPerDegLonAll;
    const dy = (s.lat - clat) * METERS_PER_DEG_LAT;
    distFromCenter.set(s.code, Math.hypot(dx, dy));
  }
  const med = median([...distFromCenter.values()]);
  const isCore = (code: string) => (distFromCenter.get(code) ?? 0) <= med * CORE_RADIUS_FACTOR;

  const core = stops.filter((s) => isCore(s.code));
  const coreStops = core.length >= 2 ? core : stops; // never end up with an empty core

  const lats = coreStops.map((s) => s.lat);
  const lons = coreStops.map((s) => s.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const metersPerDegLon = METERS_PER_DEG_LAT * Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180));

  const widthM = Math.max(1, (maxLon - minLon) * metersPerDegLon);
  const heightM = Math.max(1, (maxLat - minLat) * METERS_PER_DEG_LAT);
  const scale = (VIEW_W - 2 * PAD) / widthM;
  const viewH = Math.round(heightM * scale + 2 * PAD);

  function project(s: Stop): { x: number; y: number } {
    const mX = (s.lon - minLon) * metersPerDegLon;
    const mY = (s.lat - minLat) * METERS_PER_DEG_LAT;
    return {
      x: Math.round((PAD + mX * scale) * 10) / 10,
      // Latitude grows north; SVG y grows down. Flip so north is up.
      y: Math.round((PAD + (heightM - mY) * scale) * 10) / 10,
    };
  }

  const servicesAt = new Map<string, string[]>();
  for (const [svc, seq] of Object.entries(graph.routes ?? {})) {
    for (const code of seq) {
      const list = servicesAt.get(code) ?? [];
      if (!list.includes(svc)) list.push(svc);
      servicesAt.set(code, list);
    }
  }
  const byCode = new Map(stops.map((s) => [s.code, s]));

  const projected: ProjectedStop[] = stops.map((s) => {
    const { x, y } = project(s);
    return { code: s.code, name: s.name, longName: s.name, opposite: s.opposite ?? null, x, y, lat: s.lat, lon: s.lon, services: servicesAt.get(s.code) ?? [], core: isCore(s.code) };
  });

  const routes: Record<string, ProjectedRoute> = {};
  for (const [svc, seq] of Object.entries(graph.routes ?? {})) {
    // graph.routes stores the raw scraped sequence, which for a loop repeats
    // its first stop as its last -- drop that so the polyline does not draw
    // a zero-length closing segment on top of a real one.
    const closes = seq.length > 2 && seq[0] === seq[seq.length - 1];
    const loop = graph.loops?.[svc] ?? closes;
    const shape = shapeFor(svc, seq);
    routes[svc] = {
      seq: closes ? seq.slice(0, -1) : seq.slice(),
      loop,
      color: routeColor(svc),
      line: shape?.line ?? seq.flatMap((c) => {
        const st = byCode.get(c);
        return st ? [[st.lon, st.lat] as [number, number]] : [];
      }),
      shaped: Boolean(shape),
    };
  }

  return { viewBox: `0 0 ${VIEW_W} ${viewH}`, stops: projected, routes };
}

/** The road shape for a service, when it was made for the stops it runs now. */
export function shapeFor(svc: string, seq: string[]): RouteShape | null {
  const shape = SHAPES[svc];
  if (!shape || shape.stops.length !== seq.length || shape.stops.some((c, i) => c !== seq[i])) return null;
  return shape;
}

/* ------------------------------------------------------------------ */
/* Friendly building labels                                            */
/* ------------------------------------------------------------------ */

/**
 * A best-effort starter set, not a verified official directory. Kept
 * deliberately small: shipping a wrong campus building name to a real
 * student is worse than an unlabelled code they can still search directly.
 * Safe to extend -- add an entry and it is picked up everywhere.
 */
const CURATED_LABELS: Record<string, string> = {
  UTOWN: 'University Town',
  PGP: "Prince George's Park Residences",
  CLB: 'Central Library',
  CLIB: 'Central Library',
  CNLIB: 'Central Library (C J Koh)',
  MUSEUM: 'NUS Museum',
  UHALL: 'University Hall',
  UHC: 'University Health Centre',
  YIH: 'Yusof Ishak House',
  LKCNHM: 'Lee Kong Chian Natural History Museum',
  UCC: 'University Cultural Centre',
  KV: 'Kent Vale',
  HSSML: 'Hon Sui Sen Memorial Library',
  RH: 'Raffles Hall',
  KEVII: 'King Edward VII Hall',
  TEMB: 'Tembusu College',
  CAPT: 'College of Alice & Peter Tan',
};

/** Mechanical, low-risk patterns: a faculty/lecture-theatre prefix is public
 *  and unambiguous, unlike guessing a specific hall or lab's proper name. */
const MECHANICAL_LABELS: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [/^LT(\d+[A-Z]?)$/, (m) => `Lecture Theatre ${m[1]}`],
  [/^COM([123])$/, (m) => `School of Computing (COM${m[1]})`],
  [/^BIZ([12])$/, (m) => `NUS Business School (BIZ${m[1]})`],
  [/^AS(\d)$/, (m) => `Faculty of Arts & Social Sciences (AS${m[1]})`],
  [/^SDE(\d)$/, (m) => `School of Design & Environment (SDE${m[1]})`],
  [/^E(\d+A?)$/, (m) => `Faculty of Engineering (E${m[1]})`],
  [/^S(\d+[A-Z]?)$/, (m) => `Faculty of Science (S${m[1]})`],
];

export function friendlyLabel(code: string): string | null {
  const c = code.trim().toUpperCase();
  if (CURATED_LABELS[c]) return CURATED_LABELS[c];
  for (const [re, fn] of MECHANICAL_LABELS) {
    const m = re.exec(c);
    if (m) return fn(m);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Destination search index                                            */
/* ------------------------------------------------------------------ */

export interface Destination {
  code: string;
  label: string;
  /** Always a real stop code -- the client never resolves a venue itself. */
  stopCode: string;
  kind: 'stop' | 'landmark' | 'building' | 'room';
  /** A landmark's every stop, best first; the router takes the quicker. */
  stops?: string[];
  /** What a landmark is ("Food court"). */
  detail?: string;
  /** Metres on foot from `stopCode` to here. Absent for a stop. */
  walkM?: number;
  /** Other names people search for ("soc", "mrt"). Lower case. */
  aliases?: string[];
}

/**
 * Short names students actually type. Only ones that are certain: a wrong
 * nickname sends someone to the wrong side of campus. Keyed by destination
 * code, or by a building-code pattern for whole faculties.
 */
const ALIASES: Record<string, string[]> = {
  'KR-MRT': ['mrt', 'kent ridge mrt'],
  UTOWN: ['utown', 'university town'],
  PGP: ['pgp', "prince george's park"],
  CLB: ['library', 'central library', 'clb'],
  UHC: ['health centre', 'clinic'],
  YIH: ['yih'],
  KV: ['kent vale'],
};
const FACULTY_ALIASES: Array<[RegExp, string[]]> = [
  [/^COM\d$/, ['soc', 'computing']],
  [/^BIZ\d$/, ['biz', 'business']],
  [/^AS\d$/, ['fass', 'arts']],
  [/^SDE\d$/, ['cde', 'sde', 'design']],
  [/^E\d+A?$/, ['engineering', 'cde']],
  [/^S\d+[A-Z]?$/, ['science', 'fos']],
];

function aliasesFor(code: string): string[] | undefined {
  const out = [...(ALIASES[code] ?? [])];
  for (const [re, names] of FACULTY_ALIASES) if (re.test(code)) out.push(...names);
  return out.length ? out : undefined;
}

/**
 * One flat list combining the 33 stops and every known NUSMods venue code,
 * each already resolved to a boardable stop. The client just substring-
 * searches `label`/`code` and hands the matched `stopCode` straight to
 * `/trip?to=`; venue resolution (data/venues.json, prefix fallback) happens
 * here once, server-side, the same way it already does for NUSMods import.
 */
/**
 * What the destination search offers: every stop, every building with a
 * real name, and NUSMods' rooms. Not the import lookup table (venues.json):
 * that also holds the NUS map's internal ids, bare room numbers and codes no
 * one would type, which still resolve when typed but are never listed.
 */
export function buildDestinations(graph: Graph): Destination[] {
  const stops = new Set(graph.stops.map((s) => s.code));
  const out: Destination[] = [];
  for (const s of graph.stops) {
    out.push({ code: s.code, label: s.name, stopCode: s.code, kind: 'stop', ...(aliasesFor(s.code) ? { aliases: aliasesFor(s.code) } : {}) });
  }
  for (const [code, lm] of allLandmarks()) {
    const served = Object.keys(lm.stops).filter((c) => stops.has(c));
    if (!served.length) continue;
    out.push({
      code,
      label: lm.name,
      stopCode: served[0],
      kind: 'landmark',
      stops: served,
      detail: lm.kind,
      walkM: Math.min(...served.map((c) => lm.stops[c])),
      aliases: lm.aliases,
    });
  }
  // Several codes can name one building (CLB, CLIB): list it once.
  const named = new Set<string>();
  for (const [code, v] of Object.entries(VENUES.venues).sort(([a], [b]) => a.length - b.length || a.localeCompare(b))) {
    const label = friendlyLabel(code);
    if (!label || !stops.has(v.stop) || named.has(`${label}|${v.stop}`)) continue;
    named.add(`${label}|${v.stop}`);
    const aliases = aliasesFor(code);
    out.push({ code, label, stopCode: v.stop, kind: 'building', walkM: v.m, ...(aliases ? { aliases } : {}) });
  }
  for (const [code, r] of Object.entries(ROOMS.rooms)) {
    if (!stops.has(r.stop)) continue;
    out.push({ code, label: r.name || code, stopCode: r.stop, kind: 'room', walkM: r.m });
  }
  return out;
}
