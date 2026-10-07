import test from 'node:test';
import assert from 'node:assert/strict';

import { makeKV } from './_stubs.mjs';
import { makeD1, makeEmail } from './_d1.mjs';
import { readFileSync } from 'node:fs';
import { DEVICE_IDLE_MS, INCIDENTS_KEPT, KV_NAMESPACE_ID, MAIL_TIMEOUT_MS, adviceFor, checkCalendar, checkUpstream, feedDownSince, housekeeping, readIncidents, readUpstream, runCron } from '../src/monitor.ts';
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
  assert.equal(e.EMAIL.sent.length, 1, 'one good check could be a blip too');
  await checkUpstream(e, 4500, ok);
  assert.equal(e.EMAIL.sent.length, 2);
  assert.match(e.EMAIL.sent[1].subject, /recovered/);
  assert.equal((await readUpstream(e)).since, 4000, 'since = the first of the good checks that confirmed it');
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
  await checkUpstream(e, 4700, ok);
  assert.deepEqual(await readIncidents(e), [{ start: 3000, end: 4000, cause: 'feed' }], 'it ended at the first good check');

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
    await checkUpstream(e, t + 500, ok);
    await checkUpstream(e, t + 1000, fail('network'));
    await checkUpstream(e, t + 2000, fail('network'));
  }
  assert.equal((await readIncidents(e)).length, INCIDENTS_KEPT, 'capped');
});

/** Makes KV reads (or writes) of the keys matching `re` fail until undone. */
function breakKV(e, re, op = 'get') {
  const real = e.KV[op];
  e.KV[op] = async (k, ...rest) => {
    if (re.test(k)) throw new Error('KV unavailable');
    return real.call(e.KV, k, ...rest);
  };
  return () => {
    e.KV[op] = real;
  };
}

async function confirmedDown(e) {
  await checkUpstream(e, 1000, ok);
  await checkUpstream(e, 2000, fail('network'));
  await checkUpstream(e, 3000, fail('network'));
  assert.equal((await readUpstream(e)).up, false);
}

test('a KV read that fails changes nothing: no state, no email, no incident', async () => {
  // While the feed is down: read as "never checked", it would be marked up
  // and the next failure would email "down" a second time.
  const e = env();
  await confirmedDown(e);
  const before = e.KV._map.get('monitor:upstream');
  const undo = breakKV(e, /^monitor:upstream$/);
  await assert.rejects(checkUpstream(e, 4000, fail('network')));
  await assert.rejects(checkUpstream(e, 5000, ok));
  undo();
  assert.equal(e.KV._map.get('monitor:upstream'), before);
  await checkUpstream(e, 6000, fail('network'));
  assert.equal(e.EMAIL.sent.length, 1, 'one "down" email');
  assert.deepEqual(await readIncidents(e), [{ start: 3000, end: null, cause: 'feed' }]);
  // And once it's back, the incident closes.
  await checkUpstream(e, 7000, ok);
  await checkUpstream(e, 8000, ok);
  assert.deepEqual(await readIncidents(e), [{ start: 3000, end: 7000, cause: 'feed' }]);
});

test('an incident whose close was not saved is closed on the next run', async () => {
  const e = env();
  await confirmedDown(e);
  const undo = breakKV(e, /^monitor:incidents$/, 'put');
  const quiet = console.error;
  console.error = () => {};
  await checkUpstream(e, 4000, ok);
  await checkUpstream(e, 5000, ok);
  console.error = quiet;
  undo();
  assert.equal((await readIncidents(e))[0].end, null, 'still open');
  await checkUpstream(e, 6000, ok);
  assert.deepEqual(await readIncidents(e), [{ start: 3000, end: 4000, cause: 'feed' }], 'closed when it came back');
  await checkUpstream(e, 7000, fail('network'));
  await checkUpstream(e, 8000, fail('network'));
  assert.deepEqual((await readIncidents(e)).map((i) => [i.start, i.end]), [[8000, null], [3000, 4000]]);
});

