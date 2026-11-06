/**
 * A second opinion on "the next D1 in 4 min": the feed's time corrected for
 * how it usually errs, blended with history's time for the bus's position.
 * Pure, with no I/O and nothing bigger than a Map: it runs in the Worker or
 * in scripts/probes/eta_backtest.mjs. Nothing in the answer path uses it.
 * See docs/eta-model.md, *The model*.
 */

import { HORIZONS, type Passing } from './eta.ts';
import { SGT_MS } from '../config.ts';

/** A route's stops in order: a loop's ring once round (its first stop not repeated at the end). */
export interface Route {
  seq: string[];
  loop: boolean;
}

/** A segment longer than this is a bus out of service or laid up, not driving. */
const MAX_SEGMENT_S = 20 * 60;
/** Two readings further apart than this say nothing about what happened between (as eta.ts). */
const MAX_GAP_MS = 120_000;
/** A bus's last stop is its position for this long after; older, it's lost. */
const STATE_MAX_AGE_MS = 20 * 60_000;
/** Overdue on its segment by this much (heldAfterS), a bus is taken as held; the gate refuses it. */
const HELD = { factor: 2, overS: 120 };
/** A bus still this far from its next stop when overdue: it is held, not there. */
const OVERDUE_LEFT_S = 10;
/**
 * The check (checkS): a time this far outside what history says the bus
 * could do is wrong, for a bus seen at a stop no longer ago than [maxAgeS],
 * on stop pairs driven at least [minN] times (fewer give no real range).
 * On 19 October 2026 the feed held a D2 at 3 minutes from PGP for many
 * reads while the bus was half a lap away; it came 25 to 30 minutes later.
 */
export const CHECK = { maxAgeS: 90, marginS: 240, minN: 5 };
/**
 * A bus said to be about there may already have reached the stop: for a
 * plate said to be 2 minutes or less away, a minute back (as eta.ts
 * scoreEtas); for a board's next bus of any plate, said to be a minute or
 * less away, 30 s (longer, and it's more likely the bus before, gone).
 */
const PLATE_EARLY = { etaS: 120, backS: 60 };
const BOARD_EARLY = { etaS: 60, backS: 30 };

/** How far back an arrival still counts as the one [q] means, s. */
export function earlyS(q: Pick<Query, 'etaS' | 'plate'>): number {
  const rule = q.plate ? PLATE_EARLY : BOARD_EARLY;
  return q.etaS !== null && q.etaS <= rule.etaS ? rule.backS : 0;
}
/** Readings a slot's median is worth against the stop pair's own: the shrinkage. */
const SLOT_PRIOR = 4;
/** Predictions a service's bias is worth against every service's, at a horizon. */
const BIAS_PRIOR = 10;

/** A route as rung: a loop's last stop dropped where it repeats the first. */
export function ringOf(seq: string[], loop: boolean): Route {
  return { seq: loop && seq.length > 1 && seq[0] === seq[seq.length - 1] ? seq.slice(0, -1) : [...seq], loop };
}

/** The stop after index [i], or null past a one-way route's end. */
function after(route: Route, i: number): number | null {
  if (i + 1 < route.seq.length) return i + 1;
  return route.loop && route.seq.length > 1 ? 0 : null;
}

/** Whether [to] directly follows [from] on the route. */
function adjacent(route: Route, from: string, to: string): boolean {
  for (let i = 0; i < route.seq.length; i++) {
    if (route.seq[i] !== from) continue;
    const j = after(route, i);
    if (j !== null && route.seq[j] === to) return true;
  }
  return false;
}

/**
 * One bus as the map placed it (/api/buses): at a stop, or between [last]
 * and [next]. [next] is the stop it's heading for, from a stop too.
 */
export interface BusReading {
  t: number;
  svc: string;
  plate: string;
  at: string | null;
  last: string | null;
  next: string | null;
}

/** A Passing with when it could first be known: the reading that showed it. */
export interface SeenPassing extends Passing {
  seen: number;
}

