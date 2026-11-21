import { exportOutcomes } from './outcomes.ts';
import type { Env } from '../types.ts';
import { DEVICE_IDLE_MS } from '../ops/monitor.ts';
import { mailName } from '../site/site.ts';
import { isBeta, linkOrigin } from '../origin.ts';
import { m } from '../i18n.ts';
import { TTL } from '../config.ts';
import { kvMemo } from '../memo.ts';

export const ACCOUNT_TTL = {
  linkMs: 15 * 60_000,
  linkCooldownMs: 60_000,
  webSessionMs: 30 * 86_400_000,
  webRenewBelowMs: 23 * 86_400_000,
  webSessionMaxMs: 180 * 86_400_000,
  pairCodeMs: 10 * 60_000,
  codeTries: 5,
  touchMs: 3_600_000,
  anonIdleMs: 60 * 86_400_000,
} as const;

export const SESSION_COOKIE = '__Host-tm_s';

const PAIR_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface User {
  id: string;
  email: string | null;
}

export interface SessionInfo {
  user: User;
  kind: 'web' | 'device';
  tokenHash: string;
  paired: boolean;
  profileJson?: unknown;
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

function newCode(alphabet: string): string {
  const under = 256 - (256 % alphabet.length);
  const out: string[] = [];
  while (out.length < 6) {
    for (const b of crypto.getRandomValues(new Uint8Array(12))) {
      if (b < under && out.length < 6) out.push(alphabet[b % alphabet.length]);
    }
  }
  return out.join('');
}

export function newPairCode(): string {
  return newCode(PAIR_ALPHABET);
}

export function newEmailCode(): string {
  return newCode('23456789');
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  if (e.length > 254) return null;
  return /^[a-z0-9._%+-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(e) ? e : null;
}

export function inboxKey(email: string): string {
  let [local, domain] = email.split('@');
  local = local.split('+')[0];
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replaceAll('.', '');
  return `${local}@${domain}`;
}

export function normalizePairCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const c = raw.replace(/[\s-]/g, '').toUpperCase();
  return c.length === 6 && [...c].every((ch) => PAIR_ALPHABET.includes(ch)) ? c : null;
}

export type LinkOutcome = 'sent' | 'blocked' | 'cooldown' | 'busy';

export async function takeGlobalMail(env: Env, scope: 'web' | 'app' = 'web'): Promise<boolean> {
  return !env.RL_MAIL || (await env.RL_MAIL.limit({ key: scope === 'app' ? 'mail:app' : 'mail:global' })).success;
}

export async function requestLink(
  env: Env,
  db: D1Database,
  email: string,
  origin: string,
  nowMs: number,
  toApp = false,
): Promise<LinkOutcome> {
  const inbox = inboxKey(email);
  const blocked = await db.prepare('SELECT 1 FROM blocklist WHERE email IN (?, ?)').bind(email, inbox).first();
  if (blocked) return (await takeGlobalMail(env)) ? 'blocked' : 'busy';

  const since = nowMs - ACCOUNT_TTL.linkCooldownMs;
  const recent = await db
    .prepare(
      'SELECT 1 FROM magic_links WHERE email = ? AND created > ? UNION ALL SELECT 1 FROM login_requests WHERE email = ? AND created > ?',
    )
    .bind(email, since, email, since)
    .first();
  if (recent) return 'cooldown';
  const coolKey = `mail:${await hashToken(inbox)}`;
  if (await env.KV.get(coolKey).catch(() => null)) return 'cooldown';
  if (!(await mailBudgetLeft(env, inbox, nowMs))) return 'cooldown';
  if (!(await takeGlobalMail(env))) return 'busy';
  if (!(await takeMailBudget(env, inbox, nowMs))) return 'cooldown';

  const token = newToken();
  const tokenHash = await hashToken(token);
  const [, made] = await db.batch([
    db.prepare('DELETE FROM magic_links WHERE expires < ?').bind(nowMs),
    db
      .prepare(
        'INSERT INTO magic_links (token_hash, email, created, expires) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM magic_links WHERE email = ? AND created > ?) AND NOT EXISTS (SELECT 1 FROM login_requests WHERE email = ? AND created > ?) RETURNING token_hash',
      )
      .bind(tokenHash, email, nowMs, nowMs + ACCOUNT_TTL.linkMs, email, since, email, since),
  ]);
  if (!made?.results?.length) return 'cooldown';

  const code = newEmailCode();
  const codeKey = await signInCodeKey(email);
  const pending: PendingCode = { c: await hashToken(code), t: tokenHash, e: nowMs + ACCOUNT_TTL.linkMs };

  const link = `${origin}/auth/verify?t=${token}${toApp ? '&next=app' : ''}`;
  try {
    if (!env.EMAIL || !env.EMAIL_FROM) throw new Error('email sending not configured');
    await env.KV.put(codeKey, JSON.stringify(pending), { expirationTtl: ACCOUNT_TTL.linkMs / 1000 });
    await sendLink(env, email, link, code, origin);
  } catch (err) {
    await db.prepare('DELETE FROM magic_links WHERE token_hash = ?').bind(tokenHash).run();
    await env.KV.delete(codeKey).catch(() => {});
    throw err;
  }
  await env.KV.put(coolKey, '1', { expirationTtl: Math.max(60, ACCOUNT_TTL.linkCooldownMs / 1000) }).catch(() => {});
  return 'sent';
}

export const mail = () => import('../site/mail.ts');

export const MAIL_TIMEOUT_MS = 20_000;

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
    html: await (await mail()).signInHtml({ origin: linkOrigin(env), beta: isBeta(env), code, link, why }),
  });
}

