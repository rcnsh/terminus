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

/** Static imports (not import()), resolved to site paths: ours, and the vendored modules' minified ones. */
function importsOf(file) {
  const src = read(file);
  return [...src.matchAll(/(?:^|[;\s])import\s*(?:[\w$*{}\s,]+?\s*from\s*)?(['"])([^'"]+)\1/gm)].map((m) => (m[2].startsWith('/') ? m[2] : path.posix.join(path.posix.dirname(file), m[2])));
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

/** Every module [entry] loads at startup, itself left out: its static imports, all the way down. */
function startupModules(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    queue.push(...importsOf(f));
  }
  seen.delete(entry);
  return [...seen].sort();
}

test('each page asks for every module it starts with at once (modulepreload), and only those', () => {
  // Without a bundler the browser finds a module's imports only once it has
  // it: one round trip per level. The page's list lets it ask for them all
  // in one go. Out of date, it would load a file for nothing, or miss one.
  for (const [page, entry] of [['/app/index.html', '/app/app.js'], ['/account/index.html', '/account/app.js']]) {
    const listed = [...read(page).matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]).sort();
    assert.deepEqual(listed, startupModules(entry), page);
  }
  // Settings and setup wait for sign-in on the account page.
  assert.ok(!startupModules('/account/app.js').includes('/account/settings.js'));
});
