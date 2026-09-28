/**
 * Invite-only accounts: email sign-in links for the web page, pairing codes
 * for the native apps, and one profile document per user.
 *
 * Every token is 32 random bytes, handed out once and stored only as its
 * SHA-256. A leaked database row cannot be replayed as a session.
 */

import type { Env } from './types.ts';
import { DEVICE_IDLE_MS } from './monitor.ts';

export const ACCOUNT_TTL = {
  linkMs: 15 * 60_000,
  /** One sign-in email per address per this window. */
  linkCooldownMs: 60_000,
  webSessionMs: 30 * 86_400_000,
  pairCodeMs: 10 * 60_000,
  /** last_seen is only rewritten this often, to keep D1 writes down. */
  touchMs: 3_600_000,
} as const;

export const SESSION_COOKIE = 'nb_s';

// No 0/O, 1/I/L, U: a code read off a screen and typed on a phone.
const PAIR_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface User {
  id: string;
  email: string;
}

export interface SessionInfo {
  user: User;
  kind: 'web' | 'device';
  tokenHash: string;
}

export function accountsConfigured(env: Env): boolean {
  return Boolean(env.DB);
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function newToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function newPairCode(): string {
  // Rejection sampling keeps every character equally likely.
  const out: string[] = [];
  while (out.length < 6) {
    for (const b of crypto.getRandomValues(new Uint8Array(12))) {
      if (b < 240 && out.length < 6) out.push(PAIR_ALPHABET[b % PAIR_ALPHABET.length]);
    }
  }
  return out.join('');
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  return /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/.test(e) ? e : null;
}

/** Normalises a user-entered pairing code; null if it cannot be one. */
export function normalizePairCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const c = raw.replace(/[\s-]/g, '').toUpperCase();
  return c.length === 6 && [...c].every((ch) => PAIR_ALPHABET.includes(ch)) ? c : null;
}

/* ------------------------------------------------------------------ */
/* Sign-in links                                                      */
/* ------------------------------------------------------------------ */

export type LinkOutcome = 'sent' | 'blocked' | 'cooldown';

/**
 * Creates a sign-in link and emails it. Sign-up is open; addresses on the
 * blocklist are refused. The caller shows the same message for every
 * outcome, so the endpoint doesn't reveal who has an account or is blocked.
 */
export async function requestLink(env: Env, db: D1Database, email: string, origin: string, nowMs: number): Promise<LinkOutcome> {
  const blocked = await db.prepare('SELECT 1 FROM blocklist WHERE email = ?').bind(email).first();
  if (blocked) return 'blocked';

  const recent = await db
    .prepare('SELECT 1 FROM magic_links WHERE email = ? AND created > ?')
    .bind(email, nowMs - ACCOUNT_TTL.linkCooldownMs)
    .first();
  if (recent) return 'cooldown';

  const token = newToken();
  await db.batch([
    db.prepare('DELETE FROM magic_links WHERE expires < ?').bind(nowMs),
    db
      .prepare('INSERT INTO magic_links (token_hash, email, created, expires) VALUES (?, ?, ?, ?)')
      .bind(await hashToken(token), email, nowMs, nowMs + ACCOUNT_TTL.linkMs),
  ]);

  const link = `${origin}/auth/verify?t=${token}`;
  if (!env.EMAIL || !env.EMAIL_FROM) throw new Error('email sending not configured');
  await env.EMAIL.send({
    from: { email: env.EMAIL_FROM, name: 'terminus' },
    to: email,
    subject: 'Sign in to terminus',
    text: `Sign in to terminus:\n\n${link}\n\nThe link works once and expires in 15 minutes. If you didn't ask for it, ignore this email.`,
    html: `<p><a href="${link}">Sign in to terminus</a></p><p>The link works once and expires in 15 minutes. If you didn't ask for it, ignore this email.</p>`,
  });
  return 'sent';
}

/**
 * Spends a sign-in link and opens a web session. Returns the raw session
 * token for the cookie, or null when the link is unknown, used or expired.
 */
