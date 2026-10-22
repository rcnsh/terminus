/**
 * APNs: push to the iPhone app, alongside FCM (Android) and Web Push
 * (push.ts sends all three).
 *
 * The app registers its device token as `apns:<hex>`; while a trip's Live
 * Activity runs, that activity's token as `apnsla:<hex>`; and, with its Live
 * Activity setting on (iOS 17.2 and later), the token that starts one by push
 * as `apnsstart:<hex>`. Each comes with `:sandbox` from a development build
 * (sent to Apple's sandbox host). A session keeps its latest of each
 * (sessions.push_token, sessions.live_token, sessions.start_token).
 *
 * Every request carries a provider token: a JWT signed with the team's .p8
 * key (ES256, WebCrypto), which Apple wants reused rather than minted per
 * push and refused after an hour. It's kept in the isolate and in KV and
 * used for JWT_REUSE_S; one Apple refuses is signed again at most every
 * RESIGN_GAP_S, as Apple refuses renewing more often. With APNS_KEY,
 * APNS_KEY_ID, APNS_TEAM_ID or the APNS_TOPIC var missing, APNs is off:
 * tokens are still stored, and sends are skipped (said once per isolate).
 *
 * Apple only takes HTTP/2. Cloudflare doesn't document which HTTP version a
 * Worker's fetch uses; deployed Workers have been seen reaching APNs with it
 * (Cloudflare's proxy upgrades the request), the local runtime can't (cf dev,
 * the dev stub). Unverified for terminus until a real push: see
 * docs/internals.md, APNs. A refused connection counts as a failed send,
 * drops no token, and pauses APNs like a 5xx.
 */

import type { Card } from './card.ts';
import { routeColor } from './campus.ts';
import type { Env, MeAnswer } from './types.ts';
import type { Phase } from './trip.ts';
import { b64url, warnUnusable } from './webpush.ts';

export const APNS_PREFIX = 'apns:';
export const LIVE_PREFIX = 'apnsla:';
export const START_PREFIX = 'apnsstart:';

/** What a token pushes to: the phone, its running Live Activity, or a Live Activity it starts. */
export type ApnsTokenKind = 'device' | 'live' | 'start';

const KIND_OF: Record<string, ApnsTokenKind> = { apns: 'device', apnsla: 'live', apnsstart: 'start' };
const PREFIX_OF: Record<ApnsTokenKind, string> = { device: 'apns', live: 'apnsla', start: 'apnsstart' };

/** A device's (or a Live Activity's) token, as registered. */
export interface ApnsToken {
  /** `apns:` the device's, `apnsla:` a running Live Activity's, `apnsstart:` the one that starts a Live Activity. */
  kind: ApnsTokenKind;
  /** The token, lower-case hex. */
  hex: string;
  /** From a development build: Apple's sandbox host. */
  sandbox: boolean;
}

/** 32 bytes today; Apple says not to rely on the length, and an activity's token is longer. */
const TOKEN_RE = /^(apns|apnsla|apnsstart):((?:[0-9a-f]{2}){32,255})(:sandbox)?$/;

/** Whether the app meant this as an APNs token, well formed or not. */
export const looksApns = (s: string) => /^apns(la|start)?:/i.test(s);

/** `apns:`, `apnsla:` or `apnsstart:`, then `<hex>[:sandbox]`, in either case; null when it isn't one. */
export function parseApnsToken(s: string): ApnsToken | null {
  const m = TOKEN_RE.exec(s.trim().toLowerCase());
  return m ? { kind: KIND_OF[m[1]], hex: m[2], sandbox: Boolean(m[3]) } : null;
}

/** The token as stored: lower case, so the same token from two sessions is one. */
export const formatApnsToken = (t: ApnsToken) => `${PREFIX_OF[t.kind]}:${t.hex}${t.sandbox ? ':sandbox' : ''}`;

interface ApnsConfig {
  key: string;
  keyId: string;
  teamId: string;
  /** The app's bundle id. */
  topic: string;
}

function config(env: Env): ApnsConfig | null {
  const { APNS_KEY: key, APNS_KEY_ID: keyId, APNS_TEAM_ID: teamId, APNS_TOPIC: topic } = env;
  return key && keyId && teamId && topic ? { key, keyId, teamId, topic } : null;
}

/** Whether push to the iPhone app is set up. */
export const apnsEnabled = (env: Env) => config(env) !== null;

let saidOff = false;

/** An iPhone was due a push with APNs off: said once per isolate, by name only. */
function warnOff(): void {
  if (saidOff) return;
  saidOff = true;
  console.warn('push: APNs is off (APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID or APNS_TOPIC unset), so iPhones are not pushed');
}

/* ---------------------------------------------------------------- */
/* The provider token                                                */
/* ---------------------------------------------------------------- */

