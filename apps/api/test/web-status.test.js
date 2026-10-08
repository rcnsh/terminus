/**
 * The status page's outages (apps/web/public/status/outages.js): how long
 * each lasted, and the last 30 days, from the list the server keeps.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { useLang, web } from './_web.mjs';
import { INCIDENTS_KEPT } from '../src/monitor.ts';

const { KEPT, MONTH_MS, duration, month } = await web('status/outages.js');
const { t } = await web('account/dom.js');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('how long an outage lasted: minutes, then hours and minutes, then days', () => {
  useLang('en');
  const cases = [
    [0, '1 min'],
    [20_000, '1 min'],
    [5 * MIN, '5 min'],
    [59 * MIN + 29_000, '59 min'],
    [59 * MIN + 31_000, '1 h'],
    [HOUR, '1 h'],
    [2 * HOUR + 10 * MIN, '2 h 10 min'],
    [47 * HOUR + 59 * MIN, '47 h 59 min'],
    [48 * HOUR, '2 days'],
    [3 * DAY + 13 * HOUR, '4 days'],
  ];
  for (const [ms, text] of cases) assert.equal(duration(ms), text, `${ms} ms`);
  useLang('zh');
  assert.equal(duration(2 * HOUR + 10 * MIN), t('{0} h {1} min', 2, 10));
  assert.notEqual(duration(2 * HOUR + 10 * MIN), '2 h 10 min');
  useLang('en');
});

const NOW = Date.parse('2026-10-08T04:00:00Z');
const at = (ms) => new Date(NOW - ms).toISOString();
/** An outage `ago` before now, lasting `long` (ongoing without). */
const outage = (ago, long = null) => ({ start: at(ago), end: long === null ? null : at(ago - long), cause: 'feed' });

test('the last 30 days: how many outages, and the share of the time live, rounded down', () => {
  assert.equal(KEPT, INCIDENTS_KEPT);
  assert.deepEqual(month([], NOW), { count: 0, live: 100 });
  // A minute down in a month still isn't 100%.
  assert.deepEqual(month([outage(DAY, MIN)], NOW), { count: 1, live: 99.9 });
  // 3 days of 30 down: 90%.
  assert.deepEqual(month([outage(10 * DAY, 3 * DAY)], NOW), { count: 1, live: 90 });
  // Ongoing: down until now.
  assert.deepEqual(month([outage(3 * DAY)], NOW), { count: 1, live: 90 });
  // Begun before the 30 days: only its part inside counts.
  assert.deepEqual(month([outage(MONTH_MS + 2 * DAY, 5 * DAY)], NOW), { count: 1, live: 90 });
  // Over before them: not counted.
  assert.deepEqual(month([outage(MONTH_MS + 2 * DAY, DAY), outage(DAY, MIN)], NOW), { count: 1, live: 99.9 });
});

test('no numbers when the kept list is full and does not reach back 30 days: they would undercount', () => {
  const recent = Array.from({ length: KEPT }, (_, i) => outage((i + 1) * HOUR, MIN));
  assert.equal(month(recent, NOW), null);
  // One fewer: everything there was, so the numbers stand.
  assert.equal(month(recent.slice(1), NOW).count, KEPT - 1);
  // Full, but the oldest is from before the 30 days: they stand too.
  const reaching = [...recent.slice(1), outage(MONTH_MS + DAY, MIN)];
  assert.equal(month(reaching, NOW).count, KEPT - 1);
});
