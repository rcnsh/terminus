/**
 * On-campus residences, so "Home" is not an errand when you're already there.
 *
 * Nothing about where someone lives is stored: their home is still just
 * stops. You count as home when your location is inside a residence that one
 * of your home stops serves. Outlines are OpenStreetMap's, with GPS_MARGIN_M
 * of slack for a phone indoors.
 */

import residencesJson from '../data/residences.json' with { type: 'json' };
import { haversineM } from './geo.ts';
import { footM, stopFootM } from './walk.ts';
import type { Stop } from './types.ts';
import { WALK } from './config.ts';

export interface Residence {
  name: string;
  /** Where most students live: the pickers show it first. */
  common?: boolean;
  /** Stop code -> metres on foot from the residence, nearest first. */
  stops: Record<string, number>;
  /** Outlines, each a ring of [lat, lon]. */
  areas: Array<Array<[number, number]>>;
}

const RESIDENCES = (residencesJson as unknown as { residences: Record<string, Residence> }).residences;

/** Indoors a phone's fix can be this far off. */
export const GPS_MARGIN_M = 30;

/**
 * A residence's walk to its nearest stop, in whole minutes at a normal pace,
 * never under one: what "Where do you live?" shows beside it.
 */
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

/** Metres from a point to the nearest edge of a ring (flat-earth, fine at this scale). */
function edgeM(lat: number, lon: number, ring: Array<[number, number]>): number {
  const mLat = 111_320;
  const mLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (let i = 0; i + 1 < ring.length; i++) {
    const ax = (ring[i][1] - lon) * mLon, ay = (ring[i][0] - lat) * mLat;
    const bx = (ring[i + 1][1] - lon) * mLon, by = (ring[i + 1][0] - lat) * mLat;
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/** The residence at this point, if any (with the GPS margin). */
export function residenceAt(lat: number, lon: number): [string, Residence] | null {
  for (const [code, r] of allResidences()) {
    // Cheap reject: nowhere near any of it.
    if (!r.areas.some((a) => haversineM(lat, lon, a[0][0], a[0][1]) < 1500)) continue;
    if (r.areas.some((a) => inside(lat, lon, a) || edgeM(lat, lon, a) <= GPS_MARGIN_M)) return [code, r];
  }
  return null;
}

/** Inside a residence served by one of these home stops. */
export function atHome(lat: number | null, lon: number | null, homeStops: string[]): boolean {
  if (lat == null || lon == null || !homeStops.length) return false;
  const r = residenceAt(lat, lon);
  return r !== null && Object.keys(r[1].stops).some((s) => homeStops.includes(s));
}

export interface NearStop {
  stop: Stop;
  /** Straight line, metres. */
  distM: number;
  /** On foot, metres. */
  footM: number;
}

/** The user's home stops and their own walk to the nearest one, in metres at their pace. */
export interface HomeWalk {
  stops: string[];
  m: number;
}

/**
 * Inside a residence: its own stops, and the far side of each one's road,
 * with the walk to each. Those stops were picked by path distance from the
 * building, so a stop that is close as the crow flies but a hill and a
 * link-way away (PGP to KR MRT) never shows up as a short walk. Null
 * outside every residence: then the nearest stops by distance, as before.
 *
 * With `home` and the residence one of its stops serves, the walk to the
 * nearest of those is the user's own (`home.m`), and every other stop of the
 * residence is as much further as the paths say.
 */
export function residenceStops(lat: number, lon: number, byCode: Map<string, Stop>, home?: HomeWalk | null): NearStop[] | null {
  const r = residenceAt(lat, lon);
  if (!r) return null;
  // The building's edge isn't where you start: the lift, the stairs and the
  // far block are what the "walk to your stop" setting is for, and a phone
  // indoors can't tell which floor or wing you're in.
  const homeM = home ? Object.entries(r[1].stops).filter(([code]) => home.stops.includes(code)).map(([, m]) => m) : [];
  const extraM = home && homeM.length ? home.m - Math.min(...homeM) : 0;
  const out: NearStop[] = [];
  for (const [code, metres] of Object.entries(r[1].stops)) {
    const stop = byCode.get(code);
    if (!stop) continue;
    // From deep inside a big hall the stop is further than from its edge.
    const foot = Math.max(metres + extraM, footM(lat, lon, stop));
    out.push({ stop, distM: haversineM(lat, lon, stop.lat, stop.lon), footM: foot });
    const opp = stop.opposite ? byCode.get(stop.opposite) : undefined;
    if (opp && !r[1].stops[opp.code]) {
      out.push({ stop: opp, distM: haversineM(lat, lon, opp.lat, opp.lon), footM: foot + stopFootM(stop, opp) });
    }
  }
  return out.length ? out.sort((a, b) => a.footM - b.footM) : null;
}

/**
 * For "Where do you live?" on /campus: names and stops only, the outlines
 * stay here. The common ones come first, so a client matching home stops
 * back to a residence (every UTown college shares UTOWN) lands on the
 * likelier one. Names in code-unit order, not localeCompare (which starts
 * ICU): the same order for the real names (campus.test.js).
 */
export function residenceList() {
  return allResidences()
    .map(([code, r]) => ({ code, name: r.name, stops: Object.keys(r.stops), walkM: Object.values(r.stops)[0], walkMin: residenceWalkMin(Object.values(r.stops)[0]), common: r.common === true }))
    .sort((a, b) => Number(b.common) - Number(a.common) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
