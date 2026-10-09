/**
 * Which terminus this Worker is: the stable site, or the beta at
 * beta.terminus.run, which sets PUBLIC_ORIGIN (cloudflare.config.ts,
 * `--mode beta`). Links in email and messages point at this origin, so a beta
 * account is never sent to the stable site, where it doesn't exist.
 */

import type { Env } from './types.ts';
import { UPDATE_REQUIRED } from './accounts.ts';
import { CORS, json } from './http.ts';

export const STABLE_ORIGIN = 'https://terminus.run';

export const siteOrigin = (env: Env): string => env.PUBLIC_ORIGIN || STABLE_ORIGIN;

export const isBeta = (env: Env): boolean => siteOrigin(env) !== STABLE_ORIGIN;

/**
 * Where links handed to people point: sign-in links, the new-device email,
 * an error's "create a key at". LINK_ORIGIN when set, for while some
 * networks refuse terminus.run (NUS Wi-Fi resets connections to a domain
 * that new), so a link tapped on campus still opens; else the site's own.
 */
export const linkOrigin = (env: Env): string => env.LINK_ORIGIN || siteOrigin(env);

/** The site's old addresses, and where each one's pages now live. */
const MOVED: Record<string, string> = {
  'terminus.rcn.sh': STABLE_ORIGIN,
  'beta.terminus.rcn.sh': 'https://beta.terminus.run',
};

/**
 * What keeps answering on an old address, for what calls it there rather
 * than a person: the API, the Mac's updates and the downloads, Android's
 * app-link check, the map's files and crawlers' rules.
 */
const STAYS = ['/api/', '/download/', '/.well-known/', '/map/', '/robots.txt'];

/**
 * A page opened on an old address goes to the same page on the new one.
 * Only a browser's GET for HTML: the apps call the old address on purpose
 * (it's the one kept for good) and ask for JSON, so they're never sent
 * on. A 301, for search engines, that browsers keep for a day only, so
 * moving back is a change here, not something cached for good.
 */
export function movedPage(req: Request, env: Env): Response | null {
  // Off unless MOVE_PAGES is "on" (cloudflare.config.ts says why).
  if (env.MOVE_PAGES !== 'on') return null;
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  const url = new URL(req.url);
  const to = MOVED[url.hostname];
  // Each Worker sends only its own old address on, to itself.
  if (to === undefined || to !== siteOrigin(env)) return null;
  if (!(req.headers.get('accept') ?? '').includes('text/html')) return null;
  if (STAYS.some((p) => url.pathname === p || url.pathname.startsWith(p))) return null;
  return new Response(null, { status: 301, headers: { location: `${to}${url.pathname}${url.search}`, 'cache-control': 'public, max-age=86400' } });
}

/** The API's old paths, before it moved under /api (3.0). */
const OLD_API = new Set(['/me', '/next', '/trip', '/arrivals', '/buses', '/line', '/campus', '/stops/pairs', '/health', '/status.json', '/admin/stats', '/openapi.json', '/pair/check']);
const OLD_API_UNDER = ['/me/', '/auth/', '/timelapse/'];

/**
 * A call to the API at its old path. An app (it says which in
 * x-terminus-client) is one from before 3.0: a 426 has it show "update",
 * as config:minClient does, rather than fail on a 404. Anyone else (an API
 * key's script, a page open since before) is sent to the new path with a
 * 308, which keeps the method and body. The two emailed pages under /auth/
 * and the pairing page (GET /pair) never moved, so they aren't this.
 */
export function movedApi(req: Request, url: URL): Response | null {
  const path = url.pathname;
  const reading = req.method === 'GET' || req.method === 'HEAD';
  const old =
    OLD_API.has(path)
    || (path === '/pair' && !reading)
    || (OLD_API_UNDER.some((p) => path.startsWith(p)) && path !== '/auth/verify' && path !== '/auth/approve');
  if (!old) return null;
  if (req.headers.has('x-terminus-client')) return json(UPDATE_REQUIRED, 426);
  return new Response(null, { status: 308, headers: { location: `/api${path}${url.search}`, 'cache-control': 'no-store', ...CORS } });
}

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
