import type { Env } from '../types.ts';
import { GRAPH } from '../answer/graph.ts';
import { shapeFor, type RouteShape } from '../map/campus.ts';
import { type DayFile, dayKey, lineKeys, serviceDate, windowOf } from '../map/timelapse.ts';
import { collecting } from './collect.ts';
import { aeSql } from './analytics.ts';
import { sharedColumns } from '../analytics-rows.ts';
import { SGT_MS } from '../config.ts';

const DAY = 86_400_000;
const ARRIVE_BEFORE_M = 25;
const MAX_GAP_MS = 120_000;
const MAX_SPEED_MPS = 20;
const LATE_LIMIT_MS = 30 * 60_000;
const MAX_ETA_S = 30 * 60;
const MAX_ROWS = 20_000;
const SCORE_DAYS = 28;

export const etaKey = (date: string) => `eta/${date}.json`;

export interface Passing {
  svc: string;
  plate: string;
  stop: string;
  t: number;
  seen?: number;
}

export interface Prediction {
  t: number;
  svc: string;
  plate: string;
  stop: string;
  etaS: number;
  w?: number;
  berth?: string;
}

export function departs(p: Pick<Prediction, 'berth'>): boolean {
  return !!p.berth?.toUpperCase().endsWith('-S');
}

export interface Scored {
  svc: string;
  etaS: number;
  errS: number;
  hour: number;
}

export const ETA_V = 3;

export const scoredNow = (head: R2Object | null) => head?.customMetadata?.v === String(ETA_V);

export interface EtaDay {
  v: 1 | 2 | typeof ETA_V;
  date: string;
  predictions: number;
  matched: number;
  services: string[];
  rows: [number, number, number, number][];
}

function linesOf(day: Pick<DayFile, 'routes' | 'services'>): Map<string, { shape: RouteShape; loop: boolean }> {
  const recorded = lineKeys(day);
  const now = lineKeys(null);
  const out = new Map<string, { shape: RouteShape; loop: boolean }>();
  for (const svc of day.services) {
    const seq = GRAPH.routes?.[svc] ?? [];
    const shape = shapeFor(svc, seq);
    if (!shape || !recorded[svc] || recorded[svc] !== now[svc]) continue;
    const loop = GRAPH.loops?.[svc] ?? (seq.length > 2 && seq[0] === seq[seq.length - 1]);
    out.set(svc, { shape, loop });
  }
  return out;
}

const BACK_M = 500;
const RUN_TO_MOVE = 3;
const WRAP_M = 1200;

