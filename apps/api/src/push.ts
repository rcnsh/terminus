/**
 * Push: Firebase Cloud Messaging (HTTP v1) to Android devices, and Web
 * Push to the installed web app (webpush.ts), both kept as the
 * session's push_token: an FCM token, or `web:` and a subscription.
 *
 * A push is usually only a nudge. It says the card has changed (`kind:
 * 'card'` and the phase), and the app fetches /me/next itself, so the words
 * are never worked out twice and nothing sensitive travels through Google.
 * It's high priority only when the user should look: the trip is due, or it
 * was missed. The one exception is the new semester's reminder (`kind:
 * 'term'`), which carries its own words, in English and Chinese.
 *
 * The Worker signs its own OAuth token from the service account in
 * FCM_SERVICE_ACCOUNT (RS256 with WebCrypto) and keeps it in KV for 50
 * minutes. A token FCM no longer knows is cleared from its session.
 */

import type { Env } from './types.ts';
import { WEB_PREFIX, parseSubscription, sendWebPush, webPushEnabled } from './webpush.ts';

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_KV = 'fcm:access';
const TOKEN_TTL_S = 50 * 60;

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
    return a.project_id && a.client_email && a.private_key ? a : null;
  } catch {
    return null;
  }
}

/** Whether push is set up at all. */
export const pushEnabled = (env: Env) => account(env) !== null || webPushEnabled(env);

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
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

async function accessToken(env: Env, a: ServiceAccount, nowMs: number): Promise<string> {
  const cached = await env.KV.get(TOKEN_KV).catch(() => null);
  if (cached) return cached;
  const res = await fetch(a.token_uri ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: await signJwt(a, Math.floor(nowMs / 1000)) }),
  });
  if (!res.ok) throw new Error(`fcm oauth ${res.status}`);
  const { access_token } = (await res.json()) as { access_token?: string };
  if (!access_token) throw new Error('fcm oauth: no token');
  await env.KV.put(TOKEN_KV, access_token, { expirationTtl: TOKEN_TTL_S }).catch(() => {});
  return access_token;
}

/**
 * Nudges every device of a user that registered for push. Returns how many
 * were sent. Never throws: push is a nicety on top of the apps' own refresh.
 */
export async function nudgeUser(env: Env, userId: string, nudge: Nudge, nowMs: number, exceptTokenHash?: string): Promise<number> {
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
 * The new semester's reminder (monitor.ts): a notification the apps show as
 * it is, rather than a card to fetch. Returns how many devices it went to.
 */
export async function remindUser(env: Env, userId: string, notice: Notice, nowMs: number): Promise<number> {
  const words = { title: notice.title, body: notice.body, zhTitle: notice.zhTitle, zhBody: notice.zhBody };
  return deliver(env, userId, { web: { kind: 'term', ...words }, fcm: { kind: 'term', ...words }, urgent: false, collapse: 'term', ttlS: 2 * 86_400 }, nowMs);
}

interface Delivery {
  /** The web push's payload, or null to send browsers nothing. */
  web: Record<string, unknown> | null;
  /** FCM data: strings only. */
  fcm: Record<string, string>;
  urgent: boolean;
  /** A newer message with the same key replaces one not yet delivered. */
  collapse: string;
  ttlS: number;
}

/** Sends one message to every device of a user that takes push, and clears tokens that are gone. */
async function deliver(env: Env, userId: string, msg: Delivery, nowMs: number, exceptTokenHash?: string): Promise<number> {
  const a = account(env);
  if (!pushEnabled(env) || !env.DB) return 0;
  try {
    const { results } = await env.DB.prepare('SELECT token_hash, push_token FROM sessions WHERE user_id = ? AND push_token IS NOT NULL AND token_hash != ?')
      .bind(userId, exceptTokenHash ?? '')
      .all<{ token_hash: string; push_token: string }>();
    if (!results.length) return 0;
    let bearer: string | null = null;
    let sent = 0;
    for (const r of results) {
      if (r.push_token.startsWith(WEB_PREFIX)) {
        if (!msg.web) continue;
        let sub = null;
        try {
          sub = parseSubscription(JSON.parse(r.push_token.slice(WEB_PREFIX.length)));
        } catch {
          sub = null;
        }
        // One browser's failure (a key that won't import, a service that hangs) mustn't stop the rest.
        const out = sub
          ? await sendWebPush(env, sub, msg.web, { urgent: msg.urgent, nowMs, topic: msg.collapse, ttlS: msg.ttlS }).catch((err) => {
              console.error('web push', String(err));
              return 'failed' as const;
            })
          : 'gone';
        if (out === 'sent') sent++;
        else if (out === 'gone') await env.DB.prepare('UPDATE sessions SET push_token = NULL WHERE token_hash = ?').bind(r.token_hash).run();
        continue;
      }
      if (!a) continue;
      const send = (token: string) =>
        fetch(`https://fcm.googleapis.com/v1/projects/${a.project_id}/messages:send`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            message: {
              token: r.push_token,
              data: msg.fcm,
              android: { priority: msg.urgent ? 'HIGH' : 'NORMAL', ttl: `${msg.ttlS}s`, collapse_key: msg.collapse },
            },
          }),
        });
      bearer ??= await accessToken(env, a, nowMs);
      let res = await send(bearer);
      if (res.status === 401) {
        // The access token went stale before its cache entry did: a new one, and once more.
        await env.KV.delete(TOKEN_KV).catch(() => {});
        bearer = await accessToken(env, a, nowMs);
        res = await send(bearer);
      }
      if (res.ok) {
        sent++;
      } else if (res.status === 404 || res.status === 400) {
        // UNREGISTERED or INVALID_ARGUMENT: the app was uninstalled or the token is stale.
        await env.DB.prepare('UPDATE sessions SET push_token = NULL WHERE token_hash = ?').bind(r.token_hash).run();
      } else {
        console.error('fcm send', res.status);
      }
    }
    return sent;
  } catch (err) {
    console.error('push failed', err instanceof Error ? err.message : typeof err);
    return 0;
  }
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
