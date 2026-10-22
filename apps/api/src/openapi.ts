/**
 * OpenAPI 3.1 description of this API. Served at /api/openapi.json and rendered
 * at /docs by Stoplight Elements.
 *
 * Kept by hand, next to the code it describes. test/worker.smoke.js asserts
 * every documented path answers (no 404s) and every route is documented;
 * test/openapi.test.js calls every operation and checks each status is
 * listed, each body fits its schema with no key left undocumented, and each
 * operation's `security` matches whether it answers 401. So the two cannot
 * silently drift.
 *
 * The paths are in openapi/paths.ts, the schemas in openapi/components.ts,
 * what both use in openapi/parts.ts and the /docs page in openapi/docs.ts.
 */

import { RETRY_AFTER, errorResponse, slowDown } from './openapi/parts.ts';
import { paths } from './openapi/paths.ts';
import { components } from './openapi/components.ts';

export { docsPage, docsPageFor } from './openapi/docs.ts';

/** The apps' version (Android versionName, the Mac's CFBundleShortVersionString, the iPhone's MARKETING_VERSION):
 *  the API and the apps are released together. A test fails when a version
 *  bump leaves this behind. */
export const API_VERSION = '3.6.1';

export function openApiSpec(origin: string): Record<string, unknown> {
  return withCommonErrors({
    openapi: '3.1.0',
    info: {
      title: 'terminus API',
      version: API_VERSION,
      description: [
        'Arrival times for the NUS internal shuttle buses, returned as short text ready to display.',
        '',
        'Every endpoint is under `/api`, apart from the two pages a sign-in email links to (`/auth/verify` and `/auth/approve`) and these docs. ' +
          'Before version 3.0 the endpoints had no `/api` in front; an old path now redirects to the new one (308), or answers an app from before 3.0 with 426.',
        '',
        '`/api/next` and `/api/trip` return a `label` (for example `D2 · 4 min`) and a one-line `detail`. Clients ' +
          'show these as they are instead of formatting times themselves, so every client shows the same text.',
        '',
        'NUS stops come in pairs on opposite sides of the road, often a few metres apart (`KR-MRT` and ' +
          '`KR-MRT-OPP`), which is within GPS error. The API picks the side using the route order rather ' +
          'than distance: it checks which stop has a bus that goes on to your destination, and tells you ' +
          'when you need to cross the road.',
        '',
        'Every answer has a `quality` field. When the upstream feed is down, the API returns the last cached ' +
          'answer with its original `asOf` time, or says that live times are unavailable.',
        '',
        'The answers need an API key: sign in at /account, create one under API keys, and send it in the ' +
          '`x-api-key` header (or as a bearer token). A signed-in session or a paired device works too. Without one they answer 401. Each key ' +
          'is limited to 60 requests a minute, and a request with no valid key to 60 a minute from its IP address. Arrivals are cached for 15 seconds per stop, so repeated requests ' +
          'for the same stop do not reach the NUS feed. Please do not poll many stops in bulk.',
        '',
        'A signed-in account (a browser session or a device token) may make 120 requests a minute to the answers, and another 120 to the `/api/me` routes, ' +
          'shared by all its devices. Over a limit, the answer is 429 with `Retry-After`. A device token that is not valid answers 401, and too many of those from one IP address 429.',
        '',
        'When the account database cannot be reached for a moment, any call that needs a key or a session answers 503 with ' +
          '`Retry-After`: wait that long and try again.',
      ].join('\n'),
    },
    servers: [{ url: origin }],
    // An API key, or a signed-in session or device. Open routes (/api/health, sign-in, pairing, the map, ...) opt out with `security: []`.
    security: [{ apiKey: [] }, { bearer: [] }, { cookie: [] }],
    tags: [
      { name: 'Answers', description: 'Next-bus answers as ready-to-display text.' },
      { name: 'Stops', description: 'Per-stop arrivals and static campus data.' },
      { name: 'Service', description: 'Health and configuration.' },
      { name: 'Account', description: 'Sign in on the account page, or pair a device with a code from it.' },
      { name: 'Map', description: 'The campus street map, for MapLibre. Open, like the website.' },
      { name: 'Downloads', description: 'The apps, and what their update checks read.' },
    ],
    paths: paths(),
    components: components(),
  });
}

const ACCOUNTS_DOWN_503 = {
  ...errorResponse('The account database could not be reached just now. Wait for `Retry-After` and try again.'),
  headers: RETRY_AFTER,
};
const NO_SESSION_401 = errorResponse('No valid session: sign in first.', { error: 'sign in first' });
const ACCOUNT_429 = {
  ...errorResponse(
    'Too many requests from this account (over 120 a minute, across its devices); or, with a token that is no session, too many tries from this IP. Wait for `Retry-After`.',
  ),
  headers: RETRY_AFTER,
};
/** /api/auth/app/merge comes before the account's limit: only a token that is no session counts. */
const BAD_TOKEN_429 = {
  ...errorResponse('A token that is no session, sent too often from this IP. Wait for `Retry-After`.', {
    error: 'too many attempts, try again in a minute',
  }),
  headers: RETRY_AFTER,
};
const CROSS_SITE = 'The request came from another site with this browser’s session cookie.';