export function passingsOf(day: DayFile): Passing[] {
  const lines = linesOf(day);
  const series = new Map<string, { svc: string; plate: string; fixes: [number, number][] }>();
  let t = day.t0;
  for (const s of day.samples) {
    t += s[0];
    const svc = day.services[s[1]];
    if (!lines.has(svc)) continue;
    for (let i = 2; i + 3 < s.length; i += 4) {
      const along = s[i + 3];
      if (along < 0) continue;
      const plate = day.plates[s[i]];
      const key = `${svc}|${plate}`;
      let entry = series.get(key);
      if (!entry) series.set(key, (entry = { svc, plate, fixes: [] }));
      entry.fixes.push([t, along]);
    }
  }
  const out: Passing[] = [];
  for (const { svc, plate, fixes } of series.values()) {
    const { shape, loop } = lines.get(svc)!;
    const total = shape.at.at(-1) ?? 0;
    const stops = loop
      ? shape.stops.slice(0, -1).map((code, k) => ({ code, mark: shape.at[k] }))
      : shape.stops.slice(1).map((code, k) => ({ code, mark: shape.at[k + 1] }));
    const drive = ([t1, a1]: [number, number], [t2, a2]: [number, number]): number | null => {
      const dt = t2 - t1;
      if (dt <= 0 || dt > MAX_GAP_MS) return null;
      let d = a2 - a1;
      if (total > 0 && total - a1 + a2 <= WRAP_M && d < 0) d = loop ? d + total : 0;
      return d < -BACK_M || d / (dt / 1000) > MAX_SPEED_MPS ? null : d;
    };
    let odo = 0;
    let peak = 0;
    const cross = ([t1, a1]: [number, number], d: number, dt: number, seen: number) => {
      const from = a1 + Math.max(0, peak - odo);
      odo += d;
      peak = Math.max(peak, odo);
      if (d <= 0) return;
      for (const { code, mark } of stops) {
        let target = mark - ARRIVE_BEFORE_M;
        if (loop && total > 0) {
          target = ((target % total) + total) % total;
          if (target <= a1) target += total;
        }
        if (target > from && target <= a1 + d) out.push({ svc, plate, stop: code, t: Math.round(t1 + ((target - a1) / d) * dt), seen });
      }
    };
    let good: [number, number] | null = null;
    let run: [number, number][] = [];
    for (const fix of fixes) {
      const fromGood = good && drive(good, fix);
      if (good && fromGood != null) {
        cross(good, fromGood, fix[0] - good[0], fix[0]);
        good = fix;
        run = [];
        continue;
      }
      const last = run.at(-1);
      const fromRun = last ? drive(last, fix) : null;
      if (fromRun == null) {
        run = [fix];
        continue;
      }
      run.push(fix);
      if (run.length < (good && fix[0] - good[0] <= MAX_GAP_MS ? RUN_TO_MOVE : 2)) continue;
      odo = peak = 0;
      for (let k = 1; k < run.length; k++) cross(run[k - 1], drive(run[k - 1], run[k])!, run[k][0] - run[k - 1][0], fix[0]);
      good = fix;
      run = [];
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

export function scoreEtas(predictions: Prediction[], passings: Passing[]): { scored: Scored[]; predictions: number; matched: number } {
  const byKey = new Map<string, number[]>();
  for (const p of passings) {
    const k = `${p.svc}|${p.plate}|${p.stop}`;
    const ts = byKey.get(k) ?? [];
    ts.push(p.t);
    byKey.set(k, ts);
  }
  const seen = new Set<string>();
  const scored: Scored[] = [];
  let count = 0;
  let matched = 0;
  for (const p of predictions) {
    if (!(p.etaS >= 0 && p.etaS <= MAX_ETA_S) || !p.plate || departs(p)) continue;
    const once = `${p.svc}|${p.plate}|${p.stop}|${Math.floor(p.t / 15_000)}`;
    if (seen.has(once)) continue;
    seen.add(once);
    const w = p.w ?? 1;
    count += w;
    const said = p.t + p.etaS * 1000;
    const from = p.t - (p.etaS <= 120 ? 60_000 : 0);
    const came = byKey.get(`${p.svc}|${p.plate}|${p.stop}`)?.find((t) => t >= from && t <= said + LATE_LIMIT_MS);
    if (came === undefined) continue;
    matched += w;
    scored.push({ svc: p.svc, etaS: p.etaS, errS: Math.round((came - said) / 1000), hour: new Date(p.t + SGT_MS).getUTCHours() });
  }
  return { scored, predictions: count, matched };
}

export function aeTime(s: unknown): number {
  const text = String(s);
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
}

export function askedOnce<R extends { kind?: unknown; timestamp?: unknown }>(rows: R[]): R[] {
  let firstBoard = Infinity;
  for (const r of rows) {
    const t = aeTime(r.timestamp);
    if (r.kind === 'board' && t < firstBoard) firstBoard = t;
  }
  return rows.filter((r) => {
    const t = aeTime(r.timestamp);
    return r.kind === 'board' ? t >= firstBoard : t < firstBoard;
  });
}

export async function predictionsFor(env: Env, date: string, nowMs: number, fetchImpl: typeof fetch): Promise<Prediction[]> {
  const { open, close } = windowOf(date);
  const days = Math.ceil((nowMs - open) / DAY) + 1;
  const hours = Math.max(0, Math.floor((nowMs - close) / 3_600_000));
  const dataset = env.AE_DATASET || 'terminus';
  const c = sharedColumns('arrival', 'board');
  const rows = await aeSql(
    env,
    `SELECT ${c.kind} AS kind, ${c.plate} AS plate, ${c.stop} AS stop, ${c.svc} AS svc, ${c.berth} AS berth, ${c.etaS} AS eta, _sample_interval AS w, timestamp FROM ${dataset}
      WHERE ${c.kind} IN ('arrival', 'board') AND ${c.plate} != '' AND timestamp > NOW() - INTERVAL '${days}' DAY
      AND timestamp < NOW() - INTERVAL '${hours}' HOUR`,
    fetchImpl,
  );
  const inWindow = rows.filter((r) => {
    const t = aeTime(r.timestamp);
    return t >= open && t < close;
  });
  return askedOnce(inWindow)
    .map((r) => ({
      t: aeTime(r.timestamp),
      plate: String(r.plate),
      stop: String(r.stop),
      svc: String(r.svc),
      etaS: Number(r.eta),
      w: Number(r.w) >= 1 ? Number(r.w) : 1,
      ...(r.berth ? { berth: String(r.berth) } : {}),
    }))
    .filter((p) => p.t >= open && p.t < close)
    .sort((a, b) => a.t - b.t);
}

export async function gunzipJson<T>(gz: ArrayBuffer): Promise<T> {
  return (await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).json()) as T;
}

export async function scoreDay(env: Env, date: string, nowMs: number, fetchImpl: typeof fetch = fetch): Promise<EtaDay | null> {
  const stored = await env.FILES!.get(dayKey(date));
  if (!stored) return null;
  const day = await gunzipJson<DayFile>(await stored.arrayBuffer());
  const { scored, predictions, matched } = scoreEtas(await predictionsFor(env, date, nowMs, fetchImpl), passingsOf(day));
  const services = [...new Set(scored.map((s) => s.svc))].sort();
  const index = new Map(services.map((s, i) => [s, i]));
  return {
    v: ETA_V,
    date,
    predictions,
    matched,
    services,
    rows: scored.slice(0, MAX_ROWS).map((s) => [index.get(s.svc)!, s.etaS, s.errS, s.hour]),
  };
}

export async function recordEta(env: Env, nowMs: number, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (!env.FILES || !env.ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID || !(await collecting(env, 'eta'))) return null;
  const previous = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - DAY).toISOString().slice(0, 10);
  let latest = serviceDate(nowMs);
  if (windowOf(latest).close > nowMs) latest = previous(latest);
  const dates = [latest];
  while (dates.length < SCORE_DAYS) dates.unshift(previous(dates[0]));
  for (const date of dates) {
    if (scoredNow(await env.FILES.head(etaKey(date)))) continue;
    if (!(await env.FILES.head(dayKey(date)))) continue;
    const scored = await scoreDay(env, date, nowMs, fetchImpl);
    if (!scored) continue;
    await env.FILES.put(etaKey(date), JSON.stringify(scored), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { v: String(ETA_V) },
    });
    return date;
  }
  return null;
}

