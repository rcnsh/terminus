import { HORIZONS, type Passing } from './eta.ts';
import { SGT_MS } from '../config.ts';

export interface Route {
  seq: string[];
  loop: boolean;
}

const MAX_SEGMENT_S = 20 * 60;
const MAX_GAP_MS = 120_000;
const STATE_MAX_AGE_MS = 20 * 60_000;
const HELD = { factor: 2, overS: 120 };
const OVERDUE_LEFT_S = 10;
export const CHECK = { maxAgeS: 90, marginS: 240, minN: 5 };
const PLATE_EARLY = { etaS: 120, backS: 60 };
const BOARD_EARLY = { etaS: 60, backS: 30 };

export function earlyS(q: Pick<Query, 'etaS' | 'plate'>): number {
  const rule = q.plate ? PLATE_EARLY : BOARD_EARLY;
  return q.etaS !== null && q.etaS <= rule.etaS ? rule.backS : 0;
}
const SLOT_PRIOR = 4;
const BIAS_PRIOR = 10;

export function ringOf(seq: string[], loop: boolean): Route {
  return { seq: loop && seq.length > 1 && seq[0] === seq[seq.length - 1] ? seq.slice(0, -1) : [...seq], loop };
}

function after(route: Route, i: number): number | null {
  if (i + 1 < route.seq.length) return i + 1;
  return route.loop && route.seq.length > 1 ? 0 : null;
}

function adjacent(route: Route, from: string, to: string): boolean {
  for (let i = 0; i < route.seq.length; i++) {
    if (route.seq[i] !== from) continue;
    const j = after(route, i);
    if (j !== null && route.seq[j] === to) return true;
  }
  return false;
}

export interface BusReading {
  t: number;
  svc: string;
  plate: string;
  at: string | null;
  last: string | null;
  next: string | null;
}

export interface SeenPassing extends Passing {
  seen: number;
}

export function passingsFromReadings(readings: BusReading[]): SeenPassing[] {
  const byBus = new Map<string, BusReading[]>();
  for (const r of readings) {
    const k = `${r.svc}|${r.plate}`;
    const list = byBus.get(k);
    if (list) list.push(r);
    else byBus.set(k, [r]);
  }
  const out: SeenPassing[] = [];
  for (const list of byBus.values()) {
    list.sort((a, b) => a.t - b.t);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      const dt = cur.t - prev.t;
      if (dt <= 0 || dt > MAX_GAP_MS || !prev.next || prev.at === prev.next) continue;
      if (cur.at === prev.next || cur.last === prev.next) {
        out.push({ svc: cur.svc, plate: cur.plate, stop: prev.next, t: Math.round(prev.t + dt / 2), seen: cur.t });
      }
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

export interface Segment {
  svc: string;
  from: string;
  to: string;
  t: number;
  s: number;
  known: number;
}

function byBusOf<P extends Passing>(passings: P[]): Map<string, P[]> {
  const byBus = new Map<string, P[]>();
  for (const p of passings) {
    const k = `${p.svc}|${p.plate}`;
    const list = byBus.get(k);
    if (list) list.push(p);
    else byBus.set(k, [p]);
  }
  for (const list of byBus.values()) list.sort((a, b) => a.t - b.t);
  return byBus;
}

export function segmentsOf(passings: (Passing & { seen?: number })[], routes: Record<string, Route>, lagMs = 0): Segment[] {
  const out: Segment[] = [];
  for (const list of byBusOf(passings).values()) {
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1];
      const b = list[i];
      const route = routes[a.svc];
      const s = (b.t - a.t) / 1000;
      if (!route || s <= 0 || s > MAX_SEGMENT_S || !adjacent(route, a.stop, b.stop)) continue;
      out.push({ svc: a.svc, from: a.stop, to: b.stop, t: a.t, s: Math.round(s), known: b.seen ?? b.t + lagMs });
    }
  }
  return out;
}

export function slotOf(t: number): string {
  const d = new Date(t + SGT_MS);
  const day = d.getUTCDay();
  return `${day === 0 || day === 6 ? 'we' : 'wd'}|${d.getUTCHours()}`;
}

export interface SegmentTable {
  v: 2;
  all: Record<string, Spread>;
  slot: Record<string, Spread>;
}

