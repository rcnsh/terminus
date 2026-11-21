import type { Env } from '../types.ts';
import { UPDATE_REQUIRED } from '../accounts/accounts.ts';
import { CORS, json } from '../http.ts';
import { STABLE_ORIGIN, isBeta, siteOrigin } from '../origin.ts';

const MOVED: Record<string, string> = {
  'terminus.rcn.sh': STABLE_ORIGIN,
  'beta.terminus.rcn.sh': 'https://beta.terminus.run',
};

const STAYS = ['/api/', '/download/', '/.well-known/', '/map/', '/robots.txt'];

export function movedPage(req: Request, env: Env): Response | null {
  if (env.MOVE_PAGES !== 'on') return null;
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  const url = new URL(req.url);
  const to = MOVED[url.hostname];
  if (to === undefined || to !== siteOrigin(env)) return null;
  if (!(req.headers.get('accept') ?? '').includes('text/html')) return null;
  if (STAYS.some((p) => url.pathname === p || url.pathname.startsWith(p))) return null;
  return new Response(null, {
    status: 301,
    headers: { location: `${to}${url.pathname}${url.search}`, 'cache-control': 'public, max-age=86400' },
  });
}

const OLD_API = new Set([
  '/me',
  '/next',
  '/trip',
  '/arrivals',
  '/buses',
  '/line',
  '/campus',
  '/stops/pairs',
  '/health',
  '/status.json',
  '/admin/stats',
  '/openapi.json',
  '/pair/check',
]);
const OLD_API_UNDER = ['/me/', '/auth/', '/timelapse/'];

export function movedApi(req: Request, url: URL): Response | null {
  if (!oldApiPath(req, url)) return null;
  if (req.headers.has('x-terminus-client')) return json(UPDATE_REQUIRED, 426);
  return new Response(null, {
    status: 308,
    headers: { location: `/api${url.pathname}${url.search}`, 'cache-control': 'no-store', ...CORS },
  });
}

export function oldApiPath(req: Request, url: URL): boolean {
  const path = url.pathname;
  const reading = req.method === 'GET' || req.method === 'HEAD';
  return (
    OLD_API.has(path) ||
    (path === '/pair' && !reading) ||
    (OLD_API_UNDER.some((p) => path.startsWith(p)) && path !== '/auth/verify' && path !== '/auth/approve')
  );
}

export const oldAddress = (hostname: string): boolean => hostname in MOVED;

export function appSiteAssociation(env: Env): Record<string, unknown> | null {
  const team = env.APPLE_TEAM_ID?.trim();
  if (!team) return null;
  const appID = `${team}.sh.rcn.terminus${isBeta(env) ? '.beta' : ''}`;
  return {
    applinks: {
      details: [
        {
          appIDs: [appID],
          components: [
            { '/': '/pair', comment: 'pairing links' },
            { '/': '/pair/', comment: 'pairing links' },
          ],
        },
      ],
    },
  };
}

export const mailName = (env: Env): string => (isBeta(env) ? 'terminus beta' : 'terminus');

export function markBeta(res: Response, env: Env): Response {
  if (!isBeta(env) || !(res.headers.get('content-type') ?? '').startsWith('text/html')) return res;
  const marked = new HTMLRewriter()
    .on('html', { element: (e) => void e.setAttribute('data-site', 'beta') })
    .on('.wordmark', { element: (e) => void e.after('<span class="beta-tag">beta</span>', { html: true }) })
    .transform(res);
  const out = new Response(marked.body, marked);
  out.headers.set('x-robots-tag', 'noindex');
  return out;
}
