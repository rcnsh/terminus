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
  livePush,
  newApnsRun,
  parseApnsToken,
  sendApns,
  signProviderJwt,
} from '../src/apns.ts';
import { nudgeUser, pushEnabled, remindUser, setPushToken, updateLive } from '../src/push.ts';
import { fromB64url } from '../src/webpush.ts';

const NOW = Date.parse('2026-08-27T01:00:00Z');
const HEX = 'ab'.repeat(32);
const HEX2 = 'cd'.repeat(32);
const LIVE_HEX = 'ef'.repeat(80);
const TOPIC = 'sh.rcn.terminus';
const NOTICE = { title: 'a', body: 'b', zhTitle: 'a', zhBody: 'b' };
const answer = (name) => JSON.parse(readFileSync(new URL(`./fixtures/answers/${name}.json`, import.meta.url), 'utf8'));

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

/** A user with these sessions ({push, live, lang}), and a fetch that plays Apple. */
async function setup(sessions, { apple = () => new Response(null, { status: 200 }), secrets = true } = {}) {
  const db = makeD1();
  db._db.prepare("INSERT INTO users (id, email, created, last_seen) VALUES ('u1', 'a@u.nus.edu', 0, 0)").run();
  sessions.forEach((s, i) =>
    db._db
      .prepare(
        "INSERT INTO sessions (token_hash, user_id, kind, created, last_seen, push_token, live_token, push_lang) VALUES (?, 'u1', 'device', 0, ?, ?, ?, ?)",
      )
      .run(`h${i}`, i, s.push ?? null, s.live ?? null, s.lang ?? null),
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

test('an APNs token is apns: or apnsla:, hex, with :sandbox from a development build', () => {
  assert.deepEqual(parseApnsToken(`apns:${HEX}`), { live: false, hex: HEX, sandbox: false });
  assert.deepEqual(parseApnsToken(`apns:${HEX.toUpperCase()}:sandbox`), { live: false, hex: HEX, sandbox: true }, 'any case, kept lower');
  assert.deepEqual(
    parseApnsToken(`apnsla:${LIVE_HEX}`),
    { live: true, hex: LIVE_HEX, sandbox: false },
    "a Live Activity's token is longer",
  );
  assert.deepEqual(parseApnsToken(` apnsla:${HEX}:sandbox `), { live: true, hex: HEX, sandbox: true });
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
  assert.deepEqual(first.body.aps.alert, { title: 'Time to get going', body: card.card.line });
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

  // There: the Live Activity ends.
  sent.length = 0;
  await nudgeUser(env, 'u1', { phase: 'arrived', urgent: false, answer: as('arrived') }, NOW);
  assert.equal(sent.at(-1).body.aps.event, 'end');

  // Only the Live Activity, when what it shows moved and the phase didn't.
  sent.length = 0;
  assert.deepEqual(await updateLive(env, 'u1', liveActivityState(card), 'update', NOW), { sent: 1, failed: 0 });
  assert.deepEqual(
    sent.map((s) => s.headers['apns-push-type']),
    ['liveactivity'],
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
  await updateLive(env, 'u1', liveActivityState(answer('class-bus')), 'update', NOW);
  assert.deepEqual(row(0), { push_token: `apns:${HEX}`, live_token: null });
  // Any other 400 is our message's fault: nobody's token goes.
  const ours = await setup([{ push: `apns:${HEX}` }], { apple: () => refuse(400, 'BadCollapseId') });
  const { out } = await quietly(() => remindUser(ours.env, 'u1', NOTICE, NOW));
  assert.deepEqual(out, { sent: 0, failed: 1 });
  assert.equal(ours.row(0).push_token, `apns:${HEX}`);
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

  // Apple refuses the one in KV: signed again, and the push sent once more.
  const stale = await setup([{ push: `apns:${HEX}` }], {
    apple: (_r, n) => (n === 1 ? Response.json({ reason: 'ExpiredProviderToken' }, { status: 403 }) : new Response(null)),
  });
  await stale.env.KV.put('apns:jwt:KEY1234567', JSON.stringify({ jwt: 'old.jwt.token', iat: NOW / 1000 }));
  assert.equal(await sendApns(stale.env, newApnsRun(), parseApnsToken(`apns:${HEX}`), backgroundPush({}, 0), NOW + 1000), 'sent');
  assert.equal(stale.sent[0].headers.authorization, 'bearer old.jwt.token');
  assert.ok(await verifies(stale.publicKey, stale.sent[1].headers.authorization.slice('bearer '.length)));
});

test('a 429 or 5xx from Apple backs off: the rest of the delivery, and the next minute, ask nothing', async () => {
  const { env, sent } = await setup([{ push: `apns:${HEX}` }, { push: `apns:${HEX2}` }], {
    apple: () => Response.json({ reason: 'TooManyRequests' }, { status: 429 }),
  });
  const { out } = await quietly(() => remindUser(env, 'u1', NOTICE, NOW));
  assert.deepEqual(out, { sent: 0, failed: 2 });
  assert.equal(sent.length, 1, 'the second device is not tried');
  await quietly(() => remindUser(env, 'u1', NOTICE, NOW + 30_000));
  assert.equal(sent.length, 1, 'nor a delivery a moment later');
  await quietly(() => remindUser(env, 'u1', NOTICE, NOW + 61_000));
  assert.equal(sent.length, 2, 'asked again once the pause is over');
});

test('setPushToken keeps the language an iPhone registered in, and forgets it with the token', async () => {
  const { db } = await setup([{}]);
  await setPushToken(db, 'h0', `apns:${HEX}`, 'zh');
  assert.equal(db._db.prepare("SELECT push_lang FROM sessions WHERE token_hash = 'h0'").get().push_lang, 'zh');
  await setPushToken(db, 'h0', null);
  assert.equal(db._db.prepare("SELECT push_lang FROM sessions WHERE token_hash = 'h0'").get().push_lang, null);
});

test('a connection Apple refuses (no HTTP/2, a reset) counts as failed and drops no token', async () => {
  const { env, row } = await setup([{ push: `apns:${HEX}`, live: `apnsla:${LIVE_HEX}` }], {
    apple: () => {
      throw new TypeError('Network connection lost.');
    },
  });
  const { out } = await quietly(() => remindUser(env, 'u1', NOTICE, NOW));
  assert.deepEqual(out, { sent: 0, failed: 1 });
  assert.deepEqual(row(0), { push_token: `apns:${HEX}`, live_token: `apnsla:${LIVE_HEX}` });
});
