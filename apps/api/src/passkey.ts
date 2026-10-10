/**
 * Passkeys for the operator's pages (/admin/, /admin/timelapse/).
 *
 * Adding a passkey needs HEALTH_TOKEN itself; signing in with one gives an
 * operator session, a signed token that does what HEALTH_TOKEN does, sent
 * in the same x-health-token header, for SESSION_MS. So the secret is typed
 * once per device rather than every visit, and a session that leaks dies on
 * its own.
 *
 * Nothing here is stored but the passkeys (KV `operator:passkeys`): the
 * challenge and the session are signed with a key made from HEALTH_TOKEN,
 * so a challenge needs no KV read-after-write, and rotating the token ends
 * every session. A passkey is kept for the host it was made on (its rpId):
 * terminus.run, terminus.rcn.sh and the beta each want their own.
 *
 * WebAuthn is checked by hand with WebCrypto: the browser gives the public
 * key as SPKI (getPublicKey()), so there's no CBOR to read, and attestation
 * isn't asked for (the token is what vouches for a new passkey).
 */

import type { Env } from './types.ts';
import { json } from './http.ts';
import { b64url, fromB64url } from './webpush.ts';

export const PASSKEYS_KEY = 'operator:passkeys';
export const SESSION_MS = 12 * 3_600_000;
export const CHALLENGE_MS = 5 * 60_000;
const MAX_PASSKEYS = 20;
const SESSION_PREFIX = 'op1.';

export interface Passkey {
  id: string;
  rpId: string;
  alg: number;
  /** The public key, SPKI, base64url. */
  key: string;
  name: string;
  created: string;
}

/** The COSE algorithms offered, as WebCrypto names them. */
type ImportAlg = Parameters<SubtleCrypto['importKey']>[2];
type VerifyAlg = Parameters<SubtleCrypto['verify']>[0];
const ALGS: Record<number, { key: ImportAlg; verify: VerifyAlg; der?: boolean }> = {
  [-8]: { key: { name: 'Ed25519' }, verify: { name: 'Ed25519' } },
  [-7]: { key: { name: 'ECDSA', namedCurve: 'P-256' }, verify: { name: 'ECDSA', hash: 'SHA-256' }, der: true },
  [-257]: { key: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verify: { name: 'RSASSA-PKCS1-v1_5' } },
};
export const PASSKEY_ALGS = Object.keys(ALGS).map(Number);

const enc = new TextEncoder();

/* ---------- signing with a key made from HEALTH_TOKEN ---------- */

let keyMemo: { token: string; key: Promise<CryptoKey> } | null = null;

