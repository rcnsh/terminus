/**
 * GET /stops/pairs -- every stop grouped with its twin across the road, and
 * which buses call at each side and where they go next.
 *
 * NUS stops come in directional pairs a few metres apart ("KR MRT" and
 * "Opp KR MRT"), well within GPS error, and the bus that goes your way only
 * stops on one side. The answers already use this to say "cross the road";
 * this is the same knowledge as data, for anyone building on it.
 *
 * A pure function of the bundled stop graph, so it only changes when a deploy
 * ships a new scrape. Distances are straight lines between the two stops,
 * deliberately not the footpath distances the answers use: those come from
 * OpenStreetMap, and publishing them as a dataset would carry its licence.
 */

import { haversineM } from './geo.ts';
import type { Graph, Stop } from './types.ts';

export interface PairService {
  svc: string;
  /** The stop this bus calls at next, or null when it terminates here. */
  next: string | null;
}

export interface PairSide {
  code: string;
  name: string;
  longName: string;
  lat: number;
  lon: number;
  services: PairService[];
}

export interface PairPlace {
  /** The code of the side that isn't "Opp", or the only side. */
  id: string;
  name: string;
  /** Straight-line metres between the two sides; null with one side. */
  crossingM: number | null;
  sides: PairSide[];
}

export interface StopPairs {
  /** When the stop graph was scraped. Codes can change between versions. */
  version: string;
  attribution: string;
  places: PairPlace[];
}

type GraphStop = Stop & { longName?: string };

const isOpp = (s: GraphStop) => /-OPP$/i.test(s.code) || /^opp(osite)?\b/i.test(s.name);

function isLoop(graph: Graph, svc: string, seq: string[]): boolean {
  return graph.loops?.[svc] ?? (seq.length > 1 && seq[0] === seq[seq.length - 1]);
}

/** Every call a service makes at each stop, with the stop after it. */
function servicesByStop(graph: Graph): Map<string, PairService[]> {
  const out = new Map<string, PairService[]>();
  for (const [svc, seq] of Object.entries(graph.routes).sort(([a], [b]) => a.localeCompare(b))) {
    const loop = isLoop(graph, svc, seq);
    // A loop's last entry repeats its first: one call there, not two.
    const calls = loop && seq[0] === seq[seq.length - 1] ? seq.length - 1 : seq.length;
    for (let i = 0; i < calls; i++) {
      const next = i + 1 < seq.length ? seq[i + 1] : null;
      const list = out.get(seq[i]) ?? [];
      // A stop a route passes twice gets both calls, but not the same one twice.
      if (!list.some((c) => c.svc === svc && c.next === next)) list.push({ svc, next });
      out.set(seq[i], list);
    }
  }
  return out;
}

export function stopPairs(graph: Graph): StopPairs {
  const byCode = new Map(graph.stops.map((s) => [s.code, s as GraphStop]));
  const services = servicesByStop(graph);
  const side = (s: GraphStop): PairSide => ({
    code: s.code,
    name: s.name,
    longName: s.longName ?? s.name,
    lat: s.lat,
    lon: s.lon,
    services: services.get(s.code) ?? [],
  });

  const seen = new Set<string>();
  const places: PairPlace[] = [];
  for (const stop of graph.stops as GraphStop[]) {
    if (seen.has(stop.code)) continue;
    const twin = stop.opposite ? byCode.get(stop.opposite) : undefined;
    // Only a mutual pair is a pair: a one-way pointer is a scrape oddity.
    const pair = twin && twin.opposite === stop.code ? [stop, twin] : [stop];
    pair.sort((a, b) => Number(isOpp(a)) - Number(isOpp(b)) || a.code.localeCompare(b.code));
    for (const s of pair) seen.add(s.code);
    const [main, other] = pair;
    places.push({
      id: main.code,
      name: main.longName ?? main.name,
      crossingM: other ? Math.round(haversineM(main.lat, main.lon, other.lat, other.lon)) : null,
      sides: pair.map(side),
    });
  }
  places.sort((a, b) => a.name.localeCompare(b.name));

  return {
    version: graph.generated,
    attribution: "Stop names, positions and routes from NUS's internal shuttle feed, via terminus (https://terminus.run). Unofficial, not affiliated with NUS.",
    places,
  };
}
