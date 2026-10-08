import test from 'node:test';
import assert from 'node:assert/strict';

// The web pages' calls to the API (apps/web/public/account/dom.js): a call
// that never answers, or a page that isn't the API's (a captive portal),
// must fail, so the page says it couldn't update rather than waiting or
// taking it for an answer.
import { api, send, sentences } from '../../web/public/account/dom.js';

globalThis.window ??= {};
const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

const reply = (body, init = {}) => () => Promise.resolve(new Response(body, { status: 200, ...init }));

test('a call with no answer gives up after its time, with a sentence to show', async () => {
  // Black-holed Wi-Fi: nothing comes back until the call is aborted.
  globalThis.fetch = (_, init) => new Promise((_, fail) => init.signal.addEventListener('abort', () => fail(init.signal.reason)));
  const started = Date.now();
  await assert.rejects(send('/me/next', { timeoutMs: 50 }), { message: "Couldn't reach terminus. Check your connection." });
  assert.ok(Date.now() - started < 2_000);
});

test('a 200 that is not JSON (a captive portal) is a failure, not an empty answer', async () => {
  globalThis.fetch = reply('<html><body>Sign in to the Wi-Fi</body></html>', { headers: { 'content-type': 'text/html' } });
  await assert.rejects(api('/me'), { message: "Couldn't reach terminus. Check your connection." });
});

test('JSON and an empty success still come through; an error keeps the server words', async () => {
  globalThis.fetch = reply('{"ok":true}');
  assert.deepEqual(await api('/me'), { ok: true });
  globalThis.fetch = reply(null, { status: 204 });
  assert.deepEqual(await api('/me/history', { method: 'DELETE' }), {});
  globalThis.fetch = reply('{"error":"not a valid NUSMods share link"}', { status: 400 });
  await assert.rejects(api('/me/import', { method: 'POST', body: {} }), { message: 'Not a valid NUSMods share link.', status: 400 });
});

test('a 200 whose body stops part way is a failure, not an empty answer', async () => {
  // Headers arrive, then the body stalls until the call's time runs out.
  globalThis.fetch = (_, init) => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"home":'));
        init.signal.addEventListener('abort', () => c.error(init.signal.reason));
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  };
  await assert.rejects(api('/me/profile', { timeoutMs: 50 }), { message: "Couldn't reach terminus. Check your connection." });
});

test('a write waits longer than a read before giving up', async () => {
  // The time each call is given, by default: a write must still be running
  // at 25 s, past a read's 20 s.
  const asked = [];
  const real = AbortSignal.timeout;
  AbortSignal.timeout = (ms) => (asked.push(ms), new AbortController().signal);
  globalThis.fetch = () => Promise.resolve(new Response('{}', { status: 200 }));
  try {
    await api('/me/import', { method: 'POST', body: {} });
    await api('/me/profile', { method: 'PUT', body: {} });
    await api('/me/profile');
  } finally {
    AbortSignal.timeout = real;
  }
  assert.equal(asked.length, 3);
  assert.ok(asked[0] > 25_000 && asked[1] > 25_000, `writes get ${asked[0]} ms and ${asked[1]} ms`);
  assert.equal(asked[2], 20_000, 'a read gives up at 20 s');
});

test('no connection at all reads as a sentence, not the browser words', async () => {
  globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
  await assert.rejects(api('/me/profile', { method: 'PUT', body: {} }), { message: "Couldn't reach terminus. Check your connection." });
});

test('what a screen reader says is stopped as the page writes it: ". " in English, "。" in Chinese', () => {
  const parts = ['To COM3', null, 'Leave by 09:03', '', 'D2 from PGP 09:08'];
  assert.equal(sentences(parts), 'To COM3. Leave by 09:03. D2 from PGP 09:08');
  const was = globalThis.window.i18n;
  globalThis.window.i18n = { lang: 'zh', t: (en) => en };
  try {
    assert.equal(sentences(['去 COM3', '约 09:03 前出发']), '去 COM3。约 09:03 前出发');
  } finally {
    globalThis.window.i18n = was;
  }
});

test("signed out elsewhere: the account's things go, the browser's look stays, and it's off to sign in", async () => {
  const { memoryStorage } = await import('./_web.mjs');
  const realStorage = globalThis.localStorage;
  const realLocation = globalThis.location;
  const kept = { 'terminus-lang': 'zh', 'terminus-theme': 'dark', 'terminus.clock': '24', 'terminus-card-style': 'compact' };
  const store = memoryStorage({ ...kept, 'added-places': '[{"to":"COM3"}]', 'terminus-lang-applied': 'zh' });
  const went = [];
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'location', { value: { replace: (u) => went.push(u) }, configurable: true, writable: true });
  try {
    const { signedOut } = await import('../../web/public/account/dom.js');
    await assert.rejects(signedOut(), { message: 'signed out' });
    assert.equal(store.getItem('added-places'), null);
    assert.equal(store.getItem('terminus-lang-applied'), null);
    for (const [k, v] of Object.entries(kept)) assert.equal(store.getItem(k), v, k);
    assert.deepEqual(went, ['/account/?next=/app/']);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { value: realStorage, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'location', { value: realLocation, configurable: true, writable: true });
  }
});

test('every 401 in the web app goes through signedOut, so none skips forgetting the account', async () => {
  const fs = await import('node:fs');
  for (const f of ['app/app.js', 'app/buses.js', 'app/map.js']) {
    const src = fs.readFileSync(new URL(`../../web/public/${f}`, import.meta.url), 'utf8');
    assert.match(src, /status === 401\) await signedOut\(\);/, f);
    assert.doesNotMatch(src, /location\.replace\('\/account\//, f);
  }
});

test('a 429 from the app quiets the app, never a sign-out', async () => {
  const sent = [];
  globalThis.fetch = async (path) => {
    sent.push(path);
    return new Response('{}', { status: path === '/me/next' ? 429 : 200, headers: { 'retry-after': '60', 'content-type': 'application/json' } });
  };
  await send('/me/next');
  await assert.rejects(send('/me/day'), { status: 429 });
  assert.equal((await send('/auth/logout', { method: 'POST' })).status, 200);
  assert.deepEqual(sent, ['/me/next', '/auth/logout']);
});
