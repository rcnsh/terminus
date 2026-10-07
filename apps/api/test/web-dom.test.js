import test from 'node:test';
import assert from 'node:assert/strict';

// The web pages' calls to the API (apps/web/public/account/dom.js): a call
// that never answers, or a page that isn't the API's (a captive portal),
// must fail, so the page says it couldn't update rather than waiting or
// taking it for an answer.
import { api, send } from '../../web/public/account/dom.js';

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
