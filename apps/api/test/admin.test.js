import test from 'node:test';
import assert from 'node:assert/strict';

import { makeKV } from './_stubs.mjs';
import { adminStats, isOperator, timingSafeEqual } from '../src/ops/admin.ts';

test('the dashboard asks Analytics Engine with the token, and says so when it fails', async () => {
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push({ url, auth: init.headers.authorization, sql: init.body });
    return new Response(JSON.stringify({ data: [{ day: '2026-09-30', kind: 'answer', n: 12 }] }));
  };
  const env = { KV: makeKV(), ANALYTICS_TOKEN: 'ae-token', CF_ACCOUNT_ID: 'acct' };
  const s = await adminStats(env, Date.now(), fetchImpl);
  assert.equal(asked.length, 9);
  assert.match(asked[3].sql, /blob1 = 'timelapse'/, "the recorder's polls, by what they cost NUS");
  // The dashboard lines these up with Singapore days (parts.js lastDays), and compares two full weeks besides today.
  for (const i of [0, 3]) assert.match(asked[i].sql, /formatDateTime\(timestamp, '%Y-%m-%d', 'Asia\/Singapore'\) AS day/);
  assert.match(asked[0].sql, /INTERVAL '15' DAY/);
  assert.match(asked[4].sql, /blob1 = 'active'/, 'the daily active counts');
  assert.match(asked[5].sql, /blob1 = 'apperror'/, 'the error reports, by fingerprint');
  assert.match(asked[7].sql, /blob1 = 'legacy'/, 'what still uses the old address and paths');
  assert.match(asked[8].sql, /blob1 = 'settings'/, "the settings' daily counts");
  assert.ok(
    asked.every((a) => a.url === 'https://api.cloudflare.com/client/v4/accounts/acct/analytics_engine/sql' && a.auth === 'Bearer ae-token'),
  );
  assert.ok(asked.every((a) => /FROM terminus/.test(a.sql)));
  assert.deepEqual(s.analytics.daily, [{ day: '2026-09-30', kind: 'answer', n: 12 }]);

  const down = await adminStats(env, Date.now(), async () => new Response('no', { status: 403 }));
  assert.deepEqual(down.analytics, { error: 'Analytics Engine answered 403' });
});

test('operator check: needs the configured token, exactly', async () => {
  const req = (t) => new Request('https://x.test/api/admin/stats', { headers: t ? { 'x-health-token': t } : {} });
  assert.equal(await isOperator({ HEALTH_TOKEN: 'abc' }, req('abc')), true);
  assert.equal(await isOperator({ HEALTH_TOKEN: 'abc' }, req('abd')), false);
  assert.equal(await isOperator({ HEALTH_TOKEN: 'abc' }, req('abcd')), false);
  assert.equal(await isOperator({ HEALTH_TOKEN: 'abc' }, req(null)), false);
  assert.equal(await isOperator({}, req('')), false, 'no token configured: nobody');
});

test('the token compare gets every length and prefix right', () => {
  for (const [given, ok] of [
    ['secret', true],
    ['secre', false],
    ['secret!', false],
    ['', false],
    ['Secret', false],
    ['secret\u0000', false],
    ['xsecret', false],
  ]) {
    assert.equal(timingSafeEqual(given, 'secret'), ok, JSON.stringify(given));
  }
});
