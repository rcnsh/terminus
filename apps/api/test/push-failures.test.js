/**
 * Push when things go wrong (push.ts, webpush.ts): a stale FCM access token,
 * Firebase refusing to mint one, the database failing, and a web push
 * service erroring. Each is counted as it should be, and nobody's
 * registration is thrown away for a fault that isn't theirs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeEnv } from './_stubs.mjs';
import { makeD1 } from './_d1.mjs';
import { remindUser } from '../src/push.ts';
import { b64url } from '../src/webpush.ts';

const NOW = Date.parse('2026-08-27T01:00:00Z');
const NOTICE = { title: 't', body: 'b', zhTitle: 't', zhBody: 'b' };
const MINT = 'https://oauth2.googleapis.com/token';
const SEND = 'https://fcm.googleapis.com/';
const PUSH = 'https://web.push.apple.com/send/abc123';

async function serviceAccount() {
  const { privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey)).toString('base64');
  const pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
  return JSON.stringify({ project_id: 'terminus-test', client_email: 'push@terminus-test.iam.gserviceaccount.com', private_key: pem });
}

async function subscription() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { endpoint: PUSH, keys: { p256dh: b64url(raw), auth: b64url(crypto.getRandomValues(new Uint8Array(16))) } };
}

async function vapidKey() {
  const { privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return JSON.stringify(await crypto.subtle.exportKey('jwk', privateKey));
}

/** A user whose devices have these push tokens, and a fetch that plays Firebase and the push service. */
async function setup(tokens, { mint = () => new Response('{}', { status: 500 }), send = () => Response.json({}), push = () => new Response(null, { status: 201 }) } = {}) {
  const db = makeD1();
  db._db.prepare("INSERT INTO users (id, email, created, last_seen) VALUES ('u1', 'a@u.nus.edu', 0, 0)").run();
  tokens.forEach((t, i) => db._db.prepare("INSERT INTO sessions (token_hash, user_id, kind, created, last_seen, push_token) VALUES (?, 'u1', 'device', 0, 0, ?)").run(`h${i}`, t));
  const calls = { mints: 0, sends: [], pushes: 0 };
  globalThis.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (url === MINT) return (calls.mints++, mint(calls.mints));
    if (url.startsWith(SEND)) {
      calls.sends.push(init.headers.authorization);
      return send(calls.sends.length);
    }
    if (url === PUSH) return (calls.pushes++, push(calls.pushes));
    throw new Error(`unexpected fetch ${url}`);
  };
  const env = { ...makeEnv(), DB: db, FCM_SERVICE_ACCOUNT: await serviceAccount() };
  const pushToken = (i) => db._db.prepare('SELECT push_token FROM sessions WHERE token_hash = ?').get(`h${i}`).push_token;
  return { env, db, calls, pushToken };
}

const quietly = async (fn) => {
  const err = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = err;
  }
};

test('an FCM 401: the kept access token is dropped from KV, a new one minted, and the push sent again', async () => {
  const { env, calls, pushToken } = await setup(['fcm-phone'], {
    mint: (n) => Response.json({ access_token: `access-${n}` }),
    send: (n) => (n === 1 ? new Response('{}', { status: 401 }) : Response.json({ name: 'ok' })),
  });
  const deleted = [];
  const del = env.KV.delete.bind(env.KV);
  env.KV.delete = (k) => (deleted.push(k), del(k));
  assert.deepEqual(await remindUser(env, 'u1', NOTICE, NOW), { sent: 1, failed: 0 });
  assert.equal(calls.mints, 2);
  assert.deepEqual(calls.sends, ['Bearer access-1', 'Bearer access-2']);
  assert.deepEqual(deleted, ['fcm:access']);
  assert.equal(await env.KV.get('fcm:access'), 'access-2', 'the new token is kept');
  assert.equal(pushToken(0), 'fcm-phone', 'the device keeps its registration');
});

test('a failed mint marks Firebase down for the rest of the delivery: one try, every phone failed', async () => {
  const { env, calls, pushToken } = await setup(['fcm-phone', 'fcm-tablet']);
  assert.deepEqual(await quietly(() => remindUser(env, 'u1', NOTICE, NOW)), { sent: 0, failed: 2 });
  assert.equal(calls.mints, 1, 'not asked again for the second phone');
  assert.equal(calls.sends.length, 0);
  assert.equal(pushToken(0), 'fcm-phone');
  assert.equal(pushToken(1), 'fcm-tablet');
});

test('a mint that fails on the retry after a 401 also counts as failed, keeping the token', async () => {
  const { env, calls, pushToken } = await setup(['fcm-phone', 'fcm-tablet'], {
    mint: (n) => (n === 1 ? Response.json({ access_token: 'access-1' }) : new Response('{}', { status: 500 })),
    send: () => new Response('{}', { status: 401 }),
  });
  assert.deepEqual(await quietly(() => remindUser(env, 'u1', NOTICE, NOW)), { sent: 0, failed: 2 });
  assert.equal(calls.mints, 2);
  assert.equal(calls.sends.length, 1, 'Firebase was down for the second phone');
  assert.equal(pushToken(0), 'fcm-phone');
});

test('the database failing is one failure, not a thrown error', async () => {
  const { env, calls } = await setup(['fcm-phone']);
  env.DB = { prepare: () => ({ bind: () => ({ all: async () => { throw new Error('D1_ERROR: storage down'); } }) }) };
  assert.deepEqual(await quietly(() => remindUser(env, 'u1', NOTICE, NOW)), { sent: 0, failed: 1 });
  assert.equal(calls.sends.length, 0);
});

test('a web push service answering 5xx counts as failed and keeps the subscription', async () => {
  const sub = `web:${JSON.stringify(await subscription())}`;
  const { env, calls, pushToken } = await setup([sub], { push: () => new Response('down', { status: 503 }) });
  env.VAPID_PRIVATE_KEY = await vapidKey();
  delete env.FCM_SERVICE_ACCOUNT;
  assert.deepEqual(await quietly(() => remindUser(env, 'u1', NOTICE, NOW)), { sent: 0, failed: 1 });
  assert.equal(calls.pushes, 1);
  assert.equal(pushToken(0), sub, 'still subscribed');
});
