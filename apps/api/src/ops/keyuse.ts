/**
 * Requests made with each API key, for the dashboard's API keys table: one
 * Analytics Engine row per request (analytics.ts logKeyUse) with the key's
 * id, the keyed route and whether the key's rate limit turned it away.
 * Nothing else from the request: no query, address or stop.
 *
 * Off unless the operator turns `keys` on (collect.ts). The dashboard names
 * a key's owner from D1 (admin.ts), so once a key is revoked its rows lead
 * back to no one.
 */

import type { Env } from '../types.ts';
import { analyticsEnabled, logKeyUse, type KeyUseRow } from './analytics.ts';
import { collectingMemo } from './collect.ts';

/** Counts one request made with [keyId] while the operator is collecting; never delays or fails the answer. */
export function noteKeyUse(env: Env, ctx: ExecutionContext, keyId: string, route: string, outcome: KeyUseRow['outcome']): void {
  if (!analyticsEnabled(env)) return;
  ctx.waitUntil(
    collectingMemo(env, 'keys').then((on) => {
      if (on) logKeyUse(env, { keyId, route, outcome });
    }),
  );
}
