import type { Env } from '../types.ts';
import { TTL } from '../config.ts';
import { timedFetch } from '../http.ts';
import { cacheBase, flag, flagged } from './edgecache.ts';

const KV_TOKEN = 'auth:session';
const KV_DEVICE = 'auth:deviceid';
export const KV_APP_VERSION = 'config:appVersion';
const VERSION_FORMAT = /^univus_android_\d+(?:\.\d+)+_\d+$/;

const DEFAULT_AUTH_PATH = '/get-access-token';

const PLACEHOLDER_IP = '127.0.0.1';

export interface Session {
  token: string;
  userid: string;
  domain: string;
  expMs: number;
  version?: string;
}

const memos = new WeakMap<object, Session>();
const versionMemos = new WeakMap<object, { value: string; atMs: number }>();
const inflight = new Map<string, Promise<Session>>();

export async function appVersion(env: Env, nowMs: number = Date.now()): Promise<string> {
  const memo = versionMemos.get(env.KV);
  if (memo && nowMs - memo.atMs < TTL.versionMemoMs) return memo.value;
  const stored = (await env.KV.get(KV_APP_VERSION).catch(() => null))?.trim();
  if (stored && !VERSION_FORMAT.test(stored)) console.error(`ignoring ${KV_APP_VERSION}: not univus_android_<versionName>_<versionCode>`);
  const value = chosenVersion(env, stored);
  versionMemos.set(env.KV, { value, atMs: nowMs });
  return value;
}

function chosenVersion(env: Env, stored: string | null | undefined): string {
  return stored && VERSION_FORMAT.test(stored) ? stored : (env.NEXTBUS_APP_VERSION ?? '');
}

export async function markIfOutdated(env: Env, err: unknown): Promise<void> {
  if (!(err instanceof UpstreamRejected) || err.code !== '10009' || err.version === undefined || err.outdated) return;
  let stored: string | null;
  try {
    stored = await env.KV.get(KV_APP_VERSION);
  } catch {
    return;
  }
  if (chosenVersion(env, stored?.trim()) === err.version) return;
  err.outdated = true;
  forgetAppVersion(env);
}

export function authConfigured(env: Env): boolean {
  return Boolean(env.NEXTBUS_AUTH_BASE && env.NEXTBUS_HTD_API && env.NEXTBUS_APP_API);
}

export function authUrl(env: Env): string {
  const base = (env.NEXTBUS_AUTH_BASE ?? '').replace(/\/+$/, '');
  return base.endsWith(DEFAULT_AUTH_PATH) ? base : base + DEFAULT_AUTH_PATH;
}

export function apiKeyHeaders(env: Env): Record<string, string> {
  const h: Record<string, string> = {
    'X-HTD-API': env.NEXTBUS_HTD_API ?? '',
    'X-APP-API': env.NEXTBUS_APP_API ?? '',
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (env.NEXTBUS_REQUESTED_BY) h['X-Requested-By'] = env.NEXTBUS_REQUESTED_BY;
  if (env.NEXTBUS_SECURED_REQUEST) h['X-Secured-Request'] = env.NEXTBUS_SECURED_REQUEST;
  return h;
}

export function jwtExpMs(token: string): number | null {
  return timeMs(jwtClaims(token)?.exp);
}

export function jwtLifeMs(token: string): number | null {
  const claims = jwtClaims(token);
  const exp = timeMs(claims?.exp);
  const iat = timeMs(claims?.iat);
  return exp !== null && iat !== null && exp > iat ? exp - iat : null;
}

function jwtClaims(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const pad = part.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(pad + '='.repeat((4 - (pad.length % 4)) % 4))) as unknown;
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const timeMs = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value * 1000 : null);

export function extractSession(body: unknown, nowMs: number): Session | null {
  const root = body as Record<string, unknown> | null;
  const data = (root?.data ?? root) as Record<string, unknown> | undefined;
  const token = data?.token ?? data?.access_token ?? data?.accessToken;
  if (typeof token !== 'string' || token.length < 16) return null;

  const expMs = jwtExpMs(token) ?? nowMs + TTL.tokenDefaultS * 1000;
  return {
    token,
    userid: typeof data?.userid === 'string' ? data.userid : '',
    domain: typeof data?.domain === 'string' ? data.domain : 'PUBLIC',
    expMs: expMs - TTL.tokenSkewS * 1000,
  };
}