export async function linkEmail(db: D1Database, token: string, nowMs: number): Promise<string | null> {
  const row = await db
    .prepare('SELECT email FROM magic_links WHERE token_hash = ? AND expires >= ?')
    .bind(await hashToken(token), nowMs)
    .first<{ email: string }>();
  return row?.email ?? null;
}

export interface Redeemed {
  token: string;
  removed?: string;
}

export async function redeemLink(db: D1Database, token: string, nowMs: number, anonId: string | null = null): Promise<Redeemed | null> {
  return spendLink(db, await hashToken(token), nowMs, anonId);
}

async function spendLink(db: D1Database, hash: string, nowMs: number, anonId: string | null): Promise<Redeemed | null> {
  const row = await db
    .prepare('SELECT email FROM magic_links WHERE token_hash = ? AND expires >= ?')
    .bind(hash, nowMs)
    .first<{ email: string }>();
  if (!row) return null;
  const live: Live = { sql: 'EXISTS (SELECT 1 FROM magic_links WHERE token_hash = ? AND expires >= ?)', params: [hash, nowMs] };
  const claim = await claimEmail(db, row.email, anonId, nowMs, live);
  const token = newToken();
  const tokenHash = await hashToken(token);
  const out = await db.batch([
    ...claim.statements,
    sessionFor(db, tokenHash, row.email, 'web', null, nowMs, NO_CLIENT, live),
    db
      .prepare('DELETE FROM magic_links WHERE token_hash = ? AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ?) RETURNING email')
      .bind(hash, tokenHash),
  ]);
  if (!out.at(-1)?.results?.length) return null;
  return { token, ...(claim.removed ? { removed: claim.removed } : {}) };
}

export interface Live {
  sql: string;
  params: unknown[];
}

export function whileLive(db: D1Database, sql: string, params: unknown[], live: Live): D1PreparedStatement {
  return db.prepare(sql.replace('{live}', live.sql)).bind(...params, ...live.params);
}

export function sessionFor(
  db: D1Database,
  tokenHash: string,
  email: string,
  kind: 'web' | 'device',
  name: string | null,
  nowMs: number,
  client: Client,
  live: Live,
): D1PreparedStatement {
  return whileLive(
    db,
    `INSERT INTO sessions (token_hash, user_id, kind, name, created, last_seen, expires, platform, client)
     SELECT ?, id, ?, ?, ?, ?, ?, ?, ? FROM users WHERE email = ? AND {live} RETURNING user_id`,
    [tokenHash, kind, name, nowMs, nowMs, kind === 'web' ? nowMs + ACCOUNT_TTL.webSessionMs : null, client.platform, client.client, email],
    live,
  );
}

