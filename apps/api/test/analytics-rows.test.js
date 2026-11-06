/**
 * The Analytics Engine row layout (src/analytics-rows.ts). Rows already
 * written can't be rewritten, so every kind's raw positions are pinned
 * here as they were written before the layout was declared, and the
 * queries that read them are pinned byte for byte.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { makeAnalytics, makeEnv, makeKV, named } from './_stubs.mjs';
import { fakeAeRows } from '../scripts/dev/stub-admin.mjs';
import { ROWS, rowPoint, sharedColumns } from '../src/analytics-rows.ts';
import {
  logActive,
  logAnswer,
  logAppError,
  logBoard,
  logCronError,
  logError,
  logKeyUse,
  logLegacy,
  logNextTook,
  logPoll,
  logSetting,
  logSignal,
  logStep,
  logTripWake,
} from '../src/ops/analytics.ts';
import { noteFailure, resetFailureNotes } from '../src/feeds/fms.ts';
import { adminStats } from '../src/ops/admin.ts';
import { predictionsFor } from '../src/ops/eta.ts';

const best = {
  svc: 'D2',
  arrival: { crowd: 'high', berth: 'COM3-S' },
  change: { stop: { code: 'UTOWN' }, svc: 'D1', boardS: 900, reachS: 600, crossS: 60 },
  boardS: 240,
  rideS: 480,
  totalS: 1500,
  hops: 4,
  walkS: 90,
  ambiguousBerth: true,
};
const answer = {
  stop: { code: 'COM3', confidence: 0.9 },
  quality: 'live',
  arrivals: [
    { svc: 'D2', etaS: 240, plate: 'PA1234A', crowd: 'high', berth: 'COM3-S' },
    { svc: 'D1', etaS: null },
    { svc: 'A1', etaS: 60 },
  ],
};

/** Every kind written by its real logger, and the data point it wrote before ROWS existed. */
async function written() {
  const ae = makeAnalytics();
  const kv = makeKV();
  await kv.put('config:collect:eta', 'on');
  const env = makeEnv(kv, ae);
  logAnswer(env, { answer, best, dest: 'UTOWN', hadCoords: true, walkAllS: 1200 });
  await logBoard(env, {
    code: 'COM3',
    fetchedAt: Date.now() + 60_000,
    arrivals: [{ svc: 'D2', etaS: 240, plate: 'PA1234A', crowd: 'low', berth: 'COM3-N' }],
  });
  logNextTook(env, 412.6);
  logError(env, '/api/me/devices/abc123?lat=1');
  logCronError(env, 'upstream');
  resetFailureNotes();
  noteFailure(env, 'buses', 'A1', new TypeError('x is undefined'));
  logPoll(env, 'upstream', 'A1', 3);
  logTripWake(env, { changed: true, phase: 'leave', quality: 'live', first: false, gapS: 30, feedAgeS: 5, leaveShiftS: -20, lateS: 1 });
  logActive(env, { scope: 'app', name: 'android', day: '2026-10-11', d1: 1, d7: 2, d30: 3 });
  logLegacy(env, { what: 'address', client: 'android/3.2.0', route: '/api/me/next' });
  logSetting(env, { setting: 'walkPace', value: 'fast', day: '2026-10-11', n: 6, of: 31 });
  logKeyUse(env, { keyId: 'k1', route: '/api/next', outcome: 'limited' });
  logAppError(env, {
    platform: 'web',
    version: '3.6.0',
    fingerprint: 'fp',
    type: 'E',
    message: 'm',
    stack: 's',
    os: 'Safari 26',
    fatal: true,
  });
  logSignal(env, 'onboard');
  logStep(env, 'later', 'home:2026-10-11');
  return ae.events;
}

const BEFORE = [
  {
    blobs: ['answer', 'COM3', 'D2', 'UTOWN', 'live', '', 'high', '', 'COM3-S', 'UTOWN', 'D1'],
    doubles: [0, 240, 480, 1500, 4, 90, 0.9, 1, 1, 1200, 240],
    indexes: ['COM3'],
  },
  {
    blobs: ['arrival', 'COM3', 'D2', 'UTOWN', 'live', 'PA1234A', 'high', '', 'COM3-S'],
    doubles: [240, -1, -1, -1, -1, -1, 0.9, 0, 1, -1],
    indexes: ['COM3'],
  },
  {
    blobs: ['arrival', 'COM3', 'A1', 'UTOWN', 'live', '', '', '', ''],
    doubles: [60, -1, -1, -1, -1, -1, 0.9, 0, 1, -1],
    indexes: ['COM3'],
  },
  { blobs: ['board', 'COM3', 'D2', '', 'live', 'PA1234A', 'low', '', 'COM3-N'], doubles: [240], indexes: ['COM3'] },
  { blobs: ['next'], doubles: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 413], indexes: ['next'] },
  { blobs: ['error', '/api/me/devices'], doubles: [], indexes: ['error'] },
  { blobs: ['error', 'cron upstream'], doubles: [], indexes: ['error'] },
  { blobs: ['error', 'feed buses', 'TypeError: x is undefined'], doubles: [], indexes: ['error'] },
  { blobs: ['timelapse', 'upstream', 'A1'], doubles: [3], indexes: ['timelapse'] },
  { blobs: ['tripwake', 'pushed', 'leave', 'live', 'again'], doubles: [30, 5, -20, 1], indexes: ['tripwake'] },
  { blobs: ['active', 'app', 'android', '2026-10-11'], doubles: [1, 2, 3], indexes: ['active'] },
  { blobs: ['legacy', 'address', 'android/3.2.0', '/api/me/next'], doubles: [1], indexes: ['legacy'] },
  { blobs: ['settings', 'walkPace', 'fast', '2026-10-11'], doubles: [6, 31], indexes: ['settings'] },
  { blobs: ['apikey', 'k1', '/api/next', 'limited'], doubles: [1], indexes: ['k1'] },
  {
    blobs: ['apperror', 'web', '3.6.0', 'fp', 'E', 'm', 's', 'Safari 26'],
    doubles: [1, 1],
    indexes: ['apperror'],
  },
  { blobs: ['signal', 'onboard'], doubles: [1], indexes: ['signal'] },
  { blobs: ['step', 'later', 'home'], doubles: [1], indexes: ['step'] },
];

