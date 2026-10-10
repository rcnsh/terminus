/**
 * How good the feed's arrival times are: when NUS said "R1 in 4 min", when
 * did that bus really come? Measured with no user data at all, from two
 * things terminus already has:
 *
 * - the predictions: every `arrival` row in Analytics Engine (analytics.ts
 *   logAnswer) is a plate, a stop and the seconds the feed gave it, at a time;
 * - what happened: the timelapse recorder's day (timelapse.ts DayFile) has
 *   every bus's metres along its line every 30 s, so the moment a plate
 *   reached a stop can be read off it (passingsOf).
 *
 * Once a day, after the recorder has written the day to R2, the cron joins
 * the two (scoreEtas) and keeps the result as `eta/YYYY-MM-DD.json` in the
 * same bucket. The dashboard reads the last 14 (etaSummary). Nothing calls
 * NUS: the recorder's polls are the only input, and it is bounded as rule 2
 * says. Off unless the operator turns `eta` on (collect.ts).
 *
 * The answer is good to about 15 s either way: a prediction can be up to
 * TTL.arrivalsMs old when the row is written, and a bus's position is read
 * every pollMs and interpolated between.
 */

import type { Env } from './types.ts';
import { GRAPH } from './graph.ts';
import { shapeFor, type RouteShape } from './campus.ts';
import { type DayFile, dayKey, lineKeys, serviceDate, windowOf } from './timelapse.ts';
import { collecting } from './collect.ts';
import { aeSql } from './analytics.ts';
import { SGT_MS } from './config.ts';

const DAY = 86_400_000;
/** A bus counts as at a stop this many metres before the stop's mark on its line. */
const ARRIVE_BEFORE_M = 25;
/** Two readings further apart than this say nothing about what happened between. */
const MAX_GAP_MS = 120_000;
/** Faster than this between two readings is a bad fix, not a bus (about 72 km/h). */
const MAX_SPEED_MPS = 20;
/** A prediction is matched to the plate's first arrival this long after it was given at most. */
const LATE_LIMIT_MS = 30 * 60_000;
/** Predictions further ahead than this aren't scored: the feed only shows the next two buses. */
const MAX_ETA_S = 30 * 60;
/** Rows kept per day, so one busy day can't make a huge file. */
const MAX_ROWS = 20_000;

export const etaKey = (date: string) => `eta/${date}.json`;

/** A plate reaching a stop: [t] epoch ms. */
export interface Passing {
  svc: string;
  plate: string;
  stop: string;
  t: number;
}

/** What the feed said: at [t], [plate] would reach [stop] in [etaS]. */
export interface Prediction {
  t: number;
  svc: string;
  plate: string;
  stop: string;
  etaS: number;
}

/** One scored prediction: [errS] is how much later than said the bus came (negative: earlier). */
export interface Scored {
  svc: string;
  etaS: number;
  errS: number;
  /** Singapore hour the prediction was given in, 0 to 23. */
  hour: number;
}

/** The day as kept in R2: rows are [service index, etaS, errS, hour]. */
export interface EtaDay {
  v: 1;
  date: string;
  /** Predictions read (after dropping repeats of one cached answer), and how many found their bus. */
  predictions: number;
  matched: number;
  services: string[];
  rows: [number, number, number, number][];
}

/** The line each service is recorded on, when it's the one this deploy has: [shape, loop]. */
function linesOf(day: Pick<DayFile, 'routes' | 'services'>): Map<string, { shape: RouteShape; loop: boolean }> {
  const recorded = lineKeys(day);
  const now = lineKeys(null);
  const out = new Map<string, { shape: RouteShape; loop: boolean }>();
  for (const svc of day.services) {
    const seq = GRAPH.routes?.[svc] ?? [];
    const shape = shapeFor(svc, seq);
    // A day recorded on another line measured its metres on that one.
    if (!shape || !recorded[svc] || recorded[svc] !== now[svc]) continue;
    const loop = GRAPH.loops?.[svc] ?? (seq.length > 2 && seq[0] === seq[seq.length - 1]);
    out.set(svc, { shape, loop });
  }
  return out;
}

