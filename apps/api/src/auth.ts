/**
 * Public / guest access token for the uNivUS API.
 *
 * NO NUSNET CREDENTIALS ARE INVOLVED ANYWHERE. The flow is the one that lets
 * uNivUS show Bus Arrival without signing in: post a device id and get back a
 * 24-hour JWT scoped to domain PUBLIC. If you ever find yourself adding a
 * username field here, stop.
 *
 * Confirmed against a real capture (2026-08-27):
 *
 *   POST {NEXTBUS_AUTH_BASE}/get-access-token
 *   headers: X-HTD-API, X-APP-API          <- the ONLY captured secrets
 *   body:    { deviceid, ipaddr, version } <- JSON, not headers
 *   ->       { code: "00000", data: { token, userid, domain, username } }
 *
 * Without the two API key headers the endpoint answers
 * `{"code":"10000","msg":"Invalid API KEY"}`, so they are not optional.
 */

import type { Env } from './types.ts';
import { TTL } from './config.ts';
import { timedFetch } from './http.ts';

const KV_TOKEN = 'auth:session';
const KV_DEVICE = 'auth:deviceid';
/** Overrides the NEXTBUS_APP_VERSION secret when set: the fix for a new
 *  uNivUS release is one KV write, live within TTL.versionMemoMs. */
export const KV_APP_VERSION = 'config:appVersion';
/** What uNivUS sends, e.g. univus_android_2.59.2_140. Anything else in KV is a
 *  typo, and sending it would fail every call, so it is ignored. */
const VERSION_FORMAT = /^univus_android_\d+(?:\.\d+)+_\d+$/;

/** Confirmed. Only used when NEXTBUS_AUTH_BASE carries no path of its own. */
const DEFAULT_AUTH_PATH = '/get-access-token';

/**
 * The app sends its LAN address here (an emulator reports 10.0.2.15). A Worker
 * has no such thing. Probing showed the field is not what the endpoint
 * validates -- omitting it entirely produces the same "Invalid API KEY" -- but
 * that cannot be confirmed until a valid key exists.
 */
const PLACEHOLDER_IP = '127.0.0.1';

export interface Session {
  token: string;
  /** Reissued on EVERY mint, even for the same device id, so it must travel
   *  with the token rather than being pinned in config. */
  userid: string;
  domain: string;
  expMs: number;
  /** The version string it was minted with. A token from another version is
   *  not reused, so changing the version takes effect on the next call. */
  version?: string;
}

/**
 * In-memory memo: the common case costs neither a KV read nor a round trip.
 * Kept per KV binding, so a token never outlives the store it came from (and
 * each test's fresh KV starts with an empty memo).
 */
const memos = new WeakMap<object, Session>();
const versionMemos = new WeakMap<object, { value: string; atMs: number }>();

/**
 * The uNivUS version string to send: `config:appVersion` in KV when it holds a
 * well-formed one, otherwise the NEXTBUS_APP_VERSION secret. Remembered per
 * isolate for TTL.versionMemoMs, so it costs a KV read about once a minute.
 */
export async function appVersion(env: Env, nowMs: number = Date.now()): Promise<string> {
  const memo = versionMemos.get(env.KV);
  if (memo && nowMs - memo.atMs < TTL.versionMemoMs) return memo.value;
  const stored = (await env.KV.get(KV_APP_VERSION).catch(() => null))?.trim();
  if (stored && !VERSION_FORMAT.test(stored)) console.error(`ignoring ${KV_APP_VERSION}: not univus_android_<versionName>_<versionCode>`);
  const value = stored && VERSION_FORMAT.test(stored) ? stored : (env.NEXTBUS_APP_VERSION ?? '');
  versionMemos.set(env.KV, { value, atMs: nowMs });
  return value;
}

export function authConfigured(env: Env): boolean {
  return Boolean(env.NEXTBUS_AUTH_BASE && env.NEXTBUS_HTD_API && env.NEXTBUS_APP_API);
}

/**
 * The real base carries a path PREFIX (`/univus-public/mobile`), so "has a
 * path means use it verbatim" -- which was a reasonable rule when the base was
 * assumed to be a bare origin -- silently posts to the directory instead of
 * the endpoint. Append unless the endpoint is already there.
 */
export function authUrl(env: Env): string {
  const base = (env.NEXTBUS_AUTH_BASE ?? '').replace(/\/+$/, '');
  return base.endsWith(DEFAULT_AUTH_PATH) ? base : base + DEFAULT_AUTH_PATH;
}

/** The two captured API keys. The "secure" Dio headers stay optional -- the
 *  server does not require them and there is no request signing to defeat. */
export function apiKeyHeaders(env: Env): Record<string, string> {
  const h: Record<string, string> = {
    'X-HTD-API': env.NEXTBUS_HTD_API ?? '',
    'X-APP-API': env.NEXTBUS_APP_API ?? '',
    'content-type': 'application/json',
    accept: 'application/json',
    // Do NOT add X-Forwarded-Proto. Sending it makes the NUS load balancer
    // intermittently answer 400 "Contradictory scheme headers" (2 of 6 mints
    // in a direct A/B, 0 of 6 without). Cloudflare strips it from Worker
    // subrequests anyway, so it never helped there either.
  };
  if (env.NEXTBUS_REQUESTED_BY) h['X-Requested-By'] = env.NEXTBUS_REQUESTED_BY;
  if (env.NEXTBUS_SECURED_REQUEST) h['X-Secured-Request'] = env.NEXTBUS_SECURED_REQUEST;
  return h;
}