export function userFor(db: D1Database, email: string, nowMs: number, via: 'web' | 'app', live: Live): D1PreparedStatement {
  return whileLive(
    db,
    'INSERT INTO users (id, email, created, last_seen, via) SELECT ?, ?, ?, ?, ? WHERE {live} ON CONFLICT(email) DO NOTHING',
    [crypto.randomUUID(), email, nowMs, nowMs, via],
    live,
  );
}

export function addEmailTo(db: D1Database, anonId: string, email: string, nowMs: number, live: Live): D1PreparedStatement[] {
  return [
    whileLive(db, 'UPDATE users SET email = ?, email_added = ? WHERE id = ? AND email IS NULL AND {live}', [email, nowMs, anonId], live),
    whileLive(
      db,
      'DELETE FROM sessions WHERE user_id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND email = ?) AND {live}',
      [anonId, anonId, email],
      live,
    ),
  ];
}

export function profileFor(db: D1Database, userId: string, profile: unknown, nowMs: number, live: Live): D1PreparedStatement {
  return whileLive(
    db,
    'INSERT INTO profiles (user_id, json, updated) SELECT ?, ?, ? WHERE {live} ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated = MAX(excluded.updated, profiles.updated + 1)',
    [userId, JSON.stringify(profile), nowMs],
    live,
  );
}