const deviceIds = new WeakMap<object, string>();

export async function deviceId(env: Env): Promise<string> {
  if (env.NEXTBUS_DEVICE_ID) return env.NEXTBUS_DEVICE_ID;
  const known = deviceIds.get(env.KV);
  if (known) return known;
  const stored = await env.KV.get(KV_DEVICE);
  if (stored) {
    deviceIds.set(env.KV, stored);
    return stored;
  }
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.KV.put(KV_DEVICE, id).catch(() => {});
  return id;
}

export function forgetAppVersion(env: Env): void {
  versionMemos.delete(env.KV);
}

export function mintWith(env: Env, version: string, nowMs: number = Date.now()): Promise<Session> {
  return mint(env, nowMs, version);
}

export async function getSession(
  env: Env,
  nowMs: number = Date.now(),
  { force = false, onMint }: { force?: boolean; onMint?: () => void } = {},
): Promise<Session> {
  if (!authConfigured(env)) throw new Error('auth not configured');
  const version = await appVersion(env, nowMs);
  const memo = memos.get(env.KV);
  if (!force && memo && memo.expMs > nowMs && memo.version === version) return memo;

  if (!force) {
    const cached = (await env.KV.get(KV_TOKEN, 'json').catch(() => null)) as Session | null;
    if (cached && cached.expMs > nowMs && cached.version === version) {
      memos.set(env.KV, cached);
      return cached;
    }
  }

  let minting = inflight.get(version);
  if (!minting) {
    minting = (async () => {
      if (await flagged(mintFailedKey())) throw new MintQuiet('token mint failed a moment ago');
      onMint?.();
      return mint(env, nowMs, version).catch(async (err) => {
        await markIfOutdated(env, err);
        if (!(err instanceof UpstreamRejected && err.outdated))
          await flag(mintFailedKey(), String((err as Error)?.message ?? err), TTL.failMemoS);
        throw err;
      });
    })().finally(() => {
      inflight.delete(version);
    });
    inflight.set(version, minting);
  }
  return minting;
}

const KV_RENEWED = 'auth:renewed';
const RENEW_GAP_S = 12 * 3_600;
const KV_RENEW_REFUSED = 'auth:renewRefused';

export const NO_REMINT_CODES = new Set(['10009', '10000']);

export async function renewAhead(env: Env, nowMs: number): Promise<boolean> {
  if (!authConfigured(env)) return false;
  let kept: Session | null;
  let renewed: string | null;
  try {
    [kept, renewed] = await Promise.all([env.KV.get(KV_TOKEN, 'json') as Promise<Session | null>, env.KV.get(KV_RENEWED)]);
  } catch {
    return false;
  }
  if (!kept) return false;
  const leftMs = kept.expMs - nowMs;
  const aheadMs = (jwtLifeMs(kept.token) ?? TTL.tokenDefaultS * 1000) * TTL.tokenRenewShare;
  if (renewed || leftMs <= 0 || leftMs > aheadMs || kept.version !== (await appVersion(env, nowMs))) return false;
  const keptId = String(kept.expMs);
  if ((await env.KV.get(KV_RENEW_REFUSED).catch(() => keptId)) === keptId) return false;
  const fresh = await getSession(env, nowMs, { force: true }).catch(async (err) => {
    if (err instanceof UpstreamRejected && NO_REMINT_CODES.has(err.code) && !err.outdated)
      await env.KV.put(KV_RENEW_REFUSED, keptId, { expirationTtl: Math.max(60, Math.ceil(leftMs / 1000)) }).catch(() => {});
    throw err;
  });
  const saved = (await env.KV.get(KV_TOKEN, 'json').catch(() => null)) as Session | null;
  if (saved?.token === fresh.token) await env.KV.put(KV_RENEWED, String(nowMs), { expirationTtl: RENEW_GAP_S }).catch(() => {});
  return true;
}

export class MintQuiet extends Error {}

