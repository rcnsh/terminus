import test from 'node:test';
import assert from 'node:assert/strict';

// The sky over Now by the hour; the Android app keeps the same hours (NightSky.kt, SkyTest.kt).
import { PHASES, parallax, phaseAt } from '../../web/public/account/daylight.js';

const at = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return phaseAt(h * 60 + m);
};

test('the sky follows the day, dawn to night', () => {
  const day = ['00:00', '06:29', '06:30', '08:29', '08:30', '12:00', '16:29', '16:30', '18:44', '18:45', '19:39', '19:40', '23:59'].map(at);
  assert.deepEqual(day, ['night', 'night', 'dawn', 'dawn', 'day', 'day', 'day', 'golden', 'golden', 'dusk', 'dusk', 'night', 'night']);
});

test('every minute of the day has a sky', () => {
  for (let min = 0; min < 1440; min++) assert.ok(PHASES.includes(phaseAt(min)), `minute ${min}`);
});

test('the sky has depth as Now scrolls: far things lag, near ones stay', () => {
  const at = (s) => Object.values(parallax(s)).map((n) => Math.round(n * 100) / 100);
  // sky, clouds, far, fade
  assert.deepEqual(at(0), [0, 0, 0, 1]);
  assert.deepEqual(at(50), [25, 17.5, 6, 0.69]);
  assert.deepEqual(at(150), [75, 52.5, 18, 0.06]);
  assert.deepEqual(at(400), [200, 140, 18, 0]);
  // Pulled past the top (a bounce): as at the top.
  assert.deepEqual(at(-20), at(0));
});
