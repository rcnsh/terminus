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

const KV_TOKEN = 'auth:session';
const KV_DEVICE = 'auth:deviceid';

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
}

/** In-memory memo: the common case costs neither a KV read nor a round trip. */
let memo: Session | null = null;

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
  const stored = await env.NUSBUS_KV.get(KV_DEVICE).catch(() => null);
  if (stored) return stored;
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.NUSBUS_KV.put(KV_DEVICE, id).catch(() => {});
  return id;
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
  if (!force && memo && memo.expMs > nowMs) return memo;

  if (!force) {
    const cached = (await env.NUSBUS_KV.get(KV_TOKEN, 'json').catch(() => null)) as Session | null;
    if (cached && cached.expMs > nowMs) {
      memo = cached;
      return cached;
    }
  }

  const res = await fetch(authUrl(env), {
    method: 'POST',
    headers: apiKeyHeaders(env),
    body: JSON.stringify({
      deviceid: await deviceId(env),
      ipaddr: PLACEHOLDER_IP,
      version: env.NEXTBUS_APP_VERSION ?? '',
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
  const session = extractSession(body, nowMs);
  if (!session) {
    // "Invalid API KEY" arrives as HTTP 200 with code 10000, so the status
    // line alone will happily tell you everything is fine.
    throw new Error(`auth rejected: code=${body?.code ?? '?'} msg=${body?.msg ?? ''}`);
  }

  memo = session;
  const ttlS = Math.max(60, Math.floor((session.expMs - nowMs) / 1000));
  await env.NUSBUS_KV.put(KV_TOKEN, JSON.stringify(session), { expirationTtl: ttlS }).catch(() => {});
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
    version: env.NEXTBUS_APP_VERSION ?? '',
  };
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
