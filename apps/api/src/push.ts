/**
 * Push: Firebase Cloud Messaging (HTTP v1) to Android devices, and Web
 * Push to the installed web app (webpush.ts), both kept as the
 * session's push_token: an FCM token, or `web:` and a subscription.
 *
 * A push is usually only a nudge. It says the card has changed (`kind:
 * 'card'` and the phase), and the app fetches /me/next itself, so the words
 * are never worked out twice and nothing sensitive travels through Google.
 * It's high priority only when the user should look: the trip is due, or it
 * was missed, whether or not its reminders are on, since Android starts the
 * live notification from these. The new semester's reminder (`kind: 'term'`) is the same to
 * an app that can fetch its words (GET /me/notice): only to an older
 * Android app, which shows what it's sent, does it carry the words, in
 * English and Chinese (fetchesNotice). Web pushes are encrypted for the
 * browser, so they always carry them.
 *
 * The Worker signs its own OAuth token from the service account in
 * FCM_SERVICE_ACCOUNT (RS256 with WebCrypto) and keeps it in KV for 50
 * minutes. A token FCM no longer knows is cleared from its session.
 */

import type { Env } from './types.ts';
import { WEB_PREFIX, type WebSubscription, b64url, parseSubscription, sendWebPush, warnUnusable, webPushEnabled } from './webpush.ts';

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_KV = 'fcm:access';
const TOKEN_TTL_S = 50 * 60;
/** Google answers in well under a second; a hung call mustn't hold up the other devices, or the Trip object's alarm. */
const FCM_TIMEOUT_MS = 5_000;

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** What a push says; the app fetches the card itself. */
export interface Nudge {
  phase: string;
  /** Worth waking the phone for. */
  urgent: boolean;
  /** False when reminders are off for this trip: the web app then isn't
   *  pushed, since a web push must show a notification. */
  remind?: boolean;
}

function account(env: Env): ServiceAccount | null {
  if (!env.FCM_SERVICE_ACCOUNT) return null;
  try {
    const a = JSON.parse(env.FCM_SERVICE_ACCOUNT) as ServiceAccount;
    if (a.project_id && a.client_email && a.private_key) return a;
  } catch {
    // Unreadable: said once below, like one missing a field.
  }
  warnUnusable('FCM_SERVICE_ACCOUNT');
  return null;
}

/** Whether push to Android (FCM) is set up. */
export const fcmEnabled = (env: Env) => account(env) !== null;

/** Whether push is set up at all. */
export const pushEnabled = (env: Env) => fcmEnabled(env) || webPushEnabled(env);

const b64urlText = (s: string) => b64url(new TextEncoder().encode(s));

