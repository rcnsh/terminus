/**
 * Payload-free Web Push ("tickle").
 *
 * The server sends an empty push; the service worker wakes up and calls the
 * API itself, so the times shown are fresh at display time rather than fresh
 * at send time. Encrypted payloads need an ECDH exchange per subscription and
 * a lot of code that goes subtly wrong -- and would show times that are
 * already stale by the time the phone buzzes.
 *
 * This also means the subscription's p256dh/auth keys are never needed, so
 * they are never stored.
 *
 * Chosen over geofencing because background location on Android is
 * permission-heavy and gets killed by OEM battery managers.
 */

import type { Env } from './types.ts';

const SUB_PREFIX = 'sub:';

export function pushConfigured(env: Env): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

export function b64urlToBytes(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(b: Uint8Array): string {
  let s = '';
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function utf8B64url(s: string): string {
  return bytesToB64url(new TextEncoder().encode(s));
}

async function signingKey(env: Env): Promise<CryptoKey> {
  const pub = b64urlToBytes(env.VAPID_PUBLIC_KEY ?? '');
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('VAPID_PUBLIC_KEY must be a base64url uncompressed P-256 point (65 bytes)');
  }
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    d: (env.VAPID_PRIVATE_KEY ?? '').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    ext: true,
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** VAPID JWT (ES256) via Web Crypto. WebCrypto already returns raw r||s. */
export async function vapidJwt(env: Env, audience: string, nowMs = Date.now()): Promise<string> {
  const header = utf8B64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = utf8B64url(
    JSON.stringify({
      aud: audience,
      exp: Math.floor(nowMs / 1000) + 12 * 3600,
      sub: env.VAPID_SUBJECT,
    }),
  );
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    await signingKey(env),
    data,
  );
  return `${header}.${payload}.${bytesToB64url(new Uint8Array(sig))}`;
}

async function subKey(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return SUB_PREFIX + bytesToB64url(new Uint8Array(digest)).slice(0, 24);
}

export async function saveSubscription(env: Env, endpoint: string, nowMs = Date.now()): Promise<void> {
  // Deliberately stores the endpoint only. Payload-free push needs no keys,
  // so no crypto material belonging to the browser is retained.
  await env.NUSBUS_KV.put(await subKey(endpoint), JSON.stringify({ endpoint, createdAt: nowMs }));
}

export async function listSubscriptions(env: Env): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.NUSBUS_KV.list({ prefix: SUB_PREFIX, cursor });
    for (const k of page.keys) {
      const v = await env.NUSBUS_KV.get(k.name, 'json');
      const endpoint = (v as { endpoint?: string } | null)?.endpoint;
      if (endpoint) out.push(endpoint);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

/** Returns true if delivered. Prunes subscriptions the push service has retired. */
export async function tickle(env: Env, endpoint: string, nowMs = Date.now()): Promise<boolean> {
  const aud = new URL(endpoint).origin;
  const jwt = await vapidJwt(env, aud, nowMs);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
      ttl: '120',
      'content-length': '0',
    },
  });
  if (res.status === 404 || res.status === 410) {
    await env.NUSBUS_KV.delete(await subKey(endpoint)).catch(() => {});
    return false;
  }
  return res.ok;
}

export async function tickleAll(env: Env, nowMs = Date.now()): Promise<{ sent: number; failed: number }> {
  if (!pushConfigured(env)) return { sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;
  for (const endpoint of await listSubscriptions(env)) {
    try {
      (await tickle(env, endpoint, nowMs)) ? sent++ : failed++;
    } catch {
      failed++;
    }
  }
  return { sent, failed };
}
