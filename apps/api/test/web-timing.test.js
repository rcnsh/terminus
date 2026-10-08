/**
 * When the web app's Now fetches its card again, and its banner while the
 * card isn't live (apps/web/public/app/timing.js, used by app/app.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { useLang, web } from './_web.mjs';

const { MARK_GAP_MS, MARK_MIN_MS, REFRESH_MS, markWaitMs, slowRetryMs, staleText } = await web('app/timing.js');
const { t } = await web('account/dom.js');

test('the banner says why the card is old: offline, a failed update, or a slow connection', () => {
  for (const lang of ['en', 'zh']) {
    useLang(lang);
    assert.equal(staleText('9:41', { online: false }), t("You're offline. Showing the update from {0}.", '9:41'));
    assert.equal(staleText('9:41', { online: false, failed: true }), t("You're offline. Showing the update from {0}.", '9:41'), 'offline wins');
    assert.equal(staleText('9:41', { online: true, failed: true }), t("Couldn't update. Showing the update from {0}.", '9:41'));
    assert.equal(staleText('9:41', { online: true }), t('Slow connection. Showing the update from {0}.', '9:41'));
  }
  useLang('en');
  assert.equal(staleText('9:41', { online: true }), 'Slow connection. Showing the update from 9:41.');
  useLang('zh');
  assert.doesNotMatch(staleText('9:41', { online: false }), /offline/);
  assert.match(staleText('9:41', { online: false }), /9:41/);
});

test('after a kept copy, tries again in 8 s, then 16 s, then leaves it to the timed refresh', () => {
  assert.equal(slowRetryMs(0), 8_000);
  assert.equal(slowRetryMs(1), 16_000);
  assert.equal(slowRetryMs(2), null);
  assert.equal(slowRetryMs(9), null);
  assert.equal(REFRESH_MS, 30_000);
});

const NOW = Date.parse('2026-08-27T01:00:00Z');
const answer = ({ next = null, refresh = null, asOf = NOW } = {}) => ({
  asOf: new Date(asOf).toISOString(),
  refreshAt: refresh === null ? null : new Date(NOW + refresh).toISOString(),
  card: { nextChangeAt: next === null ? null : new Date(NOW + next).toISOString() },
});
const wait = (a, { now = NOW, serverNow = now, markAt = -Infinity } = {}) => markWaitMs(a, { now, serverNow, markAt });

test("fetched again at the card's sooner mark, when that's before the timed refresh", () => {
  assert.equal(wait(answer({ next: 12_000 })), 12_000);
  assert.equal(wait(answer({ refresh: 20_000 })), 20_000);
  assert.equal(wait(answer({ next: 25_000, refresh: 9_000 })), 9_000);
  // At or past the 30 s refresh: that one is soon enough.
  assert.equal(wait(answer({ next: REFRESH_MS })), null);
  assert.equal(wait(answer({ next: 45_000 })), null);
  // No marks, or ones that aren't times.
  assert.equal(wait(answer()), null);
  assert.equal(wait({ asOf: 'x', refreshAt: 'soon', card: { nextChangeAt: '' } }), null);
  assert.equal(wait(null), null);
});

test('never sooner than MARK_MIN_MS from now, nor MARK_GAP_MS after the last refresh a mark brought', () => {
  assert.equal(MARK_MIN_MS, 5_000);
  assert.equal(wait(answer({ next: 1_000 })), MARK_MIN_MS);
  // A mark between the answer and now (the answer came late): soon, not at once.
  assert.equal(wait(answer({ next: -2_000, asOf: NOW - 10_000 })), MARK_MIN_MS);
  // A mark brought a refresh 10 s ago: the next waits out the rest of the 30 s.
  assert.equal(wait(answer({ next: 6_000 }), { markAt: NOW - 10_000 }), MARK_GAP_MS - 10_000);
  // Long ago: no hold.
  assert.equal(wait(answer({ next: 6_000 }), { markAt: NOW - 60_000 }), 6_000);
});

test('a mark the answer already got past is ignored', () => {
  // The server had it in hand: waiting on it would ask every 5 s.
  assert.equal(wait(answer({ next: -1_000 })), null);
  assert.equal(wait(answer({ next: 0 })), null);
  assert.equal(wait(answer({ next: -1_000, refresh: 15_000 })), 15_000);
});

test("marks are on the server's clock; the hold after the last is on this device's", () => {
  // This device is a minute slow: the mark is 12 s away on the server's clock.
  const device = NOW - 60_000;
  assert.equal(wait(answer({ next: 12_000 }), { now: device, serverNow: NOW }), 12_000);
  assert.equal(wait(answer({ next: 12_000 }), { now: device, serverNow: NOW, markAt: device - 5_000 }), 25_000);
});