export async function claimEmail(
  db: D1Database,
  email: string,
  anonId: string | null,
  nowMs: number,
  live: Live,
): Promise<{ statements: D1PreparedStatement[]; removed?: string }> {
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

export function hasSetup(json: unknown): boolean {
  const p = json as { home?: { stops?: unknown[] } | null; trips?: unknown[]; manual?: unknown[]; places?: unknown[] } | null;
  if (!p) return false;
  return Boolean(p.home?.stops?.length || p.trips?.length || p.manual?.length || p.places?.length);
}

export async function removeAnonymous(
  db: D1Database,
  anonId: string,
  intoUserId: string,
  first: D1PreparedStatement[] = [],
): Promise<void> {
  await db.batch([...first, ...anonymousGone(db, anonId, intoUserId, ALWAYS)]);
}

const ALWAYS: Live = { sql: '1', params: [] };

export function anonymousGone(db: D1Database, anonId: string, intoUserId: string, live: Live): D1PreparedStatement[] {
  return [
    whileLive(db, 'UPDATE feedback SET user_id = ? WHERE user_id = ? AND {live}', [intoUserId, anonId], live),
    whileLive(db, 'DELETE FROM users WHERE id = ? AND email IS NULL AND {live}', [anonId], live),
  ];
}

interface PendingCode {
  c: string;
  t: string;
  e: number;
}

export const MAILS_PER_HOUR = 10;

export async function takeMailBudget(env: Env, inbox: string, nowMs: number): Promise<boolean> {
  const key = await mailHourKey(inbox, nowMs);
  const n = Number((await env.KV.get(key).catch(() => null)) ?? 0);
  if (n >= MAILS_PER_HOUR) return false;
  await env.KV.put(key, String(n + 1), { expirationTtl: 3_700 }).catch(() => {});
  return true;
}

export async function mailBudgetLeft(env: Env, inbox: string, nowMs: number): Promise<boolean> {
  return Number((await env.KV.get(await mailHourKey(inbox, nowMs)).catch(() => null)) ?? 0) < MAILS_PER_HOUR;
}

const mailHourKey = async (inbox: string, nowMs: number) => `mailhour:${await hashToken(inbox)}:${Math.floor(nowMs / 3_600_000)}`;

export const WRONG_CODES_PER_DAY = 20;

const wrongCodesKey = async (email: string, nowMs: number) => `wrongcodes:${await hashToken(email)}:${Math.floor(nowMs / 86_400_000)}`;

export async function codesLeft(env: Env, email: string, nowMs: number): Promise<boolean> {
  return Number((await env.KV.get(await wrongCodesKey(email, nowMs)).catch(() => null)) ?? 0) < WRONG_CODES_PER_DAY;
}

export async function countWrongCode(env: Env, email: string, nowMs: number): Promise<void> {
  const key = await wrongCodesKey(email, nowMs);
  const n = Number((await env.KV.get(key).catch(() => null)) ?? 0);
  await env.KV.put(key, String(n + 1), { expirationTtl: 2 * 86_400 }).catch(() => {});
}

async function signInCodeKey(email: string): Promise<string> {
  return `code:${await hashToken(email)}`;
}

export async function redeemCode(
  env: Env,
  db: D1Database,
  email: string,
  code: string,
  nowMs: number,
  anonId: string | null = null,
): Promise<Redeemed | 'locked' | null> {
  const key = await signInCodeKey(email);
  const pending = await env.KV.get<PendingCode>(key, 'json').catch(() => null);
  if (!pending || pending.e < nowMs) return null;
  if (!(await codesLeft(env, email, nowMs))) return 'locked';
  const spent = await db
    .prepare(
      'UPDATE magic_links SET code_tries = code_tries + 1 WHERE token_hash = ? AND code_tries < ? AND expires >= ? RETURNING code_tries',
    )
    .bind(pending.t, ACCOUNT_TTL.codeTries, nowMs)
    .first<{ code_tries: number }>();
  if (!spent) {
    await env.KV.delete(key).catch(() => {});
    return null;
  }
  if ((await hashToken(code)) !== pending.c) {
    await countWrongCode(env, email, nowMs);
    if (spent.code_tries >= ACCOUNT_TTL.codeTries) await env.KV.delete(key).catch(() => {});
    return null;
  }
  const redeemed = await spendLink(db, pending.t, nowMs, anonId);
  await env.KV.delete(key).catch(() => {});
  return redeemed;
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
    .bind(
      await hashToken(token),
      userId,
      kind,
      name || null,
      nowMs,
      nowMs,
      kind === 'web' ? nowMs + ACCOUNT_TTL.webSessionMs : null,
      client.platform,
      client.client,
    )
    .run();
  return token;
}

export function platformFromAgent(ua: string | null): 'android' | 'mac' | null {
  if (!ua) return null;
  if (/Dalvik|Android/i.test(ua)) return 'android';
  if (/CFNetwork|Darwin/i.test(ua)) return 'mac';
  return null;
}

export const PLATFORMS = ['android', 'mac', 'ios'] as const;
export type Platform = (typeof PLATFORMS)[number];

export interface Client {
  platform: Platform | null;
  client: string | null;
}
const NO_CLIENT: Client = { platform: null, client: null };

export function clientFrom(req: Request): Client {
  const raw = req.headers.get('x-terminus-client')?.trim().toLowerCase() ?? '';
  const m = /^([a-z]+)(?:-([a-z]{1,12}))?\/([0-9a-z][0-9a-z.+-]{0,19})$/.exec(raw);
  const platform = m ? PLATFORMS.find((p) => p === m[1]) : undefined;
  if (m && platform) return { platform, client: raw };
  return { platform: platformFromAgent(req.headers.get('user-agent')), client: null };
}

export const KV_MIN_CLIENT = 'config:minClient';
export const UPDATE_REQUIRED = { error: 'Update terminus to keep using it.', update: true } as const;

function versionParts(v: string): { core: number[]; pre: number[] | null } | null {
  const m = /^(\d+(?:\.\d+)*)(-[a-z]*\.?(\d+(?:\.\d+)*)?)?(?:\+.*)?$/.exec(v.trim().toLowerCase());
  if (!m) return null;
  const pre = m[2] ? (m[3] ?? '0').split('.').map(Number) : null;
  return { core: m[1].split('.').map(Number), pre };
}

function compareNums(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

export function versionBelow(version: string, min: string): boolean {
  const v = versionParts(version);
  const lo = versionParts(min);
  if (!v || !lo) return false;
  const core = compareNums(v.core, lo.core);
  if (core !== 0) return core < 0;
  if (v.pre && !lo.pre) return true;
  if (!v.pre || !lo.pre) return false;
  return compareNums(v.pre, lo.pre) < 0;
}

const minClients = kvMemo(TTL.versionMemoMs, async (env: Env): Promise<Record<string, string>> => {
  let value: Record<string, string> = {};
  try {
    const parsed: unknown = await env.KV.get(KV_MIN_CLIENT, 'json');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      value = Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'));
    }
  } catch (err) {
    console.error(`ignoring ${KV_MIN_CLIENT}:`, err instanceof Error ? err.message : String(err));
  }
  return value;
});

export async function clientOutdated(env: Env, req: Request, nowMs: number): Promise<boolean> {
  const { platform, client } = clientFrom(req);
  if (!platform || !client) return false;
  const min = (await minClients.get(env, nowMs))[platform];
  return min !== undefined && versionBelow(client.slice(client.indexOf('/') + 1), min);
}

export async function createAnonymous(db: D1Database, name: string, client: Client, nowMs: number): Promise<string> {
  return openSession(db, await newAnonymousUser(db, 'app', nowMs), 'device', name, nowMs, client);
}

export async function createAnonymousWeb(db: D1Database, nowMs: number): Promise<string> {
  return openSession(db, await newAnonymousUser(db, 'web', nowMs), 'web', null, nowMs);
}

async function newAnonymousUser(db: D1Database, via: 'app' | 'web', nowMs: number): Promise<string> {
  const id = crypto.randomUUID();
  await db.prepare('INSERT INTO users (id, email, created, last_seen, via) VALUES (?, NULL, ?, ?, ?)').bind(id, nowMs, nowMs, via).run();
  return id;
}

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

export function hasSessionCookie(req: Request): boolean {
  return cookieToken(req) !== null;
}

export async function authenticate(
  db: D1Database,
  req: Request,
  nowMs: number,
  ctx?: ExecutionContext,
  withProfile = false,
): Promise<SessionInfo | null> {
  const token = tokenFrom(req);
  if (!token) return null;
  const hash = await hashToken(token);
  const row = await db
    .prepare(
      withProfile
        ? `SELECT s.kind, s.created, s.last_seen, s.expires, s.client, u.id, u.email, s.paired, p.json AS profile
             FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN profiles p ON p.user_id = u.id
            WHERE s.token_hash = ?`
        : `SELECT s.kind, s.created, s.last_seen, s.expires, s.client, u.id, u.email, s.paired
             FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ?`,
    )
    .bind(hash)
    .first<{
      kind: 'web' | 'device';
      created: number;
      last_seen: number;
      expires: number | null;
      client: string | null;
      id: string;
      email: string | null;
      paired: number;
      profile?: string | null;
    }>();
  if (!row) return null;
  if (row.expires !== null && row.expires < nowMs) return null;
  if (row.kind === 'web' && row.email !== null && nowMs - row.created > ACCOUNT_TTL.webSessionMaxMs) return null;
  if (row.kind === 'device' && nowMs - row.last_seen > DEVICE_IDLE_MS) return null;

  const client = row.kind === 'device' ? clientFrom(req) : NO_CLIENT;
  if (nowMs - row.last_seen > ACCOUNT_TTL.touchMs || (client.client !== null && client.client !== row.client)) {
    const touch = db.batch([
      db
        .prepare(
          'UPDATE sessions SET last_seen = ?, platform = CASE WHEN ? IS NOT NULL THEN ? ELSE COALESCE(platform, ?) END, client = COALESCE(?, client) WHERE token_hash = ?',
        )
        .bind(nowMs, client.client, client.platform, client.platform, client.client, hash),
      db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').bind(nowMs, row.id),
    ]);
    if (ctx) ctx.waitUntil(touch.catch((err) => console.error('last_seen not updated:', err instanceof Error ? err.message : String(err))));
    else await touch;
  }
  const paired = row.email === null && row.paired === 1;
  const session: SessionInfo = { user: { id: row.id, email: row.email }, kind: row.kind, tokenHash: hash, paired };
  if (withProfile) session.profileJson = row.profile ? JSON.parse(row.profile) : null;
  return session;
}

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
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeS}`;
}

export async function createPairCode(db: D1Database, userId: string, nowMs: number): Promise<{ code: string; expires: number }> {
  const code = newPairCode();
  const expires = nowMs + ACCOUNT_TTL.pairCodeMs;
  await db.batch([
    db.prepare('DELETE FROM pair_codes WHERE user_id = ? OR expires < ?').bind(userId, nowMs),
    db.prepare('INSERT INTO pair_codes (code, user_id, expires) VALUES (?, ?, ?)').bind(code, userId, expires),
  ]);
  return { code, expires };
}

export function isWatch(client: Pick<Client, 'client'>): boolean {
  return client.client?.startsWith('ios-watch/') ?? false;
}

export async function pairCodeOwner(db: D1Database, code: string, nowMs: number, client: Client): Promise<{ email: string | null } | null> {
  const row = await db
    .prepare(
      'SELECT u.email FROM pair_codes p JOIN users u ON u.id = p.user_id WHERE p.code = ? AND p.expires >= ? AND (u.email IS NOT NULL OR ?)',
    )
    .bind(code, nowMs, isWatch(client) ? 1 : 0)
    .first<{ email: string | null }>();
  return row ? { email: row.email } : null;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
}

export async function redeemPairCode(
  db: D1Database,
  code: string,
  name: string,
  nowMs: number,
  client: Client = NO_CLIENT,
): Promise<{ token: string; email: string | null } | null> {
  const token = newToken();
  const tokenHash = await hashToken(token);
  const [made] = await db.batch([
    db
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, kind, name, created, last_seen, expires, platform, client, paired)
         SELECT ?, p.user_id, 'device', ?, ?, ?, NULL, ?, ?, 1 FROM pair_codes p JOIN users u ON u.id = p.user_id
          WHERE p.code = ? AND p.expires >= ? AND (u.email IS NOT NULL OR ?) RETURNING user_id`,
      )
      .bind(tokenHash, name, nowMs, nowMs, client.platform, client.client, code, nowMs, isWatch(client) ? 1 : 0),
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
  watch: boolean;
  created: number;
  lastSeen: number;
  current: boolean;
}

