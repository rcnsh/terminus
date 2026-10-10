/**
 * The operator's switches for the statistics terminus collects beyond its
 * answers, flipped on the dashboard (POST /api/admin/collect):
 *
 * - `active`: how many accounts used terminus each day, by app and version
 *   (usage.ts). Counts only, worked out from the sessions D1 already keeps.
 * - `eta`: how close the feed's "in 4 min" came to when the bus did come
 *   (eta.ts). No user data at all: the feed's predictions against the
 *   timelapse recorder's buses.
 * - `errors`: crash and error reports from the apps and the website
 *   (apperrors.ts), with no account, device or address in them.
 *
 * Each is KV `config:collect:<name>`, "on" or "off". Unset is off, and so is
 * KV failing to answer: nothing new is collected until the operator turns
 * it on.
 */

import type { Env } from './types.ts';
import { isOperator } from './admin.ts';
import { json } from './http.ts';

export const COLLECTORS = ['active', 'eta', 'errors'] as const;
export type Collector = (typeof COLLECTORS)[number];

const keyOf = (name: Collector) => `config:collect:${name}`;

export async function collecting(env: Env, name: Collector): Promise<boolean> {
  try {
    return (await env.KV.get(keyOf(name))) === 'on';
  } catch {
    return false;
  }
}

/** Every switch, for the dashboard. */
export async function collectState(env: Env): Promise<Record<Collector, boolean>> {
  const on = await Promise.all(COLLECTORS.map((c) => collecting(env, c)));
  return Object.fromEntries(COLLECTORS.map((c, i) => [c, on[i]])) as Record<Collector, boolean>;
}

/** POST /api/admin/collect {name, on}: operator only; answers every switch. */
export async function handleCollect(req: Request, env: Env, nowMs: number): Promise<Response> {
  if (!(await isOperator(env, req, nowMs))) return json({ error: 'not found' }, 404);
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, { allow: 'POST' });
  const body = (await req.json().catch(() => null)) as { name?: unknown; on?: unknown } | null;
  const name = COLLECTORS.find((c) => c === body?.name);
  if (!name || typeof body?.on !== 'boolean') return json({ error: 'name must be active, eta or errors, and on true or false' }, 400);
  await env.KV.put(keyOf(name), body.on ? 'on' : 'off');
  // KV may still read the old value back for a while: say what was just set.
  return json({ ...(await collectState(env)), [name]: body.on }, 200, { 'cache-control': 'no-store' });
}
