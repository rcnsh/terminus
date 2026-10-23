/**
 * APNs (apns.ts, push.ts): the iPhone's tokens, the provider token and its
 * signature, the requests and payloads Apple is sent, tokens Apple has
 * dropped, backing off, and APNs staying off without its secrets. On a fake
 * Apple: nothing here reaches the network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { makeCtx, makeEnv } from './_stubs.mjs';
import { makeD1, makeEmail } from './_d1.mjs';
import worker from '../src/index.ts';
import {
  JWT_REUSE_S,
  alertPush,
  apnsEnabled,
  apnsRequest,
  backgroundPush,
  formatApnsToken,
  liveActivityState,
  liveActivityTrip,
  livePush,
  liveStartPush,
  newApnsRun,
  parseApnsToken,
  sendApns,
  signProviderJwt,
} from '../src/push/apns.ts';
import { nudgeUser, pushEnabled, remindUser, setPushToken, updateLive } from '../src/push/push.ts';
import { fromB64url } from '../src/push/webpush.ts';

const NOW = Date.parse('2026-08-27T01:00:00Z');
const HEX = 'ab'.repeat(32);
const HEX2 = 'cd'.repeat(32);
const LIVE_HEX = 'ef'.repeat(80);
const LIVE_HEX2 = '12'.repeat(80);
const START_HEX = '34'.repeat(80);
const START_HEX2 = '56'.repeat(80);
const TOPIC = 'sh.rcn.terminus';
const NOTICE = { title: 'a', body: 'b', zhTitle: 'a', zhBody: 'b' };
const answer = (name) => JSON.parse(readFileSync(new URL(`../../../fixtures/answers/${name}.json`, import.meta.url), 'utf8'));
const LIVE_PRIORITY = (sent) => sent.filter((s) => s.headers['apns-push-type'] === 'liveactivity').map((s) => s.headers['apns-priority']);

async function p8() {
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey)).toString('base64');
  return { pem: `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`, publicKey };
}

const decode = (part) => JSON.parse(new TextDecoder().decode(fromB64url(part)));
const verifies = (publicKey, jwt) => {
  const [h, c, s] = jwt.split('.');
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, fromB64url(s), new TextEncoder().encode(`${h}.${c}`));
};

const quietly = async (fn) => {
  const [err, warn] = [console.error, console.warn];
  const said = [];
  console.error = console.warn = (...a) => said.push(a.join(' '));
  try {
    return { out: await fn(), said };
  } finally {
    [console.error, console.warn] = [err, warn];
  }
};

/** A user with these sessions ({push, live, start, lang, alerts}), and a fetch that plays Apple. */
async function setup(sessions, { apple = () => new Response(null, { status: 200 }), secrets = true } = {}) {
  const db = makeD1();
  db._db.prepare("INSERT INTO users (id, email, created, last_seen) VALUES ('u1', 'a@u.nus.edu', 0, 0)").run();
  sessions.forEach((s, i) =>
    db._db
      .prepare(
        "INSERT INTO sessions (token_hash, user_id, kind, created, last_seen, push_token, live_token, start_token, push_lang, push_alerts) VALUES (?, 'u1', 'device', 0, ?, ?, ?, ?, ?, ?)",
      )
      .run(`h${i}`, i, s.push ?? null, s.live ?? null, s.start ?? null, s.lang ?? null, s.alerts === undefined ? null : s.alerts ? 1 : 0),
  );
  const sent = [];
  globalThis.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (!/^https:\/\/api(\.sandbox)?\.push\.apple\.com\/3\/device\//.test(url)) throw new Error(`unexpected fetch ${url}`);
    const r = { url, headers: init.headers, body: JSON.parse(init.body) };
    sent.push(r);
    return apple(r, sent.length);
  };
  const { pem, publicKey } = await p8();
  const env = {
    ...makeEnv(),
    DB: db,
    APNS_TOPIC: TOPIC,
    ...(secrets ? { APNS_KEY: pem, APNS_KEY_ID: 'KEY1234567', APNS_TEAM_ID: 'TEAM123456' } : {}),
  };
  const row = (i) => ({ ...db._db.prepare('SELECT push_token, live_token FROM sessions WHERE token_hash = ?').get(`h${i}`) });
  return { env, db, sent, row, publicKey };
}

test('an APNs token is apns:, apnsla: or apnsstart:, hex, with :sandbox from a development build', () => {
  assert.deepEqual(parseApnsToken(`apns:${HEX}`), { kind: 'device', hex: HEX, sandbox: false });
  assert.deepEqual(
    parseApnsToken(`apns:${HEX.toUpperCase()}:sandbox`),
    { kind: 'device', hex: HEX, sandbox: true },
    'any case, kept lower',
  );
  assert.deepEqual(
    parseApnsToken(`apnsla:${LIVE_HEX}`),
    { kind: 'live', hex: LIVE_HEX, sandbox: false },
    "a Live Activity's token is longer",
  );
  assert.deepEqual(parseApnsToken(` apnsla:${HEX}:sandbox `), { kind: 'live', hex: HEX, sandbox: true });
  assert.deepEqual(parseApnsToken(`apnsstart:${START_HEX}:sandbox`), { kind: 'start', hex: START_HEX, sandbox: true });
  assert.equal(formatApnsToken(parseApnsToken(`APNSSTART:${START_HEX}`)), `apnsstart:${START_HEX}`);
  for (const bad of [
    'apns:',
    `apns:${HEX.slice(1)}`,
    `apns:${'zz'.repeat(32)}`,
    `apns:${'ab'.repeat(16)}`,
    `apns:${HEX}:dev`,
    `apns:${HEX}:sandbox:x`,
    HEX,
    `fcm:${HEX}`,
    `apns:${'ab'.repeat(256)}`,
    `apnsstart:`,
    `apnsend:${HEX}`,
  ]) {
    assert.equal(parseApnsToken(bad), null, bad);
  }
  assert.equal(formatApnsToken(parseApnsToken(`APNS:${HEX.toUpperCase()}:SANDBOX`)), `apns:${HEX}:sandbox`);
});

