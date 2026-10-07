import test from 'node:test';
import assert from 'node:assert/strict';

// The web pages' clock correction (apps/web/public/account/dom.js): how far
// this device's clock is off, from the Date header of the API's answers.
import { noteServerDate, serverNow, skewOf, skewSample } from '../../web/public/account/dom.js';

const at = (iso) => Date.parse(iso);
const answer = (date, extra = {}) => ({ headers: new Headers({ date, ...extra }) });

test('one answer: the server clock minus this one, or null with no usable Date', () => {
  assert.equal(skewSample('Wed, 07 Oct 2026 01:30:00 GMT', at('2026-10-07T01:28:00Z')), 120_000);
  assert.equal(skewSample('Wed, 07 Oct 2026 01:30:00 GMT', at('2026-10-07T01:30:45Z')), -45_000);
  assert.equal(skewSample(null, 0), null);
  assert.equal(skewSample('not a date', 0), null);
});

test('the error is the largest of the latest readings, and none under 3 s', () => {
  assert.equal(skewOf([]), 0);
  assert.equal(skewOf([2_900, -2_000]), 0);
  // Date is whole seconds and read late, so every reading is at most the truth.
  assert.equal(skewOf([118_000, 120_000, 115_000]), 120_000);
  assert.equal(skewOf([-61_000, -60_000]), -60_000);
  assert.equal(skewOf([-3_000]), -3_000);
});

test('answers move serverNow(); the service worker kept copy and a missing Date do not', () => {
  const real = Date.now();
  // This device is two minutes slow.
  noteServerDate(answer(new Date(real + 120_000).toUTCString()), real);
  const ahead = serverNow() - Date.now();
  assert.ok(Math.abs(ahead - 120_000) < 1_500, `two minutes ahead, got ${ahead}`);
  // A copy the service worker kept, its Date from long ago: ignored.
  noteServerDate(answer(new Date(real - 3_600_000).toUTCString(), { 'x-terminus-cached': String(real - 3_600_000) }), real);
  noteServerDate({ headers: new Headers() }, real);
  assert.ok(Math.abs(serverNow() - Date.now() - 120_000) < 1_500);
  // The clock put right: after a few answers the old readings are gone.
  for (let i = 0; i < 5; i++) noteServerDate(answer(new Date(real).toUTCString()), real);
  assert.ok(Math.abs(serverNow() - Date.now()) < 1_000);
});
