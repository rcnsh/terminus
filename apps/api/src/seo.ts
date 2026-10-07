/**
 * What search engines read about the site: robots.txt and the sitemap. The
 * pages to index are the public ones; the account page, the web app,
 * the dashboard and the pairing page say noindex in their own HTML. The beta
 * is a copy of the real site, so it asks not to be crawled at all (its pages
 * also send x-robots-tag: noindex, markBeta in site.ts). AI agents get
 * /llms.txt, a short guide to the site and the API (llmstxt.org).
 */

import { isBeta, STABLE_ORIGIN } from './site.ts';
import type { Env } from './types.ts';

/** The pages in the sitemap, on the stable site. */
export const SITEMAP_PAGES = ['/', '/privacy/', '/privacy/zh/', '/privacy/policy/', '/privacy/policy/zh/', '/status/', '/docs'];

export const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${SITEMAP_PAGES.map((p) => `  <url><loc>${STABLE_ORIGIN}${p}</loc></url>`).join('\n')}
</urlset>
`;

/** robots.txt: everything public on the stable site, with its sitemap; nothing on the beta. */
export function robotsTxt(env: Env): string {
  if (isBeta(env)) return 'User-agent: *\nDisallow: /\n';
  return [
    'User-agent: *',
    'Allow: /',
    // The API and account routes answer people and apps, not search.
    'Disallow: /me',
    'Disallow: /auth/',
    'Disallow: /admin',
    'Disallow: /pair',
    'Disallow: /download/',
    '',
    `Sitemap: ${STABLE_ORIGIN}/sitemap.xml`,
    '',
  ].join('\n');
}

/**
 * /llms.txt: what terminus is and how to use its API, in Markdown, for an
 * AI agent to read before the full spec. Links are to [origin], the site
 * serving it. The detail lives in the spec; this says what it can't: what
 * the answers are for, and that a person makes the key.
 */
export function llmsTxt(origin: string): string {
  return `# terminus

> terminus tells NUS students which internal shuttle bus to catch, from which stop, and when to leave for their next class (or whether walking is faster). It reads their NUSMods timetable and NUS's live shuttle feed. It's a free, independent student project, not affiliated with NUS.

The answers are ready-made text: \`/next\` and \`/trip\` return a \`label\` (such as \`D2 · 4 min\`) and a one-line \`detail\` to show as they are. Every answer has a \`quality\`: \`live\` from NUS's feed, \`scheduled\` (an estimate from the timetable, when the feed is down) and so on. Don't present an estimate as live.

NUS stops come in pairs on opposite sides of the road, a few metres apart (\`KR-MRT\` and \`KR-MRT-OPP\`). The API picks the side from the route order and says when to cross the road.

## Using the API

- Answers need an API key. A person signs in at ${origin}/account, creates one under API keys, and gives it to you. Only they can create one. Send it in the \`x-api-key\` header or as a bearer token.
- Each key may make 60 requests a minute. Arrivals are cached 15 s per stop and live buses 5 s per service, so asking more often gets the same answer. Please don't poll many stops in bulk: every miss reaches NUS's own feed.
- Stops are codes such as \`COM3\`, \`UTOWN\` and \`KR-MRT\`; \`/campus\` lists them all, with their names and services. A destination can also be a NUSMods room code such as \`COM1-0212\`.

## Endpoints

- [GET /trip?to=UTOWN&from=PGP](${origin}/docs#/operations/getTrip): which bus to catch to a stop or a NUSMods room (\`COM1-0212\`), from a stop or a position (\`lat\`, \`lon\`), and when to leave
- [GET /next?lat=1.294962&lon=103.784556](${origin}/docs#/operations/getNext): the next buses at the stop nearest a position; with \`to\`, the same answer as \`/trip\`
- [GET /arrivals?stop=COM3](${origin}/docs#/operations/getArrivals): every service's next buses at one stop
- [GET /buses?svc=D2](${origin}/docs#/operations/getBuses): one service's live buses for a map, each at a stop or between two
- [GET /line?svc=D1&stop=YIH](${origin}/docs#/operations/getLine): one service's stops in order, its buses on them, and its next bus at one stop
- [GET /campus](${origin}/docs#/operations/getCampus): stops, route lines and colours, and destinations to search
- [GET /status.json](${origin}/status.json): whether NUS's feed is working, without a key

## Reference

- [OpenAPI 3.1 spec](${origin}/openapi.json): every endpoint, parameter and answer, with examples
- [API docs](${origin}/docs): the same spec, rendered (needs JavaScript)
- [Status](${origin}/status/): the feed's health and past outages
- [Privacy](${origin}/privacy/): what's stored, and how to delete it
`;
}
