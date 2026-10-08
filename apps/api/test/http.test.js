import test from 'node:test';
import assert from 'node:assert/strict';

import { UpstreamUnreachable, clientKey, coordsFrom, timedFetch, withSecurityHeaders } from '../src/http.ts';
import { fixOf } from '../src/detect.ts';
import { landmark, targetStops } from '../src/landmarks.ts';
import { termDay } from '../src/calendar.ts';
import { FROZEN_NOW } from './_stubs.mjs';

const req = (ip) => new Request('https://x.test/', { headers: ip ? { 'cf-connecting-ip': ip } : {} });

test('coordsFrom: a fix the phone says is hundreds of metres out is no location', () => {
  const at = (q) => coordsFrom(new URL(`https://x.test/me/next?${q}`));
  assert.deepEqual(at('lat=1.2955&lon=103.7714'), { lat: 1.2955, lon: 103.7714 });
  assert.deepEqual(at('lat=1.2955&lon=103.7714&acc=35'), { lat: 1.2955, lon: 103.7714 }, 'a usual fix');
  assert.deepEqual(at('lat=1.2955&lon=103.7714&acc=200'), { lat: 1.2955, lon: 103.7714 }, 'at the limit');
  assert.deepEqual(at('lat=1.2955&lon=103.7714&acc=640'), { lat: null, lon: null }, 'a cell-tower fix, or one from ten minutes ago');
  assert.deepEqual(at('lat=1.2955&lon=103.7714&acc=x'), { lat: 1.2955, lon: 103.7714 }, 'an unreadable accuracy is ignored');
});

test('coordsFrom and fixOf: a location is rounded to about 11 metres, whoever sends it', () => {
  const at = (q) => coordsFrom(new URL(`https://x.test/next?${q}`));
  assert.deepEqual(at('lat=1.295512345&lon=103.771449999'), { lat: 1.2955, lon: 103.7714 });
  assert.deepEqual(at('lat=-1.29556&lon=-103.77146'), { lat: -1.2956, lon: -103.7715 });
  const fix = fixOf({ lat: 1.295512345, lon: 103.771450001, speed: 6.25, acc: 12 });
  assert.deepEqual(fix, { lat: 1.2955, lon: 103.7715, speedMs: 6.25, accM: 12 });
});

test('rate-limit keys: IPv4 as is, IPv6 by its /64', () => {
  assert.equal(clientKey(req('203.0.113.9')), '203.0.113.9');
  assert.equal(clientKey(req('2001:db8:1:2:aaaa:bbbb:cccc:dddd')), '2001:db8:1:2::/64');
  assert.equal(clientKey(req('2001:db8:1:2:ffff::1')), '2001:db8:1:2::/64', 'same /64, same key');
  assert.equal(clientKey(req('2001:db8:5::1')), '2001:db8:5:0::/64', 'compressed inside the /64');
  assert.equal(clientKey(req('2001:db8:5:0:a:b:c:d')), '2001:db8:5:0::/64');
  assert.equal(clientKey(req('2001:DB8:0005:0::9')), '2001:db8:5:0::/64', 'case and leading zeros');
  assert.equal(clientKey(req('::ffff:203.0.113.9')), '203.0.113.9', 'IPv4-mapped is IPv4');
  assert.equal(clientKey(req(null)), 'unknown');
});