export type Spread = [number, number, number, number];
export type Pace = 'median' | 'quick' | 'slow';
const PACE: Record<Pace, 1 | 2 | 3> = { median: 1, quick: 2, slow: 3 };

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const middle = (s: number[]) => (s.length % 2 ? s[s.length >> 1] : (s[(s.length >> 1) - 1] + s[s.length >> 1]) / 2);
const rank = (s: number[], q: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];

export function median(xs: number[]): number {
  return middle(sorted(xs));
}

export function quantile(xs: number[], q: number): number {
  return rank(sorted(xs), q);
}

function spreads(groups: Map<string, number[]>): Record<string, Spread> {
  return Object.fromEntries(
    [...groups].map(([k, xs]) => {
      const s = sorted(xs);
      return [k, [s.length, Math.round(middle(s)), rank(s, 0.1), rank(s, 0.9)]];
    }),
  );
}

function push(m: Map<string, number[]>, k: string, x: number) {
  const xs = m.get(k);
  if (xs) xs.push(x);
  else m.set(k, [x]);
}

export type SegmentTimes = Record<string, number[]>;

export function timesOf(segments: Segment[]): SegmentTimes {
  const out: SegmentTimes = {};
  for (const g of segments) (out[`${g.svc}|${g.from}|${g.to}|${slotOf(g.t)}`] ??= []).push(g.s);
  return out;
}

export function tableOf(days: SegmentTimes[]): SegmentTable {
  const all = new Map<string, number[]>();
  const slot = new Map<string, number[]>();
  for (const times of days) {
    for (const [k, xs] of Object.entries(times)) {
      const pair = k.split('|').slice(0, 3).join('|');
      for (const x of xs) {
        push(all, pair, x);
        push(slot, k, x);
      }
    }
  }
  return { v: 2, all: spreads(all), slot: spreads(slot) };
}

export function buildTable(segments: Segment[]): SegmentTable {
  return tableOf([timesOf(segments)]);
}

export function segmentS(table: SegmentTable, svc: string, from: string, to: string, t: number, pace: Pace = 'median'): number | null {
  const k = `${svc}|${from}|${to}`;
  const i = PACE[pace];
  const all = table.all[k];
  if (!all || (pace !== 'median' && all[0] < CHECK.minN)) return null;
  const slot = table.slot[`${k}|${slotOf(t)}`];
  if (!slot) return all[i];
  return (slot[0] * slot[i] + SLOT_PRIOR * all[i]) / (slot[0] + SLOT_PRIOR);
}

export interface Recent {
  windowMs: number;
  minN: number;
  prior: number;
}

export const RECENT: Recent = { windowMs: 30 * 60_000, minN: 2, prior: 0 };

export type RecentIndex = Map<string, { known: number; s: number }[]>;

export function recentIndex(segments: Segment[]): RecentIndex {
  const out: RecentIndex = new Map();
  for (const g of segments) {
    const k = `${g.svc}|${g.from}|${g.to}`;
    const list = out.get(k);
    if (list) list.push({ known: g.known, s: g.s });
    else out.set(k, [{ known: g.known, s: g.s }]);
  }
  for (const list of out.values()) list.sort((a, b) => a.known - b.known);
  return out;
}

export function recentS(index: RecentIndex, svc: string, from: string, to: string, at: number, windowMs: number): [number, number] | null {
  const list = index.get(`${svc}|${from}|${to}`);
  if (!list) return null;
  const xs: number[] = [];
  for (let i = list.length - 1; i >= 0 && list[i].known > at - windowMs; i--) if (list[i].known <= at) xs.push(list[i].s);
  return xs.length ? [xs.length, median(xs)] : null;
}

export function heldAfterS(s: number): number {
  return Math.max(HELD.factor * s, s + HELD.overS);
}

export interface HistoryOptions {
  gate?: boolean;
  recent?: { index: RecentIndex; at: number } & Recent;
  pace?: Pace;
}

function segmentWith(table: SegmentTable, svc: string, from: string, to: string, t: number, opts: HistoryOptions): number | null {
  const hist = segmentS(table, svc, from, to, t, opts.pace);
  const r = opts.recent;
  if (!r) return hist;
  const seen = recentS(r.index, svc, from, to, r.at, r.windowMs);
  if (!seen || seen[0] < r.minN) return hist;
  if (hist === null || r.prior <= 0) return seen[1];
  return (seen[0] * seen[1] + r.prior * hist) / (seen[0] + r.prior);
}

export interface BusState {
  plate: string;
  stop: string;
  t: number;
}

export type StateIndex = Map<string, { known: number; p: Passing }[]>;

