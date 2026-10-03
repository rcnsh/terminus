/**
 * Web Push (phase 5): the web app subscribes with POST /me/push, and a nudge
 * reaches it signed (VAPID, RFC 8292) and encrypted (aes128gcm, RFC 8291).
 * The browser's side is played here with WebCrypto: the push is decrypted
 * with the subscription's own keys and the JWT checked against the public key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { installGlobals, makeCtx, makeEnv, makeFetch } from './_stubs.mjs';
import { makeD1, makeEmail } from './_d1.mjs';
import worker from '../src/index.ts';
import { nudgeUser } from '../src/push.ts';
import { b64url, fromB64url } from '../src/webpush.ts';

const BASE = 'https://bus.example.test';
const ENDPOINT = 'https://web.push.apple.com/send/abc123';
const enc = new TextEncoder();

async function vapidKey() {
  const { privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return JSON.stringify(await crypto.subtle.exportKey('jwk', privateKey));
}

/** A browser's subscription: its ECDH key pair and auth secret. */
async function browser() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { pair, raw, auth, subscription: { endpoint: ENDPOINT, keys: { p256dh: b64url(raw), auth: b64url(auth) } } };
}

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/** What the browser does with an aes128gcm push (RFC 8291), written independently of webpush.ts. */
async function decrypt(b, body) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const sealed = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, b.pair.privateKey, 256));
  const info = new Uint8Array([...enc.encode('WebPush: info\0'), ...b.raw, ...asPublic]);
  const ikm = await hkdf(b.auth, shared, info, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, sealed));
  assert.equal(plain[plain.length - 1], 2, 'one record, marked last');
  return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
}

async function setup() {
  const pushes = [];
  const status = { code: 201 };
  const base = makeFetch();
  const fetchImpl = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://web.push.apple.com/')) {
      pushes.push({ url, headers: new Headers(init.headers), body: new Uint8Array(init.body) });
      return new Response(null, { status: status.code });
    }
    return base(input, init);
  };
  installGlobals(fetchImpl);
  const env = { ...makeEnv(), DB: makeD1(), EMAIL: makeEmail(), EMAIL_FROM: 'x@example.test', VAPID_PRIVATE_KEY: await vapidKey() };
  const call = async (path, { method = 'GET', cookie, body } = {}) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const ctx = makeCtx();
    const res = await worker.fetch(new Request(BASE + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, ctx);
    await ctx.settle();
    return res;
  };
  await call('/auth/login', { method: 'POST', body: { email: 'you@u.nus.edu' } });
  const verify = await worker.fetch(
    new Request(`${BASE}/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `t=${env.EMAIL.lastToken()}` }),
    env,
    makeCtx(),
  );
  const cookie = verify.headers.get('set-cookie').split(';')[0];
  const userId = (await env.DB.prepare('SELECT id FROM users').first()).id;
  const pushToken = async () => (await env.DB.prepare('SELECT push_token FROM sessions').first()).push_token;
  return { env, call, cookie, pushes, status, userId, pushToken };
}

test('the web app gets the public key, subscribes, and a nudge arrives signed and encrypted', async () => {
  const { env, call, cookie, pushes, userId, pushToken } = await setup();
  const { key } = await (await call('/me/push/key', { cookie })).json();
  assert.equal(fromB64url(key).length, 65, 'an uncompressed P-256 key');

  const b = await browser();
  assert.equal((await call('/me/push', { method: 'POST', cookie, body: { subscription: b.subscription } })).status, 200);
  assert.match(await pushToken(), /^web:\{"endpoint":"https:\/\/web\.push\.apple\.com/);

  const sent = await nudgeUser(env, userId, { phase: 'due', urgent: true, remind: true }, Date.now());
  assert.equal(sent, 1);
  const [p] = pushes;
  assert.equal(p.url, ENDPOINT);
  assert.equal(p.headers.get('content-encoding'), 'aes128gcm');
  assert.equal(p.headers.get('urgency'), 'high');
  assert.equal(p.headers.get('ttl'), '600');
  assert.deepEqual(await decrypt(b, p.body), { kind: 'card', phase: 'due', urgent: true });

  // The VAPID JWT: for the push service's origin, signed by the key the browser subscribed with.
  const [, t, k] = p.headers.get('authorization').match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, key);
  const [h, c, s] = t.split('.');
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(c)));
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.ok(claims.exp > Date.now() / 1000 && claims.sub.startsWith('https://'));
  const pub = await crypto.subtle.importKey('raw', fromB64url(key), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, fromB64url(s), enc.encode(`${h}.${c}`)));
});

test('nothing is pushed to the web app when there is nothing to show', async () => {
  const { env, call, cookie, pushes, userId } = await setup();
  await call('/me/push', { method: 'POST', cookie, body: { subscription: (await browser()).subscription } });
  assert.equal(await nudgeUser(env, userId, { phase: 'idle', urgent: false }, Date.now()), 0, 'an idle card');
  assert.equal(await nudgeUser(env, userId, { phase: 'due', urgent: true, remind: false }, Date.now()), 0, 'reminders off for the trip');
  assert.equal(pushes.length, 0);
});

test('a subscription the push service has dropped is forgotten', async () => {
  const { env, call, cookie, status, userId, pushToken } = await setup();
  await call('/me/push', { method: 'POST', cookie, body: { subscription: (await browser()).subscription } });
  status.code = 410;
  assert.equal(await nudgeUser(env, userId, { phase: 'due', urgent: true }, Date.now()), 0);
  assert.equal(await pushToken(), null);
});

test('a bad subscription is refused, and without a VAPID key web push says it is off', async () => {
  const { env, call, cookie } = await setup();
  const bad = [{ endpoint: 'http://push.example.test/x', keys: { p256dh: 'AA', auth: 'AA' } }, { endpoint: ENDPOINT }, 'nope'];
  const real = (await browser()).subscription;
  // Only browsers' push services: the Worker POSTs to whatever is kept here.
  for (const endpoint of ['https://evil.example/x', 'https://web.push.apple.com.evil.example/x', 'https://web.push.apple.com:8443/x', 'https://u:p@web.push.apple.com/x']) {
    bad.push({ ...real, endpoint });
  }
  // Not a P-256 point: it would fail at every push.
  bad.push({ ...real, keys: { ...real.keys, p256dh: b64url(new Uint8Array(65)) } });
  for (const subscription of bad) assert.equal((await call('/me/push', { method: 'POST', cookie, body: { subscription } })).status, 400);
  delete env.VAPID_PRIVATE_KEY;
  assert.equal((await call('/me/push/key', { cookie })).status, 503);
  assert.equal((await call('/me/push', { method: 'POST', cookie, body: { subscription: (await browser()).subscription } })).status, 503);
});
