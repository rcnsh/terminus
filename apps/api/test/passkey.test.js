/**
 * Passkeys for the operator's pages (src/passkey.ts): adding one needs
 * HEALTH_TOKEN itself; signing in with one gives a session that opens the
 * dashboard and the timelapse days as the token does, and nothing more.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { installGlobals, makeCtx, makeEnv, makeFetch } from './_stubs.mjs';
import { makeAuthenticator } from './_passkey.mjs';
import worker from '../src/index.ts';
import { challengeOk, derToRaw, newChallenge, newSession, PASSKEYS_KEY, SESSION_MS, sessionOk } from '../src/passkey.ts';

const BASE = 'https://bus.example.test';
const TOKEN = 'operator-secret';

function setup(extra = {}) {
  installGlobals(makeFetch());
  const env = { ...makeEnv(), HEALTH_TOKEN: TOKEN, ...extra };
  const call = async (path, { method = 'GET', body, token, origin = BASE } = {}) => {
    const headers = { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { 'x-health-token': token } : {}) };
    const ctx = makeCtx();
    const res = await worker.fetch(new Request(origin + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, ctx);
    await ctx.settle();
    return res;
  };
  const challenge = async () => (await (await call('/api/admin/passkey/challenge')).json()).challenge;
  return { env, call, challenge };
}

for (const alg of [-7, -8]) {
  test(`a passkey (${alg === -7 ? 'ES256' : 'Ed25519'}) added with the token signs in, and its session opens the dashboard`, async () => {
    const { env, call, challenge } = setup();
    const a = await makeAuthenticator({ alg });

    const added = await call('/api/admin/passkey/register', { method: 'POST', token: TOKEN, body: await a.create(await challenge()) });
    assert.equal(added.status, 201, await added.clone().text());
    const kept = JSON.parse(await env.KV.get(PASSKEYS_KEY));
    assert.deepEqual(kept.map((p) => [p.id, p.rpId, p.alg, p.name]), [[a.id, 'bus.example.test', alg, 'test device']]);

    const res = await call('/api/admin/passkey/signin', { method: 'POST', body: await a.get(await challenge()) });
    assert.equal(res.status, 200, await res.clone().text());
    const { session, expires } = await res.json();
    assert.match(session, /^op1\.\d{13}\./);
    assert.ok(Date.parse(expires) > Date.now());

    assert.equal((await call('/api/admin/stats', { token: session })).status, 200, 'the session opens the dashboard');
    assert.equal((await call('/api/admin/stats', { token: session.slice(0, -2) + 'AA' })).status, 404, 'a forged one does not');
    const again = await call('/api/admin/passkey/register', { method: 'POST', token: session, body: await (await makeAuthenticator()).create(await challenge()) });
    assert.equal(again.status, 404, 'a session cannot add a passkey');
  });
}

test('without the token, nothing is added', async () => {
  const { env, call, challenge } = setup();
  const a = await makeAuthenticator();
  for (const token of [undefined, 'wrong']) {
    const res = await call('/api/admin/passkey/register', { method: 'POST', token, body: await a.create(await challenge()) });
    assert.equal(res.status, 404);
  }
  assert.equal(await env.KV.get(PASSKEYS_KEY), null);
});

test('a challenge to add a passkey checks the token first, and lists the ones kept here', async () => {
  const { call, challenge } = setup();
  const reg = (token, origin) => call('/api/admin/passkey/challenge?register=1', { token, origin });
  assert.equal((await reg()).status, 404);
  assert.equal((await reg('wrong')).status, 404);
  const { session } = await newSession(TOKEN, Date.now());
  assert.equal((await reg(session)).status, 404, 'a session will not do');
  assert.deepEqual((await (await reg(TOKEN)).json()).exclude, []);
  const a = await makeAuthenticator();
  await call('/api/admin/passkey/register', { method: 'POST', token: TOKEN, body: await a.create(await challenge()) });
  assert.deepEqual((await (await reg(TOKEN)).json()).exclude, [a.id]);
  assert.deepEqual((await (await reg(TOKEN, 'https://beta.example.test')).json()).exclude, [], 'only this host’s');
});

test('with HEALTH_TOKEN unset, every passkey route is a 404', async () => {
  const { call } = setup({ HEALTH_TOKEN: undefined });
  assert.equal((await call('/api/admin/passkey/challenge')).status, 404);
  assert.equal((await call('/api/admin/passkey/signin', { method: 'POST', body: {} })).status, 404);
});

test('a passkey is refused: unknown, another site, another host, unverified, a stale or forged challenge', async () => {
  const { call, challenge } = setup();
  const a = await makeAuthenticator();
  assert.equal((await call('/api/admin/passkey/register', { method: 'POST', token: TOKEN, body: await a.create(await challenge()) })).status, 201);

  const signin = (body, origin) => call('/api/admin/passkey/signin', { method: 'POST', body, origin });
  assert.equal((await signin(await (await makeAuthenticator()).get(await challenge()))).status, 403, 'not a kept passkey');
  assert.equal((await signin(await a.get(await challenge(), { o: 'https://evil.example' }))).status, 403, 'signed for another origin');
  assert.equal((await signin(await a.get(await challenge()), 'https://beta.example.test')).status, 403, 'kept for another host');
  assert.equal((await signin(await a.get(await challenge(), { flags: 0x01 }))).status, 403, 'the user was not verified');
  assert.equal((await signin(await a.get(await newChallenge('another token', Date.now())))).status, 403, 'a challenge not ours');
  assert.equal((await signin(await a.get(await newChallenge(TOKEN, Date.now() - 6 * 60_000)))).status, 403, 'a challenge run out');

  const good = await a.get(await challenge());
  assert.equal((await signin({ ...good, signature: (await a.get(await challenge())).signature })).status, 403, 'a signature over something else');
  assert.equal((await signin({ id: a.id })).status, 400);
  assert.equal((await signin(good)).status, 200);

  const b = await makeAuthenticator();
  const made = await b.create(await challenge(), { flags: 0x41 });
  assert.equal((await call('/api/admin/passkey/register', { method: 'POST', token: TOKEN, body: made })).status, 403, 'made without verifying the user');
  const other = await b.create(await challenge());
  assert.equal((await call('/api/admin/passkey/register', { method: 'POST', token: TOKEN, body: { ...other, id: a.id } })).status, 403, 'an id the authenticator did not make');
});

test('a session dies with its expiry, and with the token', async () => {
  const now = Date.now();
  const { session } = await newSession(TOKEN, now);
  assert.equal(await sessionOk(TOKEN, session, now + SESSION_MS - 1), true);
  assert.equal(await sessionOk(TOKEN, session, now + SESSION_MS), false);
  assert.equal(await sessionOk('rotated', session, now), false);
  assert.equal(await sessionOk(undefined, session, now), false);
  assert.equal(await sessionOk(TOKEN, TOKEN, now), false, 'the token itself is not a session');
  assert.equal(await challengeOk(TOKEN, session.split('.')[2], now), false, 'nor is a session a challenge');
});

test('the timelapse days open with a session too', async () => {
  const { call } = setup();
  const { session } = await newSession(TOKEN, Date.now());
  assert.notEqual((await call('/api/timelapse/days', { token: session })).status, 404);
  assert.equal((await call('/api/timelapse/days', { token: 'op1.9999999999999.AAAA' })).status, 404);
});

test('DER signatures come out as r and s, padded and trimmed', () => {
  const r = new Uint8Array(32).fill(1);
  const s = Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 0x80 : i));
  // r with a leading zero dropped (31 bytes), s with one added (its top bit is set).
  const der = Uint8Array.from([0x30, 2 + 31 + 2 + 33, 0x02, 31, ...r.subarray(1), 0x02, 33, 0, ...s]);
  const raw = derToRaw(der);
  assert.deepEqual([...raw.subarray(0, 32)], [0, ...r.subarray(1)]);
  assert.deepEqual([...raw.subarray(32)], [...s]);
  assert.equal(derToRaw(Uint8Array.from([0x31, 0, 0, 0, 0, 0, 0, 0])), null);
});