test('security headers: every response; CSP on HTML only; /docs may load unpkg', () => {
  const json = withSecurityHeaders(new Response('{}', { headers: { 'content-type': 'application/json' } }), '/next');
  assert.equal(json.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(json.headers.get('content-security-policy'), null);
  const page = withSecurityHeaders(new Response('<p>', { headers: { 'content-type': 'text/html' } }), '/account/');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.doesNotMatch(page.headers.get('content-security-policy'), /unpkg/);
  // Cloudflare adds the Web Analytics beacon to every page; it must load and report.
  const csp = Object.fromEntries(page.headers.get('content-security-policy').split('; ').map((d) => [d.split(' ')[0], d]));
  assert.match(csp['script-src'], / https:\/\/static\.cloudflareinsights\.com( |$)/);
  assert.match(csp['connect-src'], / https:\/\/cloudflareinsights\.com( |$)/);
  const docs = withSecurityHeaders(new Response('<p>', { headers: { 'content-type': 'text/html' } }), '/docs');
  assert.match(docs.headers.get('content-security-policy'), /unpkg/);
  assert.equal(withSecurityHeaders(new Response(''), '/auth/verify').headers.get('referrer-policy'), 'no-referrer');
});

test('the CSP: blob: workers only on the timelapse page, whose video encoder starts them', async () => {
  const { readFile } = await import('node:fs/promises');
  const workers = (path) => {
    const page = withSecurityHeaders(new Response('<p>', { headers: { 'content-type': 'text/html' } }), path);
    return page.headers.get('content-security-policy').split('; ').find((d) => d.startsWith('worker-src '));
  };
  for (const path of ['/', '/app/', '/account/', '/admin/', '/docs', '/status/']) {
    assert.equal(workers(path), "worker-src 'self'", path);
  }
  assert.equal(workers('/admin/timelapse/'), "worker-src 'self' blob:");
  // The rest of the timelapse page's policy is the site's.
  const site = withSecurityHeaders(new Response('<p>', { headers: { 'content-type': 'text/html' } }), '/app/');
  const tl = withSecurityHeaders(new Response('<p>', { headers: { 'content-type': 'text/html' } }), '/admin/timelapse/');
  const others = (h) => h.get('content-security-policy').split('; ').filter((d) => !d.startsWith('worker-src '));
  assert.deepEqual(others(tl.headers), others(site.headers));

  // Why: MapLibre starts its worker from its own file when that file is on
  // the page's origin (a blob: only for another origin), and the map loads
  // it from /vendor/; Mediabunny makes its workers from blob: URLs.
  const pub = new URL('../../web/public/', import.meta.url);
  const files = await readFile(new URL('app/map-files.js', pub), 'utf8');
  const mlDir = /MAPLIBRE = '\/(vendor\/maplibre-gl%40[0-9.]+\/)'/.exec(files)?.[1];
  assert.ok(mlDir, 'the map loads MapLibre from our own origin');
  const ml = await readFile(new URL(`${decodeURIComponent(mlDir)}maplibre-gl.mjs`, pub), 'utf8');
  assert.match(ml, /\.origin!==\w+\.origin/, 'MapLibre checks whether its worker is on another origin');
  assert.match(ml, /new Worker\(\w+,\{type:`module`\}\)/, 'and starts a same-origin one from its file');
  assert.doesNotMatch(await readFile(new URL('app/map.js', pub), 'utf8'), /workerUrl|WORKER_URL/, 'the map leaves the worker where it is');
  const tlJs = await readFile(new URL('admin/timelapse/timelapse.js', pub), 'utf8');
  const mbFile = /'\/(vendor\/mediabunny%40[^']+)'/.exec(tlJs)?.[1];
  assert.ok(mbFile);
  const mb = await readFile(new URL(decodeURIComponent(mbFile), pub), 'utf8');
  assert.match(mb, /URL\.createObjectURL\(new Blob\(/, 'Mediabunny makes its workers from blob: URLs');
});

test('the CSP allows the CDNs only for the files the site loads from them, not whole hosts', async () => {
  const { readFile } = await import('node:fs/promises');
  const page = withSecurityHeaders(new Response('<p>', { headers: { 'content-type': 'text/html' } }), '/account/');
  const docs = withSecurityHeaders(new Response('<p>', { headers: { 'content-type': 'text/html' } }), '/docs');
  const sources = (h) => h.get('content-security-policy').split(/[; ]+/);
  for (const csp of [sources(page.headers), sources(docs.headers)]) {
    assert.ok(!csp.includes('https://cdnjs.cloudflare.com'), 'not all of cdnjs');
    assert.ok(!csp.includes('https://unpkg.com'), 'not all of unpkg');
  }
  // The account page's QR library is the one file allowed from cdnjs.
  const settings = await readFile(new URL('../../web/public/account/settings-pages.js', import.meta.url), 'utf8');
  const qr = /s\.src = '(https:\/\/cdnjs\.cloudflare\.com\/[^']+)'/.exec(settings)?.[1];
  assert.ok(qr && sources(page.headers).includes(qr), `the CSP must allow ${qr}`);
  // /docs loads Elements' files from under the allowed path.
  const { docsPage } = await import('../src/openapi.ts');
  const html = docsPage('day');
  const urls = [...html.matchAll(/(?:src|href)="(https:\/\/unpkg\.com\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(urls.length >= 2);
  const allowed = sources(docs.headers).filter((x) => x.startsWith('https://unpkg.com/'));
  for (const u of urls) assert.ok(allowed.some((a) => u.startsWith(a)), u);
});

test('landmarks: every stop that serves one counts; a stop is itself', () => {
  const deck = landmark('the-deck');
  assert.ok(deck, 'codes are case-insensitive');
  const t = targetStops('THE-DECK');
  assert.ok([t.to, ...t.also].length >= 2, 'The Deck is served from more than one stop');
  assert.deepEqual(targetStops('COM3'), { to: 'COM3', also: [], walkM: 0 });
});

test('the frozen test day is an ordinary teaching Thursday in the bundled calendar', () => {
  // Planner tests run on FROZEN_NOW against data/calendar.json. If a refresh
  // ever made that day a holiday or a break, they would change for a reason
  // that has nothing to do with the code: this says so first.
  const d = termDay(FROZEN_NOW);
  assert.equal(d.kind, 'instructional');
  assert.equal(d.holiday, null);
  assert.equal(new Date(FROZEN_NOW + 8 * 3_600_000).getUTCDay(), 4);
});

test('timedFetch: a host that stalls mid-body, hangs or cannot be reached fails as unreachable, naming what', async () => {
  const real = globalThis.fetch;
  try {
    // Headers at once, then a body that never ends: only the abort ends it.
    globalThis.fetch = async (_url, init) =>
      new Response(new ReadableStream({
        start(c) {
          const keep = setTimeout(() => {}, 30_000);
          init.signal.addEventListener('abort', () => {
            clearTimeout(keep);
            c.error(init.signal.reason);
          });
        },
      }));
    await assert.rejects(timedFetch('feed', 'https://x.test/', {}, 50), (err) => {
      assert.ok(err instanceof UpstreamUnreachable);
      assert.equal(err.timedOut, true);
      assert.equal(err.message, 'feed timeout after 50ms');
      return true;
    });

    // workerd's own errors for a refused connection and a failed DNS lookup
    // are plain Errors, not TypeErrors as in Node.
    for (const make of [() => new Error('Network connection lost.'), () => new Error('internal error; reference = abc'), () => new TypeError('fetch failed')]) {
      globalThis.fetch = async () => {
        throw make();
      };
      await assert.rejects(timedFetch('feed', 'https://x.test/', {}, 50), (err) => err instanceof UpstreamUnreachable && !err.timedOut && /feed unreachable/.test(err.message));
    }

    // An answer, error statuses included, comes back whole and readable.
    globalThis.fetch = async () => new Response('busy', { status: 503, headers: { 'x-a': '1' } });
    const res = await timedFetch('feed', 'https://x.test/', {}, 50);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('x-a'), '1');
    assert.equal(await res.text(), 'busy');
  } finally {
    globalThis.fetch = real;
  }
});