/**
 * When each bus reached each stop, from the map's placed buses: a bus
 * heading for S in one reading and at S, or past it, in the next reached it
 * between the two, taken as the middle. The map shows a bus at a stop from
 * 40 m out, so that's "reached". A bus that passes two stops between
 * readings, or readings further apart than MAX_GAP_MS, count for nothing.
 */
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

/** One bus's time from one stop to the next: [t] when it left (reached [from]), [s] seconds. */
export interface Segment {
  svc: string;
  from: string;
  to: string;
  t: number;
  s: number;
  /** When it could first be known: the passing at [to] seen, or [lagMs] after it. */
  known: number;
}

/** Each bus's passings, keyed `svc|plate`, in time order. */
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

/** Each bus's consecutive passings at adjacent stops of its route, as segments. */
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

/** The slot a moment falls in: weekday or weekend, and the Singapore hour. */
export function slotOf(t: number): string {
  const d = new Date(t + SGT_MS);
  const day = d.getUTCDay();
  return `${day === 0 || day === 6 ? 'we' : 'wd'}|${d.getUTCHours()}`;
}

/** Segment times: [count, median, 10th and 90th percentile s], by stop pair and by stop pair and slot. */
export interface SegmentTable {
  v: 2;
  /** `svc|from|to` */
  all: Record<string, Spread>;
  /** `svc|from|to|wd|7` */
  slot: Record<string, Spread>;
}

export type Spread = [number, number, number, number];
/** Which of a Spread's times: the median, or the quick and slow ends (the check's bounds). */
export type Pace = 'median' | 'quick' | 'slow';
const PACE: Record<Pace, 1 | 2 | 3> = { median: 1, quick: 2, slow: 3 };

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const middle = (s: number[]) => (s.length % 2 ? s[s.length >> 1] : (s[(s.length >> 1) - 1] + s[s.length >> 1]) / 2);
const rank = (s: number[], q: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];

export function median(xs: number[]): number {
  return middle(sorted(xs));
}

/** The value at fraction [q] of the way up [xs] (nearest rank). */
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

/** Segment times by `svc|from|to|wd|7`: one day's, as the cron keeps them, or any number of segments'. */
export type SegmentTimes = Record<string, number[]>;

export function timesOf(segments: Segment[]): SegmentTimes {
  const out: SegmentTimes = {};
  for (const g of segments) (out[`${g.svc}|${g.from}|${g.to}|${slotOf(g.t)}`] ??= []).push(g.s);
  return out;
}

/** The table from any number of days' segment times together. */
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

/**
 * The time from [from] to [to] at [t]: the slot's median (or [pace]'s end),
 * pulled towards the stop pair's overall one the fewer it has
 * (SLOT_PRIOR). Null with no history for the pair, or for an end too
 * little to tell one (CHECK.minN).
 */
export function segmentS(table: SegmentTable, svc: string, from: string, to: string, t: number, pace: Pace = 'median'): number | null {
  const k = `${svc}|${from}|${to}`;
  const i = PACE[pace];
  const all = table.all[k];
  if (!all || (pace !== 'median' && all[0] < CHECK.minN)) return null;
  const slot = table.slot[`${k}|${slotOf(t)}`];
  if (!slot) return all[i];
  return (slot[0] * slot[i] + SLOT_PRIOR * all[i]) / (slot[0] + SLOT_PRIOR);
}

/**
 * The bus ahead: segment times the service's buses have just driven count
 * for those still to drive them. [windowMs]: how far back a segment still
 * counts, by when it was known; [minN]: fewer than this, and history's
 * median stands alone; [prior]: segments history's median is worth against
 * the recent ones' (0: the recent median replaces it).
 */
export interface Recent {
  windowMs: number;
  minN: number;
  prior: number;
}

export const RECENT: Recent = { windowMs: 30 * 60_000, minN: 2, prior: 0 };

/** Segment times by `svc|from|to`, in the order they could be known: for recentS. */
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