test('an incident whose opening was not saved is opened on the next run, once', async () => {
  const e = env();
  const undo = breakKV(e, /^monitor:incidents$/, 'put');
  const quiet = console.error;
  console.error = () => {};
  await confirmedDown(e);
  console.error = quiet;
  undo();
  assert.deepEqual(await readIncidents(e), []);
  await checkUpstream(e, 4000, fail('network'));
  await checkUpstream(e, 5000, fail('network'));
  assert.deepEqual(await readIncidents(e), [{ start: 3000, end: null, cause: 'feed' }]);
});

test('an older incident left open is closed, at the latest when a new one opens', async () => {
  const e = env();
  await e.KV.put('monitor:upstream', JSON.stringify({ up: true, since: 500, reason: null, checkedAt: 500 }));
  await e.KV.put('monitor:incidents', JSON.stringify([{ start: 100, end: null, cause: 'feed' }]));
  const undo = breakKV(e, /^monitor:incidents$/, 'put');
  const quiet = console.error;
  console.error = () => {};
  await checkUpstream(e, 1000, ok);
  await checkUpstream(e, 2000, fail('network'));
  console.error = quiet;
  undo();
  await checkUpstream(e, 3000, fail('network'));
  assert.deepEqual(await readIncidents(e), [
    { start: 3000, end: null, cause: 'feed' },
    { start: 100, end: 3000, cause: 'feed' },
  ]);
});

test('a failed read of the incidents never writes over their history', async () => {
  const e = env();
  const history = Array.from({ length: 5 }, (_, i) => ({ start: 100 * i, end: 100 * i + 50, cause: 'feed' }));
  await e.KV.put('monitor:incidents', JSON.stringify(history));
  const undo = breakKV(e, /^monitor:incidents$/);
  const quiet = console.error;
  console.error = () => {};
  await confirmedDown(e);
  console.error = quiet;
  undo();
  assert.deepEqual(await readIncidents(e), history);
  await checkUpstream(e, 4000, fail('network'));
  const list = await readIncidents(e);
  assert.equal(list.length, 6, 'opened on the next run, with the history kept');
  assert.deepEqual(list[0], { start: 3000, end: null, cause: 'feed' });
});

test('a feed that answers every other check stays down: no "up" and "down" by turns', async () => {
  const e = env();
  await confirmedDown(e);
  for (let t = 4000; t < 12_000; t += 2000) {
    await checkUpstream(e, t, ok);
    await checkUpstream(e, t + 1000, fail('network'));
  }
  assert.equal(e.EMAIL.sent.length, 1);
  assert.equal((await readIncidents(e)).length, 1);
  assert.equal(await feedDownSince(e, 20_000), 3000);
});

test('a state that cannot be saved sends no email, rather than the same one every run', async () => {
  const e = env();
  await checkUpstream(e, 1000, ok);
  await checkUpstream(e, 2000, fail('network'));
  e.KV.put = async () => {
    throw new Error('KV write quota');
  };
  for (let t = 3000; t <= 6000; t += 1000) await assert.rejects(checkUpstream(e, t, fail('network')));
  assert.equal(e.EMAIL.sent.length, 0);
});

test('an alert email that hangs gives up and stays pending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const e = env();
  await checkUpstream(e, 1000, fail('network'));
  let asked;
  const called = new Promise((r) => (asked = r));
  e.EMAIL.send = () => {
    asked();
    return new Promise(() => {});
  };
  const quiet = console.error;
  console.error = () => {};
  const run = checkUpstream(e, 2000, fail('network'));
  await called;
  t.mock.timers.tick(MAIL_TIMEOUT_MS);
  const { state } = await run;
  console.error = quiet;
  assert.equal(state.pending, 'down');
  assert.equal((await readUpstream(e)).pending, 'down', 'sent again next run');
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
  await checkUpstream(e, 5000, fail('network'));
  assert.equal(e.EMAIL.sent.length, 1, 'not again');
  assert.equal((await readUpstream(e)).pending, null);
});

/**
 * KV as Cloudflare runs it: a second write to a key within a second is
 * refused (429). Each check here is its own run, a second or more apart.
 */
