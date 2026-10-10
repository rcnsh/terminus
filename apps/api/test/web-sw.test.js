/**
 * The web app's service worker (apps/web/public/sw.js) keeps the app's own
 * files for offline. Every module the app loads at startup (app/app.js and
 * what it imports, statically, all the way down) must be on its list: one
 * missing file fails the whole module graph, and the app never starts
 * offline. Modules loaded later with import() are fine without it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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

/**
 * The cache's name and the list it was made from, as they were last changed
 * together. When SHELL_FILES changes, bump SHELL in sw.js too (so browsers
 * drop the old copy and its files), then put both here.
 */
const SHELL_PIN = { shell: 'shell-v21', files: 'bd9ed5e5e6286b59' };

test('the list of files kept for offline changes only with a new SHELL', () => {
  const shell = /const SHELL = '([^']+)'/.exec(read('sw.js'))[1];
  const files = crypto.createHash('sha256').update([...shellFiles()].sort().join('\n')).digest('hex').slice(0, 16);
  if (files !== SHELL_PIN.files && shell === SHELL_PIN.shell) assert.fail(`SHELL_FILES changed: bump SHELL in sw.js, then set SHELL_PIN here to the new name and files: '${files}'`);
  assert.deepEqual({ shell, files }, SHELL_PIN, `SHELL_PIN is out of date: set it to { shell: '${shell}', files: '${files}' }`);
});

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

/** What [page]'s module scripts load at startup, the scripts themselves left out (the page names them already). */
function pageModules(page) {
  const entries = [...read(page).matchAll(/<script type="module" src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.ok(entries.length, `${page} has a module script`);
  const all = new Set(entries.flatMap(startupModules));
  for (const e of entries) all.delete(e);
  return [...all].sort();
}

test('each page asks for every module it starts with at once (modulepreload), and only those', () => {
  // Without a bundler the browser finds a module's imports only once it has
  // it: one round trip per level. The page's list lets it ask for them all
  // in one go. Out of date, it would load a file for nothing, or miss one.
  const pages = [
    '/app/index.html',
    '/account/index.html',
    '/index.html',
    '/status/index.html',
    '/privacy/index.html',
    '/privacy/zh/index.html',
    '/privacy/policy/index.html',
    '/privacy/policy/zh/index.html',
    '/not-found/index.html',
  ];
  for (const page of pages) {
    const listed = [...read(page).matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]).sort();
    assert.deepEqual(listed, pageModules(page), page);
  }
  // Settings and setup wait for sign-in on the account page.
  assert.ok(!startupModules('/account/app.js').includes('/account/settings.js'));
});

/** The modules [file] loads later with import(), resolved to site paths. */
function lazyImportsOf(file) {
  return [...read(file).matchAll(/\bimport\((['"])([^'"]+)\1\)/g)].map((m) => (m[2].startsWith('/') ? m[2] : path.posix.join(path.posix.dirname(file), m[2])));
}

test('Settings asks for all its modules at once, not one level at a time', () => {
  // Each page imports Settings (and the account page, setup) with import(),
  // along with every module those need that the page hasn't loaded yet.
  for (const [entry, parts] of [['/app/app.js', ['/account/settings.js']], ['/account/app.js', ['/account/settings.js', '/account/onboarding.js']]]) {
    const loaded = new Set([entry, ...startupModules(entry)]);
    const needed = new Set(parts.flatMap((p) => [p, ...startupModules(p)]).filter((f) => !loaded.has(f)));
    const asked = new Set(lazyImportsOf(entry));
    assert.deepEqual([...needed].filter((f) => !asked.has(f)), [], entry);
  }
});

test('Chinese is kept for offline only once it is asked for', () => {
  // Only Chinese readers load zh.js (assets/i18n.js): the service worker keeps it when they do.
  assert.ok(!shellFiles().has('/assets/zh.js'));
  assert.match(read('sw.js'), /const ZH = '\/assets\/zh\.js'/);
});

test('the map libraries named in app/map-files.js are the vendored ones', () => {
  // The one place their versions are written: the map, its early fetch,
  // the timelapse page, and the service worker's clean-up all follow it.
  const src = read('app/map-files.js');
  for (const name of ['MAPLIBRE', 'PMTILES']) {
    const at = new RegExp(`export const ${name} = '([^']+)'`).exec(src)[1];
    assert.ok(fs.existsSync(new URL(decodeURIComponent(at).replace(/^\//, ''), PUBLIC)), at);
  }
  for (const f of ['app/map.js', 'admin/timelapse/timelapse.js']) assert.doesNotMatch(read(f), /maplibre-gl%40\d|pmtiles%40\d/, f);
});