/** The segments from [from] to [to] known in the [windowMs] before [at], and never after: [count, median s], or null with none. */
export function recentS(index: RecentIndex, svc: string, from: string, to: string, at: number, windowMs: number): [number, number] | null {
  const list = index.get(`${svc}|${from}|${to}`);
  if (!list) return null;
  const xs: number[] = [];
  for (let i = list.length - 1; i >= 0 && list[i].known > at - windowMs; i--) if (list[i].known <= at) xs.push(list[i].s);
  return xs.length ? [xs.length, median(xs)] : null;
}

/**
 * A bus this far into a segment usually taking [s] is held (or lost), not
 * on its way: the gate's limit, twice the usual time and at least 2 minutes
 * over (A1s have sat at PGP for 15 minutes).
 */
export function heldAfterS(s: number): number {
  return Math.max(HELD.factor * s, s + HELD.overS);
}

/** How the segments to a stop are summed: see historicalEtaS. */
export interface HistoryOptions {
  /** Not through a route's first stop, where buses wait for their departure time. */
  gate?: boolean;
  /** Segments just driven, with these settings, beside history's medians. */
  recent?: { index: RecentIndex; at: number } & Recent;
  /** Each segment's quick or slow end instead of its median. */
  pace?: Pace;
}

/** The time from [from] to [to] at [t]: history's median, with the buses just ahead's (HistoryOptions.recent) where there are enough. */
function segmentWith(table: SegmentTable, svc: string, from: string, to: string, t: number, opts: HistoryOptions): number | null {
  const hist = segmentS(table, svc, from, to, t, opts.pace);
  const r = opts.recent;
  if (!r) return hist;
  const seen = recentS(r.index, svc, from, to, r.at, r.windowMs);
  if (!seen || seen[0] < r.minN) return hist;
  if (hist === null || r.prior <= 0) return seen[1];
  return (seen[0] * seen[1] + r.prior * hist) / (seen[0] + r.prior);
}

/** Where a bus is: the last stop it reached, and when. */
export interface BusState {
  plate: string;
  stop: string;
  t: number;
}

/** Passings by service, in the order they could be known: for statesAt. */
export type StateIndex = Map<string, { known: number; p: Passing }[]>;

/** [passings] indexed for statesAt: one without `seen` is known [lagMs] after it, the recorder's poll. */
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

