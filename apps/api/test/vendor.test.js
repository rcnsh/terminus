import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

// The third-party code the website serves (apps/web/public/vendor/), copied
// from npm by scripts/vendor-*.sh, which check each tarball's integrity and
// write every file's SHA-256 to vendor/SHA256SUMS. A file added, removed or
// changed without the scripts (by hand, by a bad merge, by a tool rewriting
// it) fails here. The README is ours, written by hand, so it isn't listed.

const VENDOR = new URL('../../web/public/vendor/', import.meta.url);
const NOT_LISTED = new Set(['README.md', 'SHA256SUMS']);

/** Every file under vendor/, as a path relative to it, but the README and the list. */
function vendoredFiles(dir = VENDOR, prefix = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}${e.name}`;
    if (e.isDirectory()) out.push(...vendoredFiles(new URL(`${e.name}/`, dir), `${rel}/`));
    else if (!(prefix === '' && NOT_LISTED.has(e.name))) out.push(rel);
  }
  return out.sort();
}

/** SHA256SUMS as path → hash, in `sha256sum`'s format: "<hex>  <path>". */
function parseSums(text) {
  const sums = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    const m = /^([0-9a-f]{64}) [ *](\S+)$/.exec(line);
    assert.ok(m, `not a sha256sum line: ${line}`);
    assert.ok(!sums.has(m[2]), `listed twice: ${m[2]}`);
    sums.set(m[2], m[1]);
  }
  return sums;
}

/** What's wrong between the files and the list: one line per file. */
function mismatches(files, sums, hashOf) {
  const out = [];
  for (const f of files) {
    if (!sums.has(f)) out.push(`${f}: not in SHA256SUMS`);
    else if (hashOf(f) !== sums.get(f)) out.push(`${f}: changed since it was vendored`);
  }
  for (const f of sums.keys()) if (!files.includes(f)) out.push(`${f}: in SHA256SUMS but missing`);
  return out;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const hashOnDisk = (f) => sha256(fs.readFileSync(new URL(f, VENDOR)));

test('every vendored file is the one its script wrote, as SHA256SUMS records', () => {
  const sums = parseSums(fs.readFileSync(new URL('SHA256SUMS', VENDOR), 'utf8'));
  const files = vendoredFiles();
  assert.ok(files.length >= 10, 'the vendored libraries are there');
  assert.deepEqual(
    mismatches(files, sums, hashOnDisk),
    [],
    'a vendored file differs from SHA256SUMS: re-run its scripts/vendor-*.sh rather than editing it (the scripts rewrite the list)',
  );
});

test('the vendor check catches a file changed by one byte, added or removed', () => {
  const sums = parseSums(fs.readFileSync(new URL('SHA256SUMS', VENDOR), 'utf8'));
  const files = vendoredFiles();
  const target = files.find((f) => f.endsWith('.mjs'));
  const changed = (f) => {
    const buf = Buffer.from(fs.readFileSync(new URL(f, VENDOR)));
    if (f === target) buf[buf.length >> 1] ^= 1;
    return sha256(buf);
  };
  assert.deepEqual(mismatches(files, sums, changed), [`${target}: changed since it was vendored`]);
  assert.deepEqual(mismatches([...files, 'evil/x.mjs'].sort(), sums, hashOnDisk), ['evil/x.mjs: not in SHA256SUMS']);
  assert.deepEqual(mismatches(files.filter((f) => f !== target), sums, hashOnDisk), [`${target}: in SHA256SUMS but missing`]);
});

test('every vendored library carries its licence', () => {
  const dirs = fs.readdirSync(VENDOR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  assert.ok(dirs.length >= 4);
  for (const d of dirs) {
    const licences = fs.readdirSync(new URL(`${d}/`, VENDOR)).filter((f) => /^LICEN[CS]E/.test(f));
    assert.ok(licences.length > 0, `${d} has no licence`);
    for (const l of licences) assert.ok(fs.statSync(new URL(`${d}/${l}`, VENDOR)).size > 100, `${d}/${l} is empty`);
  }
});

test('each vendor script pins its versions with their npm integrity and records what it writes', () => {
  for (const name of ['vendor-preact.sh', 'vendor-map.sh', 'vendor-mediabunny.sh']) {
    const src = fs.readFileSync(new URL(`../../../scripts/${name}`, import.meta.url), 'utf8');
    assert.match(src, /^\. scripts\/vendor-lib\.sh$/m, name);
    assert.match(src, /integrity \S+ "\$\w+" [0-9.]+ 'sha512-[A-Za-z0-9+/]{86}==' \w+_INTEGRITY\)/, `${name} pins an integrity`);
    assert.match(src, /^record /m, `${name} rewrites its SHA256SUMS entries`);
    assert.doesNotMatch(src, /\|\| true/, `${name} hides no failure`);
    assert.doesNotMatch(src, /npm pack/, `${name} downloads through fetch(), which checks the integrity`);
    // The pinned versions are the folders vendored.
    for (const [, pkg, ver] of src.matchAll(/integrity (\S+) "\$\w+" ([0-9.]+) /g)) {
      if (pkg === 'htm') continue; // inside preact's folder
      const dir = pkg === 'preact' ? `preact-${ver}` : `${pkg}@${ver}`;
      assert.ok(fs.existsSync(new URL(`${dir}/`, VENDOR)), `${name}: ${dir} is vendored`);
    }
  }
});