/**
 * Every time a recorded bus reached a stop on its line, from its metres
 * along the line in successive readings: the moment it passed the mark
 * ARRIVE_BEFORE_M before the stop, interpolated between the two readings
 * either side. Readings too far apart, a bus going backwards, or one too
 * fast to be real count for nothing. A one-way route's first stop is where
 * a bus starts, not arrives, so it has none.
 */
export function passingsOf(day: DayFile): Passing[] {
  const lines = linesOf(day);
  // Each bus's readings, in order: [t, along].
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
    // On a loop the last stop is the first again; a one-way route's first is skipped.
    const stops = loop ? shape.stops.slice(0, -1).map((code, k) => ({ code, mark: shape.at[k] })) : shape.stops.slice(1).map((code, k) => ({ code, mark: shape.at[k + 1] }));
    for (let i = 1; i < fixes.length; i++) {
      const [t1, a1] = fixes[i - 1];
      const [t2, a2] = fixes[i];
      const dt = t2 - t1;
      if (dt <= 0 || dt > MAX_GAP_MS) continue;
      let d = a2 - a1;
      // Round a loop's end and back to its start.
      if (loop && total > 0 && d < -total / 2) d += total;
      if (d <= 0 || d / (dt / 1000) > MAX_SPEED_MPS) continue;
      for (const { code, mark } of stops) {
        let target = mark - ARRIVE_BEFORE_M;
        if (loop && total > 0) {
          target = ((target % total) + total) % total;
          // Crossed after wrapping round: measure it on the far side of the end.
          if (target <= a1) target += total;
        }
        if (target > a1 && target <= a1 + d) out.push({ svc, plate, stop: code, t: Math.round(t1 + ((target - a1) / d) * dt) });
      }
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Each prediction against the first time its plate reached its stop: from
 * the moment it was given (a minute earlier for one that said under two
 * minutes, since a bus about to arrive may already be there), to
 * LATE_LIMIT_MS after the time it said. A prediction that never found its
 * bus (off its line, or a gap in the recording) isn't scored. Repeats of
 * one cached answer (the same plate, stop and 15 s) count once.
 */
export function scoreEtas(predictions: Prediction[], passings: Passing[]): { scored: Scored[]; predictions: number } {
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
  for (const p of predictions) {
    if (!(p.etaS >= 0 && p.etaS <= MAX_ETA_S) || !p.plate) continue;
    const once = `${p.svc}|${p.plate}|${p.stop}|${Math.floor(p.t / 15_000)}`;
    if (seen.has(once)) continue;
    seen.add(once);
    count++;
    const said = p.t + p.etaS * 1000;
    const from = p.t - (p.etaS <= 120 ? 60_000 : 0);
    const came = byKey.get(`${p.svc}|${p.plate}|${p.stop}`)?.find((t) => t >= from && t <= said + LATE_LIMIT_MS);
    if (came === undefined) continue;
    scored.push({ svc: p.svc, etaS: p.etaS, errS: Math.round((came - said) / 1000), hour: new Date(p.t + SGT_MS).getUTCHours() });
  }
  return { scored, predictions: count };
}

/** An Analytics Engine timestamp ("2026-10-10 04:05:06", UTC) as epoch ms. */
export function aeTime(s: unknown): number {
  const text = String(s);
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
}

/** The predictions logged inside day [date]'s recording window, from Analytics Engine. */
async function predictionsFor(env: Env, date: string, nowMs: number, fetchImpl: typeof fetch): Promise<Prediction[]> {
  const { open, close } = windowOf(date);
  // Days back to reach the window's start, with one to spare.
  const days = Math.ceil((nowMs - open) / DAY) + 1;
  const dataset = env.AE_DATASET || 'terminus';
  const rows = await aeSql(
    env,
    `SELECT blob6 AS plate, blob2 AS stop, blob3 AS svc, double1 AS eta, timestamp FROM ${dataset}
      WHERE blob1 = 'arrival' AND blob6 != '' AND timestamp > NOW() - INTERVAL '${days}' DAY`,
    fetchImpl,
  );
  return rows
    .map((r) => ({ t: aeTime(r.timestamp), plate: String(r.plate), stop: String(r.stop), svc: String(r.svc), etaS: Number(r.eta) }))
    .filter((p) => p.t >= open && p.t < close)
    .sort((a, b) => a.t - b.t);
}

async function gunzipJson<T>(gz: ArrayBuffer): Promise<T> {
  return (await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).json()) as T;
}

/** Day [date] scored, as kept: reads the recording and the day's predictions. */
export async function scoreDay(env: Env, date: string, nowMs: number, fetchImpl: typeof fetch = fetch): Promise<EtaDay | null> {
  const stored = await env.DOWNLOADS!.get(dayKey(date));
  if (!stored) return null;
  const day = await gunzipJson<DayFile>(await stored.arrayBuffer());
  const { scored, predictions } = scoreEtas(await predictionsFor(env, date, nowMs, fetchImpl), passingsOf(day));
  const services = [...new Set(scored.map((s) => s.svc))].sort();
  const index = new Map(services.map((s, i) => [s, i]));
  return {
    v: 1,
    date,
    predictions,
    matched: scored.length,
    services,
    rows: scored.slice(0, MAX_ROWS).map((s) => [index.get(s.svc)!, s.etaS, s.errS, s.hour]),
  };
}

/**
 * The cron's step: the newest of the last two recorded days not yet
 * scored, one a run. Needs the recording (so the recorder has closed the
 * day) and Analytics Engine's SQL API to read the predictions with.
 */
export async function recordEta(env: Env, nowMs: number, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (!env.DOWNLOADS || !env.ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID || !(await collecting(env, 'eta'))) return null;
  // The latest service day may still be recording (or closed an hour ago,
  // before the next opens): only a closed window is done.
  const previous = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - DAY).toISOString().slice(0, 10);
  let date = serviceDate(nowMs);
  if (windowOf(date).close > nowMs) date = previous(date);
  for (let i = 0; i < 2; date = previous(date), i++) {
    if (await env.DOWNLOADS.head(etaKey(date))) continue;
    if (!(await env.DOWNLOADS.head(dayKey(date)))) continue;
    const scored = await scoreDay(env, date, nowMs, fetchImpl);
    if (!scored) continue;
    await env.DOWNLOADS.put(etaKey(date), JSON.stringify(scored), { httpMetadata: { contentType: 'application/json' } });
    return date;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* For the dashboard                                                   */
/* ------------------------------------------------------------------ */

/** How far ahead a prediction looked, minutes: the dashboard's rows. */
export const HORIZONS: { label: string; maxS: number }[] = [
  { label: 'under 2 min', maxS: 120 },
  { label: '2 to 5 min', maxS: 300 },
  { label: '5 to 10 min', maxS: 600 },
  { label: '10 to 30 min', maxS: MAX_ETA_S },
];

export interface EtaStats {
  n: number;
  /** The middle error, s: positive is the bus coming later than said. */
  medianS: number | null;
  /** Shares, 0 to 1: within a minute of what was said; over 2 minutes later; over a minute earlier. */
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

/** The last [days] scored days, together: by how far ahead, by service, by hour. */
export async function etaSummary(env: Env, nowMs: number, days = 14): Promise<Record<string, unknown> | null> {
  if (!env.DOWNLOADS) return null;
  const dates = Array.from({ length: days }, (_, i) => new Date(nowMs + SGT_MS - (i + 1) * DAY).toISOString().slice(0, 10));
  const kept = (await Promise.all(dates.map(async (d) => (await env.DOWNLOADS!.get(etaKey(d)))?.json<EtaDay>().catch(() => null) ?? null))).filter((d): d is EtaDay => d?.v === 1);
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
    horizons: HORIZONS.map((h, i) => ({ label: h.label, ...statsOf(all.filter((s) => s.etaS <= h.maxS && s.etaS > (HORIZONS[i - 1]?.maxS ?? -1)).map((s) => s.errS)) })),
    services: [...bySvc.keys()].sort().map((svc) => ({ svc, ...statsOf(bySvc.get(svc)!) })),
    hours: [...byHour.keys()].sort((a, b) => a - b).map((hour) => ({ hour, ...statsOf(byHour.get(hour)!) })),
  };
}