const mintFailedKey = () => `${cacheBase()}/mint-failed`;
const remintedKey = () => `${cacheBase()}/reminted`;

export async function renewSession(env: Env, nowMs: number, rejected: Session, onMint?: () => void): Promise<Session | null> {
  const version = await appVersion(env, nowMs);
  const usable = (s: Session | null | undefined): s is Session =>
    Boolean(s && s.token !== rejected.token && s.expMs > nowMs && s.version === version);
  const memo = memos.get(env.KV);
  if (usable(memo)) return memo;
  const kept = (await env.KV.get(KV_TOKEN, 'json').catch(() => null)) as Session | null;
  if (usable(kept)) {
    memos.set(env.KV, kept);
    return kept;
  }
  if (await flagged(remintedKey())) return null;
  await flag(remintedKey(), 'reminted', TTL.remintGapS);
  return getSession(env, nowMs, { force: true, onMint }).catch(() => null);
}

async function mint(env: Env, nowMs: number, version: string): Promise<Session> {
  const res = await timedFetch('auth', authUrl(env), {
    method: 'POST',
    headers: apiKeyHeaders(env),
    body: JSON.stringify({
      deviceid: await deviceId(env),
      ipaddr: PLACEHOLDER_IP,
      version,
    }),
  });
  if (!res.ok) throw new UpstreamHttpError('auth', res.status);

  const text = await res.text();
  let body: { code?: string; msg?: string };
  try {
    body = JSON.parse(text) as { code?: string; msg?: string };
  } catch {
    throw new Error(`auth returned non-JSON (${res.status}, ${text.length}b): ${text.slice(0, 80)}`);
  }
  const extracted = extractSession(body, nowMs);
  if (!extracted) {
    const err = new UpstreamRejected(String(body?.code ?? '?'), `auth rejected: code=${body?.code ?? '?'} msg=${body?.msg ?? ''}`, text);
    err.version = version;
    throw err;
  }
  const session: Session = { ...extracted, version };

  memos.set(env.KV, session);
  const ttlS = Math.max(60, Math.floor((session.expMs - nowMs) / 1000));
  await env.KV.put(KV_TOKEN, JSON.stringify(session), { expirationTtl: ttlS }).catch(() => {});
  return session;
}

export async function proxyEnvelope(env: Env, session: Session): Promise<Record<string, string>> {
  return {
    token: session.token,
    userid: session.userid,
    domain: session.domain,
    deviceid: await deviceId(env),
    ipaddr: PLACEHOLDER_IP,
    version: session.version ?? (await appVersion(env)),
  };
}

export class UpstreamRejected extends Error {
  readonly code: string;
  readonly detail: string;
  version?: string;
  outdated = false;
  constructor(code: string, message: string, detail = '') {
    super(message);
    this.code = code;
    this.detail = redactDetail(detail).slice(0, 2000);
  }
}

const SECRET_FIELD =
  '"(?:token|access_?token|refresh_?token|id_?token|userid|user_?id|deviceid|device_?id|authorization|password|passwd|secret|api_?key|x-api-key)"';

export function redactDetail(detail: string): string {
  return detail
    .replace(new RegExp(`(${SECRET_FIELD}\\s*:\\s*)(?:"(?:\\\\.|[^"\\\\])*"|-?\\d[\\d.eE+-]*)`, 'gi'), '$1"[redacted]"')
    .replace(new RegExp(`(${SECRET_FIELD}\\s*:\\s*")(?:\\\\.|[^"\\\\])*$`, 'i'), '$1[redacted]')
    .replace(/eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/g, '[redacted]')
    .replace(/(Bearer\s+)[\w.~+/=-]+/gi, '$1[redacted]');
}

export class UpstreamHttpError extends Error {
  readonly status: number;
  constructor(what: string, status: number) {
    super(`${what} HTTP ${status}`);
    this.status = status;
  }
}

export function proxyHeaders(env: Env, token: string): Record<string, string> {
  return {
    'x-api-key': env.NEXTBUS_PROXY_API_KEY ?? '',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json; charset=utf-8',
    'user-agent': 'Dart/3.5 (dart:io)',
    accept: 'application/json',
  };
}