async function signJwt(a: ServiceAccount, nowS: number): Promise<string> {
  const pem = a.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const head = b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64urlText(
    JSON.stringify({ iss: a.client_email, scope: SCOPE, aud: a.token_uri ?? 'https://oauth2.googleapis.com/token', iat: nowS, exp: nowS + 3600 }),
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${claims}`));
  return `${head}.${claims}.${b64url(sig)}`;
}

/** How long Google's access tokens last. */
const TOKEN_LIFE_S = 3600;

/**
 * The token kept in the isolate too, so a push batch doesn't read KV each
 * time: until the KV entry would expire for one this isolate minted, and for
 * one read back from KV (put there at most TOKEN_TTL_S ago) only for the
 * part of its life that is certainly left.
 */
const tokenMemo = new WeakMap<object, { token: string; until: number }>();

async function accessToken(env: Env, a: ServiceAccount, nowMs: number): Promise<string> {
  const kept = tokenMemo.get(env.KV);
  if (kept && nowMs < kept.until) return kept.token;
  const cached = await env.KV.get(TOKEN_KV).catch(() => null);
  if (cached) {
    tokenMemo.set(env.KV, { token: cached, until: nowMs + (TOKEN_LIFE_S - TOKEN_TTL_S) * 1000 });
    return cached;
  }
  const res = await fetch(a.token_uri ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: await signJwt(a, Math.floor(nowMs / 1000)) }),
    signal: AbortSignal.timeout(FCM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`fcm oauth ${res.status}`);
  const { access_token } = (await res.json()) as { access_token?: string };
  if (!access_token) throw new Error('fcm oauth: no token');
  await env.KV.put(TOKEN_KV, access_token, { expirationTtl: TOKEN_TTL_S }).catch(() => {});
  tokenMemo.set(env.KV, { token: access_token, until: nowMs + TOKEN_TTL_S * 1000 });
  return access_token;
}

/** What a delivery did: how many devices it reached, and how many it should have but didn't. */
export interface Delivered {
  sent: number;
  failed: number;
}

/**
 * Nudges every device of a user that registered for push. Never throws:
 * push is a nicety on top of the apps' own refresh.
 */
export async function nudgeUser(env: Env, userId: string, nudge: Nudge, nowMs: number, exceptTokenHash?: string): Promise<Delivered> {
  // Every web push shows a notification (iOS insists), so nothing to show
  // means nothing sent: an idle card, or reminders off for the trip.
  const quiet = nudge.phase === 'idle' || nudge.remind === false;
  return deliver(env, userId, {
    web: quiet ? null : { kind: 'card', phase: nudge.phase, urgent: nudge.urgent },
    fcm: { kind: 'card', phase: nudge.phase },
    urgent: nudge.urgent,
    collapse: 'card',
    ttlS: 600,
  }, nowMs, exceptTokenHash);
}

/** A notification worded by the server, in English and Chinese: the app shows the one in its language. */
export interface Notice {
  title: string;
  body: string;
  zhTitle: string;
  zhBody: string;
}

/**
 * The new semester's reminder (monitor.ts): a notification the apps show,
 * rather than a card to fetch. Says how many devices took it and how many
 * failed; none of either means there was nobody it could go to.
 */
export async function remindUser(env: Env, userId: string, notice: Notice, nowMs: number): Promise<Delivered> {
  const words = { title: notice.title, body: notice.body, zhTitle: notice.zhTitle, zhBody: notice.zhBody };
  return deliver(
    env,
    userId,
    { web: { kind: 'term', ...words }, fcm: { kind: 'term', ...words }, fcmBare: { kind: 'term' }, urgent: false, collapse: 'term', ttlS: 2 * 86_400 },
    nowMs,
  );
}

/** The first Android version that fetches the reminder's words itself (GET /me/notice). */
export const NOTICE_FETCH_FROM = [2, 5, 0] as const;

/** Whether the app behind this session (its x-terminus-client, "android/2.5.0") fetches the reminder's words. */
export function fetchesNotice(client: string | null): boolean {
  const v = /^android\/(\d+)\.(\d+)\.(\d+)/.exec(client ?? '');
  if (!v) return false;
  const [a, b, c] = v.slice(1).map(Number);
  const [x, y, z] = NOTICE_FETCH_FROM;
  return a !== x ? a > x : b !== y ? b > y : c >= z;
}

interface Delivery {
  /** The web push's payload, or null to send browsers nothing. */
  web: Record<string, unknown> | null;
  /** FCM data: strings only. */
  fcm: Record<string, string>;
  /** What an app that fetches the words itself is sent instead (fetchesNotice). */
  fcmBare?: Record<string, string>;
  urgent: boolean;
  /** A newer message with the same key replaces one not yet delivered. */
  collapse: string;
  ttlS: number;
}

/** Sends one message to every device of a user that takes push, and clears tokens that are gone. */
async function deliver(env: Env, userId: string, msg: Delivery, nowMs: number, exceptTokenHash?: string): Promise<Delivered> {
  const out: Delivered = { sent: 0, failed: 0 };
  const db = env.DB;
  if (!pushEnabled(env) || !db) return out;
  const a = account(env);
  let results: { token_hash: string; push_token: string; client: string | null }[];
  try {
    ({ results } = await db.prepare('SELECT token_hash, push_token, client FROM sessions WHERE user_id = ? AND push_token IS NOT NULL AND token_hash != ?')
      .bind(userId, exceptTokenHash ?? '')
      .all<{ token_hash: string; push_token: string; client: string | null }>());
  } catch (err) {
    console.error('push failed', err instanceof Error ? err.message : typeof err);
    return { sent: 0, failed: 1 };
  }
  const forget = (tokenHash: string) => db.prepare('UPDATE sessions SET push_token = NULL WHERE token_hash = ?').bind(tokenHash).run();
  const fcm: Fcm = { bearer: null, down: false };
  for (const r of results) {
    // One device's failure (a key that won't import, a service that hangs) mustn't stop the rest.
    try {
      const res = r.push_token.startsWith(WEB_PREFIX) ? await toBrowser(env, r.push_token, msg, nowMs) : a ? await toAndroid(env, a, fcm, r, msg, nowMs) : 'skip';
      if (res === 'sent') out.sent++;
      else if (res === 'failed') out.failed++;
      else if (res === 'gone') await forget(r.token_hash);
    } catch (err) {
      console.error('push failed', err instanceof Error ? err.message : typeof err);
      out.failed++;
    }
  }
  return out;
}

type Outcome = 'sent' | 'failed' | 'gone' | 'skip';

async function toBrowser(env: Env, pushToken: string, msg: Delivery, nowMs: number): Promise<Outcome> {
  // Without a usable VAPID key no browser can be sent to: nobody reached, not a failure to retry.
  if (!msg.web || !webPushEnabled(env)) return 'skip';
  let sub: WebSubscription | null = null;
  try {
    sub = parseSubscription(JSON.parse(pushToken.slice(WEB_PREFIX.length)));
  } catch {
    // Unreadable: treated as gone, like a subscription that fails its checks.
  }
  if (!sub) return 'gone';
  return sendWebPush(env, sub, msg.web, { urgent: msg.urgent, nowMs, topic: msg.collapse, ttlS: msg.ttlS }).catch((err) => {
    console.error('web push', String(err));
    return 'failed' as const;
  });
}

/** One delivery's FCM access token, shared by its devices; `down` once it couldn't be had. */
interface Fcm {
  bearer: string | null;
  down: boolean;
}

async function toAndroid(env: Env, a: ServiceAccount, fcm: Fcm, to: { push_token: string; client: string | null }, msg: Delivery, nowMs: number): Promise<Outcome> {
  // Without an access token no device can be sent to: asking again for each would only wait longer.
  if (fcm.down) return 'failed';
  const send = (token: string) =>
    fetch(`https://fcm.googleapis.com/v1/projects/${a.project_id}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: to.push_token,
          // An app that fetches the words itself is sent only the kind (GET /me/notice).
          data: msg.fcmBare && fetchesNotice(to.client) ? msg.fcmBare : msg.fcm,
          android: { priority: msg.urgent ? 'HIGH' : 'NORMAL', ttl: `${msg.ttlS}s`, collapse_key: msg.collapse },
        },
      }),
      signal: AbortSignal.timeout(FCM_TIMEOUT_MS),
    });
  try {
    fcm.bearer ??= await accessToken(env, a, nowMs);
  } catch (err) {
    fcm.down = true;
    throw err;
  }
  let res = await send(fcm.bearer);
  if (res.status === 401) {
    // The access token went stale before its cache entry did: a new one, and once more.
    tokenMemo.delete(env.KV);
    await env.KV.delete(TOKEN_KV).catch(() => {});
    fcm.bearer = null;
    try {
      fcm.bearer = await accessToken(env, a, nowMs);
    } catch (err) {
      fcm.down = true;
      throw err;
    }
    res = await send(fcm.bearer);
  }
  if (res.ok) return 'sent';
  const why = await fcmError(res);
  if (why.tokenGone) return 'gone';
  // Never the token: the status and FCM's code say what went wrong.
  console.error('fcm send', res.status, why.code);
  return 'failed';
}

