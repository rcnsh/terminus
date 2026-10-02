/**
 * The offline fallback: what the apps show from the day plan they kept once
 * the network is gone and the last answer is stale. The web's rule is tested
 * here; the Android and Mac tests read the same cases.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { offlineNext } from '../../web/public/app/offline.js';

const FIXTURES = new URL('./fixtures/', import.meta.url);
const spec = JSON.parse(fs.readFileSync(new URL('offline-day.json', FIXTURES), 'utf8'));
const day = JSON.parse(fs.readFileSync(new URL(spec.day, FIXTURES), 'utf8'));

test('offline: the day plan gives the next thing at each moment', () => {
  for (const c of spec.cases) {
    const got = offlineNext(day, Date.parse(c.at));
    assert.deepEqual(got ? { key: got.item.key, step: got.step } : null, c.key === null ? null : { key: c.key, step: c.step }, c.at);
  }
});

test('offline: what was done or taken off when the plan was fetched stays that way', () => {
  const at = Date.parse('2026-08-27T01:00:00Z');
  const first = day.items[0];
  for (const status of ['done', 'skipped']) {
    const edited = { ...day, items: [{ ...first, status }, ...day.items.slice(1)] };
    assert.equal(offlineNext(edited, at).item.key, 'gap-home:UTOWN', status);
  }
  assert.equal(offlineNext(null, at), null);
  assert.equal(offlineNext({ ...day, items: [] }, at), null);
});