export function stateIndex(passings: (Passing & { seen?: number })[], lagMs: number): StateIndex {
  const out: StateIndex = new Map();
  for (const p of passings) {
    const list = out.get(p.svc);
    const entry = { known: p.seen ?? p.t + lagMs, p };
    if (list) list.push(entry);
    else out.set(p.svc, [entry]);
  }
  for (const list of out.values()) list.sort((a, b) => a.known - b.known);
  return out;
}

export function statesAt(index: StateIndex, svc: string, at: number): BusState[] {
  const list = index.get(svc) ?? [];
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].known <= at) lo = mid + 1;
    else hi = mid;
  }
  const last = new Map<string, BusState>();
  for (let i = lo - 1; i >= 0; i--) {
    const { known, p } = list[i];
    if (at - known > STATE_MAX_AGE_MS) break;
    if (at - p.t > STATE_MAX_AGE_MS) continue;
    const kept = last.get(p.plate);
    if (!kept || p.t > kept.t) last.set(p.plate, { plate: p.plate, stop: p.stop, t: p.t });
  }
  return [...last.values()];
}

export function busStates(passings: (Passing & { seen?: number })[], svc: string, at: number, lagMs: number): BusState[] {
  return statesAt(stateIndex(passings, lagMs), svc, at);
}

export function historicalEtaS(
  table: SegmentTable,
  route: Route,
  svc: string,
  bus: BusState,
  target: string,
  at: number,
  justPassedS = 0,
  opts: HistoryOptions = {},
): number | null {
  const elapsed = Math.max(0, (at - bus.t) / 1000);
  if (bus.stop === target && elapsed <= justPassedS) return 0;
  let i = route.seq.indexOf(bus.stop);
  if (i < 0) return null;
  let total = 0;
  let first: number | null = null;
  let clock = bus.t;
  for (let step = 0; step < route.seq.length; step++) {
    const j = after(route, i);
    if (j === null || (opts.gate && i === 0)) return null;
    const s = segmentWith(table, svc, route.seq[i], route.seq[j], clock, opts);
    if (s === null) return null;
    if (first === null && opts.gate && elapsed > heldAfterS(s)) return null;
    first ??= s;
    total += s;
    clock += s * 1000;
    if (route.seq[j] === target) {
      const left = Math.max(first - elapsed, Math.min(first, OVERDUE_LEFT_S));
      return Math.max(0, Math.round(total - first + left));
    }
    i = j;
  }
  return null;
}

export function horizonOf(s: number): number {
  const k = HORIZONS.findIndex((h) => s <= h.maxS);
  return k < 0 ? HORIZONS.length - 1 : k;
}

export interface EtaModel {
  v: 1;
  table: SegmentTable;
  bias: Record<string, [number, number]>;
  weights: number[];
}

export function biasS(model: Pick<EtaModel, 'bias'>, svc: string, feedS: number): number {
  const h = horizonOf(feedS);
  const any = model.bias[`*|${h}`];
  const own = model.bias[`${svc}|${h}`];
  if (!any) return 0;
  if (!own) return any[1];
  return (own[0] * own[1] + BIAS_PRIOR * any[1]) / (own[0] + BIAS_PRIOR);
}

export interface Answers {
  feed: number | null;
  corrected: number | null;
  checked: number | null;
  history: number | null;
  gated: number | null;
  recent: number | null;
  blend: number | null;
}

export function predictS(
  model: EtaModel,
  svc: string,
  feedS: number | null,
  histS: number | null,
): Pick<Answers, 'feed' | 'corrected' | 'history' | 'blend'> {
  const corrected = feedS === null ? null : Math.max(0, Math.round(feedS + biasS(model, svc, feedS)));
  let blend: number | null;
  if (corrected === null) blend = histS;
  else if (histS === null) blend = corrected;
  else {
    const w = model.weights[horizonOf(feedS!)] ?? 0;
    blend = Math.round(w * histS + (1 - w) * corrected);
  }
  return { feed: feedS, corrected, history: histS, blend };
}

export interface Query {
  t: number;
  svc: string;
  stop: string;
  etaS: number | null;
  plate?: string;
}

