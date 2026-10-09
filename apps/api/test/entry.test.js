/**
 * The Worker's entry points the other tests don't reach: the beta's
 * "noindex" on its pages (HTMLRewriter, which Node lacks, stubbed here as a
 * pass-through), the cron's scheduled() handler, and the operator's /health
 * auth probe and version lookup.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { installGlobals, makeCtx, makeEnv, makeFetch, makeKV } from './_stubs.mjs';
import worker from '../src/index.ts';
import { APKCOMBO_URL, PLAY_URL } from '../src/appversion.ts';

const BASE = 'https://bus.example.test';
const BETA = 'https://beta.terminus.run';

/** Just enough of HTMLRewriter: remembers the selectors, passes the body through. */
class HTMLRewriterStub {
  static selectors = [];
  on(selector) {
    HTMLRewriterStub.selectors.push(selector);
    return this;
  }
  transform(res) {
    return new Response(res.body, res);
  }
}

/** Static assets: one HTML page and one stylesheet. */
const ASSETS = {
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/privacy/') return new Response('<a class="wordmark">terminus</a>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (path === '/assets/site.css') return new Response('body{}', { headers: { 'content-type': 'text/css' } });
    return new Response('not found', { status: 404 });
  },
};

async function call(env, path, headers = {}) {
  const ctx = makeCtx();
  const res = await worker.fetch(new Request(BASE + path, { headers }), env, ctx);
  await ctx.settle();
  return res;
}

test('the beta asks for its HTML pages not to be indexed, and marks them; the stable site does neither', async (t) => {
  installGlobals(makeFetch());
  globalThis.HTMLRewriter = HTMLRewriterStub;
  t.after(() => delete globalThis.HTMLRewriter);

  HTMLRewriterStub.selectors = [];
  const beta = { ...makeEnv(), ASSETS, PUBLIC_ORIGIN: BETA };
  const page = await call(beta, '/privacy/');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-robots-tag'), 'noindex');
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.equal(await page.text(), '<a class="wordmark">terminus</a>');
  assert.deepEqual(HTMLRewriterStub.selectors, ['.wordmark'], 'the beta tag goes beside the wordmark');
  // Not HTML: nothing to mark, nothing to say.
  const css = await call(beta, '/assets/site.css');
  assert.equal(css.headers.get('x-robots-tag'), null);

  HTMLRewriterStub.selectors = [];
  const stable = await call({ ...makeEnv(), ASSETS }, '/privacy/');
  assert.equal(stable.status, 200);
  assert.equal(stable.headers.get('x-robots-tag'), null);
  assert.deepEqual(HTMLRewriterStub.selectors, [], 'no rewrite on the stable site');
});

test('scheduled() runs the cron: the feed health check is recorded', async () => {
  installGlobals(makeFetch({ byStop: { COM3: [{ name: 'D2', arrivalTime: '4', nextArrivalTime: '14', passengers: 'low' }] } }));
  const kv = makeKV();
  const env = makeEnv(kv);
  const err = console.error;
  console.error = () => {};
  try {
    await worker.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.now() }, env, makeCtx());
  } finally {
    console.error = err;
  }
  const up = JSON.parse(await kv.get('monitor:upstream'));
  assert.equal(up.checkedAt, Date.now(), 'checked on this run');
});

test('/api/health?probe=1 for the operator: a token through the ordinary path, never the token itself', async () => {
  installGlobals(makeFetch());
  const env = { ...makeEnv(), HEALTH_TOKEN: 'op-secret' };
  const first = (await (await call(env, '/api/health?probe=1', { 'x-health-token': 'op-secret' })).json()).auth;
  assert.equal(first.ok, true);
  assert.equal(first.cached, false);
  assert.match(first.expiresIn, /^\d+h$/);
  const again = (await (await call(env, '/api/health?probe=1', { 'x-health-token': 'op-secret' })).json()).auth;
  assert.equal(again.cached, true, 'the second goes through the cache');
  assert.ok(!JSON.stringify(again).includes(await env.KV.get('auth:session')), 'the token is never shown');
  // A wrong token is no operator.
  assert.equal((await (await call(env, '/api/health?probe=1', { 'x-health-token': 'guess' })).json()).auth, undefined);
  // Not configured: says so rather than trying.
  const bare = { ...makeEnv(), HEALTH_TOKEN: 'op-secret', NEXTBUS_AUTH_BASE: undefined };
  assert.deepEqual((await (await call(bare, '/api/health?probe=1', { 'x-health-token': 'op-secret' })).json()).auth, { ok: false, reason: 'auth not configured' });
});

test('/api/health?versions=1 for the operator: what the version update would find today', async () => {
  const base = makeFetch();
  installGlobals(async (input, init) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (url === PLAY_URL) return new Response('x[[["2.60.0"]],[[[34]],[[[1,"y');
    if (url === APKCOMBO_URL) return new Response('<a>Latest Version</a></h2><div> 2.60.0 <span class="blur">(141)</span></div>');
    return base(input, init);
  });
  const env = { ...makeEnv(makeKV({})), HEALTH_TOKEN: 'op-secret', NEXTBUS_APP_VERSION: 'univus_android_2.59.2_140' };
  const v = (await (await call(env, '/api/health?versions=1', { 'x-health-token': 'op-secret' })).json()).versions;
  assert.equal(v.current, 'univus_android_2.59.2_140');
  assert.equal(v.play, '2.60.0');
  assert.equal(v.apkcombo, 'univus_android_2.60.0_141');
  assert.deepEqual(v.errors, []);
  assert.ok(v.wouldTry.length > 0 && v.wouldTry.every((s) => s.startsWith('univus_android_2.60.0_')), JSON.stringify(v.wouldTry));
  assert.equal((await (await call(env, '/api/health?versions=1')).json()).versions, undefined, 'not without the token');
});

test('opening the web app signed out goes straight to sign-in; signed in, or the service worker\'s copy, is the app', async () => {
  installGlobals(makeFetch());
  const env = { ...makeEnv(), ASSETS: { fetch: async (req) => new Response(`page for ${new URL(req.url).pathname}`, { headers: { 'content-type': 'text/html' } }) } };
  const navigate = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', accept: 'text/html' };
  for (const path of ['/app/', '/app']) {
    const out = await call(env, path, navigate);
    assert.equal(out.status, 302, path);
    assert.equal(out.headers.get('location'), '/account/?next=/app/');
    assert.equal(out.headers.get('cache-control'), 'no-store');
  }
  const signedIn = await call(env, '/app/', { ...navigate, cookie: '__Host-tm_s=abc' });
  assert.equal(await signedIn.text(), 'page for /app/');
  // Passed on by the service worker, it's still a page being opened.
  assert.equal((await call(env, '/app/', { 'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'document' })).status, 302);
  // The service worker keeping its copy of the app gets the app.
  const kept = await call(env, '/app/', { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' });
  assert.equal(await kept.text(), 'page for /app/');
  // Other pages are left alone.
  assert.equal(await (await call(env, '/account/', navigate)).text(), 'page for /account/');
});
