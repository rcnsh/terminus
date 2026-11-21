import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const OPS = new URL('../src/ops/', import.meta.url);

const KNOWN_SMALL = [];

test('src/ops/ spreads a list into Math.min or Math.max only when the list is known to be small', () => {
  const out = [];
  for (const f of fs.readdirSync(OPS).filter((f) => f.endsWith('.ts'))) {
    fs.readFileSync(new URL(f, OPS), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*')) return;
        if (!/Math\.(min|max)\(\s*\.\.\./.test(code)) return;
        if (KNOWN_SMALL.some((s) => s.file === f && code.includes(s.spread))) return;
        out.push(`${f}:${i + 1}`);
      });
  }
  assert.deepEqual(
    out,
    [],
    'Math.min(...xs) throws a RangeError past about 100k items, and ops lists are unbounded: use a loop, or add the call to KNOWN_SMALL with why its list is small',
  );
});