/** Each of [svc]'s buses as it could be known at [at]: its latest passing known by then, if no older than STATE_MAX_AGE_MS. */
export function statesAt(index: StateIndex, svc: string, at: number): BusState[] {
  const list = index.get(svc) ?? [];
  // The last passing known by [at]: a binary search, then back from there.
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
    // Known this long before [at], it and everything before it is too old.
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

/**
 * Seconds from [at] until [bus] reaches [target], from history: the rest
 * of its current segment (never under OVERDUE_LEFT_S, or the segment if
 * shorter, once it's overdue), then each segment on to the target. A bus
 * that passed the target no more than [justPassedS] ago is there now;
 * otherwise it has the whole way round to go. Null when the target isn't
 * ahead on the route or a segment has no history; with [opts].gate, also
 * when the way there leaves the route's first stop, the bus's own included:
 * buses wait there for NUS's departure time (D1 has waited over 12 minutes
 * at COM3), which the feed may know and travel times can't; and when the
 * bus is so overdue on its current segment that it's held (heldAfterS).
 */
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
  // The bus's stop on the route: on a ring that passes a stop twice, the first.
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

/** Which of HORIZONS [s] falls in (the last for anything beyond). */
export function horizonOf(s: number): number {
  const k = HORIZONS.findIndex((h) => s <= h.maxS);
  return k < 0 ? HORIZONS.length - 1 : k;
}

/** The whole model: the segment table, the correction to the feed's times, and the blend's weights. */
export interface EtaModel {
  v: 1;
  table: SegmentTable;
  /** The correction to the feed's time, s (positive: the bus comes later than it says), by `svc|horizon` and `*|horizon`: [count, s] (biasOf). */
  bias: Record<string, [number, number]>;
  /** Per horizon (HORIZONS), the weight on history against the corrected feed, 0 to 1. */
  weights: number[];
}

/**
 * The correction for that service at that horizon, pulled towards every
 * service's (BIAS_PRIOR). Every service's is capped no higher than any one
 * service's (its errors are among them: biasOf), so the mix stays within
 * the service's cap.
 */
export function biasS(model: Pick<EtaModel, 'bias'>, svc: string, feedS: number): number {
  const h = horizonOf(feedS);
  const any = model.bias[`*|${h}`];
  const own = model.bias[`${svc}|${h}`];
  if (!any) return 0;
  if (!own) return any[1];
  return (own[0] * own[1] + BIAS_PRIOR * any[1]) / (own[0] + BIAS_PRIOR);
}

/**
 * Every way of answering one question, s from now; null where it can't be.
 * [checked] is the corrected feed through checkS; [history] is history
 * alone; [gated], history through the layover gate, and [recent], that
 * with the buses just ahead (HistoryOptions), each the feed's time where
 * they can't answer, as they would be served; [blend], the corrected feed
 * weighted with [gated]'s history, through checkS.
 */
export interface Answers {
  feed: number | null;
  corrected: number | null;
  checked: number | null;
  history: number | null;
  gated: number | null;
  recent: number | null;
  blend: number | null;
}

/** The model's answer from the feed's time and history's, either possibly missing. */
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

/** A question to answer: at [t], when does [svc] next reach [stop] (that plate's bus, given one)? */
export interface Query {
  t: number;
  svc: string;
  stop: string;
  /** The feed's answer, s from [t]; null without one. */
  etaS: number | null;
  plate?: string;
}

/**
 * History's answer to [q]: for a plate, that bus's; otherwise the soonest
 * of the service's buses. A bus that reached the stop within earlyS(q) is
 * there now; one before that has gone, and has a lap to come round. With
 * [opts].gate, the soonest is still picked as if ungated, so a bus waiting
 * at the first stop isn't skipped for the one after it: when the soonest
 * has to leave the first stop, it's null.
 */
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

/**
 * [s] for [q], unless history says it can't be: sooner by CHECK.marginS
 * than the plate's bus could get there at its quickest, or later by as much
 * than it would at its slowest on its way (gated). Then history's median,
 * ungated for the first (a layover only adds time) and gated for the
 * second. Only for a plate whose bus was seen at a stop in the last
 * CHECK.maxAgeS: longer ago, it may have gone on unseen.
 */
export function checkS(table: SegmentTable, route: Route, states: BusState[], q: Query, s: number): number {
  const bus = q.plate ? states.find((b) => b.plate === q.plate) : undefined;
  if (!bus || q.t - bus.t > CHECK.maxAgeS * 1000) return s;
  const quick = historyFor(table, route, [bus], q, { pace: 'quick' });
  if (quick !== null && s < quick - CHECK.marginS) return historyFor(table, route, [bus], q) ?? s;
  const slow = historyFor(table, route, [bus], q, { gate: true, pace: 'slow' });
  if (slow !== null && s > slow + CHECK.marginS) return historyFor(table, route, [bus], q, { gate: true }) ?? s;
  return s;
}

/**
 * When the bus [q] asks about did reach the stop: the plate's first
 * passing (or, without one, any of the service's buses') from earlyS(q)
 * before asking to 30 minutes after the time said.
 */
export function actualFor(q: Query, index: Map<string, number[]>): number | null {
  const said = q.t + (q.etaS ?? 0) * 1000;
  const from = q.t - earlyS(q) * 1000;
  const ts = index.get(q.plate ? `${q.svc}|${q.plate}|${q.stop}` : `${q.svc}|${q.stop}`) ?? [];
  return ts.find((t) => t >= from && t <= said + 30 * 60_000) ?? null;
}

/** Passing times by `svc|plate|stop` and by `svc|stop`, sorted, for actualFor. */
export function passingIndex(passings: Passing[]): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const p of passings) {
    push(m, `${p.svc}|${p.plate}|${p.stop}`, p.t);
    push(m, `${p.svc}|${p.stop}`, p.t);
  }
  for (const ts of m.values()) ts.sort((a, b) => a - b);
  return m;
}

