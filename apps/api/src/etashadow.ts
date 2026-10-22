/**
 * The arrival-time model (etamodel.ts) run in shadow, beside eta.ts's
 * scoring of the feed: nobody is shown its times. Once a day, for the
 * newest closed day the eta step has scored, the cron
 *
 * 1. builds the model from the HISTORY_DAYS days before it, from what
 *    earlier runs kept: their segment times (`eta/segments/<date>.json`),
 *    the feed's errors eta.ts scored (`eta/<date>.json`), and the weights'
 *    grids (`eta/model/<date>.json`), so the day is scored by a model that
 *    never saw it;
 * 2. answers each of the day's predictions (the same Analytics Engine rows
 *    and timelapse recording eta.ts reads) every way, against when that
 *    plate did come, and keeps the errors and the day's weight grid as
 *    `eta/model/<date>.json`;
 * 3. keeps the day's own segment times for the days after.
 *
 * Nothing calls NUS, and nothing is written but those two files in the
 * downloads bucket. Off unless the ETA_MODEL var is "shadow" and the
 * operator collects `eta` (collect.ts): the scored feed errors are its
 * input. docs/eta-model.md says what to look for before it answers anyone.
 */

import type { Env } from './types.ts';
import { GRAPH } from './graph.ts';
import { collecting } from './collect.ts';
import { type DayFile, dayKey, serviceDate, windowOf } from './timelapse.ts';
import { type EtaDay, type Passing, type Prediction, etaKey, gunzipJson, passingsOf, predictionsFor } from './eta.ts';
import {
  type EtaModel,
  type ErrorStats,
  type Method,
  type Route,
  type SegmentTimes,
  type WeightGrid,
  biasOf,
  casesOf,
  ringOf,
  scoreCases,
  segmentsOf,
  tableOf,
  timesOf,
  weightGrid,
  weightsFrom,
} from './etamodel.ts';

const DAY = 86_400_000;
/** Days of history the model is built from. */
const HISTORY_DAYS = 28;
/** A scored day this many days back not yet run in shadow is still picked up. */
const CATCH_UP_DAYS = 3;
/** Predictions further ahead than this aren't scored (as eta.ts). */
const MAX_ETA_S = 30 * 60;

export const segmentsKey = (date: string) => `eta/segments/${date}.json`;
export const shadowKey = (date: string) => `eta/model/${date}.json`;

/** Whether the model runs in shadow: the ETA_MODEL var is "shadow". Unset is off. */
export function etaModelOn(env: Pick<Env, 'ETA_MODEL'>): boolean {
  return (env.ETA_MODEL ?? '').trim().toLowerCase() === 'shadow';
}

/** One day's segment times, kept for the model of the days after. */
export interface SegmentDay {
  v: 1;
  date: string;
  times: SegmentTimes;
}

/** One day answered by the model the days before it built. */
export interface ShadowDay {
  v: 1;
  date: string;
  /** What the model was built from: days with segment times, and stop pairs known. */
  built: { days: number; pairs: number };
  /** Predictions read (one cached answer once), and how many found their bus. */
  predictions: number;
  cases: number;
  /** Of those, the share history could answer: every method is scored on these. */
  coverage: number | null;
  weights: number[];
  overall: Record<Method, ErrorStats>;
  horizons: { label: string; stats: Record<Method, ErrorStats> }[];
  /** The day's own weight grid, for the weights of the days after. */
  grid: WeightGrid;
}

let rung: Record<string, Route> | null = null;

/** This deploy's routes, once round. */
function routes(): Record<string, Route> {
  return (rung ??= Object.fromEntries(
    Object.entries(GRAPH.routes ?? {}).map(([svc, seq]) => [
      svc,
      ringOf(seq, GRAPH.loops?.[svc] ?? (seq.length > 2 && seq[0] === seq[seq.length - 1])),
    ]),
  ));
}

const before = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) - days * DAY).toISOString().slice(0, 10);

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const o = await bucket.get(key);
  return o ? await o.json<T>().catch(() => null) : null;
}

