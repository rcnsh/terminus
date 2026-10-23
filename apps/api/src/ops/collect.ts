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
 * - `legacy`: requests that still use something on its way out (the old
 *   address, the API's old paths, an app too old to be served), counted by
 *   app version and route (legacy.ts). Nothing about who sent them.
 * - `settings`: how many active accounts have each setting, once a day
 *   (settings.ts). Totals only, from the profiles D1 already keeps.
 *
 * Each is KV `config:collect:<name>`, "on" or "off". Unset is off, and so is
 * KV failing to answer: nothing new is collected until the operator turns
 * it on.
 */

import type { Env } from '../types.ts';
import { isOperator } from './admin.ts';
import { json } from '../http.ts';

export const COLLECTORS = ['active', 'eta', 'errors', 'legacy', 'settings'] as const;
export type Collector = (typeof COLLECTORS)[number];

const keyOf = (name: Collector) => `config:collect:${name}`;

export async function collecting(env: Env, name: Collector): Promise<boolean> {
  try {
    return (await env.KV.get(keyOf(name))) === 'on';
  } catch {
    return false;
  }
}

const SWITCH_MEMO_MS = 60_000;
const switchMemo = new WeakMap<object, Map<Collector, { at: number; on: boolean }>>();

/**
 * Whether [name] is on, read from KV at most once a minute per isolate (as
 * monitor.ts feedDownSince is): for a switch asked on requests, like
 * `legacy`, which would otherwise cost a KV read on each. A flip on the
 * dashboard clears it, so that isolate sees it at once.
 */
export async function collectingMemo(env: Env, name: Collector, nowMs = Date.now()): Promise<boolean> {
  const kept = switchMemo.get(env.KV)?.get(name);
  if (kept && nowMs - kept.at < SWITCH_MEMO_MS && nowMs >= kept.at) return kept.on;
  const on = await collecting(env, name);
  if (env.KV) {
    const memo = switchMemo.get(env.KV) ?? new Map();
    switchMemo.set(env.KV, memo.set(name, { at: nowMs, on }));
  }
  return on;
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
  if (!name || typeof body?.on !== 'boolean')
    return json({ error: 'name must be active, eta, errors, legacy or settings, and on true or false' }, 400);
  await env.KV.put(keyOf(name), body.on ? 'on' : 'off');
  switchMemo.get(env.KV)?.delete(name);
  // KV may still read the old value back for a while: say what was just set.
  return json({ ...(await collectState(env)), [name]: body.on }, 200, { 'cache-control': 'no-store' });
}
