#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classify } from './loc.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE = join(root, 'scripts/comments-baseline.json');

const EXEMPT = [/^apps\/api\/migrations\//];

const REGEX_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

export const SYNTAX = {
  js: {
    line: ['//'],
    block: true,
    quotes: `'"`,
    template: true,
    regex: true,
    directive: /^\s*(@ts-|oxlint-|eslint-|#\s*source(Mapping)?URL|\/\s*<reference|@vite-ignore|[#@]__PURE__)/,
  },
  kotlin: {
    line: ['//'],
    block: true,
    nested: true,
    quotes: `'"`,
    triple: true,
    dollarTemplate: true,
    directive: /^\s*(noinspection|@formatter:)/,
  },
  swift: {
    line: ['//'],
    block: true,
    nested: true,
    quotes: '"',
    triple: true,
    swiftInterp: true,
    raw: true,
    directive: /^\s*(swift-format-ignore|swiftlint:)/,
  },
  css: { line: [], block: true, quotes: `'"` },
  sql: { line: ['--'], block: true, quotes: `'` },
  sh: { hash: true, quotes: `'"`, wordStart: true, heredoc: true, directive: /^\s*shellcheck\s/ },
  py: { hash: true, quotes: `'"`, triple: true, directive: /^\s*(noqa|type:|-\*-|pragma)/ },
  yaml: { hash: true, quotes: `'"`, wordStart: true, directive: /^\s*(yaml-language-server|v?\d+(\.\d+)*\s*$)/ },
  html: { html: true },
};

const BY_EXTENSION = {
  '.ts': 'js',
  '.js': 'js',
  '.mjs': 'js',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.swift': 'swift',
  '.css': 'css',
  '.sql': 'sql',
  '.sh': 'sh',
  '.py': 'py',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.html': 'html',
};

export const syntaxFor = (path) => SYNTAX[BY_EXTENSION[extname(path)]] ?? null;

const isIdentChar = (c) => /[\w$]/.test(c);

export const findComments = (text, syntax) => {
  const comments = [];
  const n = text.length;
  let i = 0;
  const stack = [];
  let lastToken = null;

  if (text.startsWith('#!')) i = text.indexOf('\n') === -1 ? n : text.indexOf('\n');

  const addComment = (start, end, body) => {
    if (!syntax.directive?.test(body)) comments.push({ start, end });
  };

  const toLineEnd = (from) => {
    const nl = text.indexOf('\n', from);
    return nl === -1 ? n : nl;
  };

  const skipBlock = (from) => {
    let depth = 1;
    let j = from + 2;
    while (j < n && depth > 0) {
      if (syntax.nested && text.startsWith('/*', j)) {
        depth++;
        j += 2;
      } else if (text.startsWith('*/', j)) {
        depth--;
        j += 2;
      } else j++;
    }
    return j;
  };

  const scanString = (from, quote, { triple = false, raw = 0 } = {}) => {
    const close = triple ? quote.repeat(3) + '#'.repeat(raw) : quote + '#'.repeat(raw);
    let j = from;
    while (j < n) {
      const c = text[j];
      if (text.startsWith(close, j)) return { end: j + close.length };
      if (c === '\n' && !triple && quote !== '`') return { end: j };
      if (c === '\\' && raw === 0) {
        if (syntax.swiftInterp && text[j + 1] === '(') return { end: j + 2, interp: { quote, triple, raw } };
        j += 2;
        continue;
      }
      if (raw > 0 && text.startsWith('\\' + '#'.repeat(raw) + '(', j)) return { end: j + raw + 2, interp: { quote, triple, raw } };
      if (syntax.template && quote === '`' && text.startsWith('${', j)) return { end: j + 2, interp: { quote } };
      if (syntax.dollarTemplate && quote === '"' && text.startsWith('${', j)) return { end: j + 2, interp: { quote, triple } };
      j++;
    }
    return { end: n };
  };

  const resumeString = (from, state) => {
    const result = scanString(from, state.quote, state);
    if (result.interp) stack.push({ kind: 'interp', ...result.interp });
    return result.end;
  };

  const scanRegex = (from) => {
    let j = from + 1;
    let inClass = false;
    while (j < n && text[j] !== '\n') {
      const c = text[j];
      if (c === '\\') j += 2;
      else if (c === '[') {
        inClass = true;
        j++;
      } else if (c === ']') {
        inClass = false;
        j++;
      } else if (c === '/' && !inClass) {
        j++;
        while (j < n && /[a-z]/i.test(text[j])) j++;
        return j;
      } else j++;
    }
    return j;
  };

  const regexAllowed = () => {
    if (!lastToken) return true;
    if (lastToken.type === 'punct') return !')]}'.includes(lastToken.value);
    if (lastToken.type === 'word') return REGEX_KEYWORDS.has(lastToken.value);
    return false;
  };

  if (syntax.html) {
    const blocks = [];
    for (const m of text.matchAll(/<(script|style)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
      const inner = m.index + m[0].indexOf('>') + 1;
      blocks.push([inner, inner + m[2].length]);
      const sub = m[1].toLowerCase() === 'style' ? SYNTAX.css : SYNTAX.js;
      for (const c of findComments(m[2], sub)) comments.push({ start: c.start + inner, end: c.end + inner });
    }
    const inBlock = (at) => blocks.some(([s, e]) => at >= s && at < e);
    for (let at = text.indexOf('<!--'); at !== -1; at = text.indexOf('<!--', at)) {
      const close = text.indexOf('-->', at + 4);
      const end = close === -1 ? n : close + 3;
      if (!inBlock(at)) addComment(at, end, text.slice(at + 4, close === -1 ? n : close));
      at = end;
    }
    return comments.sort((a, b) => a.start - b.start);
  }

  let heredocs = [];

  while (i < n) {
    const c = text[i];

    if (syntax.heredoc && text.startsWith('<<', i) && text[i + 2] !== '<') {
      const m = /^<<(-?)[ \t]*(['"]?)([A-Za-z_][\w.-]*)\2/.exec(text.slice(i, i + 200));
      if (m) {
        heredocs.push({ word: m[3], dash: m[1] === '-' });
        i += m[0].length;
        continue;
      }
    }

    if (c === '\n' && heredocs.length) {
      let j = i + 1;
      for (const { word, dash } of heredocs) {
        while (j < n) {
          const end = toLineEnd(j);
          const line = text.slice(j, end);
          j = end + 1;
          if ((dash ? line.replace(/^\t+/, '') : line) === word) break;
        }
      }
      heredocs = [];
      i = j;
      continue;
    }

    if (syntax.hash && c === '#') {
      const prev = i === 0 ? '\n' : text[i - 1];
      if (!syntax.wordStart || /\s/.test(prev)) {
        const end = toLineEnd(i);
        addComment(i, end, text.slice(i + 1, end));
        i = end;
        continue;
      }
    }

    const lineMarker = syntax.line?.find((marker) => text.startsWith(marker, i));
    if (lineMarker) {
      const end = toLineEnd(i);
      addComment(i, end, text.slice(i + lineMarker.length, end));
      i = end;
      continue;
    }

    if (syntax.block && text.startsWith('/*', i)) {
      const end = skipBlock(i);
      addComment(i, end, text.slice(i + 2, Math.max(i + 2, end - 2)));
      i = end;
      continue;
    }

    if (syntax.raw && c === '#') {
      let hashes = 0;
      while (text[i + hashes] === '#') hashes++;
      if (text[i + hashes] === '"') {
        const triple = text.startsWith('"""', i + hashes);
        i = resumeString(i + hashes + (triple ? 3 : 1), { quote: '"', triple, raw: hashes });
        lastToken = { type: 'string' };
        continue;
      }
    }

    if (syntax.quotes?.includes(c) || (syntax.template && c === '`')) {
      const triple = syntax.triple && text.startsWith(c.repeat(3), i);
      i = resumeString(i + (triple ? 3 : 1), { quote: c, triple, raw: 0 });
      lastToken = { type: 'string' };
      continue;
    }

    if (syntax.regex && c === '/' && regexAllowed()) {
      i = scanRegex(i);
      lastToken = { type: 'string' };
      continue;
    }

    if (c === '{' || c === '(') {
      stack.push({ kind: c });
    } else if (c === '}' || c === ')') {
      const top = stack.pop();
      if (top?.kind === 'interp') {
        i = resumeString(i + 1, top);
        lastToken = { type: 'string' };
        continue;
      }
    }

    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (isIdentChar(c)) {
      let j = i;
      while (j < n && isIdentChar(text[j])) j++;
      lastToken = { type: /^\d/.test(c) ? 'number' : 'word', value: text.slice(i, j) };
      i = j;
      continue;
    }
    lastToken = { type: 'punct', value: c };
    i++;
  }
  return comments;
};

export const commentLines = (text, syntax) => {
  const comments = findComments(text, syntax);
  const lineStarts = [0];
  for (let k = 0; k < text.length; k++) if (text[k] === '\n') lineStarts.push(k + 1);
  const lineOf = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const touched = new Set();
  const masked = text.split('');
  for (const { start, end } of comments) {
    for (let line = lineOf(start); line <= lineOf(Math.max(start, end - 1)); line++) touched.add(line);
    for (let k = start; k < end; k++) if (masked[k] !== '\n') masked[k] = ' ';
  }
  const maskedLines = masked.join('').split('\n');
  const lines = [...touched].sort((a, b) => a - b).map((line) => line + 1);
  const ownLines = lines.filter((line) => maskedLines[line - 1].trim() === '');
  return { lines, ownLines };
};

export const strip = (text, syntax) => {
  const masked = text.split('');
  for (const { start, end } of findComments(text, syntax)) {
    for (let k = start; k < end; k++) if (masked[k] !== '\n') masked[k] = '\0';
    const joins = start > 0 && end < text.length && /\S/.test(text[start - 1]) && /\S/.test(text[end]);
    if (joins) masked[start] = ' ';
  }
  const before = text.split('\n');
  const kept = [];
  let dropped = false;
  masked
    .join('')
    .split('\n')
    .forEach((line, k) => {
      const hadComment = line.includes('\0');
      const clean = hadComment ? line.replaceAll('\0', '').replace(/[ \t]+$/, '') : line;
      if (hadComment && clean.trim() === '' && before[k].trim() !== '') {
        dropped = true;
        return;
      }
      if (dropped && clean.trim() === '' && (kept.length === 0 || kept[kept.length - 1].trim() === '')) return;
      dropped = false;
      kept.push(clean);
    });
  return kept.join('\n');
};

const exempt = (path) => EXEMPT.some((re) => re.test(path));

export const trackedFiles = () =>
  execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((path) => path && classify(path) && syntaxFor(path) && !exempt(path) && existsSync(join(root, path)));

export const tally = (files = trackedFiles()) => {
  const counts = {};
  for (const path of files) {
    const text = readFileSync(join(root, path), 'utf8');
    const { lines, ownLines } = commentLines(text, syntaxFor(path));
    if (lines.length) counts[path] = { lines, ownLines, part: classify(path).part };
  }
  return counts;
};

export const ratchet = (counts, baseline) => {
  const over = [];
  for (const [path, { lines }] of Object.entries(counts)) {
    const allowed = baseline[path] ?? 0;
    if (lines.length > allowed) over.push({ path, count: lines.length, allowed, lines });
  }
  return over;
};

export const lowered = (counts, baseline) => {
  const next = {};
  for (const path of Object.keys(baseline).sort()) {
    const count = counts[path]?.lines.length ?? 0;
    if (count > 0) next[path] = Math.min(count, baseline[path]);
  }
  return next;
};

export const moved = (counts, baseline) => {
  const next = { ...baseline };
  const gone = Object.keys(baseline).filter((path) => !existsSync(join(root, path)));
  for (const [path, { lines }] of Object.entries(counts)) {
    if (path in next || !gone.length) continue;
    const from = gone.find((g) => basename(g) === basename(path)) ?? gone.reduce((a, b) => (next[b] > next[a] ? b : a));
    next[path] = Math.min(lines.length, next[from]);
    delete next[from];
    gone.splice(gone.indexOf(from), 1);
  }
  return next;
};

const readBaseline = () => (existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {});
const writeBaseline = (baseline) => writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + '\n');

const report = (counts) => {
  const parts = new Map();
  let all = 0;
  let own = 0;
  for (const { lines, ownLines, part } of Object.values(counts)) {
    const p = parts.get(part) ?? { lines: 0, own: 0, files: 0 };
    p.lines += lines.length;
    p.own += ownLines.length;
    p.files++;
    parts.set(part, p);
    all += lines.length;
    own += ownLines.length;
  }
  const num = (x) => x.toLocaleString('en-GB');
  console.log(`${'part'.padEnd(16)}${'files'.padStart(7)}${'comment lines'.padStart(15)}${'lines shed'.padStart(12)}`);
  for (const [name, p] of [...parts].sort((a, b) => b[1].lines - a[1].lines)) {
    console.log(`${name.padEnd(16)}${num(p.files).padStart(7)}${num(p.lines).padStart(15)}${num(p.own).padStart(12)}`);
  }
  console.log(`${'total'.padEnd(16)}${num(Object.keys(counts).length).padStart(7)}${num(all).padStart(15)}${num(own).padStart(12)}`);
};

const main = (args) => {
  if (args[0] === '--strip') {
    for (const arg of args.slice(1)) {
      const abs = resolve(process.cwd(), arg);
      const syntax = syntaxFor(abs);
      if (!syntax || exempt(relative(root, abs))) continue;
      writeFileSync(abs, strip(readFileSync(abs, 'utf8'), syntax));
    }
    return 0;
  }
  const counts = tally();
  if (args.includes('--reset')) {
    writeBaseline(
      Object.fromEntries(
        Object.entries(counts)
          .map(([path, { lines }]) => [path, lines.length])
          .sort(),
      ),
    );
    return 0;
  }
  const baseline = args.includes('--update') ? moved(counts, readBaseline()) : readBaseline();
  if (args.includes('--check') || args.includes('--update')) {
    const over = ratchet(counts, baseline);
    for (const { path, count, allowed, lines } of over) {
      console.error(
        `${path}: ${count} comment lines, allowed ${allowed} (lines ${lines.slice(0, 10).join(', ')}${lines.length > 10 ? ', …' : ''})`,
      );
    }
    if (over.length) {
      console.error('\nComments are banned (docs/adr/0018-no-comments.md). Delete them, or move a decision into an ADR.');
      if (over.some(({ path }) => !(path in baseline)))
        console.error('A renamed file keeps its old allowance: node scripts/comments.mjs --update.');
      return 1;
    }
    if (args.includes('--update')) writeBaseline(lowered(counts, baseline));
    else {
      const low = lowered(counts, baseline);
      const behind = Object.keys(baseline).filter((path) => low[path] !== baseline[path]);
      if (behind.length) {
        console.error(`${behind.length} files have fewer comments than the baseline: run node scripts/comments.mjs --update`);
        return 1;
      }
    }
    return 0;
  }
  if (args.includes('--list')) {
    for (const [path, { lines }] of Object.entries(counts).sort((a, b) => b[1].lines.length - a[1].lines.length))
      console.log(`${lines.length}\t${path}`);
    return 0;
  }
  report(counts);
  return 0;
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
