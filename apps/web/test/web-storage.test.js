import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryStorage, web } from './_web.mjs';

const { local, perTab } = await web('assets/storage.js');

function withStorage(name, value, run) {
  const was = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { ...value, configurable: true });
  try {
    run();
  } finally {
    if (was) Object.defineProperty(globalThis, name, was);
    else delete globalThis[name];
  }
}

test('kept values read back as written, JSON too, and a missing or broken one reads as null', () => {
  withStorage('localStorage', { value: memoryStorage() }, () => {
    assert.equal(local.get('k'), null);
    assert.equal(local.set('k', 'v'), true);
    assert.equal(local.get('k'), 'v');
    local.set('j', JSON.stringify({ n: 2 }));
    assert.deepEqual(local.json('j'), { n: 2 });
    local.set('bad', '{');
    assert.equal(local.json('bad'), null);
    assert.equal(local.remove('k'), true);
    assert.equal(local.get('k'), null);
  });
});

test('blocked storage (private mode, site data off) reads as nothing and says a write did not stick, without throwing', () => {
  const refuse = () => {
    throw new DOMException('blocked', 'SecurityError');
  };
  for (const [name, store] of [
    ['localStorage', local],
    ['sessionStorage', perTab],
  ]) {
    withStorage(name, { get: refuse }, () => {
      assert.equal(store.get('k'), null);
      assert.equal(store.json('k'), null);
      assert.equal(store.set('k', 'v'), false);
      assert.equal(store.remove('k'), false);
    });
    withStorage(name, { value: { getItem: refuse, setItem: refuse, removeItem: refuse } }, () => {
      assert.equal(store.get('k'), null);
      assert.equal(store.set('k', 'v'), false);
      assert.equal(store.remove('k'), false);
    });
  }
});