type Operation = { security?: Record<string, unknown>[]; responses?: Record<string, { description: string }> };

/**
 * The responses every operation of a kind can give, added where it does not
 * list them itself, so each one says what can happen rather than only the
 * overview:
 * - the accounts-down 503 on every operation that needs a key or a session,
 *   and on sign-in and pairing, which use the account database too;
 * - on `/api/me` routes, "sign in first" (401), the account's limit (429), and a
 *   change sent with the session cookie from another site (403);
 * - the per-IP limit (429, with `Retry-After`) on the public routes that read
 *   storage: /api/health, /api/status.json, /api/admin/*, /download/* and
 *   /api/timelapse/*.
 */
function withCommonErrors(spec: Record<string, unknown>): Record<string, unknown> {
  const paths = spec.paths as Record<string, Record<string, Operation>>;
  for (const [path, ops] of Object.entries(paths)) {
    const session = path === '/api/me' || path.startsWith('/api/me/') || path === '/api/auth/app/merge';
    const limitedByIp =
      ['/api/health', '/api/status.json'].includes(path) ||
      path.startsWith('/api/admin/') ||
      path.startsWith('/download/') ||
      path.startsWith('/api/timelapse/');
    for (const [method, op] of Object.entries(ops)) {
      if (!op || typeof op !== 'object' || !op.responses) continue;
      const r = op.responses;
      const needs = !Array.isArray(op.security) || op.security.length > 0;
      if (needs || path.startsWith('/api/auth/') || path.startsWith('/auth/') || path.startsWith('/api/pair'))
        r['503'] ??= ACCOUNTS_DOWN_503;
      if (session) {
        r['401'] ??= NO_SESSION_401;
        r['429'] ??= path === '/api/auth/app/merge' ? BAD_TOKEN_429 : ACCOUNT_429;
        if (method !== 'get' && op.security?.some((s) => 'cookie' in s)) {
          r['403'] = r['403'] ? { ...r['403'], description: `${r['403'].description} Or: ${CROSS_SITE}` } : errorResponse(CROSS_SITE);
        }
      }
      if (limitedByIp) r['429'] ??= slowDown('Too many requests from this IP. Wait for `Retry-After`.');
    }
  }
  return withUpdateRequired(spec);
}

const UPDATE_REQUIRED_426 = errorResponse(
  'The app is older than the oldest version still served (`x-terminus-client` names it). It should ask the user to update, and stop asking until then. ' +
    'A request without that header (the website, API keys) is never refused this way.',
  { error: 'Update terminus to keep using it.', update: true },
);

/**
 * Lists the 426 on every operation an app reaches with its device token:
 * the bus answers and /api/me, but not sign-in, pairing or sign-out, which
 * answer before the version is checked, nor DELETE /api/me/push and DELETE /api/me,
 * which an outdated app may still do.
 */
function withUpdateRequired(spec: Record<string, unknown>): Record<string, unknown> {
  const paths = spec.paths as Record<string, Record<string, { security?: { bearer?: unknown }[]; responses?: Record<string, unknown> }>>;
  for (const [path, ops] of Object.entries(paths)) {
    const me = path === '/api/me' || path.startsWith('/api/me/');
    if (!me && (path.startsWith('/api/auth/') || path.startsWith('/auth/') || path.startsWith('/api/pair'))) continue;
    for (const [method, op] of Object.entries(ops)) {
      if (!op || typeof op !== 'object' || !op.responses) continue;
      if (method === 'delete' && (path === '/api/me' || path === '/api/me/push')) continue;
      // The overview's default security takes a bearer token; an operation's own must list one.
      const bearer = op.security === undefined || op.security.some((s) => s && 'bearer' in s);
      if (bearer) op.responses['426'] ??= UPDATE_REQUIRED_426;
    }
  }
  return spec;
}

/**
 * The spec as sent, kept per origin: it is a few hundred kilobytes built and
 * stringified from the same constants every time. A few origins at most (the
 * site, the beta, workers.dev); past that it starts again, so a stream of
 * made-up hosts can't grow it.
 */
const specMemo = new Map<string, string>();
const SPEC_ORIGINS_KEPT = 8;

export function openApiJson(origin: string): string {
  let text = specMemo.get(origin);
  if (text === undefined) {
    if (specMemo.size >= SPEC_ORIGINS_KEPT) specMemo.clear();
    text = JSON.stringify(openApiSpec(origin));
    specMemo.set(origin, text);
  }
  return text;
}
