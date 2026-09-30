/**
 * Web Push (phase 5): the same nudge as the Android push, to the installed
 * web app, including on iPhone (iOS 16.4 and later, from the Home Screen).
 *
 * A subscription is kept on its session like an FCM token, as `web:` and the
 * subscription's JSON (sessions.push_token), so push.ts sends to both kinds.
 * Each push is signed for the browser's push service with the VAPID key in
 * VAPID_PRIVATE_KEY (a P-256 JWK, RFC 8292) and its payload encrypted for the
 * browser (aes128gcm, RFC 8291), all with WebCrypto. The payload is the nudge
 * (phase, question); the service worker fetches the card and words the
 * notification itself.
 */

import type { Env } from './types.ts';

export const WEB_PREFIX = 'web:';
/** The contact push services see with each push. */
const SUBJECT = 'https://terminus.rcn.sh';

export interface WebSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

interface Vapid {
  jwk: JsonWebKey;
  /** The public key, uncompressed and base64url: what the browser subscribes with. */
  publicKey: string;
}

const enc = new TextEncoder();

export const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function vapid(env: Env): Vapid | null {
  if (!env.VAPID_PRIVATE_KEY) return null;
  try {
    const jwk = JSON.parse(env.VAPID_PRIVATE_KEY) as JsonWebKey;
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) return null;
    return { jwk, publicKey: b64url(concat(new Uint8Array([4]), fromB64url(jwk.x), fromB64url(jwk.y))) };
  } catch {
    return null;
  }
}

export const webPushEnabled = (env: Env) => vapid(env) !== null;
export const vapidPublicKey = (env: Env) => vapid(env)?.publicKey ?? null;

/** A subscription from the browser, checked before it's kept. */
export function parseSubscription(v: unknown): WebSubscription | null {
  const s = v as Partial<WebSubscription> | null;
  if (!s || typeof s.endpoint !== 'string' || s.endpoint.length > 1024) return null;
  let url: URL;
  try {
    url = new URL(s.endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const p256dh = s.keys?.p256dh;
  const auth = s.keys?.auth;
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return null;
  try {
    if (fromB64url(p256dh).length !== 65 || fromB64url(auth).length !== 16) return null;
  } catch {
    return null;
  }
  return { endpoint: s.endpoint, keys: { p256dh, auth } };
}

/** The VAPID JWT for one push service (its origin), valid 12 hours. */
async function vapidAuth(v: Vapid, endpoint: string, nowMs: number): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: SUBJECT })));
  const key = await crypto.subtle.importKey('jwk', { ...v.jwk, key_ops: ['sign'], ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // WebCrypto signs ECDSA as r || s, which is exactly ES256's form.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${v.publicKey}`;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/** RFC 8291: the payload encrypted for this subscription, as one aes128gcm record. */
export async function encryptPayload(sub: WebSubscription, payload: Uint8Array): Promise<Uint8Array> {
  const uaPublic = fromB64url(sub.keys.p256dh);
  const authSecret = fromB64url(sub.keys.auth);
  const local = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', local.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  // The Workers types spell the peer key `$public`; the runtime, like the spec, takes `public`.
  const ecdh = { name: 'ECDH', public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, local.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // One record: the payload, then the last-record delimiter, no padding.
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(payload, new Uint8Array([2]))));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, sealed);
}

export type WebPushResult = 'sent' | 'gone' | 'failed';

/** Sends one push. 'gone' means the subscription is dead and should be forgotten. */
export async function sendWebPush(
  env: Env,
  sub: WebSubscription,
  data: Record<string, unknown>,
  { urgent, nowMs }: { urgent: boolean; nowMs: number },
): Promise<WebPushResult> {
  const v = vapid(env);
  if (!v) return 'failed';
  const body = await encryptPayload(sub, enc.encode(JSON.stringify(data)));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      authorization: await vapidAuth(v, sub.endpoint, nowMs),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: '600',
      urgency: urgent ? 'high' : 'normal',
      // One card at a time: a newer nudge replaces one not yet delivered.
      topic: 'card',
    },
    body,
  });
  if (res.status === 404 || res.status === 410) return 'gone';
  if (!res.ok) {
    console.error('web push', res.status);
    return 'failed';
  }
  return 'sent';
}
