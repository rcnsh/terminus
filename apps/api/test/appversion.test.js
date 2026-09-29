import test from 'node:test';
import assert from 'node:assert/strict';

import { installGlobals, makeEnv, makeKV, shuttlePayload } from './_stubs.mjs';
import { makeEmail } from './_d1.mjs';
import {
  APKCOMBO_URL,
  LOOKUP_EVERY_MS,
  PLAY_URL,
  autoUpdateVersion,
  candidates,
  compareNames,
  versionFromApkCombo,
  versionFromPlay,
  versionsFromRefusal,
} from '../src/appversion.ts';
import { appVersion, getSession } from '../src/auth.ts';
import { checkUpstream, readUpstream } from '../src/monitor.ts';

// The shapes of the real pages, not copies of them: on Play the app's version
// sits before its SDK levels, and a review's version comes earlier.
const playPage = (v) => `<script>AF_initDataCallback({data:[["review",null,"2.58.1",null],[[["${v}"]],[[[35]],[[[23,"6.0"]]]]]]})</script>`;
const comboPage = (name, code) =>
  `<h2 class="title"><a href="/univus/sg.edu.nus.univus/download/apk" >Latest Version</a></h2> <div class="information-table"> <div class="item"> <div class="name">Version</div> <div class="value"> <a href="/univus/sg.edu.nus.univus/download/apk" >${name} <span class="blur">(${code})</span></a> </div> </div>`;

const V = (name, code) => ({ name, code });
const OLD = 'univus_android_2.59.2_140';

test('reads the version from each page, and nothing from a changed page', () => {
  assert.equal(versionFromPlay(playPage('2.60.0')), '2.60.0', 'not the review version before it');
  assert.equal(versionFromPlay('<html>redesigned</html>'), null);
  assert.deepEqual(versionFromApkCombo(comboPage('2.60.0', 141)), V('2.60.0', 141));
  assert.equal(versionFromApkCombo('<html>redesigned</html>'), null);
  assert.deepEqual(versionsFromRefusal('{"code":"10009","msg":"update to univus_android_2.60.0_141"}'), [V('2.60.0', 141)]);
  assert.deepEqual(versionsFromRefusal(null), []);
});

test('versionNames compare by number, not as text', () => {
  assert.ok(compareNames('2.10.0', '2.9.9') > 0);
  assert.ok(compareNames('2.59.2', '2.59.10') < 0);
  assert.equal(compareNames('2.60', '2.60.0'), 0);
});

test('candidates: likeliest first, only newer than what we send', () => {
  const cur = V('2.59.2', 140);
  const s = (vs) => vs.map((v) => `${v.name}_${v.code}`);
  assert.deepEqual(s(candidates(cur, { refusal: [], play: '2.60.0', apkcombo: V('2.60.0', 141) })), ['2.60.0_141', '2.60.0_142', '2.60.0_143'],
    'both pages agree: their code first, then the next codes in case it was wrong');
  assert.deepEqual(s(candidates(cur, { refusal: [], play: '2.60.0', apkcombo: V('2.59.2', 140) })), ['2.60.0_141', '2.60.0_142', '2.60.0_143'],
    'APKCombo lagging behind Play: its old code is skipped');
  assert.deepEqual(s(candidates(cur, { refusal: [], play: null, apkcombo: V('2.60.0', 141) })).slice(0, 1), ['2.60.0_141'], 'Play unreadable');
  assert.deepEqual(candidates(cur, { refusal: [], play: '2.59.2', apkcombo: V('2.59.2', 140) }), [], 'pages not caught up yet: no guesses');
  assert.deepEqual(s(candidates(cur, { refusal: [], play: '2.59.2', apkcombo: V('2.59.2', 141) })), ['2.59.2_141'], 'a newer code under the same name is still tried');
  assert.deepEqual(candidates(cur, { refusal: [], play: '2.58.1', apkcombo: null }), [], 'nothing older');
  assert.deepEqual(s(candidates(cur, { refusal: [V('2.61.0', 150)], play: '2.60.0', apkcombo: null }))[0], '2.61.0_150', 'the refusal wins');
});

/**
 * Fake NUS plus the two pages. NUS accepts only `accepts` (null: nothing);
 * the refusal comes from the bus proxy, the way it would on the real feed.
 */
function world({ accepts, play = '2.60.0', combo = ['2.60.0', 141] } = {}) {
  const hits = { play: 0, combo: 0, mint: 0, proxy: 0 };
  const versionsTried = [];
  let serial = 0;
  const jwt = () => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return [b64({ alg: 'RS256' }), b64({ exp: Math.floor(Date.now() / 1000) + 3600, n: ++serial }), 'sig'].join('.');
  };
  const fetchImpl = async (input, init = {}) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (url === PLAY_URL) {
      hits.play++;
      return new Response(playPage(play));
    }
    if (url === APKCOMBO_URL) {
      hits.combo++;
      return new Response(comboPage(...combo));
    }
    const body = JSON.parse(init.body ?? '{}');
    if (url.includes('get-access-token')) {
      hits.mint++;
      return Response.json({ code: '00000', data: { token: jwt(), userid: 'U', domain: 'PUBLIC' } });
    }
    if (url.includes('bus-proxy')) {
      hits.proxy++;
      versionsTried.push(body.version);
      if (body.version !== accepts) return Response.json({ code: '10009', msg: 'We have a new release of uNivUS', data: null });
      return Response.json(shuttlePayload([]));
    }
    return new Response('unexpected ' + url, { status: 599 });
  };
  installGlobals(fetchImpl);
  const env = { ...makeEnv(makeKV()), NEXTBUS_APP_VERSION: OLD, EMAIL: makeEmail(), EMAIL_FROM: 'login@example.test', ALERT_EMAIL: 'ops@example.test' };
  return { env, hits, versionsTried };
}

