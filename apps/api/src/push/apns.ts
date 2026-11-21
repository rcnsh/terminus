import type { Card } from '../answer/card.ts';
import { routeColor } from '../map/campus.ts';
import type { Env, MeAnswer } from '../types.ts';
import type { Phase } from '../answer/trip.ts';
import { b64url, warnUnusable } from './webpush.ts';

export const APNS_PREFIX = 'apns:';
export const LIVE_PREFIX = 'apnsla:';
export const START_PREFIX = 'apnsstart:';

export type ApnsTokenKind = 'device' | 'live' | 'start';

const KIND_OF: Record<string, ApnsTokenKind> = { apns: 'device', apnsla: 'live', apnsstart: 'start' };
const PREFIX_OF: Record<ApnsTokenKind, string> = { device: 'apns', live: 'apnsla', start: 'apnsstart' };

export interface ApnsToken {
  kind: ApnsTokenKind;
  hex: string;
  sandbox: boolean;
}

const TOKEN_RE = /^(apns|apnsla|apnsstart):((?:[0-9a-f]{2}){32,255})(:sandbox)?$/;

export const looksApns = (s: string) => /^apns(la|start)?:/i.test(s);

export function parseApnsToken(s: string): ApnsToken | null {
  const m = TOKEN_RE.exec(s.trim().toLowerCase());
  return m ? { kind: KIND_OF[m[1]], hex: m[2], sandbox: Boolean(m[3]) } : null;
}

export const formatApnsToken = (t: ApnsToken) => `${PREFIX_OF[t.kind]}:${t.hex}${t.sandbox ? ':sandbox' : ''}`;

interface ApnsConfig {
  key: string;
  keyId: string;
  teamId: string;
  topic: string;
}

function config(env: Env): ApnsConfig | null {
  const { APNS_KEY: key, APNS_KEY_ID: keyId, APNS_TEAM_ID: teamId, APNS_TOPIC: topic } = env;
  return key && keyId && teamId && topic ? { key, keyId, teamId, topic } : null;
}

export const apnsEnabled = (env: Env) => config(env) !== null;

let saidOff = false;

function warnOff(): void {
  if (saidOff) return;
  saidOff = true;
  console.warn('push: APNs is off (APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID or APNS_TOPIC unset), so iPhones are not pushed');
}

export const JWT_REUSE_S = 50 * 60;
export const RESIGN_GAP_S = 20 * 60;
const JWT_KV = (keyId: string) => `apns:jwt:${keyId}`;

const keys = new Map<string, Promise<CryptoKey>>();

function importKey(pem: string): Promise<CryptoKey> {
  let k = keys.get(pem);
  if (!k) {
    const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
    k = crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    k.catch(() => keys.delete(pem));
    keys.set(pem, k);
  }
  return k;
}

const b64urlText = (s: string) => b64url(new TextEncoder().encode(s));

export async function signProviderJwt(pem: string, keyId: string, teamId: string, nowS: number): Promise<string> {
  const head = b64urlText(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = b64urlText(JSON.stringify({ iss: teamId, iat: nowS }));
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    await importKey(pem),
    new TextEncoder().encode(`${head}.${claims}`),
  );
  return `${head}.${claims}.${b64url(sig)}`;
}

const jwtMemo = new WeakMap<object, { kid: string; jwt: string; iat: number }>();

interface Jwt {
  jwt: string;
  iat: number;
}

async function providerJwt(env: Env, c: ApnsConfig, nowMs: number): Promise<Jwt> {
  const nowS = Math.floor(nowMs / 1000);
  const fresh = (t: { iat: number } | null | undefined) => t && nowS - t.iat < JWT_REUSE_S && t.iat <= nowS + 60;
  const kept = jwtMemo.get(env.KV);
  if (kept?.kid === c.keyId && fresh(kept)) return kept;
  const stored = await storedJwt(env, c.keyId);
  if (stored && fresh(stored)) {
    jwtMemo.set(env.KV, { kid: c.keyId, ...stored });
    return stored;
  }
  return signJwt(env, c, nowS);
}

async function signJwt(env: Env, c: ApnsConfig, nowS: number): Promise<Jwt> {
  let jwt: string;
  try {
    jwt = await signProviderJwt(c.key, c.keyId, c.teamId, nowS);
  } catch (err) {
    warnUnusable('APNS_KEY');
    throw err;
  }
  jwtMemo.set(env.KV, { kid: c.keyId, jwt, iat: nowS });
  await env.KV.put(JWT_KV(c.keyId), JSON.stringify({ jwt, iat: nowS }), { expirationTtl: JWT_REUSE_S }).catch(() => {});
  return { jwt, iat: nowS };
}

