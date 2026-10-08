import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import defineSite from '../cloudflare.config.ts';
import { conflictMarkers, problems } from '../scripts/predeploy.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// The config is a function of cf's --mode: none (or "production") for the
// stable site, "beta" for the beta.
const STABLE = defineSite({ mode: undefined }).worker;
const BETA = defineSite({ mode: 'beta' }).worker;

/** The account resources a binding points at, as "kind:value" (empty for one that names none, like a secret). */
function resources(b) {
  switch (b.type) {
    case 'd1':
      return [`d1:${b.id}`, `d1-name:${b.name}`];
    case 'kv':
      return [`kv:${b.id}`];
    case 'r2':
      return [`r2:${b.name}`];
    case 'rate-limit':
      return [`rl:${b.namespace}`];
    case 'analytics-engine-dataset':
      return [`ae:${b.name}`];
    case 'durable-object':
      return [`worker:${b.worker}`];
    default:
      return [];
  }
}

const everything = (w) => new Set([`worker:${w.name}`, ...w.domains.map((d) => `domain:${d}`), ...Object.values(w.env).flatMap(resources)]);

test('stable is the default mode, and an unknown mode is refused', () => {
  assert.deepEqual(defineSite({ mode: 'production' }).worker, STABLE);
  assert.throws(() => defineSite({ mode: 'staging' }), /unknown mode/);
});

test('the beta shares no database, store, bucket, limit, dataset, Worker or domain with the stable site', () => {
  assert.deepEqual(Object.keys(BETA.env).filter((k) => !(k in STABLE.env)), ['PUBLIC_ORIGIN', 'AE_DATASET'], 'the beta only adds the vars that say it is the beta');
  for (const [name, binding] of Object.entries(STABLE.env)) {
    const stable = resources(binding);
    const beta = resources(BETA.env[name]);
    assert.equal(beta.length, stable.length, name);
    for (const r of stable) assert.ok(!beta.includes(r), `${name} is ${r} on both sites`);
  }
  const shared = [...everything(STABLE)].filter((r) => everything(BETA).has(r));
  assert.deepEqual(shared, [], 'nothing on one site is used by any binding on the other');
  // Rate-limit counters are per namespace: two limits on one would count each other's requests.
  const rl = [STABLE, BETA].flatMap((w) => Object.values(w.env).filter((b) => b.type === 'rate-limit').map((b) => b.namespace));
  assert.equal(new Set(rl).size, rl.length, `rate-limit namespaces repeat: ${rl.join(' ')}`);
  // Each Durable Object binding is to this Worker's own class.
  for (const w of [STABLE, BETA]) {
    for (const b of Object.values(w.env).filter((b) => b.type === 'durable-object')) assert.equal(b.worker, w.name);
  }
});

test('the beta knows it is the beta, and writes its analytics to its own dataset', () => {
  // site.ts isBeta reads PUBLIC_ORIGIN; admin.ts queries AE_DATASET.
  assert.equal(STABLE.env.PUBLIC_ORIGIN, undefined);
  assert.equal(BETA.env.PUBLIC_ORIGIN.value, `https://${BETA.domains[0]}`);
  assert.equal(STABLE.env.AE.name, 'terminus', 'admin.ts falls back to "terminus" without AE_DATASET');
  assert.equal(BETA.env.AE_DATASET.value, BETA.env.AE.name);
  // Only one site polls NUS for the timelapse (CLAUDE.md, rule 2).
  assert.equal(STABLE.env.TIMELAPSE_ENABLED.value, 'on');
  assert.equal(BETA.env.TIMELAPSE_ENABLED.value, 'off');
});