test('the provider token is an ES256 JWT with the key id and team, and its signature verifies', async () => {
  const { pem, publicKey } = await p8();
  const jwt = await signProviderJwt(pem, 'KEY1234567', 'TEAM123456', 1_788_000_000);
  const [h, c, s] = jwt.split('.');
  assert.deepEqual(decode(h), { alg: 'ES256', kid: 'KEY1234567' });
  assert.deepEqual(decode(c), { iss: 'TEAM123456', iat: 1_788_000_000 });
  assert.equal(fromB64url(s).length, 64, 'r and s, 32 bytes each, as JWS wants');
  assert.ok(await verifies(publicKey, jwt));
});

test('a request goes to the right host with the topic, push type, priority, expiry and collapse id', () => {
  const token = parseApnsToken(`apns:${HEX}`);
  const alert = alertPush({
    title: 'T',
    body: 'B',
    data: { kind: 'card', phase: 'due' },
    loudness: 'time-sensitive',
    collapse: 'card',
    expiresS: 1234,
  });
  const { url, init } = apnsRequest(TOPIC, token, alert, 'jwt');
  assert.equal(url, `https://api.push.apple.com/3/device/${HEX}`);
  assert.equal(init.method, 'POST');
  assert.deepEqual(init.headers, {
    authorization: 'bearer jwt',
    'apns-topic': TOPIC,
    'apns-push-type': 'alert',
    'apns-priority': '10',
    'apns-expiration': '1234',
    'apns-collapse-id': 'card',
    'content-type': 'application/json',
  });

  const sandbox = apnsRequest(TOPIC, parseApnsToken(`apns:${HEX}:sandbox`), backgroundPush({ kind: 'card', phase: 'idle' }, 99), 'jwt');
  assert.equal(sandbox.url, `https://api.sandbox.push.apple.com/3/device/${HEX}`);
  assert.equal(sandbox.init.headers['apns-push-type'], 'background');
  assert.equal(sandbox.init.headers['apns-priority'], '5', 'Apple refuses a background push at 10');
  assert.equal(sandbox.init.headers['apns-collapse-id'], undefined);

  const live = apnsRequest(
    TOPIC,
    parseApnsToken(`apnsla:${LIVE_HEX}`),
    livePush(liveActivityState(answer('riding-live')), 'update', 1000, true),
    'jwt',
  );
  assert.equal(live.url, `https://api.push.apple.com/3/device/${LIVE_HEX}`);
  assert.equal(live.init.headers['apns-topic'], `${TOPIC}.push-type.liveactivity`);
  assert.equal(live.init.headers['apns-push-type'], 'liveactivity');
});

test('each kind of push carries what the app needs', () => {
  const data = { kind: 'card', phase: 'due' };
  assert.deepEqual(
    alertPush({ title: 'Time to get going', body: 'Leave by 09:36', data, loudness: 'time-sensitive', collapse: 'card', expiresS: 5 })
      .payload,
    {
      aps: {
        alert: { title: 'Time to get going', body: 'Leave by 09:36' },
        'mutable-content': 1,
        'thread-id': 'card',
        'interruption-level': 'time-sensitive',
        sound: 'default',
      },
      kind: 'card',
      phase: 'due',
    },
  );
  const passive = alertPush({ title: 'a', body: 'b', data, loudness: 'passive', collapse: 'card', expiresS: 5 });
  assert.equal(passive.payload.aps.sound, undefined, 'a quiet one makes no sound');
  assert.equal(passive.priority, 5);
  assert.deepEqual(backgroundPush(data, 5).payload, { aps: { 'content-available': 1 }, kind: 'card', phase: 'due' });

  const state = liveActivityState(answer('class-bus'));
  const update = livePush(state, 'update', 1_000, false);
  assert.deepEqual(update.payload, { aps: { timestamp: 1_000, event: 'update', 'content-state': state, 'stale-date': state.staleAt } });
  assert.equal(update.priority, 5);
  const end = livePush(state, 'end', 1_000, true);
  assert.equal(end.payload.aps.event, 'end');
  assert.equal(end.payload.aps['dismissal-date'], 1_000 + 600);
  assert.equal(end.payload.aps['stale-date'], undefined);
  assert.equal(end.priority, 10);

  const start = liveStartPush(state, 'trip-1', { title: 'Time to get going', body: 'Leave by 09:36' }, true, 1_000);
  assert.deepEqual(start.payload, {
    aps: {
      timestamp: 1_000,
      event: 'start',
      'content-state': state,
      'attributes-type': 'TripAttributes',
      attributes: { trip: 'trip-1' },
      alert: { title: 'Time to get going', body: 'Leave by 09:36' },
      sound: 'default',
      'input-push-token': 1,
      'stale-date': state.staleAt,
    },
  });
  assert.equal(start.type, 'liveactivity');
  assert.equal(start.priority, 10, 'time to go: shown at once');
  assert.equal(
    liveStartPush(state, 'trip-1', { title: 'a', body: 'b' }, false, 1_000).payload.aps.sound,
    undefined,
    'leave alerts off: no sound',
  );
  const startReq = apnsRequest(TOPIC, parseApnsToken(`apnsstart:${START_HEX}`), start, 'jwt');
  assert.equal(startReq.url, `https://api.push.apple.com/3/device/${START_HEX}`);
  assert.equal(startReq.init.headers['apns-topic'], `${TOPIC}.push-type.liveactivity`);
});

test("a Live Activity's trip is the card's, as the app names it: its first button's trip, else when the class starts", () => {
  const a = answer('class-bus');
  assert.equal(
    liveActivityTrip({ ...a, card: { ...a.card, actions: [{ id: 'skipped', label: 'x', trip: '4:600:UTOWN' }] } }),
    '4:600:UTOWN',
  );
  assert.equal(
    liveActivityTrip({ ...a, card: { ...a.card, actions: [] }, timing: { ...a.timing, classAt: '2026-08-27T02:00:00.000Z' } }),
    '2026-08-27T02:00:00.000Z',
  );
  assert.equal(liveActivityTrip({ ...a, card: { ...a.card, actions: [] }, timing: null }), 'trip');
});

