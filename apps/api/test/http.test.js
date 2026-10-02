import test from 'node:test';
import assert from 'node:assert/strict';

import { clientKey, withSecurityHeaders } from '../src/http.ts';
import { landmark, targetStops } from '../src/landmarks.ts';
import { termDay } from '../src/calendar.ts';
import { FROZEN_NOW } from './_stubs.mjs';

const req = (ip) => new Request('https://x.test/', { headers: ip ? { 'cf-connecting-ip': ip } : {} });

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
  const docs = withSecurityHeaders(new Response('<p>', { headers: { 'content-type': 'text/html' } }), '/docs');
  assert.match(docs.headers.get('content-security-policy'), /unpkg/);
  assert.equal(withSecurityHeaders(new Response(''), '/auth/verify').headers.get('referrer-policy'), 'no-referrer');
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
