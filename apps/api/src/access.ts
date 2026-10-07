/**
 * Who may call the bus-answer routes (/next, /trip, /arrivals, /campus,
 * /stops/pairs): the holder of an API key made on the account page, or anyone
 * signed in (a browser session or a paired device). Nobody anonymous: the
 * answers are NUS's data, and terminus should not be a free proxy for it.
 */

import type { Env } from './types.ts';
import { authenticate, hashToken, newToken, tokenFrom } from './accounts.ts';

export const KEY_PREFIX = 'tk_';
export const MAX_KEYS = 5;
/** Set on a test's env to open the keyed routes to anyone. */
export const TEST_OPEN = Symbol.for('terminus.testOpen');
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
  // Tests only: the public-route tests predate keys. A symbol, so no
  // deployed var or secret can ever set it.
  if ((env as unknown as Record<symbol, unknown>)[TEST_OPEN] === true) return { kind: 'open' };
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
      if (ctx) ctx.waitUntil(touch.catch((err) => console.error('api key last_used not updated:', err instanceof Error ? err.message : String(err))));
      else await touch;
    }
    return { kind: 'key', keyId: row.id, userId: row.user_id };
  }
  const session = await authenticate(db, req, nowMs, ctx);
  return session ? { kind: 'account', userId: session.user.id } : null;
}

/** The answer when D1 can't be reached to check who's asking. */
export const ACCOUNTS_DOWN = "terminus can't reach your account right now; try again in a minute";

/**
 * Whether an error is D1 being unreachable or overloaded for a moment, worth
 * a 503 and a retry, rather than a fault in the code or the schema (a
 * missing column or a broken constraint stays a 500).
 */
export function d1Unavailable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // D1's own errors say so ("D1_ERROR: Network connection lost."); a
  // timeout from a fetch to NUS doesn't, and isn't about accounts. Faults
  // in the query itself (a bad binding, too many variables) stay a 500, so
  // a bug doesn't read as "try again in a minute".
  return /\bD1\b|D1_/.test(msg)
    && !/constraint|no such (?:table|column|function)|syntax error|D1_TYPE_ERROR|D1_COLUMN_NOTFOUND|too many (?:SQL )?variables|too many terms|too ?big|datatype mismatch|out of range/i.test(msg);
}

/**
 * callerFor, tried once more when D1 is unreachable, since it sometimes
 * drops a single query. Null with `down` when it still fails: the caller answers 503 rather
 * than a bare 500, so the apps know to try again.
 */
export async function callerOrDown(env: Env, req: Request, nowMs: number, ctx?: ExecutionContext): Promise<{ caller: Caller | null; down: boolean }> {
  try {
    return { caller: await callerFor(env, req, nowMs, ctx), down: false };
  } catch (first) {
    // A fault in the query (a missing column after a deploy that ran ahead
    // of its migration) won't pass by itself: a 500, not a retry and a 503.
    if (!d1Unavailable(first)) throw first;
    try {
      return { caller: await callerFor(env, req, nowMs, ctx), down: false };
    } catch (err) {
      if (!d1Unavailable(err)) throw err;
      console.error('callerFor: D1 failed twice:', err instanceof Error ? err.message : String(err));
      return { caller: null, down: true };
    }
  }
}

/**
 * Who was let in lately, by a hash of what they sent, for /buses only: the
 * map asks every 5 s, and each ask would otherwise hash the token and look
 * it up in D1 again. The trade-off: a session signed out, or a key revoked,
 * still sees the buses on the map for up to CALLER_MEMO_MS in this isolate
 * (and keeps its own rate-limit bucket that long). Only callers let in are
 * kept, so someone just signed in is never turned away. Never used for
 * /me/* or anything else that hands out an account's data.
 */
export const CALLER_MEMO_MS = 30_000;
const CALLERS_KEPT = 2_000;
const callerMemos = new WeakMap<object, Map<string, { at: number; caller: Caller }>>();

export async function recentCallerFor(env: Env, req: Request, nowMs: number, ctx?: ExecutionContext): Promise<Caller | null> {
  const sent = [req.headers.get('x-api-key')?.trim() ?? '', tokenFrom(req) ?? ''];
  if (!env.DB || (!sent[0] && !sent[1])) return callerFor(env, req, nowMs, ctx);
  let memo = callerMemos.get(env.DB);
  if (!memo) callerMemos.set(env.DB, (memo = new Map()));
  const id = await hashToken(sent.join('\n'));
  const kept = memo.get(id);
  if (kept && nowMs >= kept.at && nowMs - kept.at < CALLER_MEMO_MS) return kept.caller;
  const caller = await callerFor(env, req, nowMs, ctx);
  memo.delete(id);
  if (caller) {
    // Oldest first in a Map: past the bound, drop the oldest.
    if (memo.size >= CALLERS_KEPT) memo.delete(memo.keys().next().value!);
    memo.set(id, { at: nowMs, caller });
  }
  return caller;
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
  const key = `${KEY_PREFIX}${newToken()}`;
  const id = crypto.randomUUID();
  const hint = key.slice(-4);
  // Counted and inserted in one statement: two at once can't both be the fifth.
  const made = await db
    .prepare('INSERT INTO api_keys (id, user_id, key_hash, name, hint, created) SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM api_keys WHERE user_id = ?) < ? RETURNING id')
    .bind(id, userId, await hashToken(key), name, hint, nowMs, userId, MAX_KEYS)
    .first<{ id: string }>();
  if (!made) return null;
  return { id, name, hint, created: nowMs, lastUsed: null, key };
}

export async function revokeKey(db: D1Database, userId: string, id: string): Promise<boolean> {
  const r = await db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?').bind(id, userId).run();
  return (r.meta?.changes ?? 0) > 0;
}
