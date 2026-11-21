import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SYNTAX, commentLines, lowered, ratchet, strip, tally } from '../../../scripts/comments.mjs';

const lines = (text, kind) => commentLines(text, SYNTAX[kind]).lines;

test('JS: line and block comments, not slashes inside strings, templates or regexes', () => {
  const src = [
    "const url = 'https://terminus.run'; // trailing",
    '/* block',
    '   spans */',
    'const re = /\\/\\/not/g;',
    'const t = `a ${b /* inside */} // not`;',
    'const d = a / b / c;',
    '// oxlint-disable-next-line no-control-regex',
    '/** doc */',
  ].join('\n');
  assert.deepEqual(lines(src, 'js'), [1, 2, 3, 5, 8]);
});

test('Kotlin and Swift: nested blocks, string templates and raw strings', () => {
  const kt = ['/* a /* b */ still */', 'val s = "${x // no}" // yes', 'val t = """// no"""'].join('\n');
  assert.deepEqual(lines(kt, 'kotlin'), [1, 2]);
  const swift = ['let a = "\\(x) // no" // yes', 'let r = #"// no"#', '#expect(a == b)', '/// doc'].join('\n');
  assert.deepEqual(lines(swift, 'swift'), [1, 4]);
});

test('shell, Python and YAML: hashes that start a word, shebangs and pinned versions stay', () => {
  const sh = ['#!/usr/bin/env bash', 'echo "${#arr[@]}" # count', "echo 'a # b'", '# shellcheck disable=SC2086'].join('\n');
  assert.deepEqual(lines(sh, 'sh'), [2]);
  assert.deepEqual(lines('- uses: actions/checkout@abc # v7.0.1\n# why', 'yaml'), [2]);
  assert.deepEqual(lines("x = '#'  # real\ns = '''\n# in a string\n'''", 'py'), [1]);
});

test('strip removes comments and the lines they stood on, and leaves code alone', () => {
  const src = ['// gone', 'const a = 1; // gone', '', '/*', ' * gone', ' */', 'const b = "//kept";', ''].join('\n');
  assert.equal(strip(src, SYNTAX.js), ['const a = 1;', '', 'const b = "//kept";', ''].join('\n'));
});

test('the ratchet fails a file over its allowance, a new file with any, and only ever lowers', () => {
  const counts = { 'a.ts': { lines: [1, 2, 3] }, 'b.ts': { lines: [1] }, 'new.ts': { lines: [4] } };
  const baseline = { 'a.ts': 2, 'b.ts': 5, 'gone.ts': 3 };
  assert.deepEqual(
    ratchet(counts, baseline).map((o) => [o.path, o.count, o.allowed]),
    [
      ['a.ts', 3, 2],
      ['new.ts', 1, 0],
    ],
  );
  assert.deepEqual(lowered(counts, baseline), { 'a.ts': 2, 'b.ts': 1 });
});

test('the repo is at or under its baseline, and the baseline is as low as the repo', () => {
  const baseline = JSON.parse(readFileSync(new URL('../../../scripts/comments-baseline.json', import.meta.url), 'utf8'));
  const counts = tally();
  assert.deepEqual(
    ratchet(counts, baseline).map((o) => `${o.path}: ${o.count} > ${o.allowed}`),
    [],
    'delete the comments, or move a decision into an ADR (docs/adr/0018-no-comments.md)',
  );
  assert.deepEqual(baseline, lowered(counts, baseline), 'run node scripts/comments.mjs --update to lower the baseline');
});