export async function listDevices(db: D1Database, userId: string, currentHash: string | null = null): Promise<DeviceRow[]> {
  const { results } = await db
    .prepare(
      "SELECT substr(token_hash, 1, 16) AS id, name, platform, client, created, last_seen AS lastSeen FROM sessions WHERE user_id = ? AND kind = 'device' ORDER BY created",
    )
    .bind(userId)
    .all<Omit<DeviceRow, 'current' | 'watch'> & { client: string | null }>();
  return results.map((d) => ({
    id: d.id,
    name: d.name,
    platform: d.platform,
    watch: isWatch(d),
    created: d.created,
    lastSeen: d.lastSeen,
    current: currentHash !== null && currentHash.startsWith(d.id),
  }));
}

export async function revokeDevice(db: D1Database, userId: string, id: string): Promise<string | null> {
  if (!/^[0-9a-f]{16}$/.test(id)) return null;
  const row = await db
    .prepare("DELETE FROM sessions WHERE user_id = ? AND kind = 'device' AND substr(token_hash, 1, 16) = ? RETURNING name")
    .bind(userId, id)
    .first<{ name: string | null }>();
  return row ? (row.name ?? '') : null;
}

export async function mailDeviceAdded(env: Env, email: string | null, name: string, nowMs: number): Promise<void> {
  if (!email || !env.EMAIL || !env.EMAIL_FROM) return;
  const t = m();
  const device = name.trim() || t.aDevice;
  const when = t.singaporeTime(new Date(nowMs + 8 * 3_600_000).toISOString().replace('T', ' ').slice(0, 16));
  const site = linkOrigin(env);
  await sendMail(env, {
    from: { email: env.EMAIL_FROM, name: mailName(env) },
    to: email,
    subject: t.deviceAddedSubject(device),
    text: t.deviceAddedText(device, when, site),
    html: await (await mail()).deviceAddedHtml({ origin: site, beta: isBeta(env), device, when, site }),
  });
}

