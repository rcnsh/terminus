#!/usr/bin/env node
// Lines of code in the repo, by part (the Worker, the website, each app) and
// by language. Counts the files git tracks, non-blank lines, comments
// included; leaves out vendored code, lockfiles, test fixtures and the
// bundled data, which nobody writes by hand.
//
//   pnpm loc            a table (coloured on a terminal; NO_COLOR turns it off)
//   pnpm loc --json     the same numbers as JSON
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const LANGUAGES = {
  '.ts': 'TypeScript',
  '.js': 'JavaScript',
  '.mjs': 'JavaScript',
  '.kt': 'Kotlin',
  '.kts': 'Kotlin',
  '.swift': 'Swift',
  '.css': 'CSS',
  '.html': 'HTML',
  '.py': 'Python',
  '.sh': 'Shell',
  '.sql': 'SQL',
  '.yml': 'YAML',
  '.yaml': 'YAML',
};

const SKIP = [/(^|\/)vendor\//, /\/test\/fixtures\//, /^apps\/api\/data\//, /(^|\/)pnpm-lock\.yaml$/];

// First match wins, so each part's tests come before the part itself.
const PARTS = [
  ['API', /^apps\/api\/test\//, true],
  ['API', /^apps\/api\//, false],
  ['Website', /^apps\/web\//, false],
  ['Android', /^apps\/android\/app\/src\/(test|androidTest)\//, true],
  ['Android', /^apps\/android\//, false],
  ['Mac', /^apps\/macos\/Tests\//, true],
  ['Mac', /^apps\/macos\//, false],
  ['iPhone', /^apps\/ios\/(Tests|UITests)\//, true],
  ['iPhone', /^apps\/ios\//, false],
  ['Scripts and CI', /^(scripts|\.github)\//, false],
  ['Other', /./, false],
];

export const classify = (path) => {
  const language = LANGUAGES[extname(path)];
  if (!language || SKIP.some((re) => re.test(path))) return null;
  const [part, , test] = PARTS.find(([, re]) => re.test(path));
  return { part, test, language };
};

export const countLines = (text) => text.split('\n').filter((line) => line.trim() !== '').length;

const tally = () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const parts = new Map(PARTS.map(([name]) => [name, { code: 0, tests: 0, files: 0 }]));
  const languages = new Map();
  let lines = 0;
  let counted = 0;
  for (const path of files) {
    const kind = classify(path);
    const abs = join(root, path);
    if (!kind || !existsSync(abs)) continue;
    const n = countLines(readFileSync(abs, 'utf8'));
    const part = parts.get(kind.part);
    part[kind.test ? 'tests' : 'code'] += n;
    part.files++;
    const lang = languages.get(kind.language) ?? { lines: 0, files: 0 };
    lang.lines += n;
    lang.files++;
    languages.set(kind.language, lang);
    lines += n;
    counted++;
  }
  return {
    lines,
    files: counted,
    parts: [...parts].filter(([, p]) => p.files).map(([name, p]) => ({ name, ...p, lines: p.code + p.tests })),
    languages: [...languages].map(([name, l]) => ({ name, ...l })).sort((a, b) => b.lines - a.lines),
  };
};

const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (colour ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint('1');
const dim = paint('2');
const accent = paint('36');

const num = (n) => n.toLocaleString('en-GB');
const pct = (n, of) => `${((100 * n) / of).toFixed(1)}%`;

// A bar `width` cells long at its longest, in eighths of a cell so short
// rows still differ. The first `split` of it is solid, the rest light; the
// light run has no partial cell, since ░ can't be cut into eighths.
const BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
const bar = (n, max, width, split = n) => {
  const eighths = Math.round((n / max) * width * 8);
  if (split >= n) return accent('█'.repeat(Math.floor(eighths / 8)) + BLOCKS[eighths % 8]);
  const solid = Math.round((split / max) * width);
  return accent('█'.repeat(solid)) + dim('░'.repeat(Math.max(1, Math.round(eighths / 8) - solid)));
};

// Each cell is [text, width, style]: padded first, then styled, so colour
// codes don't count towards the width. A negative width pads on the right.
const row = (cells) =>
  '  ' + cells.map(([text, width, style = (s) => s]) => style(width < 0 ? text.padEnd(-width) : text.padStart(width))).join('  ');

const print = ({ lines, files, parts, languages }) => {
  const W = 28;
  const maxPart = Math.max(...parts.map((p) => p.lines));
  const maxLang = languages[0].lines;
  const out = [
    '',
    `  ${bold('terminus')}  ${accent(num(lines))} lines of code in ${num(files)} files`,
    dim('  non-blank lines in the files git tracks; vendored code, fixtures and data left out'),
    '',
    row([
      ['By part', -14, bold],
      ['code', 7, dim],
      ['tests', 7, dim],
      ['total', 7, dim],
    ]),
    ...parts.map((p) =>
      row([
        [p.name, -14],
        [num(p.code), 7],
        [p.tests ? num(p.tests) : '–', 7, p.tests ? undefined : dim],
        [num(p.lines), 7, bold],
        [bar(p.lines, maxPart, W, p.code), 0],
      ]),
    ),
    row([
      ['', -14],
      ['', 7],
      ['', 7],
      ['', 7],
      [`${accent('█')} ${dim('code  ░ tests')}`, 0],
    ]),
    '',
    row([
      ['By language', -14, bold],
      ['lines', 7, dim],
      ['files', 7, dim],
      ['share', 7, dim],
    ]),
    ...languages.map((l) =>
      row([
        [l.name, -14],
        [num(l.lines), 7],
        [num(l.files), 7],
        [pct(l.lines, lines), 7],
        [bar(l.lines, maxLang, W), 0],
      ]),
    ),
    '',
  ];
  console.log(out.join('\n'));
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = tally();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else print(result);
}
