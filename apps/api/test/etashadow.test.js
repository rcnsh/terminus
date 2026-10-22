/**
 * The arrival-time model in shadow (etashadow.ts): off unless asked for,
 * each closed day answered by a model built only from the days before it,
 * one day a run, oldest first. On the real route lines.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeBucket, makeEnv } from './_stubs.mjs';
import { SHAPES } from '../src/map/campus.ts';
import { buildDayFile, dayKey, encodeBus, gzip, mapSnapshot, windowOf } from '../src/map/timelapse.ts';
import { etaKey, passingsOf, recordEta } from '../src/ops/eta.ts';
import { etaModelOn, modelBefore, segmentsKey, shadowEta, shadowKey, shadowSummary } from '../src/ops/etashadow.ts';

const DAYS = ['2026-08-25', '2026-08-26'];

/** A day with one K bus driving its real line at 8 m/s from PGP, read every 30 s for 20 minutes. */
function dayOn(date) {
  const { open } = windowOf(date);
  const rows = Array.from({ length: 40 }, (_, k) => ({
    dt: k ? 30_000 : 0,
    svc: 'K',
    buses: encodeBus({ plate: 'PA2B', lat: 1.3, lon: 103.78, along: 8 * 30 * k }, 0),
  }));
  return buildDayFile({ date, t0: open, pollMs: 30_000, plates: ['PA2B'], rows, map: mapSnapshot() });
}

const ae = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

/**
 * Each day's predictions as Analytics Engine has them: asked four minutes
 * in (the bus past UHALL, read at the poll after), for MUSEUM, [errS] too
 * soon (the bus comes that much later).
 */
function predictionsOf(days, errS) {
  const stop = SHAPES.K.stops[10];
  return days.flatMap((day) => {
    const asked = day.t0 + 240_000;
    const came = passingsOf(day).find((p) => p.stop === stop).t;
    return [{ plate: 'PA2B', stop, svc: 'K', eta: Math.round((came - asked) / 1000) - errS, timestamp: ae(asked) }];
  });
}

async function setUp(env = {}) {
  const days = DAYS.map(dayOn);
  const bucket = makeBucket(async () => null);
  for (const d of days) await bucket.put(dayKey(d.date), await gzip(JSON.stringify(d)));
  const rows = predictionsOf(days, 90);
  const fetchImpl = async () => new Response(JSON.stringify({ data: rows }));
  const base = { ...makeEnv(), DOWNLOADS: bucket, ANALYTICS_TOKEN: 'ae', CF_ACCOUNT_ID: 'acct', ...env };
  return { days, bucket, fetchImpl, env: base, now: windowOf(DAYS[1]).close + 3_600_000 };
}

const readJson = (bucket, key) => JSON.parse(new TextDecoder().decode(bucket._written.get(key)));

test('off unless ETA_MODEL is shadow and eta is collected', async () => {
  assert.equal(etaModelOn({}), false);
  assert.equal(etaModelOn({ ETA_MODEL: 'on' }), false);
  assert.equal(etaModelOn({ ETA_MODEL: ' Shadow ' }), true);
  const { env, bucket, fetchImpl, now } = await setUp();
  assert.equal(await shadowEta(env, now, fetchImpl), null, 'no ETA_MODEL');
  const shadow = { ...env, ETA_MODEL: 'shadow' };
  assert.equal(await shadowEta(shadow, now, fetchImpl), null, 'eta not collected');
  await env.KV.put('config:collect:eta', 'on');
  assert.equal(await shadowEta(shadow, now, fetchImpl), null, 'collected, but no day scored yet');
  assert.ok(![...bucket._written.keys()].some((k) => k.startsWith('eta/')), 'nothing written');
});

test('each day is answered by the model of the days before it, oldest first, once', async () => {
  const { env, bucket, fetchImpl, now } = await setUp({ ETA_MODEL: 'shadow' });
  await env.KV.put('config:collect:eta', 'on');
  // eta.ts scores both days first: newest, then the one before.
  assert.equal(await recordEta(env, now, fetchImpl), DAYS[1]);
  assert.equal(await recordEta(env, now, fetchImpl), DAYS[0]);
  assert.ok(bucket._written.has(etaKey(DAYS[0])));

  assert.equal(await shadowEta(env, now, fetchImpl), DAYS[0], 'the older day first');
  const first = readJson(bucket, shadowKey(DAYS[0]));
  assert.deepEqual(first.built, { days: 0, pairs: 0 }, 'nothing before it');
  assert.equal(first.cases, 1);
  assert.equal(first.coverage, 0, 'no history yet: nothing to score history on');
  assert.ok(Object.keys(readJson(bucket, segmentsKey(DAYS[0])).times).length >= 5, "the day's segments, kept");

  assert.equal(await shadowEta(env, now, fetchImpl), DAYS[1]);
  const second = readJson(bucket, shadowKey(DAYS[1]));
  assert.equal(second.built.days, 1);
  assert.ok(second.built.pairs >= 5);
  assert.equal(second.coverage, 1);
  // The feed was 90 s too soon; the day before taught the model that, and
  // the bus drove as it did the day before.
  // To the second: the feed says whole seconds.
  assert.equal(Math.round(second.overall.feed.mae), 90);
  assert.ok(second.overall.corrected.mae <= 1);
  assert.ok(second.overall.history.mae <= 15, `history ${second.overall.history.mae} s out: the bus's last stop, read every 30 s`);
  assert.deepEqual(second.grid.n, [0, 1, 0, 0], 'one case, said 2 to 5 minutes ahead');

  assert.equal(await shadowEta(env, now, fetchImpl), null, 'both done');
  const { model } = await modelBefore(bucket, '2026-08-27');
  assert.equal(model.bias['K|1'][1], 90, 'the feed is 90 s early for K');
  assert.equal(model.weights[1], 0, 'the corrected feed was exact: no weight on history');
});

test('the dashboard reads the days in shadow, oldest first, without their weight grids', async () => {
  const { env, bucket, fetchImpl, now } = await setUp({ ETA_MODEL: 'shadow' });
  assert.equal(await shadowSummary({}, now), null, 'no bucket');
  assert.deepEqual(await shadowSummary(env, now), { on: true, historyDays: 28, days: [] }, 'nothing run yet');
  await env.KV.put('config:collect:eta', 'on');
  await recordEta(env, now, fetchImpl);
  await recordEta(env, now, fetchImpl);
  await shadowEta(env, now, fetchImpl);
  await shadowEta(env, now, fetchImpl);
  const summary = await shadowSummary(env, now);
  assert.deepEqual(
    summary.days.map((d) => d.date),
    DAYS,
  );
  assert.ok(
    summary.days.every((d) => !('grid' in d)),
    'grids stay in the bucket',
  );
  assert.equal(summary.days[1].coverage, 1);
  assert.equal((await shadowSummary({ DOWNLOADS: bucket }, now)).on, false, 'ETA_MODEL unset: off, days still shown');
});
