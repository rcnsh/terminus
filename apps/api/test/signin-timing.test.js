/**
 * The sign-in link's clock: one email per address a minute, and a link that
 * dies after 15 minutes. Straight against requestLink()/redeemLink() at
 * chosen times, since the HTTP tests all run at one frozen moment.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FROZEN_NOW, makeEnv } from './_stubs.mjs';
import { makeD1, makeEmail } from './_d1.mjs';
import { linkEmail, redeemLink, requestLink } from '../src/accounts.ts';

const ORIGIN = 'https://bus.example.test';
const ADDR = 'friend@u.nus.edu';
const MIN = 60_000;

function setup() {
  const email = makeEmail();
  const env = { ...makeEnv(), DB: makeD1(), EMAIL: email, EMAIL_FROM: 'terminus@example.test' };
  // KV's own cooldown mark is a second guard and only eventually consistent
  // across data centres; dropping it leaves D1's check, which must hold alone.
  const forgetKvCooldown = () => {
    for (const k of [...env.KV._map.keys()]) if (k.startsWith('mail:')) env.KV._map.delete(k);
  };
  return { env, email, forgetKvCooldown };
}

test('a second link inside the minute is refused by the database alone; after it, one is sent', async () => {
  const { env, email, forgetKvCooldown } = setup();
  assert.equal(await requestLink(env, env.DB, ADDR, ORIGIN, FROZEN_NOW), 'sent');
  forgetKvCooldown();
  assert.equal(await requestLink(env, env.DB, ADDR, ORIGIN, FROZEN_NOW + 30_000), 'cooldown');
  assert.equal(email.sent.length, 1);
  forgetKvCooldown();
  assert.equal(await requestLink(env, env.DB, ADDR, ORIGIN, FROZEN_NOW + 61_000), 'sent');
  assert.equal(email.sent.length, 2);
});

test('a link works at 14 minutes and is dead at 16', async () => {
  const { env, email } = setup();
  await requestLink(env, env.DB, ADDR, ORIGIN, FROZEN_NOW);
  const token = email.lastToken();
  assert.equal(await linkEmail(env.DB, token, FROZEN_NOW + 14 * MIN), ADDR);
  assert.equal(await linkEmail(env.DB, token, FROZEN_NOW + 16 * MIN), null);
  assert.equal(await redeemLink(env.DB, token, FROZEN_NOW + 16 * MIN), null);
  assert.ok(await redeemLink(env.DB, token, FROZEN_NOW + 14 * MIN), 'still live before then');
});