test("the Live Activity's content-state comes from the card: before the bus, and on it", () => {
  assert.deepEqual(liveActivityState(answer('class-bus')), {
    phase: 'idle',
    phaseText: null,
    headline: 'R2 · 09:06',
    line: 'Leave by ~09:36 · R2 from PGP',
    glance: 'Leave 09:36',
    to: 'GEA1000',
    svc: 'R2',
    color: '#34a853',
    stop: 'PGP',
    off: 'UTown',
    leaveAt: Date.parse('2026-08-27T01:36:40Z') / 1000,
    departAt: Date.parse('2026-08-27T01:42:00Z') / 1000,
    arriveAt: Date.parse('2026-08-27T01:51:30Z') / 1000,
    estimated: true,
    gone: false,
    late: false,
    staleAt: Date.parse('2026-08-27T01:06:30Z') / 1000,
  });
  const riding = liveActivityState(answer('riding-live'));
  assert.equal(riding.phase, 'riding');
  assert.equal(riding.svc, 'D2');
  assert.equal(riding.stop, 'PGP');
  assert.equal(riding.off, 'UTown');
  assert.equal(riding.leaveAt, null, 'nothing to leave for on the bus');
  assert.equal(riding.departAt, Date.parse('2026-08-27T01:06:00Z') / 1000);
  assert.equal(riding.arriveAt, Date.parse('2026-08-27T01:15:00Z') / 1000);
  // Every field there for every answer, null rather than absent, so Swift's decoder never misses a key.
  const keys = Object.keys(riding).sort();
  for (const f of ['setup', 'free', 'missed', 'bus-gone', 'class-walk', 'change-riding', 'arrived', 'rest', 'home']) {
    const s = liveActivityState(answer(f));
    assert.deepEqual(Object.keys(s).sort(), keys, f);
    for (const [k, v] of Object.entries(s)) assert.notEqual(v, undefined, `${f}: ${k}`);
    for (const k of ['leaveAt', 'departAt', 'arriveAt', 'staleAt'])
      assert.ok(s[k] === null || Number.isInteger(s[k]), `${f}: ${k} in whole seconds`);
  }
});