export async function loadProfileJson(db: D1Database, userId: string): Promise<unknown | null> {
  const row = await db.prepare('SELECT json FROM profiles WHERE user_id = ?').bind(userId).first<{ json: string }>();
  return row ? JSON.parse(row.json) : null;
}

export async function loadProfileRow(db: D1Database, userId: string): Promise<{ json: unknown; updated: number } | null> {
  const row = await db
    .prepare('SELECT json, updated FROM profiles WHERE user_id = ?')
    .bind(userId)
    .first<{ json: string; updated: number }>();
  return row ? { json: JSON.parse(row.json), updated: row.updated } : null;
}

export async function saveProfileJson(db: D1Database, userId: string, profile: unknown, nowMs: number): Promise<number> {
  const row = await profileUpsert(db, userId, profile, nowMs).first<{ updated: number }>();
  return row?.updated ?? nowMs;
}

export function profileUpsert(db: D1Database, userId: string, profile: unknown, nowMs: number): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO profiles (user_id, json, updated) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated = MAX(excluded.updated, profiles.updated + 1) RETURNING updated',
    )
    .bind(userId, JSON.stringify(profile), nowMs);
}

export async function saveProfileIf(
  db: D1Database,
  userId: string,
  profile: unknown,
  nowMs: number,
  from: number | null,
): Promise<number | null> {
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

export async function endAllSessions(db: D1Database, user: User): Promise<number> {
  const [r] = await db.batch([
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM pair_codes WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM magic_links WHERE email = ?').bind(user.email),
    db.prepare("DELETE FROM login_requests WHERE email = ? AND status IN ('pending', 'approved')").bind(user.email),
  ]);
  return r.meta?.changes ?? 0;
}

export async function forgetSignInCode(env: Env, email: string): Promise<void> {
  await env.KV.delete(await signInCodeKey(email)).catch(() => {});
}

export async function deleteAccount(db: D1Database, user: User): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM magic_links WHERE email = ?').bind(user.email),
    db.prepare('DELETE FROM login_requests WHERE email = ? OR anon_user_id = ?').bind(user.email, user.id),
    db.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
  ]);
}