test('a new release on both pages: tried with NUS, switched to, and used from then on', async () => {
  const { env, versionsTried } = world({ accepts: 'univus_android_2.60.0_141' });
  const now = Date.now();
  const r = await autoUpdateVersion(env, now, '{"code":"10009"}', 'COM3');
  assert.deepEqual(r, { status: 'switched', from: OLD, to: 'univus_android_2.60.0_141' });
  assert.deepEqual(versionsTried, ['univus_android_2.60.0_141'], 'the right one first, so one try');
  assert.equal(await env.KV.get('config:appVersion'), 'univus_android_2.60.0_141');
  assert.equal(await appVersion(env, now), 'univus_android_2.60.0_141', 'this isolate switches at once');
  assert.equal((await getSession(env, now)).version, 'univus_android_2.60.0_141');
});

test('a wrong code on the page: the next codes are tried, three at most', async () => {
  const { env, versionsTried } = world({ accepts: 'univus_android_2.60.0_142', combo: ['2.60.0', 141] });
  const r = await autoUpdateVersion(env, Date.now(), null, 'COM3');
  assert.equal(r.status, 'switched');
  assert.deepEqual(versionsTried, ['univus_android_2.60.0_141', 'univus_android_2.60.0_142']);
});

test('nothing works: each candidate is tried once, and the pages are read at most hourly', async () => {
  const { env, hits } = world({ accepts: null });
  const now = Date.now();
  const first = await autoUpdateVersion(env, now, null, 'COM3');
  assert.equal(first.status, 'failed');
  assert.match(first.note, /NUS refused univus_android_2\.60\.0_141, univus_android_2\.60\.0_142, univus_android_2\.60\.0_143/);
  assert.equal(hits.proxy, 3);

  // Fifteen minutes later: no page reads, no repeat tries, no NUS calls.
  const again = await autoUpdateVersion(env, now + 15 * 60_000, null, 'COM3');
  assert.equal(again.status, 'failed');
  assert.match(again.note, /nothing new to try/);
  assert.deepEqual([hits.play, hits.combo, hits.proxy], [1, 1, 3]);

  // An hour on, the pages are read again, but the same versions are not retried.
  await autoUpdateVersion(env, now + LOOKUP_EVERY_MS, null, 'COM3');
  assert.deepEqual([hits.play, hits.combo, hits.proxy], [2, 2, 3]);
  assert.equal(await env.KV.get('config:appVersion'), null, 'nothing was switched');
});

test('pages that have not caught up: nothing to try, so no NUS calls', async () => {
  const { env, hits } = world({ accepts: null, play: '2.59.2', combo: ['2.59.2', 140] });
  const r = await autoUpdateVersion(env, Date.now(), null, 'COM3');
  assert.match(r.note, /nothing new to try.*Google Play shows 2\.59\.2/);
  assert.equal(hits.proxy, 0);
  const lagging = world({ accepts: null, play: '2.58.1', combo: ['2.58.1', 139] });
  const r2 = await autoUpdateVersion(lagging.env, Date.now(), null, 'COM3');
  assert.match(r2.note, /nothing new to try/);
  assert.equal(lagging.hits.proxy, 0);
});

test('the monitor fixes a new release itself: one "switched" email, never "down"', async () => {
  const { env } = world({ accepts: 'univus_android_2.60.0_141' });
  const now = Date.now();
  for (const t of [now, now + 15 * 60_000]) await checkUpstream(env, t);
  const u = await readUpstream(env);
  assert.equal(u.up, true);
  assert.equal(u.failures, 0);
  assert.equal(env.EMAIL.sent.length, 1);
  assert.match(env.EMAIL.sent[0].subject, /switched to uNivUS 2\.60\.0 automatically/);
  assert.match(env.EMAIL.sent[0].text, /cf kv keys delete config:appVersion/);
});

test('when it cannot fix it, the down email says what it tried', async () => {
  const { env } = world({ accepts: null });
  const now = Date.now();
  for (const t of [now, now + 15 * 60_000]) await checkUpstream(env, t);
  assert.equal(env.EMAIL.sent.length, 1);
  assert.match(env.EMAIL.sent[0].subject, /down/);
  assert.match(env.EMAIL.sent[0].text, /Tried automatically: .*(NUS refused|nothing new to try)/);
  assert.match(env.EMAIL.sent[0].text, /cf kv keys put config:appVersion/);
});
