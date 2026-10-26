import test from 'node:test';
import assert from 'node:assert/strict';

import { installGlobals, makeEnv, makeKV, shuttlePayload } from './_stubs.mjs';
import { makeEmail } from './_d1.mjs';
import {
  CODE_GUESSES,
  LOOKUP_EVERY_MS,
  PLAY_URL,
  autoUpdateVersion,
  candidates,
  compareNames,
  versionFromPlay,
  versionsFromRefusal,
} from '../src/feeds/appversion.ts';
import { appVersion, getSession } from '../src/feeds/auth.ts';
import { checkUpstream, readUpstream } from '../src/ops/monitor.ts';

// The shape of the real page, not a copy of it: on Play the app's version
// sits before its SDK levels, and a review's version comes earlier.
const playPage = (v) => `<script>AF_initDataCallback({data:[["review",null,"2.58.1",null],[[["${v}"]],[[[35]],[[[23,"6.0"]]]]]]})</script>`;

const V = (name, code) => ({ name, code });
const OLD = 'univus_android_2.59.2_140';

test('reads the version from the page, and nothing from a changed page', () => {
  assert.equal(versionFromPlay(playPage('2.60.0')), '2.60.0', 'not the review version before it');
  assert.equal(versionFromPlay('<html>redesigned</html>'), null);
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
  const guesses = s(candidates(cur, { refusal: [], play: '2.60.3' }));
  assert.equal(guesses.length, CODE_GUESSES);
  assert.deepEqual(guesses.slice(0, 2), ['2.60.3_141', '2.60.3_142'], 'the next codes, lowest first');
  assert.ok(guesses.includes('2.60.3_144'), 'far enough ahead for the real 2.60.3, four codes on');
  assert.deepEqual(candidates(cur, { refusal: [], play: null }), [], 'Play unreadable: no guesses');
  assert.deepEqual(candidates(cur, { refusal: [], play: '2.59.2' }), [], 'Play not caught up yet: no guesses');
  assert.deepEqual(candidates(cur, { refusal: [], play: '2.58.1' }), [], 'nothing older');
  assert.deepEqual(s(candidates(cur, { refusal: [V('2.61.0', 150)], play: '2.60.0' }))[0], '2.61.0_150', 'the refusal wins');
});

/**
 * Fake NUS plus the Play page. NUS accepts only `accepts` (null: nothing);
 * the refusal comes from the bus proxy, the way it would on the real feed.
 */
function world({ accepts, play = '2.60.0' } = {}) {
  const hits = { play: 0, mint: 0, proxy: 0 };
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
  const env = {
    ...makeEnv(makeKV()),
    NEXTBUS_APP_VERSION: OLD,
    EMAIL: makeEmail(),
    EMAIL_FROM: 'login@example.test',
    ALERT_EMAIL: 'ops@example.test',
  };
  return { env, hits, versionsTried };
}

test('a new release on Play: tried with NUS, switched to, and used from then on', async () => {
  const { env, versionsTried } = world({ accepts: 'univus_android_2.60.0_141' });
  const now = Date.now();
  const r = await autoUpdateVersion(env, now, '{"code":"10009"}', 'COM3');
  assert.deepEqual(r, { status: 'switched', from: OLD, to: 'univus_android_2.60.0_141' });
  assert.deepEqual(versionsTried, ['univus_android_2.60.0_141'], 'the next code first, so one try');
  assert.equal(await env.KV.get('config:appVersion'), 'univus_android_2.60.0_141');
  assert.equal(await appVersion(env, now), 'univus_android_2.60.0_141', 'this isolate switches at once');
  assert.equal((await getSession(env, now)).version, 'univus_android_2.60.0_141');
});

test('a code several builds on: found over a few checks, three tries each', async () => {
  const { env, versionsTried } = world({ accepts: 'univus_android_2.60.0_144' });
  const now = Date.now();
  assert.equal((await autoUpdateVersion(env, now, null, 'COM3')).status, 'failed');
  assert.equal(versionsTried.length, 3);
  const r = await autoUpdateVersion(env, now + 15 * 60_000, null, 'COM3');
  assert.equal(r.status, 'switched');
  assert.deepEqual(
    versionsTried,
    [141, 142, 143, 144].map((c) => `univus_android_2.60.0_${c}`),
    'each once, in order',
  );
});

test('nothing works: each candidate is tried once, CODE_GUESSES in all, and Play is read at most hourly', async () => {
  const { env, hits } = world({ accepts: null });
  const now = Date.now();
  const first = await autoUpdateVersion(env, now, null, 'COM3');
  assert.equal(first.status, 'failed');
  assert.match(first.note, /NUS refused univus_android_2\.60\.0_141, univus_android_2\.60\.0_142, univus_android_2\.60\.0_143/);
  assert.equal(hits.proxy, 3);

  let t = now;
  for (let i = 0; i < 6; i++) await autoUpdateVersion(env, (t += 15 * 60_000), null, 'COM3');
  assert.equal(hits.proxy, CODE_GUESSES, 'every guess once, never more');
  const again = await autoUpdateVersion(env, (t += 15 * 60_000), null, 'COM3');
  assert.match(again.note, /nothing new to try/);
  assert.equal(hits.proxy, CODE_GUESSES);
  assert.equal(hits.play, Math.floor((t - now) / LOOKUP_EVERY_MS) + 1, 'once an hour');
  assert.equal(await env.KV.get('config:appVersion'), null, 'nothing was switched');
});

test('Play not caught up: nothing to try, so no NUS calls', async () => {
  const { env, hits } = world({ accepts: null, play: '2.59.2' });
  const r = await autoUpdateVersion(env, Date.now(), null, 'COM3');
  assert.match(r.note, /nothing new to try.*Google Play shows 2\.59\.2/);
  assert.equal(hits.proxy, 0);
  const lagging = world({ accepts: null, play: '2.58.1' });
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
