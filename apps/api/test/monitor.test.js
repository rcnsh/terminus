import test from 'node:test';
import assert from 'node:assert/strict';

import { makeKV } from './_stubs.mjs';
import { makeD1, makeEmail } from './_d1.mjs';
import { DEVICE_IDLE_MS, adviceFor, checkUpstream, housekeeping, readUpstream } from '../src/monitor.ts';

function env() {
  return { NUSBUS_KV: makeKV(), EMAIL: makeEmail(), EMAIL_FROM: 'login@example.test', ALERT_EMAIL: 'ops@example.test' };
}
const ok = async () => ({});
const fail = (msg) => async () => {
  throw new Error(msg);
};

test('first check up: recorded, no email', async () => {
  const e = env();
  const { state, changed } = await checkUpstream(e, 1000, ok);
  assert.equal(state.up, true);
  assert.equal(changed, true);
  assert.equal(e.EMAIL.sent.length, 0);
});

test('alerts once when the feed goes down, once when it recovers', async () => {
  const e = env();
  await checkUpstream(e, 1000, ok);
  await checkUpstream(e, 2000, fail('auth rejected: code=10009 msg=We have a new release of uNivUS'));
  await checkUpstream(e, 3000, fail('auth rejected: code=10009 msg=We have a new release of uNivUS'));
  assert.equal(e.EMAIL.sent.length, 1, 'no repeat while still down');
  assert.match(e.EMAIL.sent[0].subject, /down/);
  assert.match(e.EMAIL.sent[0].text, /NEXTBUS_APP_VERSION/, '10009 says exactly what to update');
  assert.equal((await readUpstream(e)).since, 2000, 'since = when it went down');

  await checkUpstream(e, 4000, ok);
  assert.equal(e.EMAIL.sent.length, 2);
  assert.match(e.EMAIL.sent[1].subject, /recovered/);
});

test('down on the very first check still alerts', async () => {
  const e = env();
  await checkUpstream(e, 1000, fail('network'));
  assert.equal(e.EMAIL.sent.length, 1);
});

test('no alert address configured: records state, sends nothing', async () => {
  const e = { ...env(), ALERT_EMAIL: undefined };
  await checkUpstream(e, 1000, fail('network'));
  assert.equal(e.EMAIL.sent.length, 0);
  assert.equal((await readUpstream(e)).up, false);
});

test('advice names the likely fix per upstream code', () => {
  assert.match(adviceFor('code=10009'), /NEXTBUS_APP_VERSION/);
  assert.match(adviceFor('code=10008'), /device id/);
  assert.match(adviceFor('Invalid API KEY'), /rotated/);
  assert.match(adviceFor('ECONNRESET'), /wrangler tail/);
});

test('housekeeping removes expired links, codes, sessions and idle devices only', async () => {
  const db = makeD1();
  const now = 10 * DEVICE_IDLE_MS;
  db.exec(`INSERT INTO users VALUES ('u', 'a@b.c', 0)`);
  db.exec(`INSERT INTO magic_links VALUES ('old', 'a@b.c', 0, ${now - 1}), ('new', 'a@b.c', 0, ${now + 1})`);
  db.exec(`INSERT INTO pair_codes VALUES ('AAAAAA', 'u', ${now - 1}), ('BBBBBB', 'u', ${now + 1})`);
  db.exec(`INSERT INTO sessions VALUES
    ('w-old', 'u', 'web', NULL, 0, 0, ${now - 1}),
    ('w-new', 'u', 'web', NULL, 0, 0, ${now + 1}),
    ('d-idle', 'u', 'device', 'x', 0, ${now - DEVICE_IDLE_MS - 1}, NULL),
    ('d-used', 'u', 'device', 'y', 0, ${now - 1000}, NULL)`);
  await housekeeping(db, now);
  const left = (t, c) => db._db.prepare(`SELECT ${c} AS k FROM ${t} ORDER BY 1`).all().map((r) => r.k);
  assert.deepEqual(left('magic_links', 'token_hash'), ['new']);
  assert.deepEqual(left('pair_codes', 'code'), ['BBBBBB']);
  assert.deepEqual(left('sessions', 'token_hash'), ['d-used', 'w-new']);
});
