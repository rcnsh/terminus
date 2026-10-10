/**
 * The operator's extra statistics (collect.ts): the switches, the daily
 * active counts (usage.ts), arrival times against where the recorder saw the
 * buses (eta.ts), and crash reports (apperrors.ts). On the real route lines.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeAnalytics, makeBucket, makeCtx, makeEnv, makeKV } from './_stubs.mjs';
import { makeD1 } from './_d1.mjs';
import worker from '../src/index.ts';
import { SHAPES } from '../src/campus.ts';
import { buildDayFile, dayKey, encodeBus, gzip, mapSnapshot, windowOf } from '../src/timelapse.ts';
import { etaKey, etaSummary, passingsOf, recordEta, scoreEtas, statsOf } from '../src/eta.ts';
import { countActive, recordActive } from '../src/usage.ts';
import { fingerprintOf, scrub } from '../src/apperrors.ts';
import { collecting } from '../src/collect.ts';
import { API_VERSION } from '../src/openapi.ts';

const BASE = 'https://bus.example.test';
const DAY = 86_400_000;

async function send(env, path, { method = 'GET', body, headers = {} } = {}) {
  const ctx = makeCtx();
  const res = await worker.fetch(
    new Request(BASE + path, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    env,
    ctx,
  );
  await ctx.settle();
  return res;
}

/* ---------- the switches ---------- */