type FcmErrorBody = {
  error?: { status?: string; message?: string; details?: { errorCode?: string; fieldViolations?: { field?: string }[] }[] };
};

/**
 * Whether FCM's error says this device's token is no good: UNREGISTERED (the
 * app was uninstalled), or a 400 that names the token as the bad field or, as
 * FCM usually words it, says the registration token isn't valid. Any other 400
 * is our message's fault, and must not cost every phone its token.
 */
export async function fcmError(res: Response): Promise<{ tokenGone: boolean; code: string }> {
  const body = (await res.json().catch(() => null)) as FcmErrorBody | null;
  const details = Array.isArray(body?.error?.details) ? body.error.details : [];
  const code = details.find((d) => typeof d?.errorCode === 'string')?.errorCode ?? body?.error?.status ?? '';
  const namesToken = details.some((d) => Array.isArray(d?.fieldViolations) && d.fieldViolations.some((v) => v?.field === 'message.token'));
  const badToken = namesToken || /registration token/i.test(String(body?.error?.message ?? ''));
  return { tokenGone: res.status === 404 || code === 'UNREGISTERED' || (res.status === 400 && badToken), code };
}

/** How many of a user's devices take push. */
export async function pushDevices(env: Env, userId: string): Promise<number> {
  if (!pushEnabled(env) || !env.DB) return 0;
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND push_token IS NOT NULL').bind(userId).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Registers (or with null, forgets) this device's push token: an FCM token or a web subscription. A token lives on one session only. */
export async function setPushToken(db: D1Database, tokenHash: string, pushToken: string | null): Promise<void> {
  const stmts = [];
  if (pushToken) stmts.push(db.prepare('UPDATE sessions SET push_token = NULL WHERE push_token = ?').bind(pushToken));
  stmts.push(db.prepare('UPDATE sessions SET push_token = ? WHERE token_hash = ?').bind(pushToken, tokenHash));
  await db.batch(stmts);
}
