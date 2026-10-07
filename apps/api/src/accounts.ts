/**
 * Accounts: email sign-in codes and links for the web page, pairing codes
 * for the native apps, and one profile document per user.
 *
 * Every token is 32 random bytes, handed out once and stored only as its
 * SHA-256. A leaked database row cannot be replayed as a session.
 */

import { exportOutcomes } from './outcomes.ts';
import type { Env } from './types.ts';
import { DEVICE_IDLE_MS } from './monitor.ts';
import { mailName, siteOrigin } from './site.ts';
import { m } from './i18n.ts';

export const ACCOUNT_TTL = {
  linkMs: 15 * 60_000,
  /** One sign-in email per address per this window. */
  linkCooldownMs: 60_000,
  webSessionMs: 30 * 86_400_000,
  /** A web session used with less than this left is renewed for another
   *  webSessionMs, so a browser (or the installed web app) in use stays signed in. */
  webRenewBelowMs: 23 * 86_400_000,
  /** However much it's used, a web session ends this long after sign-in and
   *  the email link is needed again. Not for accounts with no email: they
   *  would have no way back in. */
  webSessionMaxMs: 180 * 86_400_000,
  pairCodeMs: 10 * 60_000,
  /** Wrong guesses before an emailed sign-in code stops working. */
  codeTries: 5,
  /** last_seen is only rewritten this often, to keep D1 writes down. */
  touchMs: 3_600_000,
  /** An anonymous account (an app that never added an email) unused this long is deleted. */
  anonIdleMs: 60 * 86_400_000,
} as const;

/**
 * `__Host-` pins the cookie to this exact host over HTTPS: a sibling
 * *.rcn.sh site cannot set or shadow it.
 */
export const SESSION_COOKIE = '__Host-tm_s';

