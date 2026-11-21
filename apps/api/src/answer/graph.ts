import graphJson from '../../data/stops.json' with { type: 'json' };
import serviceHoursJson from '../../data/service-hours.json' with { type: 'json' };
import oppositesJson from '../../data/opposites.json' with { type: 'json' };
import publicJson from '../../data/public.json' with { type: 'json' };
import headwaysJson from '../../data/headways.json' with { type: 'json' };
import type { Graph, HeadwaysByTime, Stop } from '../types.ts';
import { mergeServiceHours } from './hours.ts';
import { type PublicData, withPublic } from './public.ts';

export function mergeOpposites(stops: Stop[], pairs: string[][]): Stop[] {
  const out = stops.map((s) => ({ ...s }));
  const byCode = new Map(out.map((s) => [s.code, s]));
  for (const [a, b] of pairs) {
    const sa = byCode.get(a);
    const sb = byCode.get(b);
    if (!sa || !sb || a === b) continue;
    for (const s of [sa, sb]) {
      const old = s.opposite ? byCode.get(s.opposite) : undefined;
      if (old && old.opposite === s.code) old.opposite = null;
    }
    sa.opposite = b;
    sb.opposite = a;
  }
  return out;
}

const SCRAPED = graphJson as unknown as Graph;

export const GRAPH = {
  ...SCRAPED,
  stops: mergeOpposites(SCRAPED.stops, oppositesJson.pairs),
  serviceHours: mergeServiceHours(SCRAPED.serviceHours, serviceHoursJson as Record<string, unknown>),
  headwayS: { ...SCRAPED.headwayS, ...headwaysJson.usualS },
  headwaysByTime: headwaysJson.byTime as Record<string, HeadwaysByTime>,
} as Graph;

export const GRAPH_PUBLIC: Graph = withPublic(GRAPH, publicJson as unknown as PublicData);

export function oppositeOrPartner(stop: Stop): string | null {
  if (stop.opposite) return stop.opposite;
  const pair = oppositesJson.nearby.find((p) => p.includes(stop.code));
  return pair ? (pair[0] === stop.code ? pair[1] : pair[0]) : null;
}

export function oppositeOf(
  stop: Stop,
  byCode: Map<string, Stop>,
): { opposite: string | null; oppositeAcross: boolean; oppositeName: string | null } {
  const code = oppositeOrPartner(stop);
  const other = code ? byCode.get(code) : undefined;
  return { opposite: code, oppositeAcross: !!stop.opposite, oppositeName: code ? (other?.longName ?? other?.name ?? code) : null };
}