test('every kind is written at the positions it always was', async () => {
  const rows = await written();
  // The board's fetchedAt is in the future so its lag is 0: the time is the feed's own.
  assert.deepEqual(rows, BEFORE);
  assert.deepEqual(new Set(rows.map((r) => r.blobs[0])), new Set(Object.keys(ROWS)), 'one row of every declared kind');
});

test('the named fields read back what each logger meant', async () => {
  const byKind = Object.groupBy((await written()).map(named), (r) => r.kind);
  const read = (kind, i = 0) => byKind[kind][i];
  assert.equal(read('answer').changeWaitS, 240, 'board at 900, reach at 600, cross 60');
  assert.equal(read('arrival').plate, 'PA1234A');
  assert.equal(read('board').etaS, 240);
  assert.equal(read('next').tookMs, 413);
  assert.equal(read('error', 2).reason, 'TypeError: x is undefined');
  assert.equal(read('apperror').fatal, 1);
  assert.equal(read('step').trip, 'home');
});

test('a field left out is an empty column, and none trails', () => {
  assert.deepEqual(rowPoint('error', { route: '/x' }), { blobs: ['error', '/x'], doubles: [], indexes: ['error'] });
  assert.deepEqual(rowPoint('answer', { stop: 'PGP', quality: 'ended' }), {
    blobs: ['answer', 'PGP', '', '', 'ended'],
    doubles: [],
    indexes: ['PGP'],
  });
  assert.deepEqual(rowPoint('next', {}), { blobs: ['next'], doubles: [], indexes: ['next'] });
});

test('each kind names a field once, within what Analytics Engine keeps', () => {
  for (const [kind, spec] of Object.entries(ROWS)) {
    const names = [...spec.blobs, ...spec.doubles].filter(Boolean);
    assert.equal(new Set(names).size, names.length, kind);
    assert.ok(!names.includes('kind'), `${kind}: blob1 is the kind`);
    assert.ok(spec.blobs.length <= 19 && spec.doubles.length <= 20, kind);
    assert.ok(spec.index === 'kind' || spec.blobs.includes(spec.index), `${kind}: index1 is a blob it writes`);
  }
});

test("'board' rows keep the columns 'arrival' rows do, so the ETA job reads both as one", () => {
  const c = sharedColumns('arrival', 'board');
  assert.deepEqual(c, {
    kind: 'blob1',
    stop: 'blob2',
    svc: 'blob3',
    dest: 'blob4',
    quality: 'blob5',
    plate: 'blob6',
    crowd: 'blob7',
    berth: 'blob9',
    etaS: 'double1',
  });
  // And an arrival's doubles are its answer's, so a query over both reads the same meaning.
  assert.doesNotThrow(() => sharedColumns('answer', 'arrival'));
  assert.throws(() => sharedColumns('answer', 'tripwake'), /quality in different columns/);
});

test('the queries reading the rows are the same, byte for byte', async () => {
  const asked = [];
  const fetchImpl = async (_url, init) => (asked.push(init.body), new Response(JSON.stringify({ data: [] })));
  const now = Date.parse('2026-10-20T04:00:00Z');
  await adminStats({ KV: makeKV(), ANALYTICS_TOKEN: 't', CF_ACCOUNT_ID: 'a' }, now, fetchImpl);
  await predictionsFor({ ANALYTICS_TOKEN: 't', CF_ACCOUNT_ID: 'a' }, '2026-10-19', now, fetchImpl);
  assert.deepEqual(asked, JSON.parse(readFileSync(new URL('fixtures/ae-sql.json', import.meta.url), 'utf8')));
});

test('the dev stub answers every query the dashboard makes', () => {
  const now = Date.parse('2026-10-20T04:00:00Z');
  // The last query is the ETA job's, which the stub answers from R2 instead.
  for (const q of JSON.parse(readFileSync(new URL('fixtures/ae-sql.json', import.meta.url), 'utf8')).slice(0, -1)) {
    assert.ok(fakeAeRows(q, now)?.length, q);
  }
});

test('docs/analytics.md has a section for every kind of row', () => {
  const doc = readFileSync(new URL('../../../docs/analytics.md', import.meta.url), 'utf8');
  const headed = new Set([...doc.matchAll(/^#+ .*$/gm)].flatMap(([h]) => [...h.matchAll(/`([a-z]+)`/g)].map((m) => m[1])));
  const missing = Object.keys(ROWS).filter((k) => !headed.has(k));
  assert.deepEqual(missing, [], 'a heading naming each kind in backticks, as "## Trip signals (`signal`)"');
});
