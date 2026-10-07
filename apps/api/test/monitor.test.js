import test from 'node:test';
import assert from 'node:assert/strict';

import { makeKV } from './_stubs.mjs';
import { makeD1, makeEmail } from './_d1.mjs';
import { readFileSync } from 'node:fs';
import { DEVICE_IDLE_MS, INCIDENTS_KEPT, KV_NAMESPACE_ID, adviceFor, checkCalendar, checkUpstream, feedDownSince, housekeeping, readIncidents, readUpstream, runCron } from '../src/monitor.ts';
import { UpstreamRejected } from '../src/auth.ts';
import { cardFor } from '../src/card.ts';
import { withLang } from '../src/i18n.ts';

function env() {
  return { KV: makeKV(), EMAIL: makeEmail(), EMAIL_FROM: 'login@example.test', ALERT_EMAIL: 'ops@example.test' };
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
  assert.equal(e.EMAIL.sent.length, 0, 'one failed check is a blip');
  await checkUpstream(e, 3000, fail('auth rejected: code=10009 msg=We have a new release of uNivUS'));
  await checkUpstream(e, 3500, fail('auth rejected: code=10009 msg=We have a new release of uNivUS'));
  assert.equal(e.EMAIL.sent.length, 1, 'no repeat while still down');
  assert.match(e.EMAIL.sent[0].subject, /down/);
  assert.match(e.EMAIL.sent[0].text, /NEXTBUS_APP_VERSION/, '10009 says exactly what to update');
  assert.equal((await readUpstream(e)).since, 3000, 'since = when it was confirmed down');

  await checkUpstream(e, 4000, ok);
  assert.equal(e.EMAIL.sent.length, 2);
  assert.match(e.EMAIL.sent[1].subject, /recovered/);
});

test('confirmed outages are kept for the status page, with a cause and no error text', async () => {
  const e = env();
  await checkUpstream(e, 1000, ok);
  assert.deepEqual(await readIncidents(e), [], 'the first "up" is not an incident');
  await checkUpstream(e, 2000, fail('network'));
  assert.deepEqual(await readIncidents(e), [], 'one failed check is a blip');
  await checkUpstream(e, 3000, fail('network'));
  await checkUpstream(e, 3500, fail('network'));
  assert.deepEqual(await readIncidents(e), [{ start: 3000, end: null, cause: 'feed' }]);
  await checkUpstream(e, 4000, ok);
  await checkUpstream(e, 4500, ok);
  assert.deepEqual(await readIncidents(e), [{ start: 3000, end: 4000, cause: 'feed' }]);

  const refused = fail('auth rejected: code=10009 msg=We have a new release of uNivUS');
  const noFix = async () => ({ status: 'failed', note: 'nothing found' });
  await checkUpstream(e, 5000, refused, noFix);
  await checkUpstream(e, 6000, refused, noFix);
  const list = await readIncidents(e);
  assert.equal(list.length, 2, 'newest first');
  assert.deepEqual(list[0], { start: 6000, end: null, cause: 'version' });
  assert.ok(!JSON.stringify(list).includes('uNivUS'), "NUS's text stays private");

  for (let i = 0, t = 7000; i < INCIDENTS_KEPT; i++, t += 3000) {
    await checkUpstream(e, t, ok);
    await checkUpstream(e, t + 1000, fail('network'));
    await checkUpstream(e, t + 2000, fail('network'));
  }
  assert.equal((await readIncidents(e)).length, INCIDENTS_KEPT, 'capped');
});

test('down from the very first checks still alerts', async () => {
  const e = env();
  await checkUpstream(e, 1000, fail('network'));
  await checkUpstream(e, 2000, fail('network'));
  assert.equal(e.EMAIL.sent.length, 1);
});

test('an alert that fails to send is retried on the next run', async () => {
  const e = env();
  await checkUpstream(e, 1000, ok);
  const send = e.EMAIL.send;
  e.EMAIL.send = async () => { throw new Error('email service down'); };
  await checkUpstream(e, 2000, fail('network'));
  await checkUpstream(e, 3000, fail('network'));
  assert.equal((await readUpstream(e)).pending, 'down');
  e.EMAIL.send = send;
  await checkUpstream(e, 4000, fail('network'));
  assert.equal(e.EMAIL.sent.length, 1);
  assert.equal((await readUpstream(e)).pending, null);
});

test('cron: a KV failure in one step does not stop the others', async () => {
  const e = env();
  const db = makeD1();
  let cleaned = false;
  const batch = db.batch.bind(db);
  db.batch = async (s) => { cleaned = true; return batch(s); };
  e.KV.put = async () => { throw new Error('KV write quota'); };
  const orig = console.error;
  console.error = () => {};
  await runCron({ ...e, DB: db }, 1000);
  console.error = orig;
  assert.ok(cleaned, 'housekeeping still ran');
});

test('calendar: warns once a week inside the last 45 days, not before', async () => {
  const e = env();
  const through = '2027-08-23';
  assert.equal(await checkCalendar(e, Date.parse('2027-06-01T00:00:00Z'), through), false);
  assert.equal(await checkCalendar(e, Date.parse('2027-07-20T00:00:00Z'), through), true);
  assert.equal(await checkCalendar(e, Date.parse('2027-07-22T00:00:00Z'), through), false, 'not again within a week');
  assert.match(e.EMAIL.sent[0].text, /2027-08-23/);
});