test('POST /api/me/push takes apns: and apnsla: tokens, with APNs off too, and refuses a malformed one', async () => {
  const db = makeD1();
  const env = { ...makeEnv(), DB: db, EMAIL: makeEmail(), EMAIL_FROM: 'x@example.test' };
  assert.equal(apnsEnabled(env), false);
  const call = async (path, { method = 'GET', token, body, headers = {} } = {}) => {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const ctx = makeCtx();
    const res = await worker.fetch(
      new Request(`https://bus.example.test${path}`, { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
      env,
      ctx,
    );
    await ctx.settle();
    return res;
  };
  const anon = async () =>
    (await (await call('/api/auth/anon', { method: 'POST', headers: { 'x-terminus-client': 'ios/3.0.0' } })).json()).token;
  const [phone, other] = [await anon(), await anon()];
  assert.ok(phone && other);
  const rows = () =>
    db._db
      .prepare(
        'SELECT push_token, live_token, push_lang FROM sessions WHERE push_token IS NOT NULL OR live_token IS NOT NULL ORDER BY created, rowid',
      )
      .all()
      .map((r) => ({ ...r }));
  const alerts = () =>
    db._db
      .prepare('SELECT push_alerts FROM sessions WHERE push_token IS NOT NULL')
      .all()
      .map((r) => r.push_alerts);

  const bad = await call('/api/me/push', {
    method: 'POST',
    token: phone,
    body: { token: 'apns:not-hex' },
    headers: { 'accept-language': 'zh-CN' },
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /apns:<十六进制设备令牌>/);
  assert.equal(
    (
      await call('/api/me/push', {
        method: 'POST',
        token: phone,
        body: { token: `APNS:${HEX.toUpperCase()}:sandbox` },
        headers: { 'accept-language': 'zh' },
      })
    ).status,
    200,
  );
  assert.equal((await call('/api/me/push', { method: 'POST', token: phone, body: { token: `apnsla:${LIVE_HEX}` } })).status, 200);
  assert.deepEqual(rows(), [{ push_token: `apns:${HEX}:sandbox`, live_token: `apnsla:${LIVE_HEX}`, push_lang: 'zh' }]);
  // The latest of each replaces the last.
  await call('/api/me/push', { method: 'POST', token: phone, body: { token: `apns:${HEX2}` } });
  await call('/api/me/push', { method: 'POST', token: phone, body: { token: `apnsla:${HEX}` } });
  assert.deepEqual(rows(), [{ push_token: `apns:${HEX2}`, live_token: `apnsla:${HEX}`, push_lang: 'en' }]);
  // Whether its leave alerts are on comes with the phone's token; not said (an older build), null.
  assert.deepEqual(alerts(), [null]);
  await call('/api/me/push', { method: 'POST', token: phone, body: { token: `apns:${HEX2}`, alerts: false } });
  assert.deepEqual(alerts(), [0]);
  await call('/api/me/push', { method: 'POST', token: phone, body: { token: `apnsla:${HEX}`, alerts: true } });
  assert.deepEqual(alerts(), [0], "the Live Activity's token doesn't say");
  await call('/api/me/push', { method: 'POST', token: phone, body: { token: `apns:${HEX2}`, alerts: true } });
  assert.deepEqual(alerts(), [1]);
  // The same token from another session moves there.
  await call('/api/me/push', { method: 'POST', token: other, body: { token: `apnsla:${HEX}` } });
  assert.deepEqual(rows(), [
    { push_token: `apns:${HEX2}`, live_token: null, push_lang: 'en' },
    { push_token: null, live_token: `apnsla:${HEX}`, push_lang: null },
  ]);
  // Forgetting push forgets the Live Activity too.
  await call('/api/me/push', { method: 'DELETE', token: other });
  await call('/api/me/push', { method: 'DELETE', token: phone });
  assert.deepEqual(rows(), []);
});

test('POST /api/me/push takes an apnsstart: token while the Live Activity is on, and forgets it once it is off', async () => {
  const db = makeD1();
  const env = { ...makeEnv(), DB: db, EMAIL: makeEmail(), EMAIL_FROM: 'x@example.test' };
  const call = async (token, method, body) => {
    const headers = { authorization: `Bearer ${token}` };
    if (body) headers['content-type'] = 'application/json';
    const ctx = makeCtx();
    const res = await worker.fetch(
      new Request('https://bus.example.test/api/me/push', { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }),
      env,
      ctx,
    );
    await ctx.settle();
    return res;
  };
  const anon = async () => {
    const ctx = makeCtx();
    const res = await worker.fetch(
      new Request('https://bus.example.test/api/auth/anon', { method: 'POST', headers: { 'x-terminus-client': 'ios/3.6.0' } }),
      env,
      ctx,
    );
    await ctx.settle();
    return (await res.json()).token;
  };
  const [phone, other] = [await anon(), await anon()];
  const rows = () =>
    db._db
      .prepare('SELECT push_token, live_token, start_token FROM sessions ORDER BY created, rowid')
      .all()
      .map((r) => ({ ...r }));
  const bad = await call(phone, 'POST', { token: 'apnsstart:xyz' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /apnsstart:/);
  await call(phone, 'POST', { token: `apns:${HEX}`, alerts: true, live: true });
  await call(phone, 'POST', { token: `apnsstart:${START_HEX}:sandbox` });
  assert.deepEqual(rows()[0], { push_token: `apns:${HEX}`, live_token: null, start_token: `apnsstart:${START_HEX}:sandbox` });
  // Left out (an older build), or on: kept.
  await call(phone, 'POST', { token: `apns:${HEX}` });
  await call(phone, 'POST', { token: `apns:${HEX}`, live: true });
  assert.equal(rows()[0].start_token, `apnsstart:${START_HEX}:sandbox`);
  // The Live Activity turned off: none may be started by push.
  await call(phone, 'POST', { token: `apns:${HEX}`, alerts: true, live: false });
  assert.deepEqual(rows()[0], { push_token: `apns:${HEX}`, live_token: null, start_token: null });
  // The same token from another session moves there; DELETE forgets it with the rest.
  await call(phone, 'POST', { token: `apnsstart:${START_HEX}` });
  await call(other, 'POST', { token: `apnsstart:${START_HEX}` });
  assert.deepEqual(
    rows().map((r) => r.start_token),
    [null, `apnsstart:${START_HEX}`],
  );
  await call(other, 'DELETE');
  assert.deepEqual(rows()[1], { push_token: null, live_token: null, start_token: null });
});

test('without its secrets APNs is off: nothing is sent, said once, and the tokens are kept', async () => {
  const { env, sent, row } = await setup([{ push: `apns:${HEX}`, live: `apnsla:${LIVE_HEX}` }], { secrets: false });
  assert.equal(apnsEnabled(env), false);
  assert.equal(pushEnabled(env), false);
  const { out, said } = await quietly(async () => {
    const r = await sendApns(env, newApnsRun(), parseApnsToken(`apns:${HEX}`), backgroundPush({}, 0), NOW);
    await sendApns(env, newApnsRun(), parseApnsToken(`apns:${HEX}`), backgroundPush({}, 0), NOW);
    return r;
  });
  assert.equal(out, 'skip');
  assert.ok(said.length <= 1, 'said once per isolate at most');
  assert.ok(
    said.every((s) => !s.includes(HEX)),
    'never the token',
  );
  assert.deepEqual(await nudgeUser(env, 'u1', { phase: 'due', urgent: true }, NOW), { sent: 0, failed: 0 });
  assert.equal(sent.length, 0);
  assert.deepEqual(row(0), { push_token: `apns:${HEX}`, live_token: `apnsla:${LIVE_HEX}` });
});

test("a nudge reaches an iPhone as Android's would: words when it's time to look, silent otherwise, and the Live Activity", async () => {
  const card = answer('class-bus');
  const as = (phase, more = {}) => ({ ...card, card: { ...card.card, phase, ...more } });
  const { env, sent } = await setup([
    { push: `apns:${HEX}`, lang: 'zh' },
    { push: `apns:${HEX2}:sandbox`, live: `apnsla:${LIVE_HEX}:sandbox` },
  ]);
  assert.ok(pushEnabled(env));
  assert.deepEqual(
    await nudgeUser(env, 'u1', { phase: 'due', urgent: true, remind: true, answer: as('due', { phaseText: 'Time to get going' }) }, NOW),
    { sent: 3, failed: 0 },
  );
  const [first, second, live] = sent;
  assert.equal(first.url, `https://api.push.apple.com/3/device/${HEX}`);
  assert.equal(first.headers['apns-push-type'], 'alert');
  assert.equal(first.headers['apns-priority'], '10');
  assert.equal(first.headers['apns-collapse-id'], 'card');
  assert.equal(first.headers['apns-expiration'], String(NOW / 1000 + 600));
  // The card is in English and this iPhone is pushed in Chinese: with no
  // way to word it again (answerIn), the phase's words in Chinese.
  assert.deepEqual(first.body.aps.alert, { title: '该出发了', body: '打开 terminus 查看行程的最新情况。' });
  assert.deepEqual(second.body.aps.alert, { title: 'Time to get going', body: card.card.line }, "the card's words in its own language");
  assert.equal(first.body.aps['mutable-content'], 1);
  assert.equal(first.body.aps['interruption-level'], 'time-sensitive');
  assert.deepEqual([first.body.kind, first.body.phase], ['card', 'due'], "the same data as Android's");
  // Due is worth showing even with a Live Activity running.
  assert.equal(second.url, `https://api.sandbox.push.apple.com/3/device/${HEX2}`);
  assert.equal(second.headers['apns-push-type'], 'alert');
  assert.equal(live.url, `https://api.sandbox.push.apple.com/3/device/${LIVE_HEX}`);
  assert.equal(live.headers['apns-topic'], `${TOPIC}.push-type.liveactivity`);
  assert.equal(live.body.aps.event, 'update');
  assert.equal(live.body.aps['content-state'].phase, 'due');
  assert.equal(live.headers['apns-priority'], '5', 'not a phase change the Trip object saw: Apple budgets priority 10');
  // One provider token for the whole delivery.
  assert.equal(new Set(sent.map((s) => s.headers.authorization)).size, 1);

  // A quiet change: a passive notification, or a silent push where the Live Activity shows it.
  sent.length = 0;
  await nudgeUser(env, 'u1', { phase: 'heading', urgent: false, remind: true, answer: as('heading') }, NOW);
  assert.deepEqual(
    sent.map((s) => s.headers['apns-push-type']),
    ['alert', 'background', 'liveactivity'],
  );
  assert.equal(sent[0].body.aps['interruption-level'], 'passive');
  assert.deepEqual(sent[1].body, { aps: { 'content-available': 1 }, kind: 'card', phase: 'heading' });

  // Reminders off: silent, as the web app gets nothing.
  sent.length = 0;
  await nudgeUser(env, 'u1', { phase: 'due', urgent: true, remind: false }, NOW);
  assert.deepEqual(
    sent.map((s) => s.headers['apns-push-type']),
    ['background', 'background'],
  );

  // Without a card to word it from, the phase's words in the iPhone's language.
  sent.length = 0;
  await nudgeUser(env, 'u1', { phase: 'missed', urgent: true }, NOW);
  assert.equal(sent[0].body.aps.alert.title, '错过了。这是下一种到达方式。');
  assert.equal(sent[1].body.aps.alert.title, "Missed it. Here's the next way there.");

  // Only the Live Activity, when what it shows moved and the phase didn't.
  sent.length = 0;
  assert.deepEqual(await updateLive(env, 'u1', { state: liveActivityState(card) }, 'update', NOW), { sent: 1, failed: 0 });
  assert.deepEqual(
    sent.map((s) => s.headers['apns-push-type']),
    ['liveactivity'],
  );

  // There: the Live Activity ends.
  sent.length = 0;
  await nudgeUser(env, 'u1', { phase: 'arrived', urgent: false, answer: as('arrived') }, NOW);
  assert.equal(sent.at(-1).body.aps.event, 'end');
});

test('a card worded in one language reaches each iPhone in its own: notification and Live Activity', async () => {
  const en = answer('class-bus');
  const zh = JSON.parse(readFileSync(new URL('../../../fixtures/answers/zh/class-bus.json', import.meta.url), 'utf8'));
  const as = (a) => ({ ...a, card: { ...a.card, phase: 'heading' } });
  const { env, sent } = await setup([
    { push: `apns:${HEX}`, live: `apnsla:${LIVE_HEX}`, lang: 'zh' },
    { push: `apns:${HEX2}`, lang: 'en' },
  ]);
  const asked = [];
  const answerIn = async (l) => {
    asked.push(l);
    return l === 'zh' ? as(zh) : null;
  };
  // A tap on an English device: the answer is English, the Chinese iPhone's is worded again.
  await nudgeUser(env, 'u1', { phase: 'heading', urgent: true, remind: true, answer: as(en), lang: 'en', answerIn }, NOW);
  assert.deepEqual(asked, ['zh'], 'asked once, for the language nobody had');
  const to = (hex) => sent.find((s) => s.url.endsWith(hex));
  assert.deepEqual(to(HEX).body.aps.alert, { title: zh.card.heading, body: zh.card.line });
  assert.equal(to(LIVE_HEX).body.aps['content-state'].line, zh.card.line);
  assert.equal(to(LIVE_HEX).body.aps['content-state'].headline, zh.card.title);
  assert.deepEqual(to(HEX2).body.aps.alert, { title: en.card.heading, body: en.card.line });
  // A tap is no phase change the Trip object saw: priority 5. A phase change is 10.
  assert.deepEqual(LIVE_PRIORITY(sent), ['5']);
  sent.length = 0;
  await nudgeUser(
    env,
    'u1',
    { phase: 'heading', urgent: false, remind: true, answer: as(en), lang: 'en', answerIn, phaseChanged: true },
    NOW,
  );
  assert.deepEqual(LIVE_PRIORITY(sent), ['10']);

  // Worded again in nothing (it failed): the phase's words in Chinese, and
  // the Live Activity waits for the Trip object rather than show English.
  sent.length = 0;
  const { said } = await quietly(() =>
    nudgeUser(
      env,
      'u1',
      { phase: 'due', urgent: true, remind: true, answer: as(en), lang: 'en', answerIn: async () => Promise.reject(new Error('feed')) },
      NOW,
    ),
  );
  assert.ok(said.some((x) => x.includes('not worded')));
  assert.equal(to(HEX).body.aps.alert.title, '该出发了');
  assert.equal(to(LIVE_HEX), undefined);
  // An end still goes, in any language: a finished trip mustn't stay on the Lock Screen.
  sent.length = 0;
  await nudgeUser(
    env,
    'u1',
    { phase: 'arrived', urgent: false, answer: { ...en, card: { ...en.card, phase: 'arrived' } }, lang: 'en' },
    NOW,
  );
  assert.equal(to(LIVE_HEX).body.aps.event, 'end');
});

test('an iPhone with its leave alerts off is pushed the trip silently; one that never said gets alerts as before', async () => {
  const card = answer('class-bus');
  const as = (phase) => ({ ...card, card: { ...card.card, phase } });
  const { env, sent } = await setup([{ push: `apns:${HEX}`, alerts: false }, { push: `apns:${HEX2}` }]);
  const to = (hex) => sent.find((s) => s.url.endsWith(hex));
  for (const phase of ['due', 'missed']) {
    sent.length = 0;
    await nudgeUser(env, 'u1', { phase, urgent: true, remind: true, answer: as(phase) }, NOW);
    assert.equal(to(HEX).headers['apns-push-type'], 'background', phase);
    assert.deepEqual(to(HEX).body, { aps: { 'content-available': 1 }, kind: 'card', phase });
    assert.equal(to(HEX2).headers['apns-push-type'], 'alert', phase);
  }
  // The semester's reminder isn't a leave alert: it still shows, as on Android.
  sent.length = 0;
  await remindUser(env, 'u1', NOTICE, NOW);
  assert.equal(to(HEX).headers['apns-push-type'], 'alert');
});

test("a Live Activity's later bus reaches each iPhone in its own language", async () => {
  const en = answer('class-bus');
  const zh = JSON.parse(readFileSync(new URL('../../../fixtures/answers/zh/class-bus.json', import.meta.url), 'utf8'));
  const { env, sent } = await setup([
    { push: `apns:${HEX}`, live: `apnsla:${LIVE_HEX}`, lang: 'zh' },
    { push: `apns:${HEX2}`, live: `apnsla:${LIVE_HEX2}`, lang: 'en' },
  ]);
  const asked = [];
  const answerIn = async (l) => {
    asked.push(l);
    return l === 'zh' ? zh : null;
  };
  // Worded in English (the latest iPhone's), the Chinese one's again in Chinese.
  assert.deepEqual(await updateLive(env, 'u1', { answer: en, lang: 'en', answerIn }, 'update', NOW), { sent: 2, failed: 0 });
  assert.deepEqual(asked, ['zh']);
  const to = (hex) => sent.find((s) => s.url.endsWith(hex));
  assert.deepEqual(
    sent.map((s) => s.headers['apns-push-type']),
    ['liveactivity', 'liveactivity'],
    'only the Live Activities',
  );
  assert.equal(to(LIVE_HEX).body.aps['content-state'].line, zh.card.line);
  assert.equal(to(LIVE_HEX2).body.aps['content-state'].line, en.card.line);
  assert.notEqual(zh.card.line, en.card.line);
  // Not worded in Chinese: that activity waits for the next update rather than show English, but an end goes.
  sent.length = 0;
  await updateLive(env, 'u1', { answer: en, lang: 'en', answerIn: async () => null }, 'update', NOW);
  assert.equal(to(LIVE_HEX), undefined);
  assert.ok(to(LIVE_HEX2));
  sent.length = 0;
  await updateLive(env, 'u1', { answer: en, lang: 'en', answerIn: async () => null }, 'end', NOW);
  assert.equal(to(LIVE_HEX).body.aps.event, 'end');
});

test('time to go starts the Live Activity on an iPhone that can and has none running, in its language', async () => {
  const en = answer('class-bus');
  const zh = JSON.parse(readFileSync(new URL('../../../fixtures/answers/zh/class-bus.json', import.meta.url), 'utf8'));
  const due = (a) => ({ ...a, card: { ...a.card, phase: 'due', actions: [{ id: 'skipped', label: 'x', trip: '4:600:UTOWN' }] } });
  const { env, sent } = await setup([
    // Its setting on and none running: started.
    { push: `apns:${HEX}`, start: `apnsstart:${START_HEX}`, lang: 'zh', alerts: false },
    // One running: updated, not started again.
    { push: `apns:${HEX2}`, live: `apnsla:${LIVE_HEX}`, start: `apnsstart:${START_HEX2}` },
    // No token to start one (its setting off, or before iOS 17.2): nothing.
    { push: `apns:${'ee'.repeat(32)}` },
  ]);
  const to = (hex) => sent.filter((s) => s.url.endsWith(hex));
  const answerIn = async (l) => (l === 'zh' ? due(zh) : null);
  const out = await nudgeUser(
    env,
    'u1',
    { phase: 'due', urgent: true, remind: true, answer: due(en), lang: 'en', answerIn, startLive: true },
    NOW,
  );
  assert.deepEqual(out, { sent: 5, failed: 0, started: ['h0'] }, 'which phone it started on');
  const [start] = to(START_HEX);
  assert.equal(start.headers['apns-push-type'], 'liveactivity');
  assert.equal(start.headers['apns-topic'], `${TOPIC}.push-type.liveactivity`);
  assert.equal(start.headers['apns-priority'], '10');
  assert.equal(start.body.aps.event, 'start');
  assert.equal(start.body.aps['attributes-type'], 'TripAttributes');
  assert.deepEqual(start.body.aps.attributes, { trip: '4:600:UTOWN' }, 'the trip the app names it by');
  assert.equal(start.body.aps['content-state'].phase, 'due');
  assert.equal(start.body.aps['content-state'].line, zh.card.line, "in the iPhone's language");
  assert.equal(start.body.aps.alert.body, zh.card.line);
  assert.equal(start.body.aps.sound, undefined, 'its leave alerts are off: no sound');
  assert.equal(to(HEX)[0].headers['apns-push-type'], 'background', 'and its leave alerts stay as they were');
  assert.deepEqual(to(START_HEX2), [], 'one already running is not started again');
  assert.equal(to(LIVE_HEX)[0].body.aps.event, 'update');

  // Not asked to start (not due or missed, or started already for this trip): nothing started.
  sent.length = 0;
  await nudgeUser(env, 'u1', { phase: 'due', urgent: true, remind: true, answer: due(en), lang: 'en', answerIn }, NOW);
  assert.deepEqual(to(START_HEX), []);
  // This phone has shown the trip already (started, or seen running): not started again there.
  sent.length = 0;
  await nudgeUser(
    env,
    'u1',
    { phase: 'due', urgent: true, answer: due(en), lang: 'en', answerIn, startLive: true, startedFor: new Set(['h0']) },
    NOW,
  );
  assert.deepEqual(to(START_HEX), []);
  // No card in its language: no start, rather than one in English.
  sent.length = 0;
  await nudgeUser(env, 'u1', { phase: 'due', urgent: true, answer: due(en), lang: 'en', answerIn: async () => null, startLive: true }, NOW);
  assert.deepEqual(to(START_HEX), []);
  // The trip is over: nothing to start.
  sent.length = 0;
  await nudgeUser(
    env,
    'u1',
    { phase: 'arrived', urgent: false, answer: { ...en, card: { ...en.card, phase: 'arrived' } }, startLive: true },
    NOW,
  );
  assert.deepEqual(to(START_HEX), []);

  // A start token Apple no longer knows is forgotten, and nothing else.
  const gone = await setup([{ push: `apns:${HEX}`, start: `apnsstart:${START_HEX}` }], {
    apple: (r) => (r.url.endsWith(START_HEX) ? Response.json({ reason: 'Unregistered' }, { status: 410 }) : new Response(null)),
  });
  await nudgeUser(gone.env, 'u1', { phase: 'due', urgent: true, answer: due(en), lang: 'en', startLive: true }, NOW);
  assert.deepEqual(
    { ...gone.db._db.prepare('SELECT push_token, start_token FROM sessions').get() },
    { push_token: `apns:${HEX}`, start_token: null },
  );
});

test("the semester's reminder reaches an iPhone in its language", async () => {
  const { env, sent } = await setup([{ push: `apns:${HEX}`, lang: 'zh' }, { push: `apns:${HEX2}` }]);
  const notice = { title: 'New semester', body: 'Import it', zhTitle: '新学期', zhBody: '导入' };
  assert.deepEqual(await remindUser(env, 'u1', notice, NOW), { sent: 2, failed: 0 });
  assert.deepEqual(sent[0].body.aps.alert, { title: '新学期', body: '导入' });
  assert.deepEqual(sent[1].body.aps.alert, { title: 'New semester', body: 'Import it' });
  assert.equal(sent[0].body.kind, 'term');
  assert.equal(sent[0].headers['apns-collapse-id'], 'term');
});

test('a token Apple has dropped is forgotten; a Live Activity that ended loses only its own', async () => {
  const refuse = (status, reason) => Response.json({ reason }, { status });
  for (const [status, reason] of [
    [410, 'Unregistered'],
    [400, 'BadDeviceToken'],
    [400, 'DeviceTokenNotForTopic'],
  ]) {
    const { env, row } = await setup([{ push: `apns:${HEX}`, live: `apnsla:${LIVE_HEX}` }], {
      apple: (r) => (r.url.endsWith(HEX) ? refuse(status, reason) : new Response(null)),
    });
    await quietly(() => remindUser(env, 'u1', NOTICE, NOW));
    assert.deepEqual(row(0), { push_token: null, live_token: null }, `${status} ${reason}`);
  }
  const { env, row } = await setup([{ push: `apns:${HEX}`, live: `apnsla:${LIVE_HEX}` }], {
    apple: (r) => (r.url.endsWith(LIVE_HEX) ? refuse(410, 'Unregistered') : new Response(null)),
  });
  await updateLive(env, 'u1', { state: liveActivityState(answer('class-bus')) }, 'update', NOW);
  assert.deepEqual(row(0), { push_token: `apns:${HEX}`, live_token: null });
  // Any other 400 is our message's fault: nobody's token goes.
  const ours = await setup([{ push: `apns:${HEX}` }], { apple: () => refuse(400, 'BadCollapseId') });
  const { out } = await quietly(() => remindUser(ours.env, 'u1', NOTICE, NOW));
  assert.deepEqual(out, { sent: 0, failed: 1 });
  assert.equal(ours.row(0).push_token, `apns:${HEX}`);
});

test("a Live Activity the server ended is forgotten, so the next trip's starts by push", async () => {
  const en = answer('class-bus');
  const arrived = { ...en, card: { ...en.card, phase: 'arrived' } };
  const due = { ...en, card: { ...en.card, phase: 'due', actions: [{ id: 'skipped', label: 'x', trip: '4:780:COM3' }] } };
  const { env, sent, row } = await setup([{ push: `apns:${HEX}`, live: `apnsla:${LIVE_HEX}`, start: `apnsstart:${START_HEX}` }]);
  // The trip arrives: the server ends its Live Activity, and the app, closed, says nothing.
  await nudgeUser(env, 'u1', { phase: 'arrived', urgent: false, answer: arrived, lang: 'en' }, NOW);
  assert.equal(sent.find((s) => s.url.endsWith(LIVE_HEX)).body.aps.event, 'end');
  assert.deepEqual(row(0), { push_token: `apns:${HEX}`, live_token: null });
  sent.length = 0;
  await nudgeUser(env, 'u1', { phase: 'due', urgent: true, answer: due, lang: 'en', startLive: true }, NOW + 3_600_000);
  assert.equal(sent.filter((s) => s.url.endsWith(START_HEX)).length, 1);
  // An end with no trip left goes the same way; an update keeps the token.
  const two = await setup([{ push: `apns:${HEX}`, live: `apnsla:${LIVE_HEX}` }]);
  await updateLive(two.env, 'u1', { state: liveActivityState(en) }, 'update', NOW);
  assert.equal(two.row(0).live_token, `apnsla:${LIVE_HEX}`);
  await updateLive(two.env, 'u1', { state: liveActivityState(en) }, 'end', NOW);
  assert.equal(two.row(0).live_token, null);
});

test('the provider token is reused for 50 minutes, through KV, and signed again when Apple says it expired', async () => {
  const { env, sent, publicKey } = await setup([{ push: `apns:${HEX}` }]);
  const send = (ms) => sendApns(env, newApnsRun(), parseApnsToken(`apns:${HEX}`), backgroundPush({}, 0), ms);
  await send(NOW);
  await send(NOW + 49 * 60_000);
  const [a, b] = sent.map((s) => s.headers.authorization);
  assert.equal(a, b);
  const jwt = a.slice('bearer '.length);
  assert.ok(await verifies(publicKey, jwt));
  assert.equal(decode(jwt.split('.')[1]).iat, NOW / 1000);
  assert.equal(JSON.parse(await env.KV.get('apns:jwt:KEY1234567')).iat, NOW / 1000, 'kept in KV for the other isolates');
  await send(NOW + JWT_REUSE_S * 1000 + 1000);
  assert.notEqual(sent[2].headers.authorization, a, "renewed before Apple's hour is up");

  // Apple refuses the one in KV, signed 25 minutes ago: signed again, and the push sent once more.
  const stale = await setup([{ push: `apns:${HEX}` }], {
    apple: (_r, n) => (n === 1 ? Response.json({ reason: 'ExpiredProviderToken' }, { status: 403 }) : new Response(null)),
  });
  await stale.env.KV.put('apns:jwt:KEY1234567', JSON.stringify({ jwt: 'old.jwt.token', iat: NOW / 1000 - 25 * 60 }));
  assert.equal(await sendApns(stale.env, newApnsRun(), parseApnsToken(`apns:${HEX}`), backgroundPush({}, 0), NOW + 1000), 'sent');
  assert.equal(stale.sent[0].headers.authorization, 'bearer old.jwt.token');
  assert.ok(await verifies(stale.publicKey, stale.sent[1].headers.authorization.slice('bearer '.length)));
  assert.equal(
    JSON.parse(await stale.env.KV.get('apns:jwt:KEY1234567')).iat,
    (NOW + 1000) / 1000,
    'the new one in KV, with when it was signed',
  );
});

test('a refused provider token is signed again at most every 20 minutes; a key Apple keeps refusing pauses APNs', async () => {
  const refused = () => Response.json({ reason: 'InvalidProviderToken' }, { status: 403 });
  const { env, sent } = await setup([{ push: `apns:${HEX}` }, { push: `apns:${HEX2}` }], { apple: refused });
  // The first send signs a token; Apple refuses it, and it's too new to sign again.
  const first = await quietly(() => remindUser(env, 'u1', NOTICE, NOW));
  assert.deepEqual(first.out, { sent: 0, failed: 2 });
  assert.equal(sent.length, 1, 'no new token, no second try, and the other iPhone not asked');
  const jwt = sent[0].headers.authorization;
  // Paused: the next wakes ask nothing.
  await quietly(() => remindUser(env, 'u1', NOTICE, NOW + 30_000));
  assert.equal(sent.length, 1);
  // After the pause, still within 20 minutes of signing: the same token, refused, paused longer.
  await quietly(() => remindUser(env, 'u1', NOTICE, NOW + 61_000));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].headers.authorization, jwt, 'not signed again within 20 minutes');
  await quietly(() => remindUser(env, 'u1', NOTICE, NOW + 61_000 + 100_000));
  assert.equal(sent.length, 2, 'the pause doubled');
  // 20 minutes on: signed again once, and refused again, so paused again.
  const t = NOW + 21 * 60_000;
  await quietly(() => remindUser(env, 'u1', NOTICE, t));
  assert.equal(sent.length, 4, 'the old token, then one new one');
  assert.notEqual(sent[3].headers.authorization, jwt);
  assert.equal(JSON.parse(await env.KV.get('apns:jwt:KEY1234567')).iat, t / 1000);
  await quietly(() => remindUser(env, 'u1', NOTICE, t + 1000));
  assert.equal(sent.length, 4, 'paused, not signing again for each device');

  // A newer token another isolate signed (in KV) is taken, without signing.
  const other = await setup([{ push: `apns:${HEX}` }], {
    apple: (r) => (r.headers.authorization === 'bearer newer.jwt' ? new Response(null) : refused()),
  });
  const newer = { jwt: 'newer.jwt', iat: NOW / 1000 - 30 };
  await other.env.KV.put('apns:jwt:KEY1234567', JSON.stringify(newer));
  const run = { jwt: { jwt: 'old.jwt', iat: NOW / 1000 - 60 }, down: false };
  assert.equal(await sendApns(other.env, run, parseApnsToken(`apns:${HEX}`), backgroundPush({}, 0), NOW), 'sent');
  assert.deepEqual(
    other.sent.map((x) => x.headers.authorization),
    ['bearer old.jwt', 'bearer newer.jwt'],
  );
  assert.deepEqual(JSON.parse(await other.env.KV.get('apns:jwt:KEY1234567')), newer, 'nothing signed');
});

test('setPushToken keeps the language an iPhone registered in, and forgets it with the token', async () => {
  const { db } = await setup([{}]);
  await setPushToken(db, 'h0', `apns:${HEX}`, 'zh');
  assert.equal(db._db.prepare("SELECT push_lang FROM sessions WHERE token_hash = 'h0'").get().push_lang, 'zh');
  await setPushToken(db, 'h0', null);
  assert.equal(db._db.prepare("SELECT push_lang FROM sessions WHERE token_hash = 'h0'").get().push_lang, null);
});

test('a connection Apple refuses (no HTTP/2, a reset, a timeout) counts as failed, drops no token, and pauses like a 5xx', async () => {
  const { env, row, sent } = await setup([{ push: `apns:${HEX}`, live: `apnsla:${LIVE_HEX}` }, { push: `apns:${HEX2}` }], {
    apple: () => {
      throw new TypeError('Network connection lost.');
    },
  });
  const { out, said } = await quietly(() => remindUser(env, 'u1', NOTICE, NOW));
  assert.deepEqual(out, { sent: 0, failed: 2 });
  assert.equal(sent.length, 1, 'the other iPhone does not wait out the timeout again');
  assert.ok(
    said.every((x) => !x.includes(HEX)),
    'never the token',
  );
  assert.deepEqual(row(0), { push_token: `apns:${HEX}`, live_token: `apnsla:${LIVE_HEX}` });
  await quietly(() => remindUser(env, 'u1', NOTICE, NOW + 30_000));
  assert.equal(sent.length, 1, 'nor the next wake');
  await quietly(() => remindUser(env, 'u1', NOTICE, NOW + 61_000));
  assert.equal(sent.length, 2, 'asked again once the pause is over');
});
