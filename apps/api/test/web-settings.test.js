/**
 * Settings' times of day (apps/web/public/account/settings-pages.js): the
 * time inputs' "09:30", and a class's time as the account's clock shows it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadI18n, web } from './_web.mjs';

const S = await web('account/settings-pages.js');
const { setClockPref } = await web('account/dom.js');

/** The page in `lang`, in a fixed locale so the test reads the same on any machine. */
function page(lang, locale) {
  globalThis.i18n = { ...loadI18n({ stored: lang }).i18n, locale };
}
// Browsers put a narrow space before AM and PM.
const plain = (s) => s.replace(/[  ]/g, ' ');

test('a time input\'s "HH:MM" and minutes after midnight read back as each other', () => {
  assert.equal(S.hhmm(0), '00:00');
  assert.equal(S.hhmm(570), '09:30');
  assert.equal(S.hhmm(1439), '23:59');
  assert.equal(S.toMin('09:30'), 570);
  assert.equal(S.toMin('00:00'), 0);
  // A cleared input.
  assert.equal(S.toMin(''), null);
  assert.equal(S.toMin(null), null);
  for (let m = 0; m < 1440; m++) assert.equal(S.toMin(S.hhmm(m)), m);
});

test('a span in the 12-hour clock leaves off the first AM or PM when the end has the same', () => {
  page('en', 'en-US');
  setClockPref('12');
  assert.equal(plain(S.clockMin(540)), '9:00 AM');
  assert.equal(plain(S.clockSpan(540, 660)), '9:00–11:00 AM');
  assert.equal(plain(S.clockSpan(660, 780)), '11:00 AM–1:00 PM');
  // Across midnight: PM then AM, both said.
  assert.equal(plain(S.clockSpan(23 * 60, 60)), '11:00 PM–1:00 AM');
  assert.equal(plain(S.clockSpan(22 * 60 + 30, 23 * 60 + 45)), '10:30–11:45 PM');
});

test('in the 24-hour clock, and in Chinese, the span is both times as they are', () => {
  page('en', 'en-US');
  setClockPref('24');
  assert.equal(S.clockSpan(540, 660), '09:00–11:00');
  assert.equal(S.clockSpan(23 * 60, 60), '23:00–01:00');
  page('zh', 'zh-CN');
  assert.equal(S.clockSpan(23 * 60, 60), '23:00–01:00');
  setClockPref('12');
  // 上午 and 下午 come first: nothing to leave off, and a space after them.
  assert.equal(S.clockSpan(540, 660), '上午 9:00–上午 11:00');
  assert.equal(S.clockSpan(23 * 60, 60), '下午 11:00–上午 1:00');
});