function hmacKey(token: string): Promise<CryptoKey> {
  if (keyMemo?.token !== token) keyMemo = { token, key: crypto.subtle.importKey('raw', enc.encode(`terminus operator passkeys\n${token}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']) };
  return keyMemo.key;
}

/** The label keeps a challenge from ever passing as a session, and back. */
async function mac(token: string, label: string, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(token), concat(enc.encode(label), data)));
}

/** HMAC's own verify: compares in constant time. */
async function macOk(token: string, label: string, data: Uint8Array, sig: Uint8Array): Promise<boolean> {
  return crypto.subtle.verify('HMAC', await hmacKey(token), sig, concat(enc.encode(label), data));
}

function u64(n: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
}

/** A challenge: when it runs out, 16 random bytes, and a MAC over both. */
export async function newChallenge(token: string, nowMs: number): Promise<string> {
  const body = concat(u64(nowMs + CHALLENGE_MS), crypto.getRandomValues(new Uint8Array(16)));
  return b64url(concat(body, (await mac(token, 'challenge', body)).subarray(0, 16)));
}

export async function challengeOk(token: string, challenge: string, nowMs: number): Promise<boolean> {
  const b = decode(challenge);
  if (b?.length !== 40) return false;
  const body = b.subarray(0, 24);
  const want = (await mac(token, 'challenge', body)).subarray(0, 16);
  // A truncated MAC can't use verify(); fold every byte in, as admin.ts does.
  let diff = 0;
  for (let i = 0; i < 16; i++) diff |= want[i] ^ b[24 + i];
  return diff === 0 && Number(new DataView(body.buffer, body.byteOffset).getBigUint64(0)) > nowMs;
}

/** A session: `op1.<expiry ms>.<mac>`. */
export async function newSession(token: string, nowMs: number): Promise<{ session: string; expires: string }> {
  const exp = nowMs + SESSION_MS;
  return { session: `${SESSION_PREFIX}${exp}.${b64url(await mac(token, 'session', enc.encode(String(exp))))}`, expires: new Date(exp).toISOString() };
}

export async function sessionOk(token: string | undefined, given: string | null, nowMs: number): Promise<boolean> {
  if (!token || !given?.startsWith(SESSION_PREFIX)) return false;
  const [exp, sig] = given.slice(SESSION_PREFIX.length).split('.');
  const sigBytes = sig ? decode(sig) : null;
  if (!/^\d{13}$/.test(exp ?? '') || !sigBytes || Number(exp) <= nowMs) return false;
  return macOk(token, 'session', enc.encode(exp), sigBytes);
}

/* ---------- WebAuthn ---------- */

/**
 * clientDataJSON: the right ceremony, from this origin, not framed by
 * another site. Returns the challenge it signed, or null.
 */
export function readClientData(bytes: Uint8Array, type: 'webauthn.create' | 'webauthn.get', origin: string): string | null {
  let c: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    c = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (c?.type !== type || c.origin !== origin || c.crossOrigin === true || typeof c.challenge !== 'string') return null;
  return c.challenge;
}

/**
 * authenticatorData: made for this host, with the user present and verified
 * (a fingerprint, a face or the device's PIN, not just a tap). With a new
 * passkey, also the credential id it holds.
 */
export async function readAuthData(bytes: Uint8Array, rpId: string): Promise<{ credId: string | null } | null> {
  if (bytes.length < 37) return null;
  const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(rpId)));
  for (let i = 0; i < 32; i++) if (rpHash[i] !== bytes[i]) return null;
  const flags = bytes[32];
  if (!(flags & 0x01) || !(flags & 0x04)) return null;
  if (!(flags & 0x40)) return { credId: null };
  if (bytes.length < 55) return null;
  const len = (bytes[53] << 8) | bytes[54];
  if (bytes.length < 55 + len) return null;
  return { credId: b64url(bytes.subarray(55, 55 + len)) };
}

/** ECDSA signatures come DER-wrapped; WebCrypto wants r and s side by side. */
export function derToRaw(der: Uint8Array, size = 32): Uint8Array | null {
  if (der[0] !== 0x30 || der.length < 8) return null;
  let i = der[1] & 0x80 ? 2 + (der[1] & 0x7f) : 2;
  const out = new Uint8Array(size * 2);
  for (let k = 0; k < 2; k++) {
    if (der[i] !== 0x02) return null;
    const len = der[i + 1];
    let v = der.subarray(i + 2, i + 2 + len);
    if (v.length !== len) return null;
    i += 2 + len;
    while (v.length > size && v[0] === 0) v = v.subarray(1);
    if (v.length > size) return null;
    out.set(v, k * size + size - v.length);
  }
  return out;
}

async function importPasskey(key: string, alg: number): Promise<CryptoKey | null> {
  const a = ALGS[alg];
  const spki = decode(key);
  if (!a || !spki) return null;
  return crypto.subtle.importKey('spki', spki, a.key, false, ['verify']).catch(() => null);
}

/** The assertion's signature, over authenticatorData and the hash of clientDataJSON. */
export async function signatureOk(pk: Pick<Passkey, 'key' | 'alg'>, authData: Uint8Array, clientData: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const key = await importPasskey(pk.key, pk.alg);
  if (!key) return false;
  const a = ALGS[pk.alg];
  const sig = a.der ? derToRaw(signature) : signature;
  if (!sig) return false;
  const signed = concat(authData, new Uint8Array(await crypto.subtle.digest('SHA-256', clientData)));
  return crypto.subtle.verify(a.verify, key, sig, signed).catch(() => false);
}

/* ---------- storage ---------- */

export async function readPasskeys(env: Env): Promise<Passkey[]> {
  const list = await env.KV.get<Passkey[]>(PASSKEYS_KEY, 'json').catch(() => null);
  return Array.isArray(list) ? list : [];
}

/* ---------- the routes ---------- */

/**
 * /api/admin/passkey/*. `holdsToken`: the request carries HEALTH_TOKEN
 * itself (a session doesn't count: it can't add a passkey). Everything is
 * 404 while HEALTH_TOKEN is unset, as the other operator routes are.
 */
export async function handlePasskey(req: Request, url: URL, env: Env, nowMs: number, holdsToken: boolean): Promise<Response> {
  const token = env.HEALTH_TOKEN;
  if (!token) return json({ error: 'not found' }, 404);
  const rpId = url.hostname;
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/admin/passkey/challenge') {
    // ?register=1 checks the token before the browser makes a passkey, so
    // a mistyped token never leaves one on the device the server won't
    // know; and lists the ones kept here, so the device doesn't make a second.
    if (url.searchParams.get('register') === '1') {
      if (!holdsToken) return json({ error: 'not found' }, 404);
      const exclude = (await readPasskeys(env)).filter((p) => p.rpId === rpId).map((p) => p.id);
      return json({ challenge: await newChallenge(token, nowMs), rpId, algs: PASSKEY_ALGS, exclude }, 200, { 'cache-control': 'no-store' });
    }
    return json({ challenge: await newChallenge(token, nowMs), rpId, algs: PASSKEY_ALGS }, 200, { 'cache-control': 'no-store' });
  }

  if (route === 'POST /api/admin/passkey/register') {
    if (!holdsToken) return json({ error: 'not found' }, 404);
    const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const clientData = decode(b?.clientData);
    const authData = decode(b?.authData);
    const id = typeof b?.id === 'string' ? b.id : '';
    const alg = Number(b?.alg);
    const key = typeof b?.key === 'string' ? b.key : '';
    if (!clientData || !authData || !id || !key) return json({ error: 'expected id, key, alg, clientData and authData' }, 400);
    const challenge = readClientData(clientData, 'webauthn.create', url.origin);
    const auth = await readAuthData(authData, rpId);
    if (!challenge || !(await challengeOk(token, challenge, nowMs)) || auth?.credId !== id) return json({ error: 'passkey not accepted' }, 403);
    if (!(await importPasskey(key, alg))) return json({ error: 'unsupported passkey type' }, 400);
    const name = typeof b?.name === 'string' ? b.name.trim().slice(0, 60) : '';
    const list = (await readPasskeys(env)).filter((p) => p.id !== id);
    if (list.length >= MAX_PASSKEYS) return json({ error: 'too many passkeys; remove one first' }, 409);
    list.push({ id, rpId, alg, key, name, created: new Date(nowMs).toISOString() });
    await env.KV.put(PASSKEYS_KEY, JSON.stringify(list));
    return json(await newSession(token, nowMs), 201, { 'cache-control': 'no-store' });
  }

  if (route === 'POST /api/admin/passkey/signin') {
    const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const clientData = decode(b?.clientData);
    const authData = decode(b?.authData);
    const signature = decode(b?.signature);
    const id = typeof b?.id === 'string' ? b.id : '';
    if (!clientData || !authData || !signature || !id) return json({ error: 'expected id, clientData, authData and signature' }, 400);
    const pk = (await readPasskeys(env)).find((p) => p.id === id && p.rpId === rpId);
    const challenge = readClientData(clientData, 'webauthn.get', url.origin);
    const ok =
      pk && challenge && (await challengeOk(token, challenge, nowMs)) && (await readAuthData(authData, rpId)) && (await signatureOk(pk, authData, clientData, signature));
    if (!ok) return json({ error: 'passkey not accepted' }, 403);
    return json(await newSession(token, nowMs), 200, { 'cache-control': 'no-store' });
  }

  return json({ error: 'not found' }, 404);
}

/* ---------- bytes ---------- */

function decode(s: unknown): Uint8Array | null {
  if (typeof s !== 'string' || !s || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    return fromB64url(s);
  } catch {
    return null;
  }
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