async function storedJwt(env: Env, keyId: string): Promise<{ jwt: string; iat: number } | null> {
  try {
    const t = JSON.parse((await env.KV.get(JWT_KV(keyId))) ?? 'null') as { jwt?: unknown; iat?: unknown } | null;
    return t && typeof t.jwt === 'string' && typeof t.iat === 'number' ? { jwt: t.jwt, iat: t.iat } : null;
  } catch {
    return null;
  }
}

async function renewJwt(env: Env, c: ApnsConfig, refused: Jwt, nowMs: number): Promise<Jwt | null> {
  const nowS = Math.floor(nowMs / 1000);
  const kept = jwtMemo.get(env.KV);
  const stored = await storedJwt(env, c.keyId);
  const newer = [kept?.kid === c.keyId ? kept : null, stored].find(
    (t) => t && t.jwt !== refused.jwt && t.iat > refused.iat && nowS - t.iat < JWT_REUSE_S,
  );
  if (newer) return { jwt: newer.jwt, iat: newer.iat };
  const lastSigned = Math.max(refused.iat, kept?.kid === c.keyId ? kept.iat : 0, stored?.iat ?? 0);
  if (nowS - lastSigned < RESIGN_GAP_S) return null;
  return signJwt(env, c, nowS);
}

export interface ApnsPush {
  type: 'alert' | 'background' | 'liveactivity';
  payload: Record<string, unknown>;
  priority: 5 | 10;
  expiresS: number;
  collapseId?: string;
}

export type Loudness = 'time-sensitive' | 'active' | 'passive';

export function alertPush(o: {
  title: string;
  body: string;
  data: Record<string, string>;
  loudness: Loudness;
  collapse: string;
  expiresS: number;
}): ApnsPush {
  return {
    type: 'alert',
    payload: {
      aps: {
        alert: { title: o.title, body: o.body },
        'mutable-content': 1,
        'thread-id': o.collapse,
        'interruption-level': o.loudness,
        ...(o.loudness === 'passive' ? {} : { sound: 'default' }),
      },
      ...o.data,
    },
    priority: o.loudness === 'passive' ? 5 : 10,
    expiresS: o.expiresS,
    collapseId: o.collapse,
  };
}

export function backgroundPush(data: Record<string, string>, expiresS: number): ApnsPush {
  return { type: 'background', payload: { aps: { 'content-available': 1 }, ...data }, priority: 5, expiresS };
}

export const LIVE_DISMISS_S = 10 * 60;

export function livePush(state: LiveActivityState, event: 'update' | 'end', nowS: number, urgent: boolean): ApnsPush {
  return {
    type: 'liveactivity',
    payload: {
      aps: {
        timestamp: nowS,
        event,
        'content-state': state,
        ...(state.staleAt !== null && event === 'update' ? { 'stale-date': state.staleAt } : {}),
        ...(event === 'end' ? { 'dismissal-date': nowS + LIVE_DISMISS_S } : {}),
      },
    },
    priority: urgent ? 10 : 5,
    expiresS: nowS + 15 * 60,
  };
}

export function liveStartPush(
  state: LiveActivityState,
  trip: string,
  alert: { title: string; body: string },
  sound: boolean,
  nowS: number,
): ApnsPush {
  return {
    type: 'liveactivity',
    payload: {
      aps: {
        timestamp: nowS,
        event: 'start',
        'content-state': state,
        'attributes-type': 'TripAttributes',
        attributes: { trip },
        alert,
        ...(sound ? { sound: 'default' } : {}),
        'input-push-token': 1,
        ...(state.staleAt !== null ? { 'stale-date': state.staleAt } : {}),
      },
    },
    priority: 10,
    expiresS: nowS + 10 * 60,
  };
}

export function apnsRequest(topic: string, token: ApnsToken, push: ApnsPush, jwt: string): { url: string; init: RequestInit } {
  const host = token.sandbox ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
  const headers: Record<string, string> = {
    authorization: `bearer ${jwt}`,
    'apns-topic': push.type === 'liveactivity' ? `${topic}.push-type.liveactivity` : topic,
    'apns-push-type': push.type,
    'apns-priority': String(push.priority),
    'apns-expiration': String(push.expiresS),
    'content-type': 'application/json',
  };
  if (push.collapseId) headers['apns-collapse-id'] = push.collapseId;
  return { url: `https://${host}/3/device/${token.hex}`, init: { method: 'POST', headers, body: JSON.stringify(push.payload) } };
}

export interface LiveActivityState {
  phase: Phase;
  phaseText: string | null;
  headline: string;
  line: string;
  glance: string;
  to: string | null;
  svc: string | null;
  color: string | null;
  stop: string | null;
  off: string | null;
  leaveAt: number | null;
  departAt: number | null;
  arriveAt: number | null;
  estimated: boolean;
  gone: boolean;
  late: boolean;
  staleAt: number | null;
}

