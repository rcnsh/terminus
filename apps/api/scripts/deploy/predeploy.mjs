#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SHIPPED = ['apps/api', 'apps/web/public'];

export function conflictMarkers(text) {
  return text
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /^(<{7}|>{7})(?: |$)/.test(line) || /^={7}$/.test(line))
    .map(([n, line]) => `${n}: ${line}`);
}

export function problems(git, readFile) {
  const out = [];
  const unmerged = git(['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
  if (unmerged.length) out.push(`unmerged files:\n  ${unmerged.join('\n  ')}`);
  const dirty = git(['status', '--porcelain', '--', ...SHIPPED])
    .split('\n')
    .filter(Boolean);
  if (dirty.length) out.push(`changes not committed in ${SHIPPED.join(' or ')}:\n  ${dirty.join('\n  ')}`);
  const hits = git(['grep', '-l', '-I', '-E', '^(<{7}|>{7})( |$)', '--', ...SHIPPED, ':(exclude,glob)**/vendor/**'], true)
    .split('\n')
    .filter(Boolean);
  for (const file of hits) {
    const lines = conflictMarkers(readFile(file));
    if (lines.some((l) => /: </.test(l)) && lines.some((l) => /: >/.test(l)))
      out.push(`conflict markers in ${file}:\n  ${lines.slice(0, 6).join('\n  ')}`);
  }
  return out;
}

function main() {
  const api = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: api, encoding: 'utf8' }).trim();
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
    execFileSync('pnpm', ['check'], { cwd: root, stdio: 'inherit' });
  } catch {
    console.error('Not deploying: pnpm check failed.');
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
