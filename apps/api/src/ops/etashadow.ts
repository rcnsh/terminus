import type { Env } from '../types.ts';
import { GRAPH } from '../answer/graph.ts';
import { collecting } from './collect.ts';
import { type DayFile, dayKey, serviceDate, windowOf } from '../map/timelapse.ts';
import {
  type EtaDay,
  type Passing,
  type Prediction,
  departs,
  etaKey,
  gunzipJson,
  passingsOf,
  predictionsFor,
  scoredNow,
  ETA_V,
} from './eta.ts';
import {
  type EtaModel,
  type ErrorStats,
  type Method,
  type Misses,
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
const HISTORY_DAYS = 28;
const CATCH_UP_DAYS = HISTORY_DAYS;
const SHADOW_V = 4;
const SAME_MODEL = new Set([SHADOW_V]);
const MAX_ETA_S = 30 * 60;

export const segmentsKey = (date: string) => `eta/segments/${date}.json`;
export const shadowKey = (date: string) => `eta/model/${date}.json`;

export function etaModelOn(env: Pick<Env, 'ETA_MODEL'>): boolean {
  return (env.ETA_MODEL ?? '').trim().toLowerCase() === 'shadow';
}

export interface SegmentDay {
  v: 1;
  date: string;
  times: SegmentTimes;
}

export interface ShadowDay {
  v: 2 | 3 | typeof SHADOW_V;
  date: string;
  built: { days: number; pairs: number };
  predictions: number;
  cases: number;
  coverage: number | null;
  weights: number[];
  overall: Record<Method, ErrorStats>;
  horizons: { label: string; stats: Record<Method, ErrorStats> }[];
  misses?: Misses;
  grid: WeightGrid;
}

let rung: Record<string, Route> | null = null;

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

export async function modelBefore(bucket: R2Bucket, date: string): Promise<{ model: EtaModel; days: number }> {
  const dates = Array.from({ length: HISTORY_DAYS }, (_, i) => before(date, i + 1));
  const [segments, scored, shadows] = await Promise.all([
    Promise.all(dates.map((d) => readJson<SegmentDay>(bucket, segmentsKey(d)))),
    Promise.all(dates.map((d) => readJson<EtaDay>(bucket, etaKey(d)))),
    Promise.all(dates.map((d) => readJson<ShadowDay>(bucket, shadowKey(d)))),
  ]);
  const kept = segments.filter((s): s is SegmentDay => s?.v === 1);
  const errors = scored
    .filter((d): d is EtaDay => d?.v === 1 || d?.v === 2 || d?.v === ETA_V)
    .flatMap((d) => d.rows.map(([s, etaS, errS]) => ({ svc: d.services[s], feedS: etaS, errS })));
  const grids = shadows.filter((s): s is ShadowDay => !!s && SAME_MODEL.has(s.v)).map((s) => s.grid);
  return {
    model: { v: 1, table: tableOf(kept.map((s) => s.times)), bias: biasOf(errors), weights: weightsFrom(grids) },
    days: kept.length,
  };
}

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
    if (!p.plate || !(p.etaS >= 0 && p.etaS <= MAX_ETA_S) || departs(p)) return false;
    const once = `${p.svc}|${p.plate}|${p.stop}|${Math.floor(p.t / 15_000)}`;
    if (seen.has(once)) return false;
    seen.add(once);
    return true;
  });
  const cases = casesOf(model, routes(), { passings, queries, lagMs });
  const scored = scoreCases(cases);
  return {
    v: SHADOW_V,
    date,
    built: { days, pairs: Object.keys(model.table.all).length },
    predictions: queries.length,
    cases: cases.length,
    coverage: scored.coverage,
    weights: model.weights,
    overall: scored.overall,
    horizons: scored.horizons,
    misses: scored.misses,
    grid: weightGrid(model, cases),
  };
}

export async function shadowEta(env: Env, nowMs: number, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (!etaModelOn(env) || !env.FILES || !env.ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID || !(await collecting(env, 'eta'))) return null;
  let latest = serviceDate(nowMs);
  if (windowOf(latest).close > nowMs) latest = before(latest, 1);
  for (let i = CATCH_UP_DAYS - 1; i >= 0; i--) {
    const date = before(latest, i);
    const done = (await env.FILES.head(shadowKey(date)))?.customMetadata;
    if (done?.v === String(SHADOW_V) && done.eta === String(ETA_V)) continue;
    if (!(await env.FILES.head(dayKey(date)))) continue;
    if (!scoredNow(await env.FILES.head(etaKey(date)))) return null;
    const stored = await env.FILES.get(dayKey(date));
    if (!stored) continue;
    const day = await gunzipJson<DayFile>(await stored.arrayBuffer());
    const passings = passingsOf(day);
    const [predictions, { model, days }] = await Promise.all([predictionsFor(env, date, nowMs, fetchImpl), modelBefore(env.FILES, date)]);
    const json = { httpMetadata: { contentType: 'application/json' } };
    const segments: SegmentDay = { v: 1, date, times: timesOf(segmentsOf(passings, routes())) };
    await env.FILES.put(segmentsKey(date), JSON.stringify(segments), json);
    await env.FILES.put(shadowKey(date), JSON.stringify(shadowOf(date, model, days, passings, predictions, day.pollMs)), {
      ...json,
      customMetadata: { v: String(SHADOW_V), eta: String(ETA_V) },
    });
    return date;
  }
  return null;
}

export async function shadowSummary(
  env: Pick<Env, 'FILES' | 'ETA_MODEL'>,
  nowMs: number,
  days = HISTORY_DAYS,
): Promise<{ on: boolean; historyDays: number; days: Omit<ShadowDay, 'grid'>[] } | null> {
  if (!env.FILES) return null;
  const latest = serviceDate(nowMs);
  const dates = Array.from({ length: days }, (_, i) => before(latest, days - 1 - i));
  const kept = await Promise.all(dates.map((d) => readJson<ShadowDay>(env.FILES!, shadowKey(d))));
  return {
    on: etaModelOn(env),
    historyDays: HISTORY_DAYS,
    days: kept.filter((d): d is ShadowDay => !!d && SAME_MODEL.has(d.v)).map(({ grid: _grid, ...d }) => d),
  };
}