export const liveActivityTrip = (a: MeAnswer & { card: Card }): string => a.card.actions[0]?.trip ?? a.timing?.classAt ?? 'trip';

const epochS = (iso: string | null | undefined): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};

export function liveActivityState(a: MeAnswer & { card: Card }): LiveActivityState {
  const { card } = a;
  const ride = card.ride;
  const j = card.journey;
  const leave = a.leave ?? null;
  const svc = ride?.svc ?? j?.bus?.svc ?? leave?.svc ?? null;
  const onBoard = card.phase === 'riding' || card.phase === 'arrived';
  return {
    phase: card.phase,
    phaseText: card.phaseText,
    headline: card.title,
    line: card.line,
    glance: card.glance,
    to: j?.place ?? a.dest?.label ?? null,
    svc,
    color: svc === null ? null : j?.bus?.svc === svc ? j.bus.color : routeColor(svc),
    stop: ride ? (ride.stops[0]?.name ?? null) : (j?.bus?.stop ?? leave?.stop ?? null),
    off: ride ? (ride.stops.at(-1)?.name ?? null) : j ? (j.off ?? j.toStop) : (leave?.off ?? leave?.toStop ?? null),
    leaveAt: onBoard ? null : epochS(leave?.at),
    departAt: ride ? epochS(ride.board) : epochS(j?.boardAt ?? leave?.board),
    arriveAt: ride ? epochS(ride.arrive) : epochS(leave?.arrive),
    estimated: Boolean(leave?.estimated),
    gone: card.gone,
    late: card.late,
    staleAt: epochS(card.staleAt),
  };
}

export type ApnsOutcome = 'sent' | 'failed' | 'gone' | 'skip';

const APNS_TIMEOUT_MS = 5_000;
const BACKOFF_MS = 60_000;
const BACKOFF_MAX_MS = 15 * 60_000;
const paused = new WeakMap<object, { until: number; n: number }>();

export async function apnsError(res: Response): Promise<{ tokenGone: boolean; staleJwt: boolean; backOff: boolean; reason: string }> {
  const body = (await res.json().catch(() => null)) as { reason?: unknown } | null;
  const reason = typeof body?.reason === 'string' ? body.reason : '';
  return {
    tokenGone: res.status === 410 || (res.status === 400 && ['BadDeviceToken', 'DeviceTokenNotForTopic'].includes(reason)),
    staleJwt: res.status === 403 && ['ExpiredProviderToken', 'InvalidProviderToken'].includes(reason),
    backOff: res.status === 429 || res.status >= 500,
    reason,
  };
}

export interface ApnsRun {
  jwt: Jwt | null;
  down: boolean;
}

export const newApnsRun = (): ApnsRun => ({ jwt: null, down: false });

function pause(env: Env, run: ApnsRun, nowMs: number): void {
  const n = (paused.get(env.KV)?.n ?? 0) + 1;
  paused.set(env.KV, { until: nowMs + Math.min(BACKOFF_MS * 2 ** (n - 1), BACKOFF_MAX_MS), n });
  run.down = true;
}

export async function sendApns(env: Env, run: ApnsRun, token: ApnsToken, push: ApnsPush, nowMs: number): Promise<ApnsOutcome> {
  const c = config(env);
  if (!c) {
    warnOff();
    return 'skip';
  }
  const pausedNow = paused.get(env.KV);
  if (run.down || (pausedNow && nowMs < pausedNow.until)) return 'failed';
  const send = async (jwt: Jwt) => {
    const { url, init } = apnsRequest(c.topic, token, push, jwt.jwt);
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(APNS_TIMEOUT_MS) });
    return { res, why: res.ok ? null : await apnsError(res) };
  };
  try {
    run.jwt ??= await providerJwt(env, c, nowMs);
  } catch (err) {
    run.down = true;
    throw err;
  }
  let res: Response;
  let why: Awaited<ReturnType<typeof apnsError>> | null;
  try {
    ({ res, why } = await send(run.jwt));
    if (why?.staleJwt) {
      const renewed = await renewJwt(env, c, run.jwt, nowMs);
      if (renewed) {
        run.jwt = renewed;
        ({ res, why } = await send(run.jwt));
      }
      if (!renewed || why?.staleJwt) {
        pause(env, run, nowMs);
        console.error('apns send', res.status, why?.reason ?? '');
        return 'failed';
      }
    }
  } catch (err) {
    pause(env, run, nowMs);
    console.error('apns send failed', err instanceof Error ? err.name : typeof err);
    return 'failed';
  }
  if (!why) {
    paused.delete(env.KV);
    return 'sent';
  }
  if (why.tokenGone) return 'gone';
  if (why.backOff) pause(env, run, nowMs);
  console.error('apns send', res.status, why.reason);
  return 'failed';
}
