import type { Env } from '../types.ts';

export const WEB_PREFIX = 'web:';
const SUBJECT = 'https://terminus.run';

export interface WebSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

interface Vapid {
  jwk: JsonWebKey;
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

const warned = new Set<string>();

export function warnUnusable(secret: string): void {
  if (warned.has(secret)) return;
  warned.add(secret);
  console.error(`push: ${secret} is set but unusable, so that push is off`);
}

function vapid(env: Env): Vapid | null {
  if (!env.VAPID_PRIVATE_KEY) return null;
  try {
    const jwk = JSON.parse(env.VAPID_PRIVATE_KEY) as JsonWebKey;
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) throw new Error('not a P-256 private key');
    return { jwk, publicKey: b64url(concat(new Uint8Array([4]), fromB64url(jwk.x), fromB64url(jwk.y))) };
  } catch {
    warnUnusable('VAPID_PRIVATE_KEY');
    return null;
  }
}

export const webPushEnabled = (env: Env) => vapid(env) !== null;
export const vapidPublicKey = (env: Env) => vapid(env)?.publicKey ?? null;

const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)*push\.apple\.com$/,
  /^([a-z0-9-]+\.)*notify\.windows\.com$/,
];

export function parseSubscription(v: unknown): WebSubscription | null {
  const s = v as Partial<WebSubscription> | null;
  if (!s || typeof s.endpoint !== 'string' || s.endpoint.length > 1024) return null;
  let url: URL;
  try {
    url = new URL(s.endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  if (!PUSH_HOSTS.some((h) => h.test(url.hostname))) return null;
  const p256dh = s.keys?.p256dh;
  const auth = s.keys?.auth;
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return null;
  try {
    const key = fromB64url(p256dh);
    if (key.length !== 65 || key[0] !== 4 || fromB64url(auth).length !== 16) return null;
  } catch {
    return null;
  }
  return { endpoint: s.endpoint, keys: { p256dh, auth } };
}

async function vapidAuth(v: Vapid, endpoint: string, nowMs: number): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(
    enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: SUBJECT })),
  );
  const key = await crypto.subtle.importKey(
    'jwk',
    { ...v.jwk, key_ops: ['sign'], ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${v.publicKey}`;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

export async function encryptPayload(sub: WebSubscription, payload: Uint8Array): Promise<Uint8Array> {
  const uaPublic = fromB64url(sub.keys.p256dh);
  const authSecret = fromB64url(sub.keys.auth);
  const local = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', local.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = { name: 'ECDH', public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, local.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(payload, new Uint8Array([2]))));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, sealed);
}

export type WebPushResult = 'sent' | 'gone' | 'failed';

export async function sendWebPush(
  env: Env,
  sub: WebSubscription,
  data: Record<string, unknown>,
  { urgent, nowMs, topic = 'card', ttlS = 600 }: { urgent: boolean; nowMs: number; topic?: string; ttlS?: number },
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
      ttl: String(ttlS),
      urgency: urgent ? 'high' : 'normal',
      topic,
    },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(5_000),
  });
  if (res.status === 404 || res.status === 410) return 'gone';
  if (!res.ok) {
    console.error('web push', res.status);
    return 'failed';
  }
  return 'sent';
}
