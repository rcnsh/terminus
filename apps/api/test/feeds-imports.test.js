import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const FEEDS = new URL('../src/feeds/', import.meta.url);

test('src/feeds/, which holds the raw feed shapes and the feed etiquette, imports nothing from the other folders of src', () => {
  const files = fs.readdirSync(FEEDS).filter((f) => f.endsWith('.ts'));
  assert.ok(files.includes('fms.ts'), 'the feed code is in src/feeds/');
  const out = [];
  for (const f of files) {
    const src = fs.readFileSync(new URL(f, FEEDS), 'utf8');
    for (const [, spec] of src.matchAll(/(?:from\s+|import\(\s*)'(\.{1,2}\/[^']+)'/g)) {
      if (spec.startsWith('./') || spec.startsWith('../../') || /^\.\.\/[^/]+\.ts$/.test(spec)) continue;
      out.push(`${f}: ${spec}`);
    }
  }
  assert.deepEqual(out, [], 'feeds/ imports only itself, the top level (../x.ts) and the data');
});