export function historyFor(table: SegmentTable, route: Route, states: BusState[], q: Query, opts: HistoryOptions = {}): number | null {
  const early = earlyS(q);
  const eta = (bus: BusState) => historicalEtaS(table, route, q.svc, bus, q.stop, q.t, early, opts);
  if (q.plate) {
    const bus = states.find((b) => b.plate === q.plate);
    return bus ? eta(bus) : null;
  }
  const ungated = { ...opts, gate: false };
  let best: BusState | null = null;
  let bestS = Infinity;
  for (const bus of states) {
    const s = historicalEtaS(table, route, q.svc, bus, q.stop, q.t, early, ungated);
    if (s !== null && s < bestS) {
      best = bus;
      bestS = s;
    }
  }
  if (!best) return null;
  return opts.gate ? eta(best) : bestS;
}

export function checkS(table: SegmentTable, route: Route, states: BusState[], q: Query, s: number): number {
  const bus = q.plate ? states.find((b) => b.plate === q.plate) : undefined;
  if (!bus || q.t - bus.t > CHECK.maxAgeS * 1000) return s;
  const quick = historyFor(table, route, [bus], q, { pace: 'quick' });
  if (quick !== null && s < quick - CHECK.marginS) return historyFor(table, route, [bus], q) ?? s;
  const slow = historyFor(table, route, [bus], q, { gate: true, pace: 'slow' });
  if (slow !== null && s > slow + CHECK.marginS) return historyFor(table, route, [bus], q, { gate: true }) ?? s;
  return s;
}

export function actualFor(q: Query, index: Map<string, number[]>): number | null {
  const said = q.t + (q.etaS ?? 0) * 1000;
  const from = q.t - earlyS(q) * 1000;
  const ts = index.get(q.plate ? `${q.svc}|${q.plate}|${q.stop}` : `${q.svc}|${q.stop}`) ?? [];
  return ts.find((t) => t >= from && t <= said + 30 * 60_000) ?? null;
}

export function passingIndex(passings: Passing[]): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const p of passings) {
    push(m, `${p.svc}|${p.plate}|${p.stop}`, p.t);
    push(m, `${p.svc}|${p.stop}`, p.t);
  }
  for (const ts of m.values()) ts.sort((a, b) => a - b);
  return m;
}

export interface Recorded {
  passings: (Passing & { seen?: number })[];
  queries: Query[];
  lagMs: number;
}

export interface Case {
  svc: string;
  stop: string;
  t: number;
  feedS: number;
  actualS: number;
  answers: Answers;
  hist: { alone: number | null; gated: number | null; recent: number | null };
  why: Why;
}

const STEADY = { withinS: 60, gapS: 300 };
export const STUCK_S = 180;

export interface Why {
  wentBy: boolean;
  atStop: boolean;
  seenS: number | null;
  firstStop: boolean;
  held: boolean;
  steadyS: number;
}

export type ReadIndex = Map<string, { t: number; etaS: number }[]>;

export function readIndex(queries: Query[]): ReadIndex {
  const out: ReadIndex = new Map();
  for (const q of queries) {
    if (q.etaS === null) continue;
    const k = q.plate ? `${q.svc}|${q.plate}|${q.stop}` : `${q.svc}|${q.stop}`;
    const list = out.get(k);
    if (list) list.push({ t: q.t, etaS: q.etaS });
    else out.set(k, [{ t: q.t, etaS: q.etaS }]);
  }
  for (const list of out.values()) list.sort((a, b) => a.t - b.t);
  return out;
}

export function steadyS(index: ReadIndex, q: Query): number {
  if (q.etaS === null) return 0;
  const list = index.get(q.plate ? `${q.svc}|${q.plate}|${q.stop}` : `${q.svc}|${q.stop}`) ?? [];
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].t <= q.t) lo = mid + 1;
    else hi = mid;
  }
  let since = q.t;
  for (let i = lo - 1; i >= 0; i--) {
    const r = list[i];
    if (since - r.t > STEADY.gapS * 1000 || Math.abs(r.etaS - q.etaS) > STEADY.withinS) break;
    since = r.t;
  }
  return Math.round((q.t - since) / 1000);
}

const WENT_BY = { skipped: 3, gapMs: 10 * 60_000 };

export function wentBy(route: Route, list: Passing[], q: Query, came: number): boolean {
  const from = q.t - earlyS(q) * 1000;
  for (let k = 1; k < list.length; k++) {
    const [a, b] = [list[k - 1], list[k]];
    const mid = (a.t + b.t) / 2;
    if (mid < from || b.t >= came || a.stop === b.stop || b.t - a.t > WENT_BY.gapMs) continue;
    for (let i = 0; i < route.seq.length; i++) {
      if (route.seq[i] !== a.stop) continue;
      let passed = false;
      for (let j = after(route, i), step = 0; j !== null && step <= WENT_BY.skipped; j = after(route, j), step++) {
        if (route.seq[j] === b.stop) {
          if (passed) return true;
          break;
        }
        if (route.seq[j] === q.stop) passed = true;
      }
    }
  }
  return false;
}

