/**
 * An app's sign-in email that could not be sent: the app hears 502, and the
 * request that went nowhere doesn't hold the address's one-a-minute cooldown.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { installGlobals, makeCtx, makeEnv, makeFetch } from './_stubs.mjs';
import { makeD1, makeEmail } from './_d1.mjs';
import worker from '../src/index.ts';

const BASE = 'https://bus.example.test';

test('a sign-in email that fails to send is a 502, and trying again at once is allowed', async () => {
  installGlobals(makeFetch());
  const email = makeEmail();
  const send = email.send;
  let down = true;
  email.send = async (msg) => {
    if (down) throw new Error('mail service down');
    return send(msg);
  };
  const env = { ...makeEnv(), DB: makeD1(), EMAIL: email, EMAIL_FROM: 'terminus@example.test' };
  const start = async () => {
    const ctx = makeCtx();
    const res = await worker.fetch(
      new Request(`${BASE}/api/auth/app/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'student@u.nus.edu', name: 'Pixel 8' }) }),
      env,
      ctx,
    );
    await ctx.settle();
    return res;
  };

  const failed = await start();
  assert.equal(failed.status, 502);
  assert.match((await failed.json()).error, /could not send the email/);
  assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM login_requests').get().n, 0, 'the unsent request is gone');

  down = false;
  const again = await start();
  assert.equal(again.status, 201, 'not held back by a cooldown for an email that never went');
  assert.ok((await again.json()).request);
  assert.equal(email.sent.length, 1);
});
