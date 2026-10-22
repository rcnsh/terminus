/**
 * Requests that still use something on its way out, counted so it can be
 * switched off once nothing does: the old address (terminus.rcn.sh, the
 * beta's), the API's paths from before 3.0, and apps too old to be served
 * (config:minClient, answered 426). One Analytics Engine row each
 * (analytics.ts logLegacy): what it used, the app and version that sent it,
 * and the route. No account, address, query or anything else from the
 * request, so the rows say how much is left, never who.
 *
 * Off unless the operator turns `legacy` on (collect.ts). Apps from 3.6.0
 * call only terminus.run, so the rows come from older apps and old links.
 */

import type { Env } from './types.ts';
import { clientFrom } from './accounts.ts';
import { analyticsEnabled, logLegacy, type LegacyRow } from './analytics.ts';
import { collecting } from './collect.ts';
import { oldAddress, oldApiPath } from './site.ts';

/** What [req] used that is on its way out, given the [status] it was answered with; none for most requests. */
export function legacyUses(req: Request, url: URL, status: number): LegacyRow['what'][] {
  const out: LegacyRow['what'][] = [];
  if (oldAddress(url.hostname)) out.push('address');
  const oldPath = oldApiPath(req, url);
  if (oldPath) out.push('path');
  else if (status === 426) out.push('outdated');
  return out;
}

/** Who sent it, as far as the dashboard needs: an app and its version, a browser, or something else. */
export function senderOf(req: Request): string {
  const { client } = clientFrom(req);
  if (client) return client;
  return (req.headers.get('accept') ?? '').includes('text/html') ? 'browser' : 'other';
}

/**
 * The route, without what could single someone out: no query, and a part
 * with a digit in it (a stop code, a trip's or a device's id, a map tile's
 * numbers) is `:id`. At most three parts, so a long path is one route.
 */
export function routeOf(path: string): string {
  const parts = path.split('/').filter(Boolean).slice(0, 3);
  return '/' + parts.map((p) => (/\d/.test(p) || p.length > 32 ? ':id' : p)).join('/');
}

/** Counts [req] when it used something on its way out and the operator is collecting; never delays or fails the answer. */
export function noteLegacy(env: Env, ctx: ExecutionContext, req: Request, status: number): void {
  const url = new URL(req.url);
  const uses = legacyUses(req, url, status);
  if (!uses.length || !analyticsEnabled(env)) return;
  const client = senderOf(req);
  const route = routeOf(url.pathname);
  ctx.waitUntil(
    collecting(env, 'legacy').then((on) => {
      if (on) for (const what of uses) logLegacy(env, { what, client, route });
    }),
  );
}
