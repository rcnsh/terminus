#!/usr/bin/env node
// Runs first in `pnpm run deploy` and `deploy:beta` (package.json): a deploy
// ships the files on disk, not the commit, so it refuses a tree that isn't
// what's committed, and runs the checks CI runs (`pnpm check`). Fails before
// the migrations are applied, so a refused deploy changes nothing.
//
// What a deploy ships: the Worker (apps/api) and the website it serves
// (apps/web/public). Files git ignores (.dev.vars, dev/) don't count.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SHIPPED = ['apps/api', 'apps/web/public'];

/** Lines of `text` that are a merge's conflict markers, as "line: text". */
export function conflictMarkers(text) {
  return text
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /^(<{7}|>{7})(?: |$)/.test(line) || /^={7}$/.test(line))
    .map(([n, line]) => `${n}: ${line}`);
}

/**
 * What stops a deploy, as sentences: files left unmerged, changes not
 * committed (or not yet added) where a deploy reads, conflict markers in a
 * committed file. `git` runs a git command and returns its output.
 */
export function problems(git, readFile) {
  const out = [];
  const unmerged = git(['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
  if (unmerged.length) out.push(`unmerged files:\n  ${unmerged.join('\n  ')}`);
  const dirty = git(['status', '--porcelain', '--', ...SHIPPED]).split('\n').filter(Boolean);
  if (dirty.length) out.push(`changes not committed in ${SHIPPED.join(' or ')}:\n  ${dirty.join('\n  ')}`);
  // Markdown's setext headings use =======, so a hit is read again to make
  // sure it sits between the other two markers' kinds of line.
  const hits = git(['grep', '-l', '-I', '-E', '^(<{7}|>{7})( |$)', '--', ...SHIPPED, ':(exclude,glob)**/vendor/**'], true).split('\n').filter(Boolean);
  for (const file of hits) {
    const lines = conflictMarkers(readFile(file));
    if (lines.some((l) => /: </.test(l)) && lines.some((l) => /: >/.test(l))) out.push(`conflict markers in ${file}:\n  ${lines.slice(0, 6).join('\n  ')}`);
  }
  return out;
}

function main() {
  const api = join(dirname(fileURLToPath(import.meta.url)), '..');
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: api, encoding: 'utf8' }).trim();
  // `git grep` exits 1 when nothing matches: that's the good case.
  const git = (args, noneOk = false) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    } catch (err) {
      if (noneOk && err.status === 1) return '';
      throw err;
    }
  };
  const found = problems(git, (file) => readFileSync(join(root, file), 'utf8'));
  if (found.length) {
    console.error(`Not deploying:\n\n${found.join('\n\n')}\n\nCommit (or put aside) what should ship, then deploy again.`);
    process.exit(1);
  }
  console.log('predeploy: tree clean, running pnpm check');
  try {
    execFileSync('pnpm', ['check'], { cwd: api, stdio: 'inherit' });
  } catch {
    console.error('Not deploying: pnpm check failed.');
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
