import type { Env } from '../types.ts';
import { analyticsEnabled, logKeyUse, type KeyUseRow } from './analytics.ts';
import { collectingMemo } from './collect.ts';

export function noteKeyUse(env: Env, ctx: ExecutionContext, keyId: string, route: string, outcome: KeyUseRow['outcome']): void {
  if (!analyticsEnabled(env)) return;
  ctx.waitUntil(
    collectingMemo(env, 'keys').then((on) => {
      if (on) logKeyUse(env, { keyId, route, outcome });
    }),
  );
}