/** The model as the HISTORY_DAYS days before [date] built it, and how many of them had segment times. */
export async function modelBefore(bucket: R2Bucket, date: string): Promise<{ model: EtaModel; days: number }> {
  const dates = Array.from({ length: HISTORY_DAYS }, (_, i) => before(date, i + 1));
  const [segments, scored, shadows] = await Promise.all([
    Promise.all(dates.map((d) => readJson<SegmentDay>(bucket, segmentsKey(d)))),
    Promise.all(dates.map((d) => readJson<EtaDay>(bucket, etaKey(d)))),
    Promise.all(dates.map((d) => readJson<ShadowDay>(bucket, shadowKey(d)))),
  ]);
  const kept = segments.filter((s): s is SegmentDay => s?.v === 1);
  // eta.ts's rows are the feed's errors, the bus's arrival minus the time said.
  const errors = scored
    .filter((d): d is EtaDay => d?.v === 1)
    .flatMap((d) => d.rows.map(([s, etaS, errS]) => ({ svc: d.services[s], feedS: etaS, errS })));
  const grids = shadows.filter((s): s is ShadowDay => s?.v === 1).map((s) => s.grid);
  return {
    model: { v: 1, table: tableOf(kept.map((s) => s.times)), bias: biasOf(errors), weights: weightsFrom(grids) },
    days: kept.length,
  };
}

/**
 * Day [date] answered by [model]: each prediction with a plate, one cached
 * answer once (as eta.ts scoreEtas), against [passings]. [lagMs]: the
 * recorder's poll, after which a passing could be known.
 */
export function shadowOf(
  date: string,
  model: EtaModel,
  days: number,
  passings: Passing[],
  predictions: Prediction[],
  lagMs: number,
): ShadowDay {
  const seen = new Set<string>();
  const queries = predictions.filter((p) => {
    if (!p.plate || !(p.etaS >= 0 && p.etaS <= MAX_ETA_S)) return false;
    const once = `${p.svc}|${p.plate}|${p.stop}|${Math.floor(p.t / 15_000)}`;
    if (seen.has(once)) return false;
    seen.add(once);
    return true;
  });
  const cases = casesOf(model, routes(), { passings, queries, lagMs });
  const scored = scoreCases(cases);
  return {
    v: 1,
    date,
    built: { days, pairs: Object.keys(model.table.all).length },
    predictions: queries.length,
    cases: cases.length,
    coverage: scored.coverage,
    weights: model.weights,
    overall: scored.overall,
    horizons: scored.horizons,
    grid: weightGrid(model, cases),
  };
}

/**
 * The cron's step: the oldest of the last CATCH_UP_DAYS days eta.ts has
 * scored and this hasn't, one a run, so each is built on the ones before.
 */
export async function shadowEta(env: Env, nowMs: number, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (!etaModelOn(env) || !env.DOWNLOADS || !env.ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID || !(await collecting(env, 'eta'))) return null;
  let latest = serviceDate(nowMs);
  if (windowOf(latest).close > nowMs) latest = before(latest, 1);
  for (let i = CATCH_UP_DAYS - 1; i >= 0; i--) {
    const date = before(latest, i);
    if (await env.DOWNLOADS.head(shadowKey(date))) continue;
    // Scored first: its errors are the next day's bias.
    if (!(await env.DOWNLOADS.head(etaKey(date)))) continue;
    const stored = await env.DOWNLOADS.get(dayKey(date));
    if (!stored) continue;
    const day = await gunzipJson<DayFile>(await stored.arrayBuffer());
    const passings = passingsOf(day);
    const [predictions, { model, days }] = await Promise.all([
      predictionsFor(env, date, nowMs, fetchImpl),
      modelBefore(env.DOWNLOADS, date),
    ]);
    const json = { httpMetadata: { contentType: 'application/json' } };
    const segments: SegmentDay = { v: 1, date, times: timesOf(segmentsOf(passings, routes())) };
    await env.DOWNLOADS.put(segmentsKey(date), JSON.stringify(segments), json);
    // Last: it marks the day done.
    await env.DOWNLOADS.put(shadowKey(date), JSON.stringify(shadowOf(date, model, days, passings, predictions, day.pollMs)), json);
    return date;
  }
  return null;
}