export async function redeemLink(db: D1Database, token: string, nowMs: number): Promise<string | null> {
  const hash = await hashToken(token);
  // DELETE ... RETURNING makes the link single-use even under two racing POSTs.
  const row = await db
    .prepare('DELETE FROM magic_links WHERE token_hash = ? RETURNING email, expires')
    .bind(hash)
    .first<{ email: string; expires: number }>();
  if (!row || row.expires < nowMs) return null;

  const user = await ensureUser(db, row.email, nowMs);
  return openSession(db, user.id, 'web', null, nowMs);
}

async function ensureUser(db: D1Database, email: string, nowMs: number): Promise<User> {
  await db
    .prepare('INSERT INTO users (id, email, created) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING')
    .bind(crypto.randomUUID(), email, nowMs)
    .run();
  return (await db.prepare('SELECT id, email FROM users WHERE email = ?').bind(email).first<User>())!;
}

async function openSession(
  db: D1Database,
  userId: string,
  kind: 'web' | 'device',
  name: string | null,
  nowMs: number,
): Promise<string> {
  const token = newToken();
  await db
    .prepare(
      'INSERT INTO sessions (token_hash, user_id, kind, name, created, last_seen, expires) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(await hashToken(token), userId, kind, name, nowMs, nowMs, kind === 'web' ? nowMs + ACCOUNT_TTL.webSessionMs : null)
    .run();
  return token;
}

/* ------------------------------------------------------------------ */
/* Sessions                                                           */
/* ------------------------------------------------------------------ */

export function tokenFrom(req: Request): string | null {
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim() || null;
  const cookie = req.headers.get('cookie') ?? '';
  for (const part of cookie.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === SESSION_COOKIE) return v.join('=') || null;
  }
  return null;
}

export async function authenticate(
  db: D1Database,
  req: Request,
  nowMs: number,
  ctx?: ExecutionContext,
): Promise<SessionInfo | null> {
  const token = tokenFrom(req);
  if (!token) return null;
  const hash = await hashToken(token);
  const row = await db
    .prepare(
      `SELECT s.kind, s.last_seen, s.expires, u.id, u.email
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
    )
    .bind(hash)
    .first<{ kind: 'web' | 'device'; last_seen: number; expires: number | null; id: string; email: string }>();
  if (!row) return null;
  if (row.expires !== null && row.expires < nowMs) return null;
  // Paired devices lapse after 90 idle days (the cron deletes them too).
  if (row.kind === 'device' && nowMs - row.last_seen > DEVICE_IDLE_MS) return null;

  if (nowMs - row.last_seen > ACCOUNT_TTL.touchMs) {
    const touch = db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').bind(nowMs, hash).run();
    if (ctx) ctx.waitUntil(touch.catch(() => {}));
    else await touch;
  }
  return { user: { id: row.id, email: row.email }, kind: row.kind, tokenHash: hash };
}

export async function endSession(db: D1Database, tokenHash: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
}

export function sessionCookie(token: string, maxAgeS: number): string {
  // SameSite=Lax blocks cross-site POSTs carrying the cookie.
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeS}`;
}

/* ------------------------------------------------------------------ */
/* Devices                                                            */
/* ------------------------------------------------------------------ */

export async function createPairCode(db: D1Database, userId: string, nowMs: number): Promise<{ code: string; expires: number }> {
  const code = newPairCode();
  const expires = nowMs + ACCOUNT_TTL.pairCodeMs;
  await db.batch([
    db.prepare('DELETE FROM pair_codes WHERE user_id = ? OR expires < ?').bind(userId, nowMs),
    db.prepare('INSERT INTO pair_codes (code, user_id, expires) VALUES (?, ?, ?)').bind(code, userId, expires),
  ]);
  return { code, expires };
}

/** Spends a pairing code and returns a device token, or null. */
export async function redeemPairCode(db: D1Database, code: string, name: string, nowMs: number): Promise<string | null> {
  const row = await db
    .prepare('DELETE FROM pair_codes WHERE code = ? RETURNING user_id, expires')
    .bind(code)
    .first<{ user_id: string; expires: number }>();
  if (!row || row.expires < nowMs) return null;
  return openSession(db, row.user_id, 'device', name, nowMs);
}

export interface DeviceRow {
  id: string;
  name: string | null;
  created: number;
  lastSeen: number;
}

/** Devices are identified to the page by a prefix of the token hash, which is
 *  enough to revoke one and useless for signing in. */
export async function listDevices(db: D1Database, userId: string): Promise<DeviceRow[]> {
  const { results } = await db
    .prepare(
      "SELECT substr(token_hash, 1, 16) AS id, name, created, last_seen AS lastSeen FROM sessions WHERE user_id = ? AND kind = 'device' ORDER BY created",
    )
    .bind(userId)
    .all<DeviceRow>();
  return results;
}

export async function revokeDevice(db: D1Database, userId: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f]{16}$/.test(id)) return false;
  const r = await db
    .prepare("DELETE FROM sessions WHERE user_id = ? AND kind = 'device' AND substr(token_hash, 1, 16) = ?")
    .bind(userId, id)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