export function whyOf(table: SegmentTable, route: Route, bus: BusState | undefined, q: Query, steady: number, went = false): Why {
  if (!bus) return { wentBy: went, atStop: false, seenS: null, firstStop: false, held: false, steadyS: steady };
  const elapsed = Math.max(0, (q.t - bus.t) / 1000);
  const atStop = bus.stop === q.stop;
  let firstStop = q.stop === route.seq[0];
  let i = route.seq.indexOf(bus.stop);
  for (let step = 0; !firstStop && !atStop && i >= 0 && step < route.seq.length; step++) {
    const j = after(route, i);
    if (j === null) break;
    if (i === 0) {
      firstStop = true;
      break;
    }
    if (route.seq[j] === q.stop) break;
    i = j;
  }
  const k = route.seq.indexOf(bus.stop);
  const next = k < 0 ? null : after(route, k);
  const s = next === null ? null : segmentS(table, q.svc, bus.stop, route.seq[next], bus.t);
  return { wentBy: went, atStop, seenS: Math.round(elapsed), firstStop, held: s !== null && elapsed > heldAfterS(s), steadyS: steady };
}

export const CAUSES = ['wentBy', 'atStop', 'stuck', 'unseen', 'firstStop', 'held', 'other'] as const;
export type Cause = (typeof CAUSES)[number];

export function causeOf(why: Why): Cause {
  if (why.wentBy) return 'wentBy';
  if (why.atStop) return 'atStop';
  if (why.steadyS >= STUCK_S) return 'stuck';
  if (why.seenS === null) return 'unseen';
  if (why.firstStop) return 'firstStop';
  if (why.held) return 'held';
  return 'other';
}

export function casesOf(model: EtaModel, routes: Record<string, Route>, rec: Recorded, recent: Recent = RECENT): Case[] {
  const index = passingIndex(rec.passings);
  const states = stateIndex(rec.passings, rec.lagMs);
  const driven = recentIndex(segmentsOf(rec.passings, routes, rec.lagMs));
  const reads = readIndex(rec.queries);
  const byBus = byBusOf(rec.passings);
  const out: Case[] = [];
  for (const q of rec.queries) {
    const route = routes[q.svc];
    if (!route || q.etaS === null) continue;
    const came = actualFor(q, index);
    if (came === null) continue;
    const buses = statesAt(states, q.svc, q.t);
    const hist = {
      alone: historyFor(model.table, route, buses, q),
      gated: historyFor(model.table, route, buses, q, { gate: true }),
      recent: historyFor(model.table, route, buses, q, { gate: true, recent: { ...recent, index: driven, at: q.t } }),
    };
    const blended = predictS(model, q.svc, q.etaS, hist.gated);
    const check = (s: number) => checkS(model.table, route, buses, q, s);
    out.push({
      svc: q.svc,
      stop: q.stop,
      t: q.t,
      feedS: q.etaS,
      actualS: (came - q.t) / 1000,
      answers: {
        ...blended,
        checked: check(blended.corrected!),
        blend: check(blended.blend!),
        history: hist.alone,
        gated: hist.gated ?? q.etaS,
        recent: hist.recent ?? q.etaS,
      },
      hist,
      why: whyOf(
        model.table,
        route,
        q.plate ? buses.find((b) => b.plate === q.plate) : undefined,
        q,
        steadyS(reads, q),
        !!q.plate && wentBy(route, byBus.get(`${q.svc}|${q.plate}`) ?? [], q, came),
      ),
    });
  }
  return out;
}

const WEIGHT_STEPS = 10;

export interface WeightGrid {
  sums: number[][];
  n: number[];
  early: number[][];
  feedEarly: number[];
}