function pushOf(token: string | null): { service: 'firebase' | 'web' | 'apple'; address: unknown } | null {
  if (!token) return null;
  if (/^apns(la|start)?:/.test(token)) return { service: 'apple', address: token };
  if (!token.startsWith('web:')) return { service: 'firebase', address: token };
  try {
    return { service: 'web', address: JSON.parse(token.slice(4)) };
  } catch {
    return { service: 'web', address: token.slice(4) };
  }
}

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

export async function exportAccount(db: D1Database, user: User, today: unknown = null): Promise<Record<string, unknown>> {
  const row = await db
    .prepare('SELECT created, last_seen AS lastSeen, via, email_added AS emailAdded, ask_from AS askFrom FROM users WHERE id = ?')
    .bind(user.id)
    .first<{ created: number; lastSeen: number; via: string; emailAdded: number | null; askFrom: number | null }>();
  const profile = await loadProfileJson(db, user.id);
  const { results: sessions } = await db
    .prepare(
      'SELECT kind, name, platform, client, push_token AS push, live_token AS live, start_token AS liveStart, push_lang AS pushLang, push_alerts AS pushAlerts, push_h12 AS pushH12, created, last_seen AS lastSeen, expires FROM sessions WHERE user_id = ? ORDER BY created',
    )
    .bind(user.id)
    .all<{
      kind: string;
      name: string | null;
      platform: string | null;
      client: string | null;
      push: string | null;
      live: string | null;
      liveStart: string | null;
      pushLang: string | null;
      pushAlerts: number | null;
      pushH12: number | null;
      created: number;
      lastSeen: number;
      expires: number | null;
    }>();
  const { results: requests } = await db
    .prepare(
      'SELECT device_name AS device, platform, status, created, expires FROM login_requests WHERE email = ? OR anon_user_id = ? ORDER BY created',
    )
    .bind(user.email, user.id)
    .all<{ device: string; platform: string | null; status: string; created: number; expires: number }>();
  const { results: apiKeys } = await db
    .prepare('SELECT name, hint, created, last_used AS lastUsed FROM api_keys WHERE user_id = ? ORDER BY created')
    .bind(user.id)
    .all<{ name: string; hint: string; created: number; lastUsed: number | null }>();
  const { results: feedback } = await db
    .prepare(
      'SELECT created, kind, reason, note, platform, app_version AS appVersion, context, reply_to AS replyTo FROM feedback WHERE user_id = ? ORDER BY created',
    )
    .bind(user.id)
    .all<{
      created: number;
      kind: string;
      reason: string | null;
      note: string;
      platform: string;
      appVersion: string | null;
      context: string | null;
      replyTo: string | null;
    }>();
  const trips = await exportOutcomes(db, user.id);
  return {
    email: user.email,
    created: iso(row?.created),
    lastSeen: iso(row?.lastSeen),
    startedIn: row?.via ?? null,
    emailAdded: iso(row?.emailAdded),
    askFrom: iso(row?.askFrom),
    profile,
    ...trips,
    today,
    sessions: sessions.map((r) => ({
      kind: r.kind,
      name: r.name,
      platform: r.platform,
      app: r.client,
      push: pushOf(r.push),
      liveActivityPush: pushOf(r.live),
      liveActivityStartPush: pushOf(r.liveStart),
      pushLanguage: r.pushLang,
      pushAlerts: r.pushAlerts === null ? null : r.pushAlerts !== 0,
      pushClock: r.pushH12 === null ? null : r.pushH12 !== 0 ? '12' : '24',
      created: new Date(r.created).toISOString(),
      lastSeen: new Date(r.lastSeen).toISOString(),
      expires: iso(r.expires),
    })),
    signInRequests: requests.map((r) => ({
      device: r.device,
      platform: r.platform,
      status: r.status,
      created: iso(r.created),
      expires: iso(r.expires),
    })),
    apiKeys: apiKeys.map((k) => ({
      name: k.name,
      endsWith: k.hint,
      created: new Date(k.created).toISOString(),
      lastUsed: k.lastUsed ? new Date(k.lastUsed).toISOString() : null,
    })),
    feedback: feedback.map((f) => ({
      created: new Date(f.created).toISOString(),
      kind: f.kind,
      reason: f.reason,
      note: f.note,
      platform: f.platform,
      appVersion: f.appVersion,
      replyTo: f.replyTo,
      answer: f.context ? JSON.parse(f.context) : null,
    })),
  };
}