/**
 * Read `exp` out of the JWT payload.
 *
 * The response carries no `expires_in`, so the lifetime is only knowable from
 * the token itself. This decodes, it does not verify -- we are the bearer, not
 * the audience, and a forged expiry would only cost us an early refresh.
 */
export function jwtExpMs(token: string): number | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const pad = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Pull the session out of the response envelope, tolerating a reshape. */
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
    // Refresh a little early rather than racing the expiry.
    expMs: expMs - TTL.tokenSkewS * 1000,
  };
}

/**
 * A stable device id. Any 16 hex characters are accepted -- it is an Android
 * ID, not a secret -- but it should stay stable so we look like one install
 * rather than a new device on every cold start.
 */
export async function deviceId(env: Env): Promise<string> {
  if (env.NEXTBUS_DEVICE_ID) return env.NEXTBUS_DEVICE_ID;
  const stored = await env.KV.get(KV_DEVICE).catch(() => null);
  if (stored) return stored;
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.KV.put(KV_DEVICE, id).catch(() => {});
  return id;
}

/** Forget this isolate's remembered version, after writing a new one. */
export function forgetAppVersion(env: Env): void {
  versionMemos.delete(env.KV);
}

/**
 * Mint a token for a given version string, bypassing the caches: how a
 * candidate version is tried. The token is kept, marked with its version, so
 * if the candidate becomes the version it is used straight away.
 */
export function mintWith(env: Env, version: string, nowMs: number = Date.now()): Promise<Session> {
  return mint(env, nowMs, version);
}

/**
 * `force` skips BOTH caches and mints. Clearing only the in-memory memo is not
 * enough: the next call would read the same rejected token straight back out
 * of KV, so a "retry with a fresh token" would silently reuse the stale one.
 */
export async function getSession(
  env: Env,
  nowMs: number = Date.now(),
  { force = false }: { force?: boolean } = {},
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

  // One mint per isolate at a time. On a cold cache /trip fetches several
  // stops in parallel; without this each one minted its own token, and a
  // single failed mint degraded that stop to "unknown". A forced caller that
  // joins an in-flight mint still gets a freshly minted token.
  if (!inflight) {
    inflight = mint(env, nowMs, version).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

let inflight: Promise<Session> | null = null;

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
  if (!res.ok) throw new Error(`auth HTTP ${res.status}`);

  // A wrong path returns HTML with a 200, and a bare SyntaxError from deep in
  // the stack is a miserable thing to debug at 08:39.
  const text = await res.text();
  let body: { code?: string; msg?: string };
  try {
    body = JSON.parse(text) as { code?: string; msg?: string };
  } catch {
    throw new Error(`auth returned non-JSON (${res.status}, ${text.length}b): ${text.slice(0, 80)}`);
  }
  const extracted = extractSession(body, nowMs);
  if (!extracted) {
    // "Invalid API KEY" arrives as HTTP 200 with code 10000, so the status
    // line alone will happily tell you everything is fine.
    throw new UpstreamRejected(String(body?.code ?? '?'), `auth rejected: code=${body?.code ?? '?'} msg=${body?.msg ?? ''}`, text);
  }
  const session: Session = { ...extracted, version };

  memos.set(env.KV, session);
  const ttlS = Math.max(60, Math.floor((session.expMs - nowMs) / 1000));
  await env.KV.put(KV_TOKEN, JSON.stringify(session), { expirationTtl: ttlS }).catch(() => {});
  return session;
}

/**
 * The body envelope every bus-proxy call carries, alongside the Bearer header.
 * Confirmed from a capture of uNivUS 2.59.2: the JWT rides in both places.
 */
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

/**
 * NUS said no, at HTTP 200, with a code. `detail` keeps the whole response
 * (up to 2 KB): when a new uNivUS release refuses our version (10009), what
 * the refusal says is the best clue to what changed. It goes to the logs and
 * the operator's email, so any credential in it is blanked first.
 */
export class UpstreamRejected extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(code: string, message: string, detail = '') {
    super(message);
    this.code = code;
    this.detail = redactDetail(detail).slice(0, 2000);
  }
}

/**
 * Blanks what could let someone call the feed as us, should a refusal echo
 * our request back: the envelope's token, user and device ids, any JWT, and
 * any field named like a key or password. The rest is kept as the clue.
 */
export function redactDetail(detail: string): string {
  return detail
    .replace(/("(?:token|access_?token|refresh_?token|id_?token|userid|user_?id|deviceid|device_?id|authorization|password|passwd|secret|api_?key|x-api-key)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[redacted]"')
    .replace(/eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/g, '[redacted]')
    .replace(/(Bearer\s+)[\w.~+/=-]+/gi, '$1[redacted]');
}

/**
 * Headers for a bus-proxy call.
 *
 * Since 2026-09-05 uNivUS no longer calls ConnectX directly: it POSTs to a
 * proxy on inetapps.nus.edu.sg with this header set. `x-api-key` is a fixed
 * app constant (it sits in libapp.so); the Bearer is the same PUBLIC guest JWT
 * get-access-token mints, so no captured seed token is needed.
 */
export function proxyHeaders(env: Env, token: string): Record<string, string> {
  return {
    'x-api-key': env.NEXTBUS_PROXY_API_KEY ?? '',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json; charset=utf-8',
    'user-agent': 'Dart/3.5 (dart:io)',
    accept: 'application/json',
  };
}
