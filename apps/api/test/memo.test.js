import test from 'node:test';
import assert from 'node:assert/strict';

import { Lru, onceEvery, perScope } from '../src/memo.ts';

test('a bounded memo drops the entry used longest ago, and keeps the ones just used', () => {
  const lru = new Lru(3);
  lru.set('a', 1).set('b', 2).set('c', 3);
  assert.equal(lru.get('a'), 1);
  lru.set('d', 4);
  assert.equal(lru.size, 3);
  assert.equal(lru.has('b'), false);
  assert.deepEqual(
    ['a', 'c', 'd'].map((k) => lru.get(k)),
    [1, 3, 4],
  );
});

test('once every window: a repeat inside the window is quiet, one after it is due, a clock gone backwards is due', () => {
  const once = onceEvery(60_000, 10);
  assert.equal(once.due('k', 1_000_000), true);
  assert.equal(once.due('k', 1_059_999), false);
  assert.equal(once.due('other', 1_059_999), true);
  assert.equal(once.due('k', 1_060_000), true);
  assert.equal(once.due('k', 1_000_000), true);
});

test('once every window stays under its bound and remembers the keys seen last', () => {
  const once = onceEvery(60_000, 100);
  for (let i = 0; i < 1000; i++) once.due(`k${i}`, 1_000_000);
  assert.equal(once.size, 100);
  assert.equal(once.due('k999', 1_000_001), false);
  assert.equal(once.due('k0', 1_000_001), true);
});

test('each scope gets its own instance; no scope shares one', () => {
  const of = perScope(() => ({}));
  const a = {};
  assert.equal(of(a), of(a));
  assert.notEqual(of(a), of({}));
  assert.equal(of(undefined), of(null));
});
