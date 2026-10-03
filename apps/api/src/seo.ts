/**
 * What search engines read about the site: robots.txt and the sitemap. The
 * pages worth finding are the public ones; the account page, the web app,
 * the dashboard and the pairing page say noindex in their own HTML. The beta
 * is a copy of the real site, so it asks not to be crawled at all (its pages
 * also send x-robots-tag: noindex, markBeta in site.ts).
 */

import { isBeta, STABLE_ORIGIN } from './site.ts';
import type { Env } from './types.ts';

/** The pages in the sitemap, on the stable site. */
export const SITEMAP_PAGES = ['/', '/privacy/', '/privacy/zh/', '/status/', '/docs'];

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