/** A stretch of recorded service: what the buses did, and what was asked of the feed. */
export interface Recorded {
  passings: (Passing & { seen?: number })[];
  queries: Query[];
  /** How long after a passing it could be known, when it has no `seen`: the recorder's poll. */
  lagMs: number;
}

/** One query answered every way, with when the bus did come; errors are actual minus said, s. */
export interface Case {
  svc: string;
  stop: string;
  t: number;
  feedS: number;
  actualS: number;
  answers: Answers;
  /** History's own answers, null where it couldn't: alone, gated (the blend's), and gated with the buses just ahead. */
  hist: { alone: number | null; gated: number | null; recent: number | null };
  /** What was known about the bus when asked: why an answer may be far off (causeOf). */
  why: Why;
}

/** Reads of one time: within a minute (the feed says whole minutes), and no more than 5 minutes apart. */
const STEADY = { withinS: 60, gapS: 300 };
/** A time given this long is stuck: a bus at lights can hold a minute for a minute; three is the feed not counting down. */
export const STUCK_S = 180;

/** What was known about [q]'s bus when asked, and one thing found after. A board's time (no plate) has no bus: unseen. */
export interface Why {
  /** The bus went by the stop unseen before the arrival matched (wentBy): that arrival is likely a lap late. */
  wentBy: boolean;
  /** The stop the bus was last seen reaching is this one: it may still be there, and the arrival matched its next lap's. */
  atStop: boolean;
  /** Seconds since the bus was last seen reaching a stop; null when it wasn't in the last STATE_MAX_AGE_MS. */
  seenS: number | null;
  /**
   * Its way to the stop leaves a route's first stop, its own included: it
   * may wait there for its departure time (the gate's layover). Or the stop
   * is a first stop: buses queue there, so when one arrived is unclear.
   */
  firstStop: boolean;
  /** So overdue on its current segment that it's taken as held (heldAfterS, the gate's other refusal). */
  held: boolean;
  /** How long the feed had given about this time for this bus at this stop, s (steadyS). */
  steadyS: number;
}

/** Reads of the feed by `svc|plate|stop` (or `svc|stop` for a board), sorted by time: for steadyS. */
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

/** How long, up to [q], the feed had given [q]'s time to within STEADY.withinS, in reads no more than STEADY.gapS apart: stuck from STUCK_S. */
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

/** The most stops, and time, two passings in a row may span for wentBy: past that, a bus out of service or a reading a stop back. */
const WENT_BY = { skipped: 3, gapMs: 10 * 60_000 };

/**
 * Whether two of the plate's passings [list] (sorted) in a row span [q]'s
 * stop, the bus passing it (halfway between them) between earlyS(q) before
 * asking and [came]: it went by unseen, so [came], the arrival matched, is
 * likely its next lap's. The recorder lost it there, or it went another
 * way. Only over WENT_BY's gap at most.
 */