// The code reads columns from recent migrations (magic_links.code_tries,
// feedback.reply_to), so a deploy to a database without them answers 500.
// The guard runs first, so a dirty tree or a failed check changes nothing.
test('each deploy checks the tree, then applies its own D1 migrations, then deploys its own mode', () => {
  assert.equal(pkg.scripts.deploy, `node scripts/predeploy.mjs && cf d1 migrations apply ${STABLE.env.DB.id} && cf deploy`);
  assert.equal(pkg.scripts['deploy:beta'], `node scripts/predeploy.mjs && cf d1 migrations apply ${BETA.env.DB.id} && cf deploy --mode beta`);
});

/** Bucket names a shell script names: `BUCKET=`/`BUCKETS=` values and `r2 object put "<bucket>/...`. */
function bucketsIn(script) {
  const names = new Set();
  for (const m of script.matchAll(/\bBUCKETS?=("[^"]*"|'[^']*'|[^\s;]+)/g)) {
    for (let word of m[1].replace(/^["']|["']$/g, '').split(/\s+/)) {
      word = word.replace(/^\$\{\w+:-(.*)\}$/, '$1');
      if (word && !word.startsWith('$')) names.add(word);
    }
  }
  for (const m of script.matchAll(/r2 object put ["']?([a-z0-9][a-z0-9-]*)\//g)) names.add(m[1]);
  return names;
}

test('the release and map scripts upload to the buckets each site serves downloads from', () => {
  const stable = STABLE.env.DOWNLOADS.name;
  const beta = BETA.env.DOWNLOADS.name;
  const script = (name) => readFileSync(new URL(`../../../scripts/${name}`, import.meta.url), 'utf8');
  assert.deepEqual([...bucketsIn(script('release.sh'))], [stable], 'scripts/release.sh uploads to the stable bucket');
  assert.deepEqual([...bucketsIn(script('release-beta.sh'))], [beta], 'scripts/release-beta.sh uploads to the beta bucket');
  const tiles = script('map-tiles.sh');
  assert.deepEqual([...bucketsIn(tiles)].sort(), [stable, beta].sort(), 'scripts/map-tiles.sh knows both buckets');
  // Its CHANNEL arms, where it still picks the bucket with a case.
  const arm = (channel) => tiles.split('\n').find((l) => new RegExp(`^\\s*${channel}\\)`).test(l));
  for (const [channel, want] of [['stable', [stable]], ['beta', [beta]], ['both', [stable, beta]]]) {
    const line = arm(channel);
    if (line) assert.deepEqual([...bucketsIn(line)].sort(), want.sort(), `CHANNEL=${channel} in scripts/map-tiles.sh`);
  }
  // And no script names a bucket that is neither.
  const dir = new URL('../../../scripts/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sh'))) {
    for (const b of bucketsIn(readFileSync(new URL(f, dir), 'utf8'))) assert.ok(b === stable || b === beta, `scripts/${f} names bucket ${b}`);
  }
});

const MIGRATIONS = new URL('../migrations/', import.meta.url);
const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();

test('migrations are numbered 0001, 0002, ... with no gap or repeat', () => {
  const files = migrationFiles();
  assert.ok(files.length > 0);
  files.forEach((f, i) => {
    assert.match(f, /^\d{4}_[a-z0-9_]+\.sql$/, f);
    assert.equal(Number(f.slice(0, 4)), i + 1, `${f} should be numbered ${String(i + 1).padStart(4, '0')}`);
  });
});

/** The statements of a SQL file, comments removed. */
const statements = (sql) => sql.replace(/--[^\n]*/g, '').split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);

/** What in a migration would break the Worker still running during a deploy (docs/internals.md, "additive"). */
function notAdditive(sql) {
  return statements(sql).filter((s) => {
    if (/^DROP (TABLE|COLUMN)\b/i.test(s)) return true;
    if (!/^ALTER TABLE\b/i.test(s)) return false;
    if (/\b(DROP|RENAME)\b/i.test(s)) return true;
    return /\bADD\b/i.test(s) && /\bNOT NULL\b/i.test(s) && !/\bDEFAULT\b/i.test(s);
  });
}

// Written before this rule: 0002 renamed a table, 0006 rebuilt five. Both
// are applied and locked below, so they can't change.
const BEFORE_THE_RULE = ['0002_public_beta.sql', '0006_anonymous.sql'];

test('migrations only add, unless one says it is the contract step', () => {
  assert.ok(notAdditive('ALTER TABLE a DROP COLUMN b;').length);
  assert.ok(notAdditive('ALTER TABLE a RENAME COLUMN b TO c;').length);
  assert.ok(notAdditive('ALTER TABLE a RENAME TO b;').length);
  assert.ok(notAdditive('ALTER TABLE a ADD COLUMN b TEXT NOT NULL;').length);
  assert.ok(notAdditive('DROP TABLE a;').length);
  assert.deepEqual(notAdditive("ALTER TABLE a ADD COLUMN b TEXT NOT NULL DEFAULT '';\nALTER TABLE a ADD COLUMN c INTEGER;\nCREATE TABLE d (e TEXT NOT NULL);\nDROP INDEX f;"), []);
  for (const f of migrationFiles()) {
    if (BEFORE_THE_RULE.includes(f)) continue;
    const sql = readFileSync(new URL(f, MIGRATIONS), 'utf8');
    // The third step of expand-backfill-contract drops what no deployed
    // code reads any more; it says so with a `-- contract:` line.
    if (/^-- contract:/m.test(sql)) continue;
    assert.deepEqual(notAdditive(sql), [], `${f} would break the Worker still running while it deploys`);
  }
});

test('an applied migration is never edited', () => {
  // D1 records a migration by name and never runs it again, so an edit
  // would reach no database that has it. The lock lists each migration
  // already applied; a new one isn't in it until it has been applied to
  // both databases, when its line is appended:
  //   shasum -a 256 <file> >> test/fixtures/migrations.sha256 (from apps/api/migrations)
  const lock = readFileSync(new URL('./fixtures/migrations.sha256', import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(l));
  assert.ok(lock.length && lock.every(Boolean), 'each line is "<sha256>  <file>"');
  const files = migrationFiles();
  for (const [, hash, file] of lock) {
    assert.ok(files.includes(file), `${file} is applied; it can't be renamed or removed`);
    const now = createHash('sha256').update(readFileSync(new URL(file, MIGRATIONS))).digest('hex');
    assert.equal(now, hash, `${file} is applied and must not change: write a new migration instead`);
  }
  for (const f of BEFORE_THE_RULE) assert.ok(lock.some((l) => l[2] === f), `${f} stays locked`);
});

test('the deploy guard spots conflict markers, not markdown headings', () => {
  assert.deepEqual(conflictMarkers('a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> main\n'), ['2: <<<<<<< HEAD', '4: =======', '6: >>>>>>> main']);
  assert.deepEqual(conflictMarkers('Title\n=======\n\ntext <<<<<<< inline\n'), ['2: ======='], 'a heading underline alone');
  const git = (out) => (args) => out[args[0] === 'diff' ? 'diff' : args[0]] ?? '';
  const read = (texts) => (f) => texts[f];
  assert.deepEqual(problems(git({}), read({})), []);
  const found = problems(
    git({ diff: 'apps/api/src/a.ts\n', status: ' M apps/api/src/b.ts\n?? apps/api/src/c.ts\n', grep: 'apps/api/src/d.ts\napps/web/public/e.md\n' }),
    read({ 'apps/api/src/d.ts': '<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n', 'apps/web/public/e.md': '>>>>>>> quoted\n' }),
  );
  assert.equal(found.length, 3, found.join('\n'));
  assert.match(found[0], /unmerged files:\n {2}apps\/api\/src\/a\.ts/);
  assert.match(found[1], /not committed[\s\S]*b\.ts[\s\S]*c\.ts/);
  assert.match(found[2], /conflict markers in apps\/api\/src\/d\.ts/);
});