test('a corrupt state key reads as no state, not a crash', async () => {
  const e = env();
  await e.KV.put('monitor:upstream', '{not json');
  assert.equal(await readUpstream(e), null);
});

test('no alert address configured: records state, sends nothing', async () => {
  const e = { ...env(), ALERT_EMAIL: undefined };
  await checkUpstream(e, 1000, fail('network'));
  await checkUpstream(e, 2000, fail('network'));
  assert.equal(e.EMAIL.sent.length, 0);
  assert.equal((await readUpstream(e)).up, false);
});

test('the beta records state but leaves the alerts to the stable site', async () => {
  const e = { ...env(), PUBLIC_ORIGIN: 'https://beta.terminus.rcn.sh' };
  for (let t = 1000; t <= 10_000; t += 1000) await checkUpstream(e, t, fail('network'));
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
  db.exec(`INSERT INTO users (id, email, created, last_seen) VALUES ('u', 'a@b.c', 0, 0)`);
  db.exec(`INSERT INTO magic_links (token_hash, email, created, expires) VALUES ('old', 'a@b.c', 0, ${now - 1}), ('new', 'a@b.c', 0, ${now + 1})`);
  db.exec(`INSERT INTO pair_codes VALUES ('AAAAAA', 'u', ${now - 1}), ('BBBBBB', 'u', ${now + 1})`);
  db.exec(`INSERT INTO sessions (token_hash, user_id, kind, name, created, last_seen, expires) VALUES
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

test('a refused version: the alert gives the one-line KV fix and NUS\'s whole response', async () => {
  const e = env();
  const body = '{"code":"10009","msg":"We have a new release of uNivUS","data":{"store":"https://example.test/new"}}';
  const refused = async () => {
    throw new UpstreamRejected('10009', 'auth rejected: code=10009 msg=We have a new release of uNivUS', body);
  };
  await checkUpstream(e, 1000, refused);
  await checkUpstream(e, 2000, refused);
  const text = e.EMAIL.sent[0].text;
  assert.match(text, /cf kv keys put config:appVersion --namespace-id [0-9a-f]{32} --body univus_android_<versionName>_<versionCode>/);
  assert.match(text, /id=sg\.edu\.nus\.univus/);
  assert.ok(text.includes(body), 'the full response is in the email');
  assert.equal((await readUpstream(e)).detail, body);
  await checkUpstream(e, 3000, ok);
  assert.equal((await readUpstream(e)).detail, null, 'cleared once it recovers');
});

test('a refusal that echoes our request back has its credentials blanked before the logs and the email', async () => {
  const e = env();
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJndWVzdCJ9.c2lnbmF0dXJl';
  const body = JSON.stringify({ code: '10009', msg: 'refused', request: { token: jwt, userid: 'guest-123', deviceid: 'dev-abc', domain: 'nus' }, note: `Bearer ${jwt}` });
  const refused = async () => {
    throw new UpstreamRejected('10009', 'auth rejected: code=10009 msg=refused', body);
  };
  const logged = [];
  const log = console.log;
  console.log = (...a) => logged.push(a.join(' '));
  try {
    await checkUpstream(e, 1000, refused);
    await checkUpstream(e, 2000, refused);
  } finally {
    console.log = log;
  }
  const text = e.EMAIL.sent[0].text;
  for (const out of [text, (await readUpstream(e)).detail, logged.join('\n')]) {
    assert.doesNotMatch(out, /eyJ|guest-123|dev-abc/);
    assert.match(out, /"msg":"refused"/, 'the rest is kept as the clue');
    assert.match(out, /"domain":"nus"/);
  }
});

test('the KV namespace in the alert commands is the stable one in cloudflare.config.ts', () => {
  const config = readFileSync(new URL('../cloudflare.config.ts', import.meta.url), 'utf8');
  const id = /name: "terminus",[\s\S]*?\bkv: "([0-9a-f]+)"/.exec(config)?.[1];
  assert.equal(KV_NAMESPACE_ID, id);
});

test('the card says when the feed is down, on an answer without a live time', async () => {
  const e = env();
  await checkUpstream(e, 1000, ok);
  assert.equal(await feedDownSince(e, 1000), null);
  const down = Date.parse('2026-09-28T01:14:00Z'); // 9:14 in Singapore
  await checkUpstream(e, down - 900_000, fail('HTTP 502'));
  assert.equal(await feedDownSince(e, down - 10_000), null, 'one failed check is a blip');
  await checkUpstream(e, down, fail('HTTP 502'));
  assert.equal(await feedDownSince(e, down + 30_000), null, 'read again at most once a minute');
  assert.equal(await feedDownSince(e, down + 60_000), down);

  const answer = JSON.parse(readFileSync(new URL('./fixtures/answers/class-bus.json', import.meta.url), 'utf8'));
  assert.equal(cardFor(answer, true, undefined, down).notice, null, 'a live answer: the feed is back');
  const guess = { ...answer, quality: 'scheduled' };
  assert.equal(cardFor(guess, true, undefined, down).notice, "NUS's live bus times have been down since 9:14\u00a0AM.");
  assert.equal(withLang('zh', () => cardFor(guess, false, undefined, down).notice), 'NUS 的实时巴士时间自 09:14 起无法获取。');
  assert.equal(cardFor(guess, true).notice, null, 'up');
});
