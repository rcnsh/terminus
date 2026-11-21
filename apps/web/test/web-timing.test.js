import test from 'node:test';
import assert from 'node:assert/strict';
import { useLang, web } from './_web.mjs';

const {
  FIX_FRESH_MS,
  FIX_GRACE_MS,
  FIX_LAST_MS,
  FIX_MOVED_M,
  MARK_GAP_MS,
  MARK_MIN_MS,
  REFRESH_MS,
  fixQuery,
  fixToSend,
  markWaitMs,
  refreshAgain,
  slowRetryMs,
  staleText,
} = await web('app/timing.js');
const { t } = await web('account/dom.js');

test('the banner says why the card is old: offline, a failed update, or a slow connection', () => {
  for (const lang of ['en', 'zh']) {
    useLang(lang);
    assert.equal(staleText('9:41', { online: false }), t("You're offline. Showing the update from {0}.", '9:41'));
    assert.equal(
      staleText('9:41', { online: false, failed: true }),
      t("You're offline. Showing the update from {0}.", '9:41'),
      'offline wins',
    );
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
  assert.equal(wait(answer({ next: REFRESH_MS })), null);
  assert.equal(wait(answer({ next: 45_000 })), null);
  assert.equal(wait(answer()), null);
  assert.equal(wait({ asOf: 'x', refreshAt: 'soon', card: { nextChangeAt: '' } }), null);
  assert.equal(wait(null), null);
});

test('never sooner than MARK_MIN_MS from now, nor MARK_GAP_MS after the last refresh a mark brought', () => {
  assert.equal(MARK_MIN_MS, 5_000);
  assert.equal(wait(answer({ next: 1_000 })), MARK_MIN_MS);
  assert.equal(wait(answer({ next: -2_000, asOf: NOW - 10_000 })), MARK_MIN_MS);
  assert.equal(wait(answer({ next: 6_000 }), { markAt: NOW - 10_000 }), MARK_GAP_MS - 10_000);
  assert.equal(wait(answer({ next: 6_000 }), { markAt: NOW - 60_000 }), 6_000);
});

test('a mark the answer already got past is ignored', () => {
  assert.equal(wait(answer({ next: -1_000 })), null);
  assert.equal(wait(answer({ next: 0 })), null);
  assert.equal(wait(answer({ next: -1_000, refresh: 15_000 })), 15_000);
});

test("marks are on the server's clock; the hold after the last is on this device's", () => {
  const device = NOW - 60_000;
  assert.equal(wait(answer({ next: 12_000 }), { now: device, serverNow: NOW }), 12_000);
  assert.equal(wait(answer({ next: 12_000 }), { now: device, serverNow: NOW, markAt: device - 5_000 }), 25_000);
});

const fix = { lat: 1.2966, lon: 103.7724, accuracy: 12, at: NOW };
const near = { ...fix, lat: 1.2969 };
const far = { ...fix, lat: 1.2976 };

test('the card waits at most a short grace for a fresh fix, then goes with the last one if it is recent', () => {
  assert.equal(FIX_FRESH_MS, 60_000);
  assert.equal(FIX_GRACE_MS, 1_500);
  assert.equal(fixToSend(near, fix, NOW), near);
  assert.equal(fixToSend(null, fix, NOW), null);
  const last = { ...fix, at: NOW - 9 * 60_000 };
  assert.equal(fixToSend(undefined, last, NOW), last);
  assert.equal(fixToSend(undefined, { ...fix, at: NOW - FIX_LAST_MS }, NOW), null);
  assert.equal(fixToSend(undefined, null, NOW), null);
});

test("a fix is sent rounded to about 11 m, its accuracy grown by a walk's worth of its age", () => {
  assert.deepEqual(fixQuery(fix, NOW), { lat: '1.2966', lon: '103.7724', acc: '12' });
  assert.equal(fixQuery(fix, NOW + 120_000).acc, '168');
  assert.equal(fixQuery({ ...fix, accuracy: null }, NOW + 10_000).acc, '13');
  assert.equal(fixQuery(fix, NOW - 5_000).acc, '12');
});

test('the fresh fix brings the card once more only when it went without one, or from over 50 m away', () => {
  assert.equal(FIX_MOVED_M, 50);
  assert.equal(refreshAgain(null, fix), true);
  assert.equal(refreshAgain(fix, far, NOW), true);
  assert.equal(refreshAgain(fix, near, NOW), false);
  assert.equal(refreshAgain(fix, fix, NOW), false);
  assert.equal(refreshAgain(null, null), false);
  assert.equal(refreshAgain(fix, null, NOW), false);
  assert.equal(refreshAgain(null, { ...fix, accuracy: 500 }, NOW), false);
  assert.equal(refreshAgain(far, far, NOW), false);
  const old = { ...fix, at: NOW - 300_000 };
  assert.equal(refreshAgain(old, near, NOW), true);
});
