import type { Env } from '../types.ts';
import { isOperator } from './admin.ts';
import { json } from '../http.ts';

export const COLLECTORS = ['active', 'eta', 'errors', 'legacy', 'settings', 'keys'] as const;
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

export async function collectState(env: Env): Promise<Record<Collector, boolean>> {
  const on = await Promise.all(COLLECTORS.map((c) => collecting(env, c)));
  return Object.fromEntries(COLLECTORS.map((c, i) => [c, on[i]])) as Record<Collector, boolean>;
}

export async function handleCollect(req: Request, env: Env, nowMs: number): Promise<Response> {
  if (!(await isOperator(env, req, nowMs))) return json({ error: 'not found' }, 404);
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, { allow: 'POST' });
  const body = (await req.json().catch(() => null)) as { name?: unknown; on?: unknown } | null;
  const name = COLLECTORS.find((c) => c === body?.name);
  if (!name || typeof body?.on !== 'boolean')
    return json({ error: 'name must be active, eta, errors, legacy, settings or keys, and on true or false' }, 400);
  await env.KV.put(keyOf(name), body.on ? 'on' : 'off');
  switchMemo.get(env.KV)?.delete(name);
  return json({ ...(await collectState(env)), [name]: body.on }, 200, { 'cache-control': 'no-store' });
}
