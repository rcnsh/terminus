import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { makeBucket } from './_stubs.mjs';
import { makeD1 } from './_d1.mjs';
import { fillLanding, landingEtag, landingPage } from '../src/landing.ts';
import { ensureUser, openSession, SESSION_COOKIE } from '../src/accounts.ts';

const INDEX = await readFile(new URL('../../web/public/index.html', import.meta.url), 'utf8');
const NOW = 1_790_000_000_000;

// The website as the ASSETS binding serves it, with the headers that made a
// browser keep its copy.
const ASSETS = {
  async fetch(req) {
    if (new URL(req.url).pathname !== '/') return new Response('not found', { status: 404 });
    if (req.headers.get('if-none-match')) return new Response(null, { status: 304 });
    return new Response(INDEX, { headers: { 'content-type': 'text/html; charset=utf-8', etag: '"abc"', 'cache-control': 'public, max-age=0, must-revalidate' } });
  },
};
const downloads = (latest) => makeBucket(async (key) => (key === 'latest.json' && latest ? new TextEncoder().encode(JSON.stringify(latest)) : null));

test('landing: index.html still has the markup the Worker fills', () => {
  for (const mark of ['<span id="version"></span>', '<span id="dl-version"></span>', 'id="account-link">Sign in</a>']) {
    assert.ok(INDEX.includes(mark), mark);
  }
});

test('landing: the version and Account are in the page as sent', () => {
  const out = fillLanding(INDEX, { version: '2.4.2', signedIn: true });
  assert.ok(out.includes(`<span id="version"> <span data-t="Version {0}." data-t-args='["2.4.2"]'>Version 2.4.2.</span></span>`));
  assert.ok(out.includes('<span id="dl-version"> <span data-t'));
  assert.ok(out.includes('id="account-link">Account</a>'));
  assert.equal(fillLanding(INDEX, { version: null, signedIn: false }), INDEX, 'nothing known: the page as written');
  assert.equal(fillLanding(INDEX, { version: '2.4.2"><script>', signedIn: false }), INDEX, 'only a real version goes in');
  assert.ok(fillLanding(INDEX, { version: '2.5.0-beta.3', signedIn: false }).includes('Version 2.5.0-beta.3.'), 'a beta version goes in');
  for (const v of ['2.4', '2.4.2-Beta', '2.4.2-beta.x', ' 2.4.2']) assert.equal(fillLanding(INDEX, { version: v, signedIn: false }), INDEX, `${v} is not a release version`);
});

test('landing: signed in by a live session only, never the file\'s own 304, private', async () => {
  const db = makeD1();
  const user = await ensureUser(db, 'you@u.nus.edu', NOW);
  const token = await openSession(db, user.id, 'web', null, NOW);
  const env = { DB: db, DOWNLOADS: downloads({ version: '2.4.2' }) };
  const get = (cookie) => landingPage(new Request('https://x.test/', { headers: { accept: 'text/html', 'if-none-match': '"abc"', ...(cookie ? { cookie } : {}) } }), ASSETS, env, NOW);

  const signedIn = await get(`${SESSION_COOKIE}=${token}`);
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.headers.get('cache-control'), 'private, no-cache');
  assert.match(signedIn.headers.get('etag'), /^W\/"[0-9a-f]{24}"$/, 'the page\'s own ETag, not the file\'s');
  const html = await signedIn.text();
  assert.ok(html.includes('id="account-link">Account</a>'));
  assert.ok(html.includes('>Version 2.4.2.</span>'));

  const out = await (await get(`${SESSION_COOKIE}=not-a-session`)).text();
  assert.ok(out.includes('id="account-link">Sign in</a>'), 'an unknown cookie is signed out');
  assert.ok((await (await get(null)).text()).includes('id="account-link">Sign in</a>'));
});

test('landing: no release yet leaves the version to the page', async () => {
  const res = await landingPage(new Request('https://x.test/'), ASSETS, { DOWNLOADS: downloads(null) }, NOW);
  assert.ok((await res.text()).includes('<span id="version"></span>'));
});

test('landing: a copy that is still what would be sent gets a 304; a change to anything in it, the page', async () => {
  const db = makeD1();
  const user = await ensureUser(db, 'you@u.nus.edu', NOW);
  const token = await openSession(db, user.id, 'web', null, NOW);
  const cookie = `${SESSION_COOKIE}=${token}`;
  const env = { DB: db, DOWNLOADS: downloads({ version: '2.4.2' }) };
  const get = (headers = {}, e = env, now = NOW) => landingPage(new Request('https://x.test/', { headers: { accept: 'text/html', ...headers } }), ASSETS, e, now);

  const first = await get({ cookie });
  const etag = first.headers.get('etag');
  assert.ok(etag);
  const kept = await get({ cookie, 'if-none-match': etag });
  assert.equal(kept.status, 304);
  assert.equal(await kept.text(), '');
  assert.equal(kept.headers.get('etag'), etag);
  assert.equal(kept.headers.get('cache-control'), 'private, no-cache');
  assert.equal((await get({ cookie, 'if-none-match': etag.slice(2) })).status, 304, 'strong or weak, the same');

  // Signed out, another release, the beta, or a new page: the whole page.
  const out = await get({ 'if-none-match': etag });
  assert.equal(out.status, 200);
  assert.ok((await out.text()).includes('id="account-link">Sign in</a>'));
  assert.notEqual(out.headers.get('etag'), etag);
  assert.equal((await get({ cookie, 'if-none-match': etag }, { ...env, DOWNLOADS: downloads({ version: '2.5.0' }) })).status, 200);
  assert.equal((await get({ cookie, 'if-none-match': etag }, { ...env, PUBLIC_ORIGIN: 'https://beta.example.test' })).status, 200);
  const etags = new Set([
    await landingEtag('"abc"', '2.4.2', true, false),
    await landingEtag('"abd"', '2.4.2', true, false),
    await landingEtag('"abc"', null, true, false),
    await landingEtag('"abc"', '2.4.2', false, false),
    await landingEtag('"abc"', '2.4.2', true, true),
  ]);
  assert.equal(etags.size, 5);
});

test('landing: a new release shows on the very next request, with no wait', async () => {
  let latest = { version: '2.4.2' };
  const bucket = makeBucket(async (key) => (key === 'latest.json' ? new TextEncoder().encode(JSON.stringify(latest)) : null));
  const get = () => landingPage(new Request('https://x.test/', { headers: { accept: 'text/html' } }), ASSETS, { DOWNLOADS: bucket }, NOW);
  const before = await get();
  assert.ok((await before.text()).includes('>Version 2.4.2.</span>'));
  latest = { version: '2.4.3' };
  const after = await get();
  assert.ok((await after.text()).includes('>Version 2.4.3.</span>'), 'the same isolate, a second later');
  assert.notEqual(after.headers.get('etag'), before.headers.get('etag'), 'a browser holding the old page gets the new one');
});