/* ------------------------------------------------------------------ */
/* Profile storage                                                    */
/* ------------------------------------------------------------------ */

export async function loadProfileJson(db: D1Database, userId: string): Promise<unknown | null> {
  const row = await db.prepare('SELECT json FROM profiles WHERE user_id = ?').bind(userId).first<{ json: string }>();
  return row ? JSON.parse(row.json) : null;
}

export async function saveProfileJson(db: D1Database, userId: string, profile: unknown, nowMs: number): Promise<void> {
  await db
    .prepare(
      'INSERT INTO profiles (user_id, json, updated) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated = excluded.updated',
    )
    .bind(userId, JSON.stringify(profile), nowMs)
    .run();
}

/* ------------------------------------------------------------------ */
/* Account-wide actions                                               */
/* ------------------------------------------------------------------ */

/** Signs out every browser and device on the account. */
export async function endAllSessions(db: D1Database, userId: string): Promise<number> {
  const r = await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
  return r.meta?.changes ?? 0;
}

/** Deletes the account and everything hanging off it (the schema cascades). */
export async function deleteAccount(db: D1Database, user: User): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM magic_links WHERE email = ?').bind(user.email),
    db.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
  ]);
}

/** Everything stored about the user, for a data export. Token hashes are left out. */
export async function exportAccount(db: D1Database, user: User): Promise<Record<string, unknown>> {
  const row = await db.prepare('SELECT created FROM users WHERE id = ?').bind(user.id).first<{ created: number }>();
  const profile = await loadProfileJson(db, user.id);
  const { results: sessions } = await db
    .prepare('SELECT kind, name, created, last_seen AS lastSeen, expires FROM sessions WHERE user_id = ? ORDER BY created')
    .bind(user.id)
    .all();
  return {
    email: user.email,
    created: row ? new Date(row.created).toISOString() : null,
    profile,
    sessions: sessions.map((x) => {
      const r = x as { kind: string; name: string | null; created: number; lastSeen: number; expires: number | null };
      return {
        kind: r.kind,
        name: r.name,
        created: new Date(r.created).toISOString(),
        lastSeen: new Date(r.lastSeen).toISOString(),
        expires: r.expires ? new Date(r.expires).toISOString() : null,
      };
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Turnstile                                                          */
/* ------------------------------------------------------------------ */

/**
 * Verifies a Turnstile token. With no secret configured (local dev, tests)
 * it passes, so the check can ship before the widget is set up.
 */
export async function verifyTurnstile(env: Env, token: unknown, ip: string | null, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true;
  if (typeof token !== 'string' || !token) return false;
  const body = new FormData();
  body.set('secret', env.TURNSTILE_SECRET);
  body.set('response', token);
  if (ip) body.set('remoteip', ip);
  try {
    const res = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    const out = (await res.json()) as { success?: boolean };
    return out.success === true;
  } catch {
    return false;
  }
}