export function wentBy(route: Route, list: Passing[], q: Query, came: number): boolean {
  const from = q.t - earlyS(q) * 1000;
  for (let k = 1; k < list.length; k++) {
    const [a, b] = [list[k - 1], list[k]];
    const mid = (a.t + b.t) / 2;
    // Twice at one stop is a bus waiting there.
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

/** What was known about [q]'s bus: see Why. [bus] is the plate's, if it was seen. */
export function whyOf(table: SegmentTable, route: Route, bus: BusState | undefined, q: Query, steady: number, went = false): Why {
  if (!bus) return { wentBy: went, atStop: false, seenS: null, firstStop: false, held: false, steadyS: steady };
  const elapsed = Math.max(0, (q.t - bus.t) / 1000);
  const atStop = bus.stop === q.stop;
  let firstStop = q.stop === route.seq[0];
  let i = route.seq.indexOf(bus.stop);
  // Not from the stop itself: the whole lap would always pass a loop's first stop.
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

/**
 * Why a far-off answer was far off, the first that fits: the bus went by
 * unseen, or was last seen at the stop itself (either way the arrival it's
 * scored against may be its next lap's); the feed's time stuck (the feed's own reads say so, wherever the bus is); the bus
 * not seen (nothing to tell from); its way leaving a route's first stop,
 * or ending at one; held on its segment; or none of these.
 */
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

/**
 * Each query with a feed time, an actual arrival and history's view,
 * answered by [model]. The buses just ahead come from [rec]'s own
 * segments, each only once it could be known, with [recent]'s settings.
 */
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

/**
 * For each horizon, the blend's summed absolute error at each weight on
 * history from 0 to 1 in tenths, over the cases the blend's history
 * (gated) could answer, and how many there were, before checkS; and at
 * each weight, and by the feed's own time, how many of those buses came
 * early (EARLY_BY_S). Sums add
 * up across days, so a day's grid can be kept and the weights fitted from
 * many.
 */
export interface WeightGrid {
  sums: number[][];
  n: number[];
  early: number[][];
  /** Per horizon, how many of those buses came early by the feed's own time. */
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

/**
 * Per horizon, the weight that erred least over [grids] together, among
 * those that left no more buses early than the feed's own times did; where
 * none did, the one that left fewest; 0 (the corrected feed) where none had
 * a case.
 */
export function weightsFrom(grids: WeightGrid[]): number[] {
  return HORIZONS.map((_, h) => {
    if (!grids.some((g) => g.n[h] > 0)) return 0;
    const earlyAt = (k: number) => grids.reduce((sum, g) => sum + g.early[h][k], 0);
    const steps = Array.from({ length: WEIGHT_STEPS + 1 }, (_, k) => k);
    const limit = Math.max(
      grids.reduce((sum, g) => sum + g.feedEarly[h], 0),
      Math.min(...steps.map(earlyAt)),
    );
    let best = 0;
    let bestErr = Infinity;
    for (const k of steps) {
      if (earlyAt(k) > limit) continue;
      const err = grids.reduce((sum, g) => sum + (g.sums[h]?.[k] ?? 0), 0);
      // Ties go to the lower weight: the feed, which users already see.
      if (err < bestErr) {
        bestErr = err;
        best = k / WEIGHT_STEPS;
      }
    }
    return best;
  });
}

/**
 * The correction to the feed's time at each horizon, per service and for
 * all, from [errors] (the bus's arrival less the time said): [count, s].
 * The one with the least absolute error among those that leave no more
 * buses early (EARLY_BY_S) than the feed: the median error, unless adding
 * it would. The bus usually comes later than the feed says, so the median
 * moves every time later, the early buses' too, and someone who trusted
 * the time misses the bus (docs/eta-backtest.md, round 6).
 */
export function biasOf(errors: { svc: string; feedS: number; errS: number }[]): Record<string, [number, number]> {
  const groups = new Map<string, number[]>();
  for (const e of errors) {
    const h = horizonOf(e.feedS);
    push(groups, `${e.svc}|${h}`, e.errS);
    push(groups, `*|${h}`, e.errS);
  }
  return Object.fromEntries([...groups].map(([k, xs]) => [k, [xs.length, Math.round(correctionOf(xs))]]));
}

/**
 * biasOf's correction for one group of errors, exactly. Adding [o] makes a
 * bus early when its error is under o less EARLY_BY_S, so no more come early
 * than with none for any o up to the smallest error not already early, plus
 * EARLY_BY_S. Absolute error is least at the median and grows away from
 * it, so the answer is the median, or that ceiling when the median is past it.
 */
function correctionOf(errs: number[]): number {
  // A loop, not Math.min(...): every service's group pools 28 days of rows, past what spreading allows.
  let least = Infinity;
  for (const e of errs) if (e >= -EARLY_BY_S && e < least) least = e;
  return Math.min(median(errs), least + EARLY_BY_S);
}

/**
 * The model from [train]: segment times from its passings, the feed's
 * bias from its queries against when the buses came, and per horizon the
 * weight on history that would have erred least (weightGrid). Fitted on
 * the same data its history answered, so a little optimistic: the
 * backtest scores it on later data.
 */
export function fitModel(routes: Record<string, Route>, train: Recorded[]): EtaModel {
  const table = buildTable(train.flatMap((r) => segmentsOf(r.passings, routes)));
  const blank: EtaModel = { v: 1, table, bias: {}, weights: HORIZONS.map(() => 0) };
  const cases = train.flatMap((r) => casesOf(blank, routes, r));
  const bias = biasOf(cases.map((c) => ({ svc: c.svc, feedS: c.feedS, errS: c.actualS - c.feedS })));
  const model: EtaModel = { ...blank, bias };
  return { ...model, weights: weightsFrom([weightGrid(model, cases)]) };
}

/**
 * An answer off by more than this is a miss. The feed's misses are 1 in
 * 20 of its answers and nearly half its error (docs/eta-backtest.md,
 * round 3): what a user feels, and what the mean hides.
 */
export const MISS_S = 300;

/** How far off a set of answers was: absolute errors' mean and quantiles, the mean signed error (positive: later than said), and the share of misses (MISS_S). */
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

/**
 * The feed's misses (MISS_S) by cause (causeOf): how many, how many of
 * those buses came later than said, and every method's summed absolute
 * error on them, s, so days add up and each method's share of the fix shows.
 */
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

/**
 * Every method scored on the same cases, those every method could answer
 * (so history's gaps don't flatter or sink it), overall and by horizon
 * (by the feed's time), and the feed's misses among them by cause.
 * [coverage]: the share of cases history could answer.
 */
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

/**
 * A bus that came this much sooner than said: someone who trusted the time
 * reached the stop after it had gone. Worse than the same error the other
 * way, which only costs a wait, so it is scored on its own (earlyShare).
 */
export const EARLY_BY_S = 60;

/** The share of answers the bus beat by more than EARLY_BY_S; errors are actual minus said. */
export function earlyShare(errs: number[]): number | null {
  if (!errs.length) return null;
  return errs.filter((e) => e < -EARLY_BY_S).length / errs.length;
}

/**
 * Fewer days than this give no interval: resampling one day draws that day
 * every time, and three days have only ten ways to be drawn, so the
 * interval would be far narrower than the truth. A week of days.
 */
export const PAIRED_MIN_DAYS = 7;

/** A method's figure less the feed's on the same questions, with its 95% interval (negative: the method is better); no interval below PAIRED_MIN_DAYS. */
export interface Paired {
  diff: number;
  lo: number | null;
  hi: number | null;
}

/** pairedTest's answer: the questions and days it used, each figure's change, and the verdict. */
export interface PairedTest {
  n: number;
  days: number;
  mae: Paired;
  p90: Paired;
  early: Paired;
  verdict: 'better' | 'worse' | 'unclear' | 'too few days';
}

/**
 * Whether [method] beats the feed on [cases], over the days together rather
 * than day by day: a day has too few questions at a horizon to tell a real
 * gain from luck. The interval comes from resampling whole days (a bad day's
 * questions go wrong together, so resampling single questions would claim
 * too much), with a fixed seed, so the same cases give the same answer.
 *
 * Better: MAE's interval below zero, and neither p90 nor the share of early
 * buses shown to be worse. Worse: any of the three shown to be worse.
 * Otherwise unclear; and with fewer than PAIRED_MIN_DAYS days, too few days
 * to say. Cases without both answers are left out.
 */
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
  // mulberry32: small, seeded, and the same in every runtime.
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