export function weightGrid(model: Pick<EtaModel, 'bias'>, cases: Case[]): WeightGrid {
  const sums = HORIZONS.map(() => Array.from({ length: WEIGHT_STEPS + 1 }, () => 0));
  const early = HORIZONS.map(() => Array.from({ length: WEIGHT_STEPS + 1 }, () => 0));
  const n = HORIZONS.map(() => 0);
  const feedEarly = HORIZONS.map(() => 0);
  for (const c of cases) {
    const hist = c.hist.gated;
    if (hist === null) continue;
    const h = horizonOf(c.feedS);
    const corrected = Math.max(0, c.feedS + biasS(model, c.svc, c.feedS));
    n[h]++;
    if (c.actualS - c.feedS < -EARLY_BY_S) feedEarly[h]++;
    for (let k = 0; k <= WEIGHT_STEPS; k++) {
      const w = k / WEIGHT_STEPS;
      const errS = c.actualS - (w * hist + (1 - w) * corrected);
      sums[h][k] += Math.abs(errS);
      if (errS < -EARLY_BY_S) early[h][k]++;
    }
  }
  return { sums: sums.map((row) => row.map((x) => Math.round(x))), n, early, feedEarly };
}

export function weightsFrom(grids: WeightGrid[]): number[] {
  return HORIZONS.map((_, h) => {
    if (!grids.some((g) => g.n[h] > 0)) return 0;
    const earlyAt = (k: number) => grids.reduce((sum, g) => sum + g.early[h][k], 0);
    const steps = Array.from({ length: WEIGHT_STEPS + 1 }, (_, k) => k);
    const limit = Math.max(
      grids.reduce((sum, g) => sum + g.feedEarly[h], 0),
      steps.map(earlyAt).reduce((a, b) => Math.min(a, b), Infinity),
    );
    let best = 0;
    let bestErr = Infinity;
    for (const k of steps) {
      if (earlyAt(k) > limit) continue;
      const err = grids.reduce((sum, g) => sum + (g.sums[h]?.[k] ?? 0), 0);
      if (err < bestErr) {
        bestErr = err;
        best = k / WEIGHT_STEPS;
      }
    }
    return best;
  });
}

export function biasOf(errors: { svc: string; feedS: number; errS: number }[]): Record<string, [number, number]> {
  const groups = new Map<string, number[]>();
  for (const e of errors) {
    const h = horizonOf(e.feedS);
    push(groups, `${e.svc}|${h}`, e.errS);
    push(groups, `*|${h}`, e.errS);
  }
  return Object.fromEntries([...groups].map(([k, xs]) => [k, [xs.length, Math.round(correctionOf(xs))]]));
}

function correctionOf(errs: number[]): number {
  let least = Infinity;
  for (const e of errs) if (e >= -EARLY_BY_S && e < least) least = e;
  return Math.min(median(errs), least + EARLY_BY_S);
}

export function fitModel(routes: Record<string, Route>, train: Recorded[]): EtaModel {
  const table = buildTable(train.flatMap((r) => segmentsOf(r.passings, routes)));
  const blank: EtaModel = { v: 1, table, bias: {}, weights: HORIZONS.map(() => 0) };
  const cases = train.flatMap((r) => casesOf(blank, routes, r));
  const bias = biasOf(cases.map((c) => ({ svc: c.svc, feedS: c.feedS, errS: c.actualS - c.feedS })));
  const model: EtaModel = { ...blank, bias };
  return { ...model, weights: weightsFrom([weightGrid(model, cases)]) };
}

export const MISS_S = 300;

export interface ErrorStats {
  n: number;
  mae: number | null;
  p50: number | null;
  p90: number | null;
  bias: number | null;
  miss: number | null;
}

export function errorStats(errs: number[]): ErrorStats {
  if (!errs.length) return { n: 0, mae: null, p50: null, p90: null, bias: null, miss: null };
  const abs = errs.map(Math.abs);
  const r = (x: number) => Math.round(x * 10) / 10;
  return {
    n: errs.length,
    mae: r(abs.reduce((a, b) => a + b, 0) / abs.length),
    p50: r(quantile(abs, 0.5)),
    p90: r(quantile(abs, 0.9)),
    bias: r(errs.reduce((a, b) => a + b, 0) / errs.length),
    miss: Math.round((abs.filter((x) => x > MISS_S).length / abs.length) * 1000) / 1000,
  };
}

export const METHODS = ['feed', 'corrected', 'checked', 'history', 'gated', 'recent', 'blend'] as const;
export type Method = (typeof METHODS)[number];

export type Misses = Record<Cause, { n: number; late: number; err: Record<Method, number> }>;