/** Apple refuses a provider token after an hour, and one renewed more than every 20 minutes. */
export const JWT_REUSE_S = 50 * 60;
/**
 * A token Apple refused (a 403 saying it's expired or invalid) is signed
 * again only once this long has passed since the last was signed, by any
 * isolate: sooner, Apple answers TooManyProviderTokenUpdates, and a key
 * that's simply wrong would have every send sign and write KV again.
 */
export const RESIGN_GAP_S = 20 * 60;
const JWT_KV = (keyId: string) => `apns:jwt:${keyId}`;

const keys = new Map<string, Promise<CryptoKey>>();

function importKey(pem: string): Promise<CryptoKey> {
  let k = keys.get(pem);
  if (!k) {
    const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
    k = crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    // A key that won't import is tried again next time, not kept as a failure.
    k.catch(() => keys.delete(pem));
    keys.set(pem, k);
  }
  return k;
}

const b64urlText = (s: string) => b64url(new TextEncoder().encode(s));

/**
 * A provider token: `{alg: ES256, kid}` and `{iss: team, iat}`, signed with
 * the .p8 key. WebCrypto's ECDSA signature is r and s side by side, which is
 * what a JWT's ES256 is.
 */
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

/** The token kept in the isolate too, so a push batch doesn't read KV for each device. */
const jwtMemo = new WeakMap<object, { kid: string; jwt: string; iat: number }>();

/** A provider token and when it was signed (epoch seconds). */
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

/** The token another isolate signed, from KV; null when there's none or it's unreadable. */
async function storedJwt(env: Env, keyId: string): Promise<{ jwt: string; iat: number } | null> {
  try {
    const t = JSON.parse((await env.KV.get(JWT_KV(keyId))) ?? 'null') as { jwt?: unknown; iat?: unknown } | null;
    return t && typeof t.jwt === 'string' && typeof t.iat === 'number' ? { jwt: t.jwt, iat: t.iat } : null;
  } catch {
    return null;
  }
}

/**
 * A token to replace `refused`, which Apple wouldn't take: one another
 * isolate has signed since, or a new one, though not within RESIGN_GAP_S of
 * the last signing (the refused one's, or a newer one's). Null when it's too
 * soon. The token signed stays in KV, so every isolate knows when that was.
 */
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

/* ---------------------------------------------------------------- */
/* What is sent                                                      */
/* ---------------------------------------------------------------- */

/** One push, ready to send to a token. */
export interface ApnsPush {
  type: 'alert' | 'background' | 'liveactivity';
  payload: Record<string, unknown>;
  /** 10: now; 5: when it suits the phone (a background push must be 5). */
  priority: 5 | 10;
  /** Epoch seconds after which Apple stops trying; 0: once, now or never. */
  expiresS: number;
  /** A newer push with the same id replaces this one in Notification Center. */
  collapseId?: string;
}

/**
 * How loud a notification is. `time-sensitive` breaks through a Focus (the
 * app needs the Time Sensitive Notifications capability; without it iOS
 * treats it as `active`); `passive` lands quietly, without sound or lighting
 * the screen.
 */
export type Loudness = 'time-sensitive' | 'active' | 'passive';

/**
 * A notification with words, which the app's notification service extension
 * may re-word (`mutable-content`) from /api/me/next. `data` sits beside
 * `aps`, as Android's data message does.
 */
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

/** A silent nudge (`content-available`): the app wakes in the background and fetches the card. */
export function backgroundPush(data: Record<string, string>, expiresS: number): ApnsPush {
  return { type: 'background', payload: { aps: { 'content-available': 1 }, ...data }, priority: 5, expiresS };
}

/** How long an ended Live Activity stays on the Lock Screen. */
export const LIVE_DISMISS_S = 10 * 60;

/**
 * A Live Activity update, or its end. `timestamp` lets the phone drop one
 * that arrives after a newer one. Priority 10 only when the trip's phase
 * changed: Apple budgets those.
 */
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

/**
 * Starts the trip's Live Activity on an iPhone that has none running
 * (ActivityKit push-to-start, iOS 17.2 and later), sent to its `apnsstart:`
 * token: the moments Android starts its live notification from a push.
 * `attributes-type` and `attributes` are the app's `TripAttributes`; the
 * alert is what the phone shows as it starts (Apple requires one), with a
 * sound only when the iPhone's leave alerts are on. `input-push-token` asks
 * iOS 18 for the new activity's update token, which the app sends as
 * `apnsla:` (iOS 17 sends it anyway).
 */
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

/** The request for one push to one token: Apple's sandbox host for a development build's. */
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

/* ---------------------------------------------------------------- */
/* The Live Activity                                                 */
/* ---------------------------------------------------------------- */

/**
 * What the trip's Live Activity shows: its ActivityKit `ContentState`, sent
 * as `content-state`, worded by the server like the card it comes from.
 * Times are whole epoch seconds (a Swift `Int`, read with
 * `Date(timeIntervalSince1970:)`; not `Date`, which a default decoder reads
 * from 2001). A missing value is null, never absent.
 */
