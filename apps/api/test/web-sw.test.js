/**
 * The web app's service worker (apps/web/public/sw.js) keeps the app's own
 * files for offline. Every module the app loads at startup (app/app.js and
 * what it imports, statically, all the way down) must be on its list: one
 * missing file fails the whole module graph, and the app never starts
 * offline. Modules loaded later with import() are fine without it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PUBLIC = new URL('../../web/public/', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p.replace(/^\//, ''), PUBLIC), 'utf8');

function shellFiles() {
  const list = /const SHELL_FILES = \[([\s\S]*?)\];/.exec(read('sw.js'))[1];
  return new Set([...list.matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

/** Static imports (not import()), resolved to site paths. */
function importsOf(file) {
  const src = read(file);
  return [...src.matchAll(/^import\s[^;]*?from\s+'([^']+)';/gm)].map((m) => (m[1].startsWith('/') ? m[1] : path.posix.join(path.posix.dirname(file), m[1])));
}

test('every module the web app loads at startup is kept for offline', () => {
  const shell = shellFiles();
  const seen = new Set();
  const queue = ['/app/app.js'];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    queue.push(...importsOf(f));
  }
  const missing = [...seen].filter((f) => !shell.has(f));
  assert.deepEqual(missing, []);
});
