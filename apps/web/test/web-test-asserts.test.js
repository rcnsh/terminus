// The test page's asserts (_dom.mjs), made safe for DOM nodes.
import test from 'node:test';
import assert from 'node:assert/strict';
import loose from 'node:assert';
import { page } from './_dom.mjs';

const thrown = (f) => {
  try {
    f();
  } catch (e) {
    return e;
  }
  return null;
};

test('a failing assert on a DOM node ends at once, with the node as one line', () => {
  page({ html: '<div id="side" class="dash on"></div><span></span>' });
  const el = document.getElementById('side');
  const span = document.querySelector('span');
  assert.equal(thrown(() => assert.equal(el, null))?.message, 'equal: <div#side.dash.on> against null');
  assert.equal(thrown(() => loose.deepEqual(el, span))?.message, 'deepEqual: <div#side.dash.on> against <span>');
  assert.equal(thrown(() => assert.notEqual(el, el, 'not itself'))?.message, 'not itself');
  assert.equal(
    thrown(() => assert.equal(el, el)),
    null,
  );
  assert.equal(
    thrown(() => assert.notStrictEqual(el, span)),
    null,
  );
  assert.match(thrown(() => assert.strictEqual(el))?.message ?? '', /needs the value expected/);
});

test('every other assert behaves as Node made it', () => {
  // The diff in the message, not a complaint about the message argument.
  assert.match(thrown(() => assert.equal('Stops', 'Stop'))?.message ?? '', /Expected values to be strictly equal/);
  assert.match(thrown(() => loose.deepEqual([1], [2]))?.message ?? '', /deep-equal/);
  assert.match(thrown(() => assert.equal(1, 2, 'one is not two'))?.message ?? '', /^one is not two/);
  // Too few arguments is still an error.
  assert.equal(thrown(() => assert.strictEqual(undefined))?.code, 'ERR_MISSING_ARGS');
  assert.equal(thrown(() => loose.deepEqual())?.code, 'ERR_MISSING_ARGS');
});
