import { haversineM } from '../geo.ts';
import type { Graph, Stop } from '../types.ts';

export interface PairService {
  svc: string;
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
  id: string;
  name: string;
  crossingM: number | null;
  sides: PairSide[];
}

export interface StopPairs {
  version: string;
  attribution: string;
  places: PairPlace[];
}

const isOpp = (s: Stop) => /-OPP$/i.test(s.code) || /^opp(osite)?\b/i.test(s.name);

function isLoop(graph: Graph, svc: string, seq: string[]): boolean {
  return graph.loops?.[svc] ?? (seq.length > 1 && seq[0] === seq[seq.length - 1]);
}

function servicesByStop(graph: Graph): Map<string, PairService[]> {
  const out = new Map<string, PairService[]>();
  for (const [svc, seq] of Object.entries(graph.routes).sort(([a], [b]) => a.localeCompare(b))) {
    const loop = isLoop(graph, svc, seq);
    const calls = loop && seq[0] === seq[seq.length - 1] ? seq.length - 1 : seq.length;
    for (let i = 0; i < calls; i++) {
      const next = i + 1 < seq.length ? seq[i + 1] : null;
      const list = out.get(seq[i]) ?? [];
      if (!list.some((c) => c.svc === svc && c.next === next)) list.push({ svc, next });
      out.set(seq[i], list);
    }
  }
  return out;
}

export function stopPairs(graph: Graph): StopPairs {
  const byCode = new Map(graph.stops.map((s) => [s.code, s]));
  const services = servicesByStop(graph);
  const side = (s: Stop): PairSide => ({
    code: s.code,
    name: s.name,
    longName: s.longName ?? s.name,
    lat: s.lat,
    lon: s.lon,
    services: services.get(s.code) ?? [],
  });

  const seen = new Set<string>();
  const places: PairPlace[] = [];
  for (const stop of graph.stops) {
    if (seen.has(stop.code)) continue;
    const opp = stop.opposite ? byCode.get(stop.opposite) : undefined;
    const pair = opp && opp.opposite === stop.code ? [stop, opp] : [stop];
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
    attribution:
      "Stop names, positions and routes from NUS's internal shuttle feed, via terminus (https://terminus.run). Unofficial, not affiliated with NUS.",
    places,
  };
}
