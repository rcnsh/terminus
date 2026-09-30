/**
 * Push, phase 3: Firebase Cloud Messaging (HTTP v1) to Android devices, and
 * (phase 5) Web Push to the installed web app (webpush.ts), both kept as the
 * session's push_token: an FCM token, or `web:` and a subscription.
 *
 * A push is only a nudge. It says the card has changed (`kind: 'card'`, the
 * phase, and whether there's a question), and the app fetches /me/next
 * itself, so the words are never worked out twice and nothing sensitive
 * travels through Google. It's high priority only when the user should look:
 * the trip is due, the bus has left and there's a question, or it was missed.
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
  /** A question is showing ("On the 9:41 D2?"). */
  ask: boolean;
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
        // Every web push shows a notification (iOS insists), so nothing to
        // show means nothing sent: an idle card, or reminders off for the trip.
        if ((nudge.phase === 'idle' && !nudge.ask) || nudge.remind === false) continue;
        let sub = null;
        try {
          sub = parseSubscription(JSON.parse(r.push_token.slice(WEB_PREFIX.length)));
        } catch {
          sub = null;
        }
        const out = sub ? await sendWebPush(env, sub, { kind: 'card', phase: nudge.phase, ask: nudge.ask, urgent: nudge.urgent }, { urgent: nudge.urgent, nowMs }) : 'gone';
        if (out === 'sent') sent++;
        else if (out === 'gone') await env.DB.prepare('UPDATE sessions SET push_token = NULL WHERE token_hash = ?').bind(r.token_hash).run();
        continue;
      }
      if (!a) continue;
      bearer ??= await accessToken(env, a, nowMs);
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${a.project_id}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: r.push_token,
            data: { kind: 'card', phase: nudge.phase, ask: nudge.ask ? '1' : '0' },
            android: { priority: nudge.urgent ? 'HIGH' : 'NORMAL', ttl: '600s', collapse_key: 'card' },
          },
        }),
      });
      if (res.ok) {
        sent++;
      } else if (res.status === 404 || res.status === 400) {
        // UNREGISTERED or INVALID_ARGUMENT: the app was uninstalled or the token is stale.
        await env.DB.prepare('UPDATE sessions SET push_token = NULL WHERE token_hash = ?').bind(r.token_hash).run();
      } else if (res.status === 401) {
        await env.KV.delete(TOKEN_KV).catch(() => {});
        console.error('fcm send 401');
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

/** Registers (or with null, forgets) this device's FCM token. A token lives on one session only. */
export async function setPushToken(db: D1Database, tokenHash: string, pushToken: string | null): Promise<void> {
  const stmts = [];
  if (pushToken) stmts.push(db.prepare('UPDATE sessions SET push_token = NULL WHERE push_token = ?').bind(pushToken));
  stmts.push(db.prepare('UPDATE sessions SET push_token = ? WHERE token_hash = ?').bind(pushToken, tokenHash));
  await db.batch(stmts);
}
