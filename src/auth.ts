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
    /**
     * NOT OPTIONAL, and the reason is genuinely nasty.
     *
     * Cloudflare's fetch() injects both `CF-Visitor: {"scheme":"https"}` and
     * an `X-Forwarded-Proto` reflecting the INCOMING request's scheme. Behind
     * a plain-http hop that lands as `X-Forwarded-Proto: http`, the upstream
     * sees the two disagree and answers `400 Bad Request - Contradictory
     * scheme headers` as HTML. Verified by isolation: XFP http alone triggers
     * it, CF-Visitor alone does not, and pinning XFP to https always works.
     *
     * The symptom is "identical curl succeeds, Worker gets 400", which is a
     * horrible thing to chase in production.
     */
    'X-Forwarded-Proto': 'https',
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

export function invalidateToken(): void {
  memo = null;
}

export async function getSession(env: Env, nowMs: number = Date.now()): Promise<Session> {
  if (!authConfigured(env)) throw new Error('auth not configured');
  if (memo && memo.expMs > nowMs) return memo;

  const cached = (await env.NUSBUS_KV.get(KV_TOKEN, 'json').catch(() => null)) as Session | null;
  if (cached && cached.expMs > nowMs) {
    memo = cached;
    return cached;
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

const KV_FMS = 'auth:fms';
const BUSWIDGET_PATH = '/univus/mobile/buswidget/get-init-data';

interface FmsSession {
  /** ConnectX auth value. This is nextbus_token2, NOT nextbus_token -- the
   *  reference client uses token2 and token is unused. */
  token: string;
  expMs: number;
}

let fmsMemo: FmsSession | null = null;

/** Where get-init-data lives. NEXTBUS_AUTH_BASE ends at .../mobile for the
 *  public token, so strip that suffix before appending the univus path. */
export function buswidgetUrl(env: Env): string {
  const base = (env.NEXTBUS_AUTH_BASE ?? '').replace(/\/+$/, '');
  const host = base.replace(/\/univus-public\/mobile$/, '').replace(/\/univus\/mobile$/, '');
  return host + BUSWIDGET_PATH;
}

export function extractFmsToken(body: unknown): string | null {
  const data = (body as { data?: { tokens?: Record<string, unknown> } })?.data;
  const t = data?.tokens?.nextbus_token2 ?? data?.tokens?.nextbus_token;
  return typeof t === 'string' && t.length > 4 ? t : null;
}

export function invalidateFmsToken(): void {
  fmsMemo = null;
}

/**
 * Stage 2: exchange the PUBLIC JWT for the ConnectX FMS token.
 *
 * Kept separate from the arrivals cache -- this is a 12h credential, not
 * 15-second data -- and memoised so a tile tap does not re-run the handshake.
 */
export async function getFmsToken(env: Env, nowMs: number = Date.now()): Promise<string> {
  if (fmsMemo && fmsMemo.expMs > nowMs) return fmsMemo.token;

  const cached = (await env.NUSBUS_KV.get(KV_FMS, 'json').catch(() => null)) as FmsSession | null;
  if (cached && cached.expMs > nowMs) {
    fmsMemo = cached;
    return cached.token;
  }

  const session = await getSession(env, nowMs);
  const res = await fetch(buswidgetUrl(env), {
    method: 'POST',
    headers: apiKeyHeaders(env),
    body: JSON.stringify({
      deviceid: await deviceId(env),
      domain: session.domain,
      ipaddr: '0.0.0.0',
      token: session.token,
      userid: session.userid,
      version: env.NEXTBUS_APP_VERSION ?? '',
    }),
  });
  if (!res.ok) throw new Error(`buswidget HTTP ${res.status}`);

  const body = (await res.json()) as { code?: string; msg?: string };
  const token = extractFmsToken(body);
  if (!token) throw new Error(`buswidget rejected: code=${body?.code ?? '?'} msg=${body?.msg ?? ''}`);

  // The response gives no explicit lifetime; the reference client assumes 12h.
  const entry: FmsSession = { token, expMs: nowMs + 12 * 3600_000 - TTL.tokenSkewS * 1000 };
  fmsMemo = entry;
  const ttlS = Math.max(60, Math.floor((entry.expMs - nowMs) / 1000));
  await env.NUSBUS_KV.put(KV_FMS, JSON.stringify(entry), { expirationTtl: ttlS }).catch(() => {});
  return token;
}

/** Back-compat for callers that only want the bearer string. */
export async function getToken(env: Env, nowMs: number = Date.now()): Promise<string> {
  return (await getSession(env, nowMs)).token;
}

/**
 * Headers for a ConnectX FMS request.
 *
 * CONFIRMED from hewliyang/nus-nextbus-web's server client: the FMS token is
 * NOT a header. It goes in as a `token` query parameter (see fms.ts), and the
 * only header the host wants is `accept`. The X-HTD/X-APP keys are not sent to
 * ConnectX at all; the optional Dio "secure" headers are attached if set.
 */
export function fmsHeaders(env: Env): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json' };
  if (env.NEXTBUS_REQUESTED_BY) h['x-requested-by'] = env.NEXTBUS_REQUESTED_BY;
  if (env.NEXTBUS_SECURED_REQUEST) h['x-secured-request'] = env.NEXTBUS_SECURED_REQUEST;
  return h;
}
