/**
 * Every rate-limit binding, refusing: each route it guards answers 429 and
 * says when to try again, before doing any of the work it protects.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { installGlobals, makeCtx, makeEnv, makeFetch } from './_stubs.mjs';
import { makeD1, makeEmail } from './_d1.mjs';
import worker from '../src/index.ts';

const BASE = 'https://bus.example.test';

/** A limiter that always says no, and remembers the keys it was asked about. */
function refusing() {
  const keys = [];
  return { keys, limit: async ({ key }) => (keys.push(key), { success: false }) };
}

function setup(bindings) {
  installGlobals(makeFetch());
  const env = { ...makeEnv(), DB: makeD1(), EMAIL: makeEmail(), EMAIL_FROM: 'x@example.test', ...bindings };
  const call = async (path, { method = 'GET', body } = {}) => {
    const headers = body === undefined ? {} : { 'content-type': 'application/json' };
    const ctx = makeCtx();
    const res = await worker.fetch(new Request(BASE + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, ctx);
    await ctx.settle();
    return res;
  };
  return { env, call };
}

async function assert429(res, retryAfter) {
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), retryAfter);
  assert.ok((await res.json()).error);
}

test('RL_PUBLIC caps /health, /status.json, /admin/stats, downloads and timelapse days per IP', async () => {
  for (const path of ['/api/health', '/api/status.json', '/api/admin/stats', '/download/terminus.apk', '/api/timelapse/days']) {
    const rl = refusing();
    const { call } = setup({ RL_PUBLIC: rl });
    await assert429(await call(path), '60');
    assert.deepEqual(rl.keys, ['pub:unknown'], path);
  }
});

test('RL_PUBLIC caps the sign-in link page and /auth/config', async () => {
  for (const [path, method] of [['/auth/verify?t=abc', 'GET'], ['/api/auth/config', 'GET']]) {
    const { call } = setup({ RL_PUBLIC: refusing() });
    await assert429(await call(path, { method }), '60');
  }
});

test('the global RL_ANON ceiling refuses a new anonymous web account', async () => {
  const { env, call } = setup({ RL_ANON: refusing() });
  const res = await call('/api/auth/anon/web', { method: 'POST', body: {} });
  assert.equal(res.headers.get('set-cookie'), null, 'no session');
  await assert429(res, '60');
  assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0, 'no account made');
});

test('the app polling for its sign-in is capped per IP', async () => {
  const rl = refusing();
  const { call } = setup({ RL_PUBLIC: rl });
  await assert429(await call('/api/auth/app/poll', { method: 'POST', body: { request: 'r', poll: 'p' } }), '10');
  assert.deepEqual(rl.keys, ['poll:unknown']);
});
