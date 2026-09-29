/**
 * The stop graph: scraped stops and routes, with the hand-maintained
 * operating hours merged in once, at module scope. `pnpm scrape` can never
 * overwrite the hours, which live in their own file.
 */

import graphJson from '../data/stops.json' with { type: 'json' };
import serviceHoursJson from '../data/service-hours.json' with { type: 'json' };
import oppositesJson from '../data/opposites.json' with { type: 'json' };
import type { Graph, Stop } from './types.ts';
import { mergeServiceHours } from './resolve.ts';

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