export const HORIZONS: { label: string; maxS: number }[] = [
  { label: 'under 2 min', maxS: 120 },
  { label: '2 to 5 min', maxS: 300 },
  { label: '5 to 10 min', maxS: 600 },
  { label: '10 to 30 min', maxS: MAX_ETA_S },
];

export interface EtaStats {
  n: number;
  medianS: number | null;
  within1: number | null;
  late2: number | null;
  early1: number | null;
}

export function statsOf(errs: number[]): EtaStats {
  const n = errs.length;
  if (!n) return { n, medianS: null, within1: null, late2: null, early1: null };
  const sorted = [...errs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const medianS = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  const share = (f: (e: number) => boolean) => Math.round((errs.filter(f).length / n) * 1000) / 1000;
  return { n, medianS, within1: share((e) => Math.abs(e) <= 60), late2: share((e) => e > 120), early1: share((e) => e < -60) };
}

export async function etaSummary(env: Env, nowMs: number, days = 14): Promise<Record<string, unknown> | null> {
  if (!env.FILES) return null;
  const dates = Array.from({ length: days }, (_, i) => new Date(nowMs + SGT_MS - (i + 1) * DAY).toISOString().slice(0, 10));
  const kept = (
    await Promise.all(dates.map(async (d) => (await env.FILES!.get(etaKey(d)))?.json<EtaDay>().catch(() => null) ?? null))
  ).filter((d): d is EtaDay => d?.v === 1 || d?.v === 2 || d?.v === ETA_V);
  const all: Scored[] = kept.flatMap((d) => d.rows.map(([s, etaS, errS, hour]) => ({ svc: d.services[s], etaS, errS, hour })));
  const group = <K extends string | number>(key: (s: Scored) => K) => {
    const m = new Map<K, number[]>();
    for (const s of all) {
      const errs = m.get(key(s));
      if (errs) errs.push(s.errS);
      else m.set(key(s), [s.errS]);
    }
    return m;
  };
  const byHour = group((s) => s.hour);
  const bySvc = group((s) => s.svc);
  return {
    days: kept.map((d) => ({ date: d.date, predictions: d.predictions, matched: d.matched })),
    overall: statsOf(all.map((s) => s.errS)),
    horizons: HORIZONS.map((h, i) => ({
      label: h.label,
      ...statsOf(all.filter((s) => s.etaS <= h.maxS && s.etaS > (HORIZONS[i - 1]?.maxS ?? -1)).map((s) => s.errS)),
    })),
    services: [...bySvc.keys()].sort().map((svc) => ({ svc, ...statsOf(bySvc.get(svc)!) })),
    hours: [...byHour.keys()].sort((a, b) => a - b).map((hour) => ({ hour, ...statsOf(byHour.get(hour)!) })),
  };
}
