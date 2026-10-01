/**
 * Which terminus this Worker is: the stable site, or the beta at
 * beta.terminus.rcn.sh, which sets PUBLIC_ORIGIN (cloudflare.config.ts,
 * `--mode beta`). Links in email and messages point at this origin, so a beta
 * account is never sent to the stable site, where it doesn't exist.
 */

import type { Env } from './types.ts';

export const STABLE_ORIGIN = 'https://terminus.rcn.sh';

export const siteOrigin = (env: Env): string => env.PUBLIC_ORIGIN || STABLE_ORIGIN;

export const isBeta = (env: Env): boolean => siteOrigin(env) !== STABLE_ORIGIN;

/** The sender's name on every email, so a beta email is never mistaken for the real one. */
export const mailName = (env: Env): string => (isBeta(env) ? 'terminus beta' : 'terminus');

/**
 * On the beta, every page says "beta" next to the wordmark (styled in
 * site.css) and asks not to be indexed, so nobody lands on it by search.
 */
export function markBeta(res: Response, env: Env): Response {
  if (!isBeta(env) || !(res.headers.get('content-type') ?? '').startsWith('text/html')) return res;
  const marked = new HTMLRewriter()
    .on('.wordmark', { element: (e) => void e.after('<span class="beta-tag">beta</span>', { html: true }) })
    .transform(res);
  const out = new Response(marked.body, marked);
  out.headers.set('x-robots-tag', 'noindex');
  return out;
}
