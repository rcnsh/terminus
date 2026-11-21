import type { Env } from './types.ts';
import { writeRow } from './analytics-rows.ts';
import { onceEvery, perScope } from './memo.ts';

const lostNotes = perScope(() => onceEvery(10 * 60_000, 100));

export const lostReason = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 160);

export function noteLost(env: Pick<Env, 'KV' | 'AE'> | null, what: string, err: unknown, nowMs: number = Date.now()): void {
  if (!lostNotes(env?.KV).due(what, nowMs)) return;
  const reason = lostReason(err);
  console.error(`${what} failed: ${reason}`);
  if (env) writeRow(env, 'error', { route: what, reason });
}

export const lost =
  (env: Pick<Env, 'KV' | 'AE'> | null, what: string) =>
  (err: unknown): void =>
    noteLost(env, what, err);