export async function verifyTurnstile(env: Env, token: unknown, ip: string | null, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  return (await checkTurnstile(env, token, ip, fetchImpl)) === 'ok';
}

export const TURNSTILE_ACTION = 'signin';

export async function checkTurnstile(
  env: Env,
  token: unknown,
  ip: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<'ok' | 'failed' | 'unavailable'> {
  if (!env.TURNSTILE_SECRET) {
    if (env.TURNSTILE_SITE_KEY) console.error('TURNSTILE_SITE_KEY is set but TURNSTILE_SECRET is not; refusing sign-ins');
    return env.TURNSTILE_SITE_KEY ? 'failed' : 'ok';
  }
  const hostnames = turnstileHostnames(env);
  if (!hostnames.size) {
    console.error('TURNSTILE_SECRET is set but TURNSTILE_HOSTNAMES is not; refusing sign-ins');
    return 'failed';
  }
  if (typeof token !== 'string' || !token || token.length > 2048) return 'failed';
  const body = new FormData();
  body.set('secret', env.TURNSTILE_SECRET);
  body.set('response', token);
  if (ip) body.set('remoteip', ip);
  try {
    const res = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(5000),
    });
    const out = (await res.json()) as { success?: boolean; action?: string; hostname?: string; 'error-codes'?: string[] };
    if (out.success === true) return out.action === TURNSTILE_ACTION && hostnames.has(out.hostname ?? '') ? 'ok' : 'failed';
    const codes = out['error-codes'] ?? [];
    if (!res.ok || codes.some((c) => c === 'internal-error' || c.endsWith('-input-secret'))) {
      console.error('Turnstile siteverify failed:', res.status, codes.join(','));
      return 'unavailable';
    }
    return 'failed';
  } catch (err) {
    console.error('Turnstile siteverify failed:', err instanceof Error ? err.message : String(err));
    return 'unavailable';
  }
}

function turnstileHostnames(env: Env): Set<string> {
  return new Set(
    (env.TURNSTILE_HOSTNAMES ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}