function oneWritePerKey(e) {
  const put = e.KV.put.bind(e.KV);
  const written = new Set();
  e.KV.put = async (k, ...rest) => {
    if (written.has(k)) throw new Error('KV PUT failed: 429 Too Many Requests');
    written.add(k);
    return put(k, ...rest);
  };
  return () => written.clear();
}

test('each alert goes once, with KV taking one write a second to a key', async () => {
  for (const beta of [false, true]) {
    const e = beta ? { ...env(), PUBLIC_ORIGIN: 'https://beta.terminus.rcn.sh' } : env();
    const nextRun = oneWritePerKey(e);
    const quiet = console.error;
    const errors = [];
    console.error = (...a) => errors.push(a.join(' '));
    const steps = [ok, ok, fail('network'), fail('network'), fail('network'), fail('network'), ok, ok, ok, ok];
    for (const [i, probe] of steps.entries()) {
      nextRun();
      await checkUpstream(e, 1000 * (i + 1), probe);
    }
    console.error = quiet;
    assert.deepEqual(errors, [], beta ? 'beta' : 'stable');
    assert.deepEqual(e.EMAIL.sent.map((m) => m.subject.match(/down|recovered/)[0]), beta ? [] : ['down', 'recovered']);
    assert.equal((await readUpstream(e)).pending, null);
  }
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

test('cron: a failed step is counted with the errors on the dashboard', async () => {
  const rows = [];
  const e = { ...env(), AE: { writeDataPoint: (p) => rows.push(p) } };
  e.KV.put = async () => { throw new Error('KV write quota'); };
  const orig = console.error;
  console.error = () => {};
  await runCron(e, 1000);
  console.error = orig;
  const failed = rows.filter((r) => r.blobs[0] === 'error').map((r) => r.blobs[1]);
  assert.ok(failed.includes('cron upstream'), failed.join());
  assert.ok(rows.every((r) => r.indexes[0] === 'error'));
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

test('cron: the large tables are swept once a Singapore day, the short-lived codes every run', async () => {
  const e = env();
  const db = makeD1();
  const swept = [];
  const batch = db.batch.bind(db);
  db.batch = async (s) => { swept.push(s.length); return batch(s); };
  const orig = console.error;
  console.error = () => {};
  const day = Date.UTC(2026, 9, 7, 2); // 10:00 in Singapore
  await runCron({ ...e, DB: db }, day);
  await runCron({ ...e, DB: db }, day + 15 * 60_000);
  await runCron({ ...e, DB: db }, day + 86_400_000);
  console.error = orig;
  assert.deepEqual(swept.filter((n) => n >= 3), [7, 3, 7]);
});

test('cron: a failed daily sweep is tried again on the next run', async () => {
  const e = env();
  const db = makeD1();
  const sizes = [];
  const batch = db.batch.bind(db);
  let fail = true;
  db.batch = async (s) => {
    sizes.push(s.length);
    if (fail && s.length === 7) { fail = false; throw new Error('D1 busy'); }
    return batch(s);
  };
  const orig = console.error;
  console.error = () => {};
  const day = Date.UTC(2026, 9, 7, 2);
  await runCron({ ...e, DB: db }, day);
  await runCron({ ...e, DB: db }, day + 15 * 60_000);
  await runCron({ ...e, DB: db }, day + 30 * 60_000);
  console.error = orig;
  assert.deepEqual(sizes.filter((n) => n >= 3), [7, 7, 3]);
});

test('the hot and housekeeping lookups use an index, not a table scan', () => {
  const db = makeD1();
  const plan = (sql) => db._db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join('; ');
  assert.match(plan("SELECT svc, stop, slot, n, packed FROM crowd_stats WHERE daytype = 'term' AND n >= 3 AND stop IN ('COM3', 'UTOWN')"), /USING INDEX crowd_stats_lookup/);
  assert.match(plan("UPDATE sessions SET push_token = NULL WHERE push_token = 'x'"), /USING INDEX sessions_push/);
  assert.match(plan('DELETE FROM users INDEXED BY users_anon_idle WHERE email IS NULL AND last_seen < 5'), /USING INDEX users_anon_idle/);
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
