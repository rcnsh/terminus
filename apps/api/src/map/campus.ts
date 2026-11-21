import venuesJson from '../../data/venues.json' with { type: 'json' };
import roomsJson from '../../data/rooms.json' with { type: 'json' };
import shapesJson from '../../data/shapes.json' with { type: 'json' };
import { allLandmarks } from '../answer/landmarks.ts';
import { indexGraph } from '../answer/resolve.ts';
import { lineVia } from '../answer/via.ts';
import { listOf, m } from '../i18n.ts';
import type { Graph, Stop } from '../types.ts';

const VENUES = venuesJson as { venues: Record<string, { stop: string; m: number }> };
const ROOMS = roomsJson as { rooms: Record<string, { name: string; stop: string; m: number }> };

export interface RouteShape {
  stops: string[];
  line: [number, number][];
  at: number[];
}

export const SHAPES = (shapesJson as unknown as { routes: Record<string, RouteShape> }).routes;

export interface ProjectedStop {
  code: string;
  name: string;
  longName: string;
  opposite: string | null;
  x: number;
  y: number;
  lat: number;
  lon: number;
  services: string[];
  core: boolean;
}

export interface ProjectedRoute {
  seq: string[];
  loop: boolean;
  color: string;
  line: [number, number][];
  shaped: boolean;
  name: string;
  via: string | null;
}

export interface CampusMap {
  viewBox: string;
  stops: ProjectedStop[];
  routes: Record<string, ProjectedRoute>;
}

export const ROUTE_COLORS: Record<string, string> = {
  A1: '#d32f2f',
  A2: '#d9a000',
  D1: '#ec4fa0',
  D2: '#8e44c9',
  K: '#2b9ad6',
  P: '#8a939c',
  R1: '#f57c1f',
  R2: '#34a853',
};

export const routeColor = (svc: string): string => ROUTE_COLORS[svc] ?? '#8b98a6';

const VIEW_W = 1000;
const PAD = 60;
const METERS_PER_DEG_LAT = 111_320;
const CORE_RADIUS_FACTOR = 3;

function median(nums: number[]): number {
  const s = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function buildCampusMap(graph: Graph): CampusMap {
  const stops = graph.stops;
  const clat = median(stops.map((s) => s.lat));
  const clon = median(stops.map((s) => s.lon));
  const metersPerDegLonAll = METERS_PER_DEG_LAT * Math.cos((clat * Math.PI) / 180);
  const distFromCenter = new Map<string, number>();
  for (const s of stops) {
    const dx = (s.lon - clon) * metersPerDegLonAll;
    const dy = (s.lat - clat) * METERS_PER_DEG_LAT;
    distFromCenter.set(s.code, Math.hypot(dx, dy));
  }
  const med = median([...distFromCenter.values()]);
  const isCore = (code: string) => (distFromCenter.get(code) ?? 0) <= med * CORE_RADIUS_FACTOR;

  const core = stops.filter((s) => isCore(s.code));
  const coreStops = core.length >= 2 ? core : stops;

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
    return {
      code: s.code,
      name: s.name,
      longName: s.longName ?? s.name,
      opposite: s.opposite ?? null,
      x,
      y,
      lat: s.lat,
      lon: s.lon,
      services: servicesAt.get(s.code) ?? [],
      core: isCore(s.code),
    };
  });

  const idx = indexGraph(graph);
  const plate = (code: string | undefined) => (code ? (byCode.get(code)?.name ?? code).replaceAll(' ', '\u00a0') : '');
  const routes: Record<string, ProjectedRoute> = {};
  for (const [svc, seq] of Object.entries(graph.routes ?? {})) {
    const closes = seq.length > 2 && seq[0] === seq[seq.length - 1];
    const loop = graph.loops?.[svc] ?? closes;
    const shape = shapeFor(svc, seq);
    routes[svc] = {
      seq: closes ? seq.slice(0, -1) : seq.slice(),
      loop,
      color: routeColor(svc),
      line:
        shape?.line ??
        seq.flatMap((c) => {
          const st = byCode.get(c);
          return st ? [[st.lon, st.lat] as [number, number]] : [];
        }),
      shaped: Boolean(shape),
      name: loop ? m().lineLoop(plate(seq[0])) : m().lineEnds(plate(seq[0]), plate(seq[seq.length - 1])),
      via: (() => {
        const v = lineVia(idx, svc);
        return v.length ? m().loopVia(listOf(v.map((n) => n.replaceAll(' ', '\u00a0')))) : null;
      })(),
    };
  }

  return { viewBox: `0 0 ${VIEW_W} ${viewH}`, stops: projected, routes };
}

export function shapeFor(svc: string, seq: string[]): RouteShape | null {
  const shape = SHAPES[svc];
  if (!shape || shape.stops.length !== seq.length || shape.stops.some((c, i) => c !== seq[i])) return null;
  return shape;
}

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

export interface Destination {
  code: string;
  label: string;
  stopCode: string;
  kind: 'stop' | 'landmark' | 'building' | 'room';
  stops?: string[];
  detail?: string;
  walkM?: number;
  aliases?: string[];
}

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

export function buildDestinations(graph: Graph): Destination[] {
  const stops = new Set(graph.stops.map((s) => s.code));
  const out: Destination[] = [];
  for (const s of graph.stops) {
    const aliases = aliasesFor(s.code);
    out.push({ code: s.code, label: s.name, stopCode: s.code, kind: 'stop', ...(aliases ? { aliases } : {}) });
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
      detail: m().landmarkKind(lm.kind),
      walkM: Math.min(...served.map((c) => lm.stops[c])),
      aliases: lm.aliases,
    });
  }
  const listed = new Set(out.map((d) => `${d.code}|${d.label}`));
  const named = new Set<string>();
  for (const [code, v] of Object.entries(VENUES.venues).sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))) {
    const label = friendlyLabel(code);
    if (!label || !stops.has(v.stop) || named.has(`${label}|${v.stop}`) || listed.has(`${code}|${label}`)) continue;
    named.add(`${label}|${v.stop}`);
    listed.add(`${code}|${label}`);
    const aliases = aliasesFor(code);
    out.push({ code, label, stopCode: v.stop, kind: 'building', walkM: v.m, ...(aliases ? { aliases } : {}) });
  }
  for (const [code, r] of Object.entries(ROOMS.rooms)) {
    const label = r.name || code;
    if (!stops.has(r.stop) || listed.has(`${code}|${label}`)) continue;
    out.push({ code, label, stopCode: r.stop, kind: 'room', walkM: r.m });
  }
  return out;
}
