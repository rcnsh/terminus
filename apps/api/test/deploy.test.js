import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const config = readFileSync(new URL('../cloudflare.config.ts', import.meta.url), 'utf8');

// The code reads columns from recent migrations (magic_links.code_tries,
// feedback.reply_to), so a deploy to a database without them answers 500.
test('each deploy applies its own D1 migrations first, with the id in cloudflare.config.ts', () => {
  const stable = /name: "terminus", id: "([0-9a-f-]+)"/.exec(config)?.[1];
  const beta = /const BETA = \{\s*d1: "([0-9a-f-]+)"/.exec(config)?.[1];
  assert.ok(stable && beta);
  assert.equal(pkg.scripts.deploy, `cf d1 migrations apply ${stable} && cf deploy`);
  assert.equal(pkg.scripts['deploy:beta'], `cf d1 migrations apply ${beta} && cf deploy --mode beta`);
});
