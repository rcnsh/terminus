/**
 * The D1 migrations stay safe to deploy (docs/internals.md, "Migrations must
 * be additive"): a migration runs while the old Worker still serves, so one
 * may only add. And a migration already applied is never edited: D1 records
 * it by name and won't run it again, so an edit would only change fresh
 * databases (the tests' among them), never the real ones.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

const DIR = new URL('../migrations/', import.meta.url);
const files = () => readdirSync(DIR).filter((n) => n.endsWith('.sql')).sort();
const read = (name) => readFileSync(new URL(name, DIR), 'utf8');

/**
 * Applied to the stable and beta databases. A new migration is added here
 * deliberately, in the same commit, once it is final: from then on it is
 * frozen.
 */
const APPLIED = {
  '0001_accounts.sql': '7d5acf3ce2ff567bb4d6b55d2ab2244e6081d52587ea6994ebf00a8785eea5f7',
  '0002_public_beta.sql': 'cd2c8252e78b9947049e9a3d527617931e2a5430e68b06a68a94ad811c92515c',
  '0003_crowds.sql': '9e4df3e5b543847fcd6b4f9f3017c1e8922886099d0122c806278d0fa2df77a0',
  '0004_api_keys.sql': 'f04116bdf30ebe1817588425159fc4c3ad87ac4099c57ea2ebc01208f99c7012',
  '0005_feedback.sql': 'e0113456ee7bb3ece8c76915c8322df90e0371d5e6d307fd68b5ce12c4e6fe79',
  '0006_anonymous.sql': '6cb2c74919067af580cd1bc3bb6d15d79bd3c64620b213e9f08e9338237400ab',
  '0007_trip_outcomes.sql': 'b8fd7619257eec4e448890195e12266dae5405e1f82e995024d07ce141732e1c',
  '0008_ride_times.sql': '3e164f07e79adf566e42873862e82be0b901d79d71e48b9dba313c22894ec3a4',
  '0009_code_tries.sql': 'e733211b3c1b4da1c82c7c5f029509307c1ae2c5d4dc2d808ca435f1fd9960a8',
  '0010_feedback_reply_to.sql': '41f3bf4861b355eb0a7d5a2f99f40c40efd6e3bddebe8a6946c8d2f932b1daff',
  '0011_lookup_indexes.sql': 'fa774c48c28348496f394dbdc04e109cbba28fc9487a3b571be2d4d96bf090e5',
  '0012_trip_outcome_days.sql': '1bab62b109e0ca18c850511b8de3cfc241789eb1e8df5e4350e0808faede5bf4',
  '0013_forget_ride_times.sql': '94bc653364ec45efe2bd08b9966ced1fe0d185a48d82ea53a0c3507d6cc2dbf1',
  '0014_feedback_reason.sql': '691547b5f8b9168de55526bd0cc7f51698a79fcefee16353f0fc2a025d6d92fd',
};

/**
 * 0002 renamed a column and 0006 rebuilt five tables, before the rule was
 * written down; internals.md names both. Everything after must add only.
 */
const ADDITIVE_FROM = 7;

/** What breaks the Worker still serving on the new schema, or null. */
function unsafe(sql) {
  const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const raw of code.split(';')) {
    const st = raw.replace(/\s+/g, ' ').trim();
    if (!st) continue;
    if (/\bDROP\s+(TABLE|COLUMN|VIEW)\b/i.test(st) || /\bALTER\s+TABLE\s+\S+\s+DROP\b/i.test(st)) return `drops: ${st}`;
    if (/\bRENAME\b/i.test(st)) return `renames: ${st}`;
    // A new table may have NOT NULL columns; a column added to a table
    // with rows, and that the old code doesn't write, needs a default.
    if (/\bADD\s+(COLUMN\s+)?/i.test(st) && /\bALTER\s+TABLE\b/i.test(st) && /\bNOT\s+NULL\b/i.test(st) && !/\bDEFAULT\b/i.test(st)) return `NOT NULL without a default: ${st}`;
  }
  return null;
}

test('the additive check catches what the rule forbids, and passes what it allows', () => {
  assert.match(unsafe('DROP TABLE crowds;'), /drops/);
  assert.match(unsafe('ALTER TABLE users DROP COLUMN ask_from;'), /drops/);
  assert.match(unsafe('ALTER TABLE users RENAME COLUMN email TO address;'), /renames/);
  assert.match(unsafe('ALTER TABLE users_new RENAME TO users;'), /renames/);
  assert.match(unsafe('ALTER TABLE users ADD COLUMN tz TEXT NOT NULL;'), /NOT NULL/);
  assert.equal(unsafe('ALTER TABLE magic_links ADD COLUMN code_tries INTEGER NOT NULL DEFAULT 0;'), null);
  assert.equal(unsafe('CREATE TABLE t (a TEXT NOT NULL);\n-- DROP TABLE t; in a comment is fine\nCREATE INDEX i ON t(a);'), null);
  assert.equal(unsafe('UPDATE trip_outcomes SET at = at - 1;'), null);
});

test(`every migration from ${String(ADDITIVE_FROM).padStart(4, '0')} on only adds`, () => {
  for (const name of files()) {
    if (Number(name.slice(0, 4)) < ADDITIVE_FROM) continue;
    assert.equal(unsafe(read(name)), null, name);
  }
});

test('migrations already applied are never edited, removed or renumbered', () => {
  const sha = (name) => createHash('sha256').update(read(name).replace(/\r\n/g, '\n')).digest('hex');
  const onDisk = files();
  for (const [name, hash] of Object.entries(APPLIED)) {
    assert.ok(onDisk.includes(name), `${name} is applied in production and must stay`);
    assert.equal(sha(name), hash, `${name} was edited; add a new migration instead`);
  }
  // A new file is listed here on purpose once it is final, so it's frozen too.
  assert.deepEqual(onDisk.filter((n) => !(n in APPLIED)), [], 'add each new migration to APPLIED');
  const numbers = onDisk.map((n) => n.slice(0, 4));
  assert.equal(new Set(numbers).size, numbers.length, 'one migration per number');
});
