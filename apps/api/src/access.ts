/**
 * Who may call the bus-answer routes (/next, /trip, /arrivals, /campus,
 * /stops/pairs): the holder of an API key made on the account page, or anyone
 * signed in (a browser session or a paired device). Nobody anonymous: the
 * answers are NUS's data, and terminus should not be a free proxy for it.
 */

import type { Env } from './types.ts';
import { authenticate, hashToken, newToken } from './accounts.ts';

export const KEY_PREFIX = 'tk_';
export const MAX_KEYS = 5;
/** Only write last_used this often. */
const TOUCH_MS = 10 * 60_000;

export type Caller = { kind: 'key'; keyId: string; userId: string } | { kind: 'account'; userId: string } | { kind: 'open' };

/** The key from `x-api-key`, or a bearer token that may be one. */
function keyFrom(req: Request): { key: string; bearer: boolean } | null {
  const header = req.headers.get('x-api-key')?.trim();
  if (header) return { key: header, bearer: false };
  const auth = req.headers.get('authorization');
  if (auth?.startsWith(`Bearer ${KEY_PREFIX}`)) return { key: auth.slice(7).trim(), bearer: true };
  return null;
}

export async function callerFor(env: Env, req: Request, nowMs: number, ctx?: ExecutionContext): Promise<Caller | null> {
  // Tests only: the public-route tests predate keys.
  if (env.PUBLIC_API_OPEN === '1') return { kind: 'open' };
  const db = env.DB;
  if (!db) return null;
  const found = keyFrom(req);
  const row = found
    ? await db.prepare('SELECT id, user_id, last_used FROM api_keys WHERE key_hash = ?').bind(await hashToken(found.key)).first<{ id: string; user_id: string; last_used: number | null }>()
    : null;
  // A bearer starting tk_ that is no key may still be a session: those are
  // random base64url, and about 1 in 262,144 starts that way too.
  if (found && !row && !found.bearer) return null;
  if (row) {
    if (row.last_used === null || nowMs - row.last_used > TOUCH_MS) {
      const touch = db.prepare('UPDATE api_keys SET last_used = ? WHERE id = ?').bind(nowMs, row.id).run();
      if (ctx) ctx.waitUntil(touch.catch(() => {}));
      else await touch;
    }
    return { kind: 'key', keyId: row.id, userId: row.user_id };
  }
  const session = await authenticate(db, req, nowMs, ctx);
  return session ? { kind: 'account', userId: session.user.id } : null;
}

export interface KeyInfo {
  id: string;
  name: string;
  hint: string;
  created: number;
  lastUsed: number | null;
}

export async function listKeys(db: D1Database, userId: string): Promise<KeyInfo[]> {
  const { results } = await db
    .prepare('SELECT id, name, hint, created, last_used AS lastUsed FROM api_keys WHERE user_id = ? ORDER BY created')
    .bind(userId)
    .all<KeyInfo>();
  return results;
}

/** A new key, shown this once; only its hash is kept. Null at the limit. */
export async function createKey(db: D1Database, userId: string, name: string, nowMs: number): Promise<(KeyInfo & { key: string }) | null> {
  const count = await db.prepare('SELECT count(*) AS n FROM api_keys WHERE user_id = ?').bind(userId).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_KEYS) return null;
  const key = `${KEY_PREFIX}${newToken()}`;
  const id = crypto.randomUUID();
  const hint = key.slice(-4);
  await db
    .prepare('INSERT INTO api_keys (id, user_id, key_hash, name, hint, created) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, userId, await hashToken(key), name, hint, nowMs)
    .run();
  return { id, name, hint, created: nowMs, lastUsed: null, key };
}

export async function revokeKey(db: D1Database, userId: string, id: string): Promise<boolean> {
  const r = await db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?').bind(id, userId).run();
  return (r.meta?.changes ?? 0) > 0;
}