// No 0/O, 1/I/L, U: a code read off a screen and typed on a phone.
const PAIR_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface User {
  id: string;
  /** Null for an anonymous account: an app that hasn't added an email. */
  email: string | null;
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

/**
 * Plain addresses only. The old pattern allowed `,` `<` `>` in the local
 * part, so "x,blocked@example.com" was a different string from the blocked
 * address but could still be delivered to it.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  if (e.length > 254) return null;
  return /^[a-z0-9._%+-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(e) ? e : null;
}

/**
 * The inbox an address delivers to, for cooldowns and the blocklist:
 * "a.b+x@gmail.com" and "ab@gmail.com" are one inbox. Mail still goes to
 * the address as typed.
 */
export function inboxKey(email: string): string {
  let [local, domain] = email.split('@');
  local = local.split('+')[0];
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replaceAll('.', '');
  return `${local}@${domain}`;
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

export type LinkOutcome = 'sent' | 'blocked' | 'cooldown' | 'busy';

/**
 * One ceiling on sign-in emails for everyone: a botnet past Turnstile must
 * not be able to spend the whole email quota or the sender's reputation.
 * Taken only when an email is about to go, so requests that send nothing
 * (an address in its cooldown) can't use it up and block everyone's sign-in.
 */
export async function takeGlobalMail(env: Env): Promise<boolean> {
  return !env.RL_MAIL || (await env.RL_MAIL.limit({ key: 'mail:global' })).success;
}

/**
 * Creates a sign-in link and emails it. Sign-up is open; addresses on the
 * blocklist are refused. The caller shows the same message for every
 * outcome, so the endpoint doesn't reveal who has an account or is blocked.
 */
export async function requestLink(env: Env, db: D1Database, email: string, origin: string, nowMs: number, toApp = false): Promise<LinkOutcome> {
  const inbox = inboxKey(email);
  const blocked = await db.prepare('SELECT 1 FROM blocklist WHERE email IN (?, ?)').bind(email, inbox).first();
  // It spends from the ceiling as a sent email would, so a busy minute
  // answers the same for it and doesn't reveal the blocklist.
  if (blocked) return (await takeGlobalMail(env)) ? 'blocked' : 'busy';

  const recent = await db
    .prepare('SELECT 1 FROM magic_links WHERE email = ? AND created > ?')
    .bind(email, nowMs - ACCOUNT_TTL.linkCooldownMs)
    .first();
  if (recent) return 'cooldown';
  // Per inbox too, so +tags and dots cannot mail one person over and over.
  const coolKey = `mail:${await hashToken(inbox)}`;
  if (await env.KV.get(coolKey).catch(() => null)) return 'cooldown';
  if (!(await takeGlobalMail(env))) return 'busy';
  if (!(await takeMailBudget(env, inbox, nowMs))) return 'cooldown';

  const token = newToken();
  const tokenHash = await hashToken(token);
  // The cooldown checked and the link stored in one statement: two requests
  // at once can't both pass the check above and both send an email.
  const [, made] = await db.batch([
    db.prepare('DELETE FROM magic_links WHERE expires < ?').bind(nowMs),
    db
      .prepare('INSERT INTO magic_links (token_hash, email, created, expires) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM magic_links WHERE email = ? AND created > ?) RETURNING token_hash')
      .bind(tokenHash, email, nowMs, nowMs + ACCOUNT_TTL.linkMs, email, nowMs - ACCOUNT_TTL.linkCooldownMs),
  ]);
  if (!made?.results?.length) return 'cooldown';

  // The same sign-in, as a code typed on the page that asked. University
  // filters (NUS's among them) hold back mail that is only a link; a code
  // needs no click. It lives in KV and points at the link's row, so spending
  // either one spends both.
  const code = newPairCode();
  const codeKey = await signInCodeKey(email);
  const pending: PendingCode = { c: await hashToken(code), t: tokenHash, e: nowMs + ACCOUNT_TTL.linkMs };

  // From the installed web app: the link goes back there, not to the account page.
  const link = `${origin}/auth/verify?t=${token}${toApp ? '&next=app' : ''}`;
  try {
    if (!env.EMAIL || !env.EMAIL_FROM) throw new Error('email sending not configured');
    await env.KV.put(codeKey, JSON.stringify(pending), { expirationTtl: ACCOUNT_TTL.linkMs / 1000 });
    await sendLink(env, email, link, code, origin);
  } catch (err) {
    // Otherwise the unsent link holds the cooldown and the retry is told
    // "check your email" for a message that never went.
    await db.prepare('DELETE FROM magic_links WHERE token_hash = ?').bind(tokenHash).run();
    await env.KV.delete(codeKey).catch(() => {});
    throw err;
  }
  await env.KV.put(coolKey, '1', { expirationTtl: Math.max(60, ACCOUNT_TTL.linkCooldownMs / 1000) }).catch(() => {});
  return 'sent';
}

/** How long an email may take to send before it counts as failed. */
export const MAIL_TIMEOUT_MS = 10_000;

/**
 * Sends through the Email binding, failing after MAIL_TIMEOUT_MS like any
 * other failed send: one that hangs would otherwise hold a sign-in open
 * until the Worker is cut off, with its link or request never cleaned up.
 */
export async function sendMail(env: Env, msg: EmailMessageBuilder): Promise<void> {
  if (!env.EMAIL) throw new Error('email sending not configured');
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('email send timed out')), MAIL_TIMEOUT_MS);
  });
  try {
    await Promise.race([env.EMAIL.send(msg), timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Worded to look like what it is. A subject of "Sign in to ..." over a lone
 * link is the shape of a phishing mail, and filters treat it as one.
 */
async function sendLink(env: Env, email: string, link: string, code: string, origin: string): Promise<void> {
  const site = new URL(origin).host;
  const t = m();
  const why = t.codeWhyWeb(site);
  await sendMail(env, {
    from: { email: env.EMAIL_FROM!, name: mailName(env) },
    to: email,
    subject: t.codeSubject(code),
    text: `${t.codeIs(code)}

${t.codeTypeWeb}

${t.codeOrLinkText}
${link}

${why}`,
    html: `<p>${t.codeIsHtml}</p>
<p style="font-size:28px;font-weight:700;letter-spacing:4px;font-family:ui-monospace,Menlo,monospace">${code}</p>
<p>${t.codeTypeWeb}</p>
<p>${t.codeOrLinkHtml(link)}</p>
<p style="color:#666;font-size:13px">${why}</p>`,
  });
}

/** The address a live link signs in, without spending it: shown on the
 *  confirm page so nobody is signed in to someone else's account unawares. */
export async function linkEmail(db: D1Database, token: string, nowMs: number): Promise<string | null> {
  const row = await db
    .prepare('SELECT email FROM magic_links WHERE token_hash = ? AND expires >= ?')
    .bind(await hashToken(token), nowMs)
    .first<{ email: string }>();
  return row?.email ?? null;
}

/** A spent sign-in: the new web session's raw token, and the anonymous account it replaced, if any. */
export interface Redeemed {
  token: string;
  removed?: string;
}

/**
 * Spends a sign-in link and opens a web session, or returns null when the
 * link is unknown, used or expired. `anonId`: the browser's account without
 * an email, if it has one, which the email then goes to (claimEmail).
 */
export async function redeemLink(db: D1Database, token: string, nowMs: number, anonId: string | null = null): Promise<Redeemed | null> {
  return spendLink(db, await hashToken(token), nowMs, anonId);
}

async function spendLink(db: D1Database, hash: string, nowMs: number, anonId: string | null): Promise<Redeemed | null> {
  const row = await db
    .prepare('SELECT email FROM magic_links WHERE token_hash = ? AND expires >= ?')
    .bind(hash, nowMs)
    .first<{ email: string }>();
  if (!row) return null;
  // The account work, the session and spending the link are one batch: a
  // failure part way leaves the link to try again, and of two racing POSTs
  // only the one that finds it still there does anything.
  const live: Live = { sql: 'EXISTS (SELECT 1 FROM magic_links WHERE token_hash = ? AND expires >= ?)', params: [hash, nowMs] };
  const claim = await claimEmail(db, row.email, anonId, nowMs, live);
  const token = newToken();
  const tokenHash = await hashToken(token);
  const out = await db.batch([
    ...claim.statements,
    sessionFor(db, tokenHash, row.email, 'web', null, nowMs, NO_CLIENT, live),
    db.prepare('DELETE FROM magic_links WHERE token_hash = ? AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ?) RETURNING email').bind(hash, tokenHash),
  ]);
  if (!out.at(-1)?.results?.length) return null;
  return { token, ...(claim.removed ? { removed: claim.removed } : {}) };
}

/**
 * What must hold for a sign-in's statements to run: its link, code or
 * request not yet spent. Every statement of the sign-in's batch carries it,
 * and the batch's last statement spends it. D1 runs a batch as one
 * transaction, so a failure anywhere leaves it unspent to try again, and a
 * second sign-in racing it finds it false and changes nothing.
 */
export interface Live {
  sql: string;
  params: unknown[];
}

/** A statement that runs only while `live` holds. `{live}` in the SQL is
 *  replaced by the condition; nothing after it may take a parameter. */
export function whileLive(db: D1Database, sql: string, params: unknown[], live: Live): D1PreparedStatement {
  return db.prepare(sql.replace('{live}', live.sql)).bind(...params, ...live.params);
}

/** A new session for the account with this email, made only while `live` holds. Returns its user_id. */
export function sessionFor(db: D1Database, tokenHash: string, email: string, kind: 'web' | 'device', name: string | null, nowMs: number, client: Client, live: Live): D1PreparedStatement {
  return whileLive(
    db,
    `INSERT INTO sessions (token_hash, user_id, kind, name, created, last_seen, expires, platform, client)
     SELECT ?, id, ?, ?, ?, ?, ?, ?, ? FROM users WHERE email = ? AND {live} RETURNING user_id`,
    [tokenHash, kind, name, nowMs, nowMs, kind === 'web' ? nowMs + ACCOUNT_TTL.webSessionMs : null, client.platform, client.client, email],
    live,
  );
}

/** A new account for the email, unless one has it already, made only while `live` holds. */
export function userFor(db: D1Database, email: string, nowMs: number, via: 'web' | 'app', live: Live): D1PreparedStatement {
  return whileLive(
    db,
    'INSERT INTO users (id, email, created, last_seen, via) SELECT ?, ?, ?, ?, ? WHERE {live} ON CONFLICT(email) DO NOTHING',
    [crypto.randomUUID(), email, nowMs, nowMs, via],
    live,
  );
}

/** Gives an anonymous account the email; its old sessions go, replaced by the
 *  one the caller opens. Only while `live` holds, and the sessions only once
 *  the email is really its (another sign-in may have given it one first). */
export function addEmailTo(db: D1Database, anonId: string, email: string, nowMs: number, live: Live): D1PreparedStatement[] {
  return [
    whileLive(db, 'UPDATE users SET email = ?, email_added = ? WHERE id = ? AND email IS NULL AND {live}', [email, nowMs, anonId], live),
    whileLive(db, 'DELETE FROM sessions WHERE user_id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND email = ?) AND {live}', [anonId, anonId, email], live),
  ];
}

/** saveProfileJson, only while `live` holds. */
export function profileFor(db: D1Database, userId: string, profile: unknown, nowMs: number, live: Live): D1PreparedStatement {
  return whileLive(
    db,
    'INSERT INTO profiles (user_id, json, updated) SELECT ?, ?, ? WHERE {live} ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated = MAX(excluded.updated, profiles.updated + 1)',
    [userId, JSON.stringify(profile), nowMs],
    live,
  );
}

/**
 * Signing in with an email from a browser that's using terminus without
 * one. A new email goes to that account, setup and all. An email that has
 * an account already wins: the browser's setup moves to it only when it
 * has none of its own, and the browser's account goes. (The apps ask which
 * setup to keep; a browser's is a minute to redo.) Reads now; the changes
 * come back as statements for the caller's batch, guarded by `live`.
 */
export async function claimEmail(db: D1Database, email: string, anonId: string | null, nowMs: number, live: Live): Promise<{ statements: D1PreparedStatement[]; removed?: string }> {
  const existing = await db.prepare('SELECT id, email FROM users WHERE email = ?').bind(email).first<User>();
  const anon = anonId ? await db.prepare('SELECT id FROM users WHERE id = ? AND email IS NULL').bind(anonId).first<{ id: string }>() : null;
  if (!anon) return { statements: existing ? [] : [userFor(db, email, nowMs, 'web', live)] };
  if (!existing) return { statements: addEmailTo(db, anon.id, email, nowMs, live) };
  const statements: D1PreparedStatement[] = [];
  const mine = await loadProfileJson(db, anon.id);
  if (hasSetup(mine) && !hasSetup(await loadProfileJson(db, existing.id))) statements.push(profileFor(db, existing.id, mine, nowMs, live));
  statements.push(...anonymousGone(db, anon.id, existing.id, live));
  return { statements, removed: anon.id };
}

/** A profile worth keeping: somewhere to go or somewhere to start. */
export function hasSetup(json: unknown): boolean {
  const p = json as { home?: { stops?: unknown[] } | null; trips?: unknown[]; manual?: unknown[]; places?: unknown[] } | null;
  if (!p) return false;
  return Boolean(p.home?.stops?.length || p.trips?.length || p.manual?.length || p.places?.length);
}

/** Deletes an anonymous account once it's been signed in elsewhere; its reports move with it. */
export async function removeAnonymous(db: D1Database, anonId: string, intoUserId: string): Promise<void> {
  await db.batch(anonymousGone(db, anonId, intoUserId, ALWAYS));
}

const ALWAYS: Live = { sql: '1', params: [] };

/** removeAnonymous's statements, only while `live` holds. */
export function anonymousGone(db: D1Database, anonId: string, intoUserId: string, live: Live): D1PreparedStatement[] {
  return [
    whileLive(db, 'UPDATE feedback SET user_id = ? WHERE user_id = ? AND {live}', [intoUserId, anonId], live),
    whileLive(db, 'DELETE FROM users WHERE id = ? AND email IS NULL AND {live}', [anonId], live),
  ];
}

/** A sign-in code waiting in KV: hashes of the code and of its link's token,
 *  and when it expires. Wrong guesses are counted on the link's D1 row. */
interface PendingCode {
  c: string;
  t: string;
  e: number;
}

/** Emails one inbox may be sent an hour, on top of the one-a-minute cooldown. */
export const MAILS_PER_HOUR = 10;

/**
 * Takes one of the inbox's emails for this hour; false when they're spent.
 * A soft cap (KV is not atomic): it stops someone mailing a person all day,
 * a minute at a time, which the cooldown alone allows.
 */
export async function takeMailBudget(env: Env, inbox: string, nowMs: number): Promise<boolean> {
  const key = `mailhour:${await hashToken(inbox)}:${Math.floor(nowMs / 3_600_000)}`;
  const n = Number((await env.KV.get(key).catch(() => null)) ?? 0);
  if (n >= MAILS_PER_HOUR) return false;
  await env.KV.put(key, String(n + 1), { expirationTtl: 3_700 }).catch(() => {});
  return true;
}

async function signInCodeKey(email: string): Promise<string> {
  return `code:${await hashToken(email)}`;
}

/**
 * Spends an emailed sign-in code and opens a web session, or returns null.
 * A code is tied to the address it was sent to and dies after a few wrong
 * guesses, so with about 7×10⁸ possible codes guessing is hopeless. The
 * session itself comes from spending the link's D1 row, which is atomic, so
 * a code and its link together still sign in exactly once.
 */
export async function redeemCode(env: Env, db: D1Database, email: string, code: string, nowMs: number, anonId: string | null = null): Promise<Redeemed | null> {
  const key = await signInCodeKey(email);
  const pending = await env.KV.get<PendingCode>(key, 'json').catch(() => null);
  if (!pending || pending.e < nowMs) return null;
  // Spend a try on the link's row before checking, in one statement: KV's
  // read-then-write let guesses sent all at once past the limit.
  const spent = await db
    .prepare('UPDATE magic_links SET code_tries = code_tries + 1 WHERE token_hash = ? AND code_tries < ? AND expires >= ? RETURNING code_tries')
    .bind(pending.t, ACCOUNT_TTL.codeTries, nowMs)
    .first<{ code_tries: number }>();
  if (!spent) {
    await env.KV.delete(key).catch(() => {});
    return null;
  }
  if ((await hashToken(code)) !== pending.c) {
    if (spent.code_tries >= ACCOUNT_TTL.codeTries) await env.KV.delete(key).catch(() => {});
    return null;
  }
  await env.KV.delete(key).catch(() => {});
  return spendLink(db, pending.t, nowMs, anonId);
}

export async function ensureUser(db: D1Database, email: string, nowMs: number, via: 'web' | 'app' = 'web'): Promise<User> {
  await db
    .prepare('INSERT INTO users (id, email, created, last_seen, via) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING')
    .bind(crypto.randomUUID(), email, nowMs, nowMs, via)
    .run();
  return (await db.prepare('SELECT id, email FROM users WHERE email = ?').bind(email).first<User>())!;
}

export async function openSession(
  db: D1Database,
  userId: string,
  kind: 'web' | 'device',
  name: string | null,
  nowMs: number,
  client: Client = NO_CLIENT,
): Promise<string> {
  const token = newToken();
  await db
    .prepare(
      'INSERT INTO sessions (token_hash, user_id, kind, name, created, last_seen, expires, platform, client) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(await hashToken(token), userId, kind, name, nowMs, nowMs, kind === 'web' ? nowMs + ACCOUNT_TTL.webSessionMs : null, client.platform, client.client)
    .run();
  return token;
}

/**
 * Which app is calling, from its User-Agent: Android's HTTP stack says
 * Dalvik, the Mac app's says CFNetwork. Null for anything else (a browser
 * session doesn't need one). Only a fallback for apps that don't send
 * x-terminus-client: any CFNetwork client looks like the Mac here.
 */
export function platformFromAgent(ua: string | null): 'android' | 'mac' | null {
  if (!ua) return null;
  if (/Dalvik|Android/i.test(ua)) return 'android';
  if (/CFNetwork|Darwin/i.test(ua)) return 'mac';
  return null;
}

export const PLATFORMS = ['android', 'mac', 'ios'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** The app on the other end: its platform, and the header as sent, for the dashboard. */
export interface Client {
  platform: Platform | null;
  /** "android/1.4.0", "android-play/1.5.0": platform, optional flavour, version. */
  client: string | null;
}
const NO_CLIENT: Client = { platform: null, client: null };

/**
 * From `x-terminus-client: <platform>[-<flavour>]/<version>`, which the apps
 * send on every request; the User-Agent guess when it's absent (older apps).
 */
export function clientFrom(req: Request): Client {
  const raw = req.headers.get('x-terminus-client')?.trim().toLowerCase() ?? '';
  const m = /^([a-z]+)(?:-([a-z]{1,12}))?\/([0-9a-z][0-9a-z.+-]{0,19})$/.exec(raw);
  const platform = m ? PLATFORMS.find((p) => p === m[1]) : undefined;
  if (m && platform) return { platform, client: raw };
  return { platform: platformFromAgent(req.headers.get('user-agent')), client: null };
}

/** Starts an account with no email for an app's first launch; returns its device token. */
export async function createAnonymous(db: D1Database, name: string, client: Client, nowMs: number): Promise<string> {
  return openSession(db, await newAnonymousUser(db, 'app', nowMs), 'device', name, nowMs, client);
}

/** The same for a browser ("Use terminus without an email"); returns its web session token. */
export async function createAnonymousWeb(db: D1Database, nowMs: number): Promise<string> {
  return openSession(db, await newAnonymousUser(db, 'web', nowMs), 'web', null, nowMs);
}

async function newAnonymousUser(db: D1Database, via: 'app' | 'web', nowMs: number): Promise<string> {
  const id = crypto.randomUUID();
  await db.prepare('INSERT INTO users (id, email, created, last_seen, via) VALUES (?, NULL, ?, ?, ?)').bind(id, nowMs, nowMs, via).run();
  return id;
}

/* ------------------------------------------------------------------ */
/* Sessions                                                           */
/* ------------------------------------------------------------------ */

export function tokenFrom(req: Request): string | null {
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim() || null;
  return cookieToken(req);
}

function cookieToken(req: Request): string | null {
  const cookie = req.headers.get('cookie') ?? '';
  for (const part of cookie.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === SESSION_COOKIE) return v.join('=') || null;
  }
  return null;
}

/** Whether the browser sent its session cookie, whatever else the request carries. */
export function hasSessionCookie(req: Request): boolean {
  return cookieToken(req) !== null;
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
      `SELECT s.kind, s.created, s.last_seen, s.expires, s.client, u.id, u.email
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
    )
    .bind(hash)
    .first<{ kind: 'web' | 'device'; created: number; last_seen: number; expires: number | null; client: string | null; id: string; email: string | null }>();
  if (!row) return null;
  if (row.expires !== null && row.expires < nowMs) return null;
  if (row.kind === 'web' && row.email !== null && nowMs - row.created > ACCOUNT_TTL.webSessionMaxMs) return null;
  // Paired devices lapse after 90 idle days (the cron deletes them too).
  if (row.kind === 'device' && nowMs - row.last_seen > DEVICE_IDLE_MS) return null;

  const client = row.kind === 'device' ? clientFrom(req) : NO_CLIENT;
  // Also straight away when the app has updated, so the dashboard's versions are current.
  if (nowMs - row.last_seen > ACCOUNT_TTL.touchMs || (client.client !== null && client.client !== row.client)) {
    // Devices paired before sessions had a platform get one here. An explicit
    // header replaces a User-Agent guess.
    const touch = db.batch([
      db
        .prepare(
          'UPDATE sessions SET last_seen = ?, platform = CASE WHEN ? IS NOT NULL THEN ? ELSE COALESCE(platform, ?) END, client = COALESCE(?, client) WHERE token_hash = ?',
        )
        .bind(nowMs, client.client, client.platform, client.platform, client.client, hash),
      db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').bind(nowMs, row.id),
    ]);
    // Logged when it fails: the cron deletes anonymous accounts by last_seen,
    // so a touch that keeps failing would lose accounts still in use.
    if (ctx) ctx.waitUntil(touch.catch((err) => console.error('last_seen not updated:', err instanceof Error ? err.message : String(err))));
    else await touch;
  }
  return { user: { id: row.id, email: row.email }, kind: row.kind, tokenHash: hash };
}

/**
 * Slides a web session's expiry forward when it has less than a few weeks
 * left. True when it did, and the cookie should be sent again with the new
 * lifetime. An idle session still ends 30 days after its last use.
 */
export async function renewWebSession(db: D1Database, tokenHash: string, nowMs: number): Promise<boolean> {
  const r = await db
    .prepare("UPDATE sessions SET expires = ? WHERE token_hash = ? AND kind = 'web' AND expires IS NOT NULL AND expires < ?")
    .bind(nowMs + ACCOUNT_TTL.webSessionMs, tokenHash, nowMs + ACCOUNT_TTL.webRenewBelowMs)
    .run();
  return (r.meta.changes ?? 0) > 0;
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

/** The email of the account a live pairing code belongs to, without spending it. */
export async function pairCodeOwner(db: D1Database, code: string, nowMs: number): Promise<string | null> {
  const row = await db
    .prepare('SELECT u.email FROM pair_codes p JOIN users u ON u.id = p.user_id WHERE p.code = ? AND p.expires >= ?')
    .bind(code, nowMs)
    .first<{ email: string | null }>();
  return row?.email ?? null;
}

/** "j•••@gmail.com": enough to recognise your own account, not to harvest one. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
}

/** Spends a pairing code and returns a device token and the account's email, or null. */
export async function redeemPairCode(
  db: D1Database,
  code: string,
  name: string,
  nowMs: number,
  client: Client = NO_CLIENT,
): Promise<{ token: string; email: string | null } | null> {
  // The session and spending the code in one batch: a failure leaves the
  // code to try again, and of two racing redeems only the first gets a session.
  const token = newToken();
  const tokenHash = await hashToken(token);
  const [made] = await db.batch([
    db
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, kind, name, created, last_seen, expires, platform, client)
         SELECT ?, user_id, 'device', ?, ?, ?, NULL, ?, ? FROM pair_codes WHERE code = ? AND expires >= ? RETURNING user_id`,
      )
      .bind(tokenHash, name, nowMs, nowMs, client.platform, client.client, code, nowMs),
    db.prepare('DELETE FROM pair_codes WHERE code = ? AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ?)').bind(code, tokenHash),
  ]);
  const userId = (made?.results?.[0] as { user_id: string } | undefined)?.user_id;
  if (!userId) return null;
  const user = await db.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first<{ email: string | null }>();
  return { token, email: user?.email ?? null };
}

export interface DeviceRow {
  id: string;
  name: string | null;
  platform: string | null;
  created: number;
  lastSeen: number;
  /** The device asking. */
  current: boolean;
}

/** Devices are identified to the page by a prefix of the token hash, which is
 *  enough to revoke one and useless for signing in. */
export async function listDevices(db: D1Database, userId: string, currentHash: string | null = null): Promise<DeviceRow[]> {
  const { results } = await db
    .prepare(
      "SELECT substr(token_hash, 1, 16) AS id, name, platform, created, last_seen AS lastSeen FROM sessions WHERE user_id = ? AND kind = 'device' ORDER BY created",
    )
    .bind(userId)
    .all<Omit<DeviceRow, 'current'>>();
  return results.map((d) => ({ ...d, current: currentHash !== null && currentHash.startsWith(d.id) }));
}

/** Revokes one device; returns its name ('' when it had none), or null if there was no such device. */
export async function revokeDevice(db: D1Database, userId: string, id: string): Promise<string | null> {
  if (!/^[0-9a-f]{16}$/.test(id)) return null;
  const row = await db
    .prepare("DELETE FROM sessions WHERE user_id = ? AND kind = 'device' AND substr(token_hash, 1, 16) = ? RETURNING name")
    .bind(userId, id)
    .first<{ name: string | null }>();
  return row ? (row.name ?? '') : null;
}

/**
 * "terminus was added to MacBook Air": sent when a pairing code adds a
 * device. It's the one way in that doesn't pass through the inbox, and a
 * signed-in phone can make a code, so a lost phone can't add one without
 * the owner hearing. Signing in from the email needs no second email, and
 * removing a device exposes nothing.
 */
export async function mailDeviceAdded(env: Env, email: string | null, name: string, nowMs: number): Promise<void> {
  if (!email || !env.EMAIL || !env.EMAIL_FROM) return;
  const t = m();
  const device = name.trim() || t.aDevice;
  const when = t.singaporeTime(new Date(nowMs + 8 * 3_600_000).toISOString().replace('T', ' ').slice(0, 16));
  const site = siteOrigin(env);
  await sendMail(env, {
    from: { email: env.EMAIL_FROM, name: mailName(env) },
    to: email,
    subject: t.deviceAddedSubject(device),
    text: t.deviceAddedText(device, when, site),
  });
}

/* ------------------------------------------------------------------ */
/* Profile storage                                                    */
/* ------------------------------------------------------------------ */

export async function loadProfileJson(db: D1Database, userId: string): Promise<unknown | null> {
  const row = await db.prepare('SELECT json FROM profiles WHERE user_id = ?').bind(userId).first<{ json: string }>();
  return row ? JSON.parse(row.json) : null;
}

/** The saved profile and its version: `updated`, which a conditional write compares. */
export async function loadProfileRow(db: D1Database, userId: string): Promise<{ json: unknown; updated: number } | null> {
  const row = await db.prepare('SELECT json, updated FROM profiles WHERE user_id = ?').bind(userId).first<{ json: string; updated: number }>();
  return row ? { json: JSON.parse(row.json), updated: row.updated } : null;
}

/** Saves the profile whatever was there; returns its new version. Every
 *  write's version is later than the one it replaces, even within a
 *  millisecond, so a conditional write can't mistake one for another. */
export async function saveProfileJson(db: D1Database, userId: string, profile: unknown, nowMs: number): Promise<number> {
  const row = await db
    .prepare(
      'INSERT INTO profiles (user_id, json, updated) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated = MAX(excluded.updated, profiles.updated + 1) RETURNING updated',
    )
    .bind(userId, JSON.stringify(profile), nowMs)
    .first<{ updated: number }>();
  return row?.updated ?? nowMs;
}

/**
 * Saves the profile only if it is still at version `from` (null: none saved
 * yet). Returns the new version, or null when another write got there first.
 */
export async function saveProfileIf(db: D1Database, userId: string, profile: unknown, nowMs: number, from: number | null): Promise<number | null> {
  const json = JSON.stringify(profile);
  const row =
    from === null
      ? await db
          .prepare('INSERT INTO profiles (user_id, json, updated) VALUES (?, ?, ?) ON CONFLICT(user_id) DO NOTHING RETURNING updated')
          .bind(userId, json, nowMs)
          .first<{ updated: number }>()
      : await db
          .prepare('UPDATE profiles SET json = ?, updated = ? WHERE user_id = ? AND updated = ? RETURNING updated')
          .bind(json, Math.max(nowMs, from + 1), userId, from)
          .first<{ updated: number }>();
  return row?.updated ?? null;
}

/* ------------------------------------------------------------------ */
/* Account-wide actions                                               */
/* ------------------------------------------------------------------ */

/** Signs out every browser and device on the account. */
/**
 * Signs out every device, and cancels what could still turn into a new one:
 * pairing codes, unspent sign-in links (and so their codes), and app sign-ins
 * not yet collected. Otherwise a stolen device could make a pairing code just
 * before the owner signs out everywhere, and pair again after.
 */
export async function endAllSessions(db: D1Database, user: User): Promise<number> {
  const [r] = await db.batch([
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM pair_codes WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM magic_links WHERE email = ?').bind(user.email),
    db.prepare("DELETE FROM login_requests WHERE email = ? AND status IN ('pending', 'approved')").bind(user.email),
  ]);
  return r.meta?.changes ?? 0;
}

/** Deletes the account and everything hanging off it (the schema cascades). */
export async function deleteAccount(db: D1Database, user: User): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM magic_links WHERE email = ?').bind(user.email),
    db.prepare('DELETE FROM login_requests WHERE email = ? OR anon_user_id = ?').bind(user.email, user.id),
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
    .all<{ kind: string; name: string | null; created: number; lastSeen: number; expires: number | null }>();
  const { results: apiKeys } = await db
    .prepare('SELECT name, hint, created, last_used AS lastUsed FROM api_keys WHERE user_id = ? ORDER BY created')
    .bind(user.id)
    .all<{ name: string; hint: string; created: number; lastUsed: number | null }>();
  const { results: feedback } = await db
    .prepare('SELECT created, kind, note, platform, app_version AS appVersion, context, reply_to AS replyTo FROM feedback WHERE user_id = ? ORDER BY created')
    .bind(user.id)
    .all<{ created: number; kind: string; note: string; platform: string; appVersion: string | null; context: string | null; replyTo: string | null }>();
  const trips = await exportOutcomes(db, user.id);
  return {
    email: user.email,
    created: row ? new Date(row.created).toISOString() : null,
    profile,
    ...trips,
    sessions: sessions.map((r) => ({
      kind: r.kind,
      name: r.name,
      created: new Date(r.created).toISOString(),
      lastSeen: new Date(r.lastSeen).toISOString(),
      expires: r.expires ? new Date(r.expires).toISOString() : null,
    })),
    // Names and dates only: a key itself is never kept.
    apiKeys: apiKeys.map((k) => ({
      name: k.name,
      endsWith: k.hint,
      created: new Date(k.created).toISOString(),
      lastUsed: k.lastUsed ? new Date(k.lastUsed).toISOString() : null,
    })),
    feedback: feedback.map((f) => ({
      created: new Date(f.created).toISOString(),
      kind: f.kind,
      note: f.note,
      platform: f.platform,
      appVersion: f.appVersion,
      replyTo: f.replyTo,
      answer: f.context ? JSON.parse(f.context) : null,
    })),
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
  return (await checkTurnstile(env, token, ip, fetchImpl)) === 'ok';
}

/**
 * verifyTurnstile, telling a failed check ('failed', the visitor's) from
 * Turnstile itself not answering ('unavailable', worth trying again).
 */
export async function checkTurnstile(env: Env, token: unknown, ip: string | null, fetchImpl: typeof fetch = fetch): Promise<'ok' | 'failed' | 'unavailable'> {
  if (!env.TURNSTILE_SECRET) {
    // No Turnstile at all (tests, local dev) is allowed. A site key without
    // its secret is a broken rotation, and must not quietly open sign-in.
    if (env.TURNSTILE_SITE_KEY) console.error('TURNSTILE_SITE_KEY is set but TURNSTILE_SECRET is not; refusing sign-ins');
    return env.TURNSTILE_SITE_KEY ? 'failed' : 'ok';
  }
  if (typeof token !== 'string' || !token) return 'failed';
  const body = new FormData();
  body.set('secret', env.TURNSTILE_SECRET);
  body.set('response', token);
  if (ip) body.set('remoteip', ip);
  try {
    const res = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body, signal: AbortSignal.timeout(5000) });
    const out = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
    if (out.success === true) return 'ok';
    // A failed check is the visitor's; Turnstile's own fault is logged, or
    // sign-in would quietly stop for everyone with nobody knowing why.
    if (!res.ok || out['error-codes']?.includes('internal-error')) {
      console.error('Turnstile siteverify failed:', res.status, (out['error-codes'] ?? []).join(','));
      return 'unavailable';
    }
    return 'failed';
  } catch (err) {
    console.error('Turnstile siteverify failed:', err instanceof Error ? err.message : String(err));
    return 'unavailable';
  }
}