export function missesOf(cases: Case[]): Misses {
  const out = Object.fromEntries(CAUSES.map((c) => [c, { n: 0, late: 0, err: Object.fromEntries(METHODS.map((m) => [m, 0])) }])) as Misses;
  for (const c of cases) {
    if (Math.abs(c.actualS - c.feedS) <= MISS_S) continue;
    const o = out[causeOf(c.why)];
    o.n++;
    if (c.actualS > c.feedS) o.late++;
    for (const m of METHODS) if (c.answers[m] !== null) o.err[m] += Math.abs(c.actualS - c.answers[m]!);
  }
  for (const o of Object.values(out)) for (const m of METHODS) o.err[m] = Math.round(o.err[m]);
  return out;
}

export function scoreCases(cases: Case[]): {
  coverage: number | null;
  overall: Record<Method, ErrorStats>;
  horizons: { label: string; stats: Record<Method, ErrorStats> }[];
  misses: Misses;
} {
  const full = cases.filter((c) => METHODS.every((m) => c.answers[m] !== null));
  const statsFor = (cs: Case[]) =>
    Object.fromEntries(METHODS.map((m) => [m, errorStats(cs.map((c) => c.actualS - c.answers[m]!))])) as Record<Method, ErrorStats>;
  return {
    coverage: cases.length ? Math.round((full.length / cases.length) * 1000) / 1000 : null,
    overall: statsFor(full),
    horizons: HORIZONS.map((h, i) => ({ label: h.label, stats: statsFor(full.filter((c) => horizonOf(c.feedS) === i)) })),
    misses: missesOf(full),
  };
}

export const EARLY_BY_S = 60;

export function earlyShare(errs: number[]): number | null {
  if (!errs.length) return null;
  return errs.filter((e) => e < -EARLY_BY_S).length / errs.length;
}

export const PAIRED_MIN_DAYS = 7;

export interface Paired {
  diff: number;
  lo: number | null;
  hi: number | null;
}

export interface PairedTest {
  n: number;
  days: number;
  mae: Paired;
  p90: Paired;
  early: Paired;
  verdict: 'better' | 'worse' | 'unclear' | 'too few days';
}

export function pairedTest(
  cases: Case[],
  dayOf: (c: Case) => string,
  method: Method,
  opts: { rounds?: number; seed?: number } = {},
): PairedTest | null {
  const byDay = new Map<string, { m: number[]; f: number[] }>();
  for (const c of cases) {
    const m = c.answers[method];
    const f = c.answers.feed;
    if (m === null || f === null) continue;
    const d = byDay.get(dayOf(c)) ?? { m: [], f: [] };
    d.m.push(c.actualS - m);
    d.f.push(c.actualS - f);
    byDay.set(dayOf(c), d);
  }
  const days = [...byDay.keys()].sort().map((k) => byDay.get(k)!);
  if (!days.length) return null;
  const n = days.reduce((t, d) => t + d.m.length, 0);
  const r = (x: number) => Math.round(x * 1000) / 1000;
  const figures = (picked: { m: number[]; f: number[] }[]) => {
    const m = picked.flatMap((d) => d.m);
    const f = picked.flatMap((d) => d.f);
    const mae = (xs: number[]) => xs.reduce((t, x) => t + Math.abs(x), 0) / xs.length;
    return [mae(m) - mae(f), quantile(m.map(Math.abs), 0.9) - quantile(f.map(Math.abs), 0.9), earlyShare(m)! - earlyShare(f)!];
  };
  const point = figures(days);
  if (days.length < PAIRED_MIN_DAYS) {
    const [mae, p90, early] = point.map((diff) => ({ diff: r(diff), lo: null, hi: null }));
    return { n, days: days.length, mae, p90, early, verdict: 'too few days' };
  }
  let s = (opts.seed ?? 1) >>> 0;
  const random = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const draws: number[][] = [[], [], []];
  for (let round = 0; round < (opts.rounds ?? 2000); round++) {
    const picked = days.map(() => days[Math.floor(random() * days.length)]);
    figures(picked).forEach((x, i) => draws[i].push(x));
  }
  const [mae, p90, early] = point.map((diff, i) => ({ diff: r(diff), lo: r(quantile(draws[i], 0.025)), hi: r(quantile(draws[i], 0.975)) }));
  const worse = [mae, p90, early].some((x) => x.lo > 0);
  return { n, days: days.length, mae, p90, early, verdict: worse ? 'worse' : mae.hi < 0 ? 'better' : 'unclear' };
}
