/**
 * src/ops/ works over Analytics Engine rows and recorded passings, lists
 * with no upper bound: Math.min(...xs) and Math.max(...xs) put every item on
 * the call stack and throw a RangeError past about 100k. A loop or a reduce
 * holds any length. A spread over a list known to be small says so in a
 * `// small:` comment on its line.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const OPS = new URL('../src/ops/', import.meta.url);

test('src/ops/ spreads a list into Math.min or Math.max only when the list is small', () => {
  const out = [];
  for (const f of fs.readdirSync(OPS).filter((f) => f.endsWith('.ts'))) {
    fs.readFileSync(new URL(f, OPS), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*')) return;
        if (/Math\.(min|max)\(\s*\.\.\./.test(code) && !/\/\/ small:/.test(code)) out.push(`${f}:${i + 1}`);
      });
  }
  assert.deepEqual(out, [], 'a loop, or a `// small:` comment saying why the list is small');
});
