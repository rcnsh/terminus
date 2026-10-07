/**
 * The stop graph: scraped stops and routes, with the hand-maintained
 * operating hours merged in once, at module scope. `pnpm scrape` can never
 * overwrite the hours, which live in their own file.
 */

import graphJson from '../data/stops.json' with { type: 'json' };
import serviceHoursJson from '../data/service-hours.json' with { type: 'json' };
import oppositesJson from '../data/opposites.json' with { type: 'json' };
import publicJson from '../data/public.json' with { type: 'json' };
import type { Graph, Stop } from './types.ts';
import { mergeServiceHours } from './resolve.ts';
import { type PublicData, withPublic } from './public.ts';

/**
 * Hand-listed pairs over the scraped ones. The scrape can only pair stops by
 * name ("Opp X" and "X"); stops across a road from each other can have
 * unrelated names ("Opp NUSS" and "AS 5"). Pairs stay mutual: a listed pair
 * unpairs each stop's previous twin.
 */
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

export const GRAPH = {
  ...(graphJson as unknown as Graph),
  stops: mergeOpposites((graphJson as unknown as Graph).stops, oppositesJson.pairs),
  serviceHours: mergeServiceHours(
    (graphJson as unknown as Graph).serviceHours,
    serviceHoursJson as Record<string, unknown>,
  ),
} as Graph;

/**
 * The same graph with the public buses in it (public.ts), for accounts that
 * turned them on. Everything built from GRAPH alone (the map, the search,
 * the stop pairs) stays as it is: public buses are an answer, not a layer.
 */
export const GRAPH_PUBLIC: Graph = withPublic(GRAPH, publicJson as unknown as PublicData);


/**
 * The stop Nearby offers in place of `stop`: its twin across the road, or a
 * stop listed only for Nearby (data/opposites.json `nearby`), near enough for
 * a location to put you at the wrong one but kept apart for routing.
 */
export function nearbyTwin(stop: Stop): string | null {
  if (stop.opposite) return stop.opposite;
  const pair = oppositesJson.nearby.find((p) => p.includes(stop.code));
  return pair ? (pair[0] === stop.code ? pair[1] : pair[0]) : null;
}

/**
 * The twin as a stop page names it: `across` when it's on the other side of
 * the road ("Across the road"), false for a stop that's only near (PGP and
 * PGP Foyer), which goes by its own name.
 */
export function twinOf(stop: Stop, byCode: Map<string, Stop>): { opposite: string | null; oppositeAcross: boolean; oppositeName: string | null } {
  const code = nearbyTwin(stop);
  const twin = code ? byCode.get(code) : undefined;
  return { opposite: code, oppositeAcross: !!stop.opposite, oppositeName: code ? (twin?.longName ?? twin?.name ?? code) : null };
}
