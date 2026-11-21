import type { Env } from '../types.ts';
import { clientFrom } from '../accounts/accounts.ts';
import { analyticsEnabled, logLegacy, type LegacyRow } from './analytics.ts';
import { collectingMemo } from './collect.ts';
import { oldAddress, oldApiPath } from '../site/site.ts';

export function legacyUses(req: Request, url: URL, status: number): LegacyRow['what'][] {
  const out: LegacyRow['what'][] = [];
  if (status === 404) return out;
  if (oldAddress(url.hostname)) out.push('address');
  const oldPath = oldApiPath(req, url);
  if (oldPath) out.push('path');
  else if (status === 426) out.push('outdated');
  return out;
}

export function senderOf(req: Request): string {
  const { client } = clientFrom(req);
  if (client) return client;
  return (req.headers.get('accept') ?? '').includes('text/html') ? 'browser' : 'other';
}

export function routeOf(path: string): string {
  const parts = path.split('/').filter(Boolean).slice(0, 3);
  return '/' + parts.map((p) => (/\d/.test(p) || p.length > 32 ? ':id' : p)).join('/');
}

export function noteLegacy(env: Env, ctx: ExecutionContext, req: Request, status: number): void {
  const url = new URL(req.url);
  const uses = legacyUses(req, url, status);
  if (!uses.length || !analyticsEnabled(env)) return;
  const client = senderOf(req);
  const route = routeOf(url.pathname);
  ctx.waitUntil(
    collectingMemo(env, 'legacy').then((on) => {
      if (on) for (const what of uses) logLegacy(env, { what, client, route });
    }),
  );
}