export interface LiveActivityState {
  /** The trip's phase: due, heading, waiting, riding, missed, arrived, or idle before it's due. */
  phase: Phase;
  /** A few words on the phase ("On your way"); null when idle. card.phaseText. */
  phaseText: string | null;
  /** The headline: "D2 · 09:42". card.title. */
  headline: string;
  /** The trip in one line, for the Lock Screen. card.line. */
  line: string;
  /** 12 characters at most, for the Dynamic Island's compact and minimal views. card.glance. */
  glance: string;
  /** Where to: "GEA1000". Null with nowhere to go. */
  to: string | null;
  /** The bus to catch, or the one you're on, and its colour ("#RRGGBB"). Null on foot. */
  svc: string | null;
  color: string | null;
  /** Where to board it, and where to get off. */
  stop: string | null;
  off: string | null;
  /** When to set off, to count down to; null once on the bus or there. */
  leaveAt: number | null;
  /** When the bus leaves `stop`: the countdown at the stop, and the ride's start. */
  departAt: number | null;
  /** When you get there; with `departAt`, the ride's progress bar. */
  arriveAt: number | null;
  /** The times are a timetable guess, not live: show "~". */
  estimated: boolean;
  /** The planned bus has left and nothing says you're on it: `line` says so. Never "Leave now". */
  gone: boolean;
  /** A class you'll be late for. */
  late: boolean;
  /** From then on the activity is out of date (sent as `stale-date` too). */
  staleAt: number | null;
}

/**
 * The trip a Live Activity is about, as the app names it (TripAttributes.trip,
 * TripReminders.tripKey): the card's first button's trip, else when the
 * class starts. The app keeps an activity whose trip matches its card, and
 * ends one that doesn't.
 */
export const liveActivityTrip = (a: MeAnswer & { card: Card }): string => a.card.actions[0]?.trip ?? a.timing?.classAt ?? 'trip';

const epochS = (iso: string | null | undefined): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};

/** The Live Activity's content-state for this answer and its card. Pure. */
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

/* ---------------------------------------------------------------- */
/* Sending                                                           */
/* ---------------------------------------------------------------- */

/** What one send did: as push.ts counts them. */
export type ApnsOutcome = 'sent' | 'failed' | 'gone' | 'skip';

/** Apple answers in well under a second; a hung call mustn't hold up the other devices. */
const APNS_TIMEOUT_MS = 5_000;
/** After a 429 or 5xx, Apple isn't asked again for this long, doubling each time, up to the cap. */
const BACKOFF_MS = 60_000;
const BACKOFF_MAX_MS = 15 * 60_000;
const paused = new WeakMap<object, { until: number; n: number }>();

/** What Apple's error says: the token is no good, our provider token is, or Apple wants a rest. */
export async function apnsError(res: Response): Promise<{ tokenGone: boolean; staleJwt: boolean; backOff: boolean; reason: string }> {
  const body = (await res.json().catch(() => null)) as { reason?: unknown } | null;
  const reason = typeof body?.reason === 'string' ? body.reason : '';
  return {
    // Unregistered (410): the app was removed, or the activity ended. A 400
    // naming the token: not a token, or one for another app or host.
    tokenGone: res.status === 410 || (res.status === 400 && ['BadDeviceToken', 'DeviceTokenNotForTopic'].includes(reason)),
    staleJwt: res.status === 403 && ['ExpiredProviderToken', 'InvalidProviderToken'].includes(reason),
    backOff: res.status === 429 || res.status >= 500,
    reason,
  };
}

/** One delivery's provider token, shared by its devices; `down` once Apple can't be asked (no token, or a pause). */
export interface ApnsRun {
  jwt: Jwt | null;
  down: boolean;
}

export const newApnsRun = (): ApnsRun => ({ jwt: null, down: false });

/**
 * Apple isn't asked again in this isolate for a while, doubling each time
 * up to the cap, and not by the rest of this delivery either.
 */
function pause(env: Env, run: ApnsRun, nowMs: number): void {
  const n = (paused.get(env.KV)?.n ?? 0) + 1;
  paused.set(env.KV, { until: nowMs + Math.min(BACKOFF_MS * 2 ** (n - 1), BACKOFF_MAX_MS), n });
  run.down = true;
}

/** Sends one push to one token. Never says why with the token in it. */
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
      // Apple no longer takes the provider token: a newer one, and once more,
      // unless one was signed too lately to sign again.
      const renewed = await renewJwt(env, c, run.jwt, nowMs);
      if (renewed) {
        run.jwt = renewed;
        ({ res, why } = await send(run.jwt));
      }
      if (!renewed || why?.staleJwt) {
        // A key Apple won't take (or not yet a new token): asking with each
        // device, at each wake, would only be refused again.
        pause(env, run, nowMs);
        console.error('apns send', res.status, why?.reason ?? '');
        return 'failed';
      }
    }
  } catch (err) {
    // No answer: the 5 s timeout, a refused connection (no HTTP/2), a reset.
    // Like a 5xx, the rest of the delivery and the next wakes skip Apple
    // until the pause ends, rather than each waiting out the timeout again.
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
