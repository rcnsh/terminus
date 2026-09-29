/**
 * The stop graph: scraped stops and routes, with the hand-maintained
 * operating hours merged in once, at module scope. `npm run scrape` can never
 * overwrite the hours, which live in their own file.
 */

import graphJson from '../data/stops.json' with { type: 'json' };
import serviceHoursJson from '../data/service-hours.json' with { type: 'json' };
import type { Graph } from './types.ts';
import { mergeServiceHours } from './resolve.ts';

export const GRAPH = {
  ...(graphJson as unknown as Graph),
  serviceHours: mergeServiceHours(
    (graphJson as unknown as Graph).serviceHours,
    serviceHoursJson as Record<string, unknown>,
  ),
} as Graph;

