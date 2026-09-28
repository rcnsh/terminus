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
import type { Graph, Stop } from './types.ts';

const VENUES = venuesJson as { venues: Record<string, { stop: string; m: number }> };

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
}

export interface CampusMap {
  viewBox: string;
  stops: ProjectedStop[];
  routes: Record<string, ProjectedRoute>;
}

/**
 * Categorical palette for the 8 services. Deliberately avoids the semantic
 * quality colors (--live green, --sched amber, --bad red) so a route line is
 * never mistaken for a live/stale indicator; --accent orange is kept for D2,
 * the route already used as the project's running example elsewhere.
 */
export const ROUTE_COLORS: Record<string, string> = {
  A1: '#4f8fe8',
  A2: '#a970e0',
  D1: '#2fb6a8',
  D2: '#ff7a1a',
  K: '#e0568f',
  P: '#6c7bdb',
  R1: '#38b6ff',
  R2: '#b5824a',
};

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

  const projected: ProjectedStop[] = stops.map((s) => {
    const { x, y } = project(s);
    return { code: s.code, name: s.name, longName: s.name, opposite: s.opposite ?? null, x, y, lat: s.lat, lon: s.lon, core: isCore(s.code) };
  });

  const routes: Record<string, ProjectedRoute> = {};
  for (const [svc, seq] of Object.entries(graph.routes ?? {})) {
    // graph.routes stores the raw scraped sequence, which for a loop repeats
    // its first stop as its last -- drop that so the polyline does not draw
    // a zero-length closing segment on top of a real one.
    const closes = seq.length > 2 && seq[0] === seq[seq.length - 1];
    const loop = graph.loops?.[svc] ?? closes;
    routes[svc] = {
      seq: closes ? seq.slice(0, -1) : seq.slice(),
      loop,
      color: ROUTE_COLORS[svc] ?? '#8b98a6',
    };
  }

  return { viewBox: `0 0 ${VIEW_W} ${viewH}`, stops: projected, routes };
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
  kind: 'stop' | 'building' | 'room';
}

/**
 * One flat list combining the 33 stops and every known NUSMods venue code,
 * each already resolved to a boardable stop. The client just substring-
 * searches `label`/`code` and hands the matched `stopCode` straight to
 * `/trip?to=`; venue resolution (data/venues.json, prefix fallback) happens
 * here once, server-side, the same way it already does for NUSMods import.
 */
export function buildDestinations(graph: Graph): Destination[] {
  const out: Destination[] = [];
  for (const s of graph.stops) {
    out.push({ code: s.code, label: s.name, stopCode: s.code, kind: 'stop' });
  }
  for (const [code, v] of Object.entries(VENUES.venues)) {
    const label = friendlyLabel(code);
    out.push({ code, label: label ?? code, stopCode: v.stop, kind: label ? 'building' : 'room' });
  }
  return out;
}