test('every collector is off until the operator turns it on, and only the operator can', async () => {
  const env = { ...makeEnv(), HEALTH_TOKEN: 'op' };
  for (const name of ['active', 'eta', 'errors']) assert.equal(await collecting(env, name), false, `${name} starts off`);
  assert.equal((await send(env, '/api/admin/collect', { method: 'POST', body: { name: 'errors', on: true } })).status, 404, 'no token, no switch');
  assert.equal(await collecting(env, 'errors'), false);
  const res = await send(env, '/api/admin/collect', { method: 'POST', body: { name: 'errors', on: true }, headers: { 'x-health-token': 'op' } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { active: false, eta: false, errors: true });
  assert.equal(await collecting(env, 'errors'), true);
  assert.equal((await send(env, '/api/admin/collect', { method: 'POST', body: { name: 'errors', on: 'yes' }, headers: { 'x-health-token': 'op' } })).status, 400);
  // KV failing is off: it may hold an "off" nobody can read.
  assert.equal(await collecting({ KV: { get: async () => { throw new Error('down'); } } }, 'errors'), false);
});

/* ---------- crash reports ---------- */

test('a crash report loses what could say who or where, and keeps what says what broke', () => {
  const text = [
    'GET https://terminus.rcn.sh/api/me/next?lat=1.29661&lon=103.77628#x failed',
    'for you@u.nus.edu at /Users/jacob/dev/terminus and C:\\Users\\Jacob\\app',
    'token a1b2c3d4e5f6a7b8c9d0e1f2 code 123456',
    'at sh.rcn.terminus.ui.ComposableSingletonsMainScreenKt.lambda$1(MainScreen.kt:42)',
  ].join('\n');
  const out = scrub(text);
  assert.ok(!out.includes('lat='), 'no query');
  assert.ok(!out.includes('103.77628') && !out.includes('1.29661'), 'no coordinates');
  assert.ok(!out.includes('you@u.nus.edu'), 'no email');
  assert.ok(!out.includes('jacob') && !out.includes('Jacob'), 'no home folder name');
  assert.ok(!out.includes('a1b2c3d4e5f6a7b8c9d0e1f2') && !out.includes('123456'), 'no tokens or long numbers');
  assert.match(out, /https:\/\/terminus\.rcn\.sh\/api\/me\/next failed/, 'the address without its query');
  assert.match(out, /ComposableSingletonsMainScreenKt\.lambda\$1\(MainScreen\.kt:42\)/, 'a long class name is not a token');
});

test('the same crash gets the same fingerprint, whatever its line numbers', async () => {
  const a = await fingerprintOf('android', 'java.lang.IllegalStateException', 'x', 'at a.B.c(B.kt:10)\nat a.D.e(D.kt:20)');
  const b = await fingerprintOf('android', 'java.lang.IllegalStateException', 'y', 'at a.B.c(B.kt:11)\nat a.D.e(D.kt:25)');
  const c = await fingerprintOf('android', 'java.lang.IllegalStateException', 'x', 'at a.X.c(X.kt:10)');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(await fingerprintOf('web', 'TypeError', 'index 3', ''), await fingerprintOf('web', 'TypeError', 'index 4', ''), 'no stack: the message without its numbers');
});

test('POST /api/errors keeps a scrubbed report only while switched on, with no one on it', async () => {
  const ae = makeAnalytics();
  const env = { ...makeEnv(makeKV(), ae), HEALTH_TOKEN: 'op' };
  const report = { platform: 'android', version: '3.1.0', os: 'Android 15', type: 'java.lang.IllegalStateException', message: 'at 1.29661,103.77628', stack: 'at a.B.c(B.kt:10)', fatal: true };
  // A cookie or a token sent along changes nothing: no account is looked up.
  const headers = { cookie: 'terminus_session=abc', authorization: 'Bearer xyz' };
  assert.equal((await send(env, '/api/errors', { method: 'POST', body: report, headers })).status, 204);
  assert.equal(ae.rows('apperror').length, 0, 'off: answered, and dropped');

  await env.KV.put('config:collect:errors', 'on');
  assert.equal((await send(env, '/api/errors', { method: 'POST', body: report, headers })).status, 204);
  const [row] = ae.rows('apperror');
  assert.deepEqual(row.blobs.slice(0, 3), ['apperror', 'android', '3.1.0']);
  assert.equal(row.blobs[4], 'java.lang.IllegalStateException');
  assert.equal(row.blobs[5], 'at <number>,<number>');
  assert.equal(row.blobs[7], 'Android 15');
  assert.deepEqual(row.doubles, [1, 1]);
  assert.ok(!JSON.stringify(row).includes('abc') && !JSON.stringify(row).includes('xyz'));

  await send(env, '/api/errors', { method: 'POST', body: { platform: 'web', version: 'anything', os: 'Chrome 140', type: 'TypeError' } });
  assert.equal(ae.rows('apperror')[1].blobs[2], API_VERSION, "the website's version is the Worker's");

  for (const bad of [{ ...report, platform: 'pager' }, { ...report, version: 'not a version!' }, { ...report, type: '' }, { ...report, os: '<script>' }]) {
    assert.equal((await send(env, '/api/errors', { method: 'POST', body: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal(ae.rows('apperror').length, 2);
});

/* ---------- active counts ---------- */

async function seedSessions(db, now) {
  const user = (id, email) => db.prepare('INSERT INTO users (id, email, created, last_seen, via) VALUES (?, ?, ?, ?, ?)').bind(id, email, now - 90 * DAY, now, 'app').run();
  const session = (hash, uid, kind, ago, platform, client) =>
    db.prepare('INSERT INTO sessions (token_hash, user_id, kind, name, created, last_seen, expires, platform, client) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(hash, uid, kind, null, now - 90 * DAY, now - ago, null, platform, client).run();
  await user('u1', 'a@u.nus.edu');
  await user('u2', null);
  await user('u3', null);
  // u1: Android today and the website today; one account, counted once in all.
  await session('s1', 'u1', 'device', 3_600_000, 'android', 'android/3.1.0');
  await session('s2', 'u1', 'web', 3_600_000, null, null);
  // u2: a Mac three days ago; u3: Android twenty days ago, on an old version.
  await session('s3', 'u2', 'device', 3 * DAY, 'mac', 'mac/3.1.0');
  await session('s4', 'u3', 'device', 20 * DAY, 'android', 'android/3.0.0');
}

test('the active counts: accounts in all and by app, devices by version, nothing per person', async () => {
  const now = Date.UTC(2026, 9, 11, 16, 5);
  const db = makeD1();
  await seedSessions(db, now);
  const rows = await countActive(db, now);
  const of = (scope, name) => rows.find((r) => r.scope === scope && r.name === name);
  assert.deepEqual(of('all', 'all'), { scope: 'all', name: 'all', d1: 1, d7: 2, d30: 3 });
  assert.deepEqual(of('app', 'android'), { scope: 'app', name: 'android', d1: 1, d7: 1, d30: 2 });
  assert.deepEqual(of('app', 'web'), { scope: 'app', name: 'web', d1: 1, d7: 1, d30: 1 });
  assert.deepEqual(of('app', 'mac'), { scope: 'app', name: 'mac', d1: 0, d7: 1, d30: 1 });
  assert.deepEqual(of('version', 'android/3.0.0'), { scope: 'version', name: 'android/3.0.0', d1: 0, d7: 0, d30: 1 });
  assert.equal(of('app', 'api'), undefined, 'no keys used, no row');
  assert.ok(rows.every((r) => Object.keys(r).join() === 'scope,name,d1,d7,d30'), 'totals only');
});

test('the counts are written once a Singapore day, and not at all while switched off', async () => {
  const now = Date.UTC(2026, 9, 11, 16, 5); // 00:05 on the 12th in Singapore
  const ae = makeAnalytics();
  const env = { ...makeEnv(makeKV(), ae), DB: makeD1() };
  await seedSessions(env.DB, now);
  assert.equal(await recordActive(env, now), false, 'off');
  assert.equal(ae.rows('active').length, 0);
  await env.KV.put('config:collect:active', 'on');
  assert.equal(await recordActive(env, now), true);
  const rows = ae.rows('active');
  assert.ok(rows.length >= 6);
  assert.ok(rows.every((r) => r.blobs[3] === '2026-10-11'), 'named after the day that just ended');
  assert.deepEqual(rows.find((r) => r.blobs[1] === 'all').doubles, [1, 2, 3]);
  assert.equal(await recordActive(env, now + 15 * 60_000), false, 'the next run that day writes nothing');
  assert.equal(await recordActive(env, now + DAY), true, 'the next day counts again');
});

/* ---------- arrival times ---------- */

const DATE = '2026-08-26';
const { open } = windowOf(DATE);

/**
 * A recorded day with one bus per entry, driving its route's real line at
 * [speed] m/s from [from] metres, read every 30 s for [readings].
 */
function dayWith(buses) {
  const plates = buses.map((b) => b.plate);
  const rows = [];
  let last = open;
  const fixes = buses.flatMap((b, i) => {
    const total = SHAPES[b.svc].at.at(-1);
    return Array.from({ length: b.readings }, (_, k) => {
      const t = open + (b.start ?? 0) + k * 30_000;
      let along = b.from + b.speed * k * 30;
      if (b.loop) along %= total;
      return { t, svc: b.svc, bus: encodeBus({ plate: b.plate, lat: 1.3, lon: 103.78, along }, i) };
    });
  });
  for (const f of fixes.sort((a, b) => a.t - b.t)) {
    rows.push({ dt: f.t - last, svc: f.svc, buses: f.bus });
    last = f.t;
  }
  return buildDayFile({ date: DATE, t0: open, pollMs: 30_000, plates, rows, map: mapSnapshot() });
}

test('a bus reaches each stop on its line as it passes it, round a loop too, and never "arrives" where a route starts', () => {
  const d2 = SHAPES.D2;
  const total = d2.at.at(-1);
  // D2 is a loop from COM3 to COM3; this bus comes round the end and starts again.
  const loop = passingsOf(dayWith([{ plate: 'PA1A', svc: 'D2', from: total - 300, speed: 8, readings: 10, loop: true }]));
  const com3 = loop.filter((p) => p.stop === 'COM3');
  assert.equal(com3.length, 1, 'COM3 once, across the end of the line');
  // 275 m to the mark 25 m before the stop, at 8 m/s.
  assert.equal(com3[0].t, open + Math.round((275 / 8) * 1000));

  // K runs PGP to PGPR: starting at PGP is not arriving there.
  const k = passingsOf(dayWith([{ plate: 'PA2B', svc: 'K', from: 0, speed: 8, readings: 40 }]));
  assert.ok(!k.some((p) => p.stop === 'PGP'));
  const second = SHAPES.K.stops[1];
  assert.equal(k.find((p) => p.stop === second).t, open + Math.round(((SHAPES.K.at[1] - 25) / 8) * 1000));

  // Readings too far apart, or a jump no bus could make, say nothing.
  assert.deepEqual(passingsOf(dayWith([{ plate: 'PA3C', svc: 'K', from: 0, speed: 8, readings: 2, start: 0 }, { plate: 'PA3C', svc: 'K', from: 2000, speed: 0, readings: 1, start: 600_000 }])).filter((p) => p.plate === 'PA3C' && p.t > open + 30_000), []);
  assert.deepEqual(passingsOf(dayWith([{ plate: 'PA4D', svc: 'K', from: 0, speed: 100, readings: 5 }])), [], 'too fast: a bad fix');
});

test('each prediction is scored against its own plate at its own stop, and a cached answer counts once', () => {
  const day = dayWith([{ plate: 'PA2B', svc: 'K', from: 0, speed: 8, readings: 40 }]);
  const stop = SHAPES.K.stops[2];
  const came = passingsOf(day).find((p) => p.stop === stop).t;
  const p = (t, etaS, plate = 'PA2B') => ({ t, svc: 'K', plate, stop, etaS });
  const { scored, predictions } = scoreEtas(
    [
      p(open + 30_000, Math.round((came - open - 30_000) / 1000) - 90), // said 90 s too soon: the bus came later
      p(open + 31_000, 0), // the same cached answer, a second later
      p(open + 60_000, Math.round((came - open - 60_000) / 1000) + 45), // said 45 s too late
      p(open + 60_000, 120, 'PZ9Z'), // a plate never seen: not scored
    ],
    passingsOf(day),
  );
  assert.equal(predictions, 3, 'the repeat of a cached answer counts once');
  assert.deepEqual(scored.map((s) => s.errS), [90, -45]);
  assert.equal(scored[0].hour, 6, 'Singapore hour: the window opens at 06:30');
  assert.deepEqual(statsOf([90, -45, 10, 200]), { n: 4, medianS: 50, within1: 0.5, late2: 0.25, early1: 0 });
});

test('the cron scores a closed day once, from the recording and Analytics Engine, only while switched on', async () => {
  const day = dayWith([{ plate: 'PA2B', svc: 'K', from: 0, speed: 8, readings: 40 }]);
  const stop = SHAPES.K.stops[2];
  const came = passingsOf(day).find((p) => p.stop === stop).t;
  const asked = open + 60_000;
  const ae = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  const queries = [];
  const fetchImpl = async (url, init) => {
    queries.push(init.body);
    return new Response(JSON.stringify({ data: [{ plate: 'PA2B', stop, svc: 'K', eta: Math.round((came - asked) / 1000) + 30, timestamp: ae(asked) }] }));
  };
  const bucket = makeBucket(async () => null);
  await bucket.put(dayKey(DATE), await gzip(JSON.stringify(day)));
  const env = { ...makeEnv(), DOWNLOADS: bucket, ANALYTICS_TOKEN: 'ae', CF_ACCOUNT_ID: 'acct' };
  const now = windowOf(DATE).close + 3_600_000;

  assert.equal(await recordEta(env, now, fetchImpl), null, 'off');
  await env.KV.put('config:collect:eta', 'on');
  assert.equal(await recordEta(env, now, fetchImpl), DATE);
  assert.match(queries[0], /blob1 = 'arrival'/);
  const kept = JSON.parse(new TextDecoder().decode(bucket._written.get(etaKey(DATE))));
  assert.deepEqual({ ...kept, rows: undefined }, { v: 1, date: DATE, predictions: 1, matched: 1, services: ['K'], rows: undefined });
  assert.deepEqual(kept.rows[0].slice(2), [-30, 6], 'the bus came 30 s before it said, at 6');
  assert.equal(await recordEta(env, now + 900_000, fetchImpl), null, 'scored once');

  const summary = await etaSummary(env, now);
  assert.equal(summary.overall.n, 1);
  assert.equal(summary.overall.medianS, -30);
  assert.deepEqual(summary.services.map((s) => s.svc), ['K']);
});
