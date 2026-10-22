/**
 * A second opinion on "the next D1 in 4 min", from how long the buses have
 * really taken: the feed's time, corrected for how it usually errs, blended
 * with the time the bus's own position says it needs, from history.
 *
 * - **History.** Every time a bus reached a stop (a Passing: eta.ts
 *   passingsOf on a timelapse day, or passingsFromReadings on the map's
 *   placed buses), the time to the next stop on its line is one segment.
 *   Their medians, by service and stop pair, and by weekday or weekend and
 *   Singapore hour where there are enough, are the SegmentTable.
 * - **Position.** A bus's last stop and when it passed it (busStates): the
 *   time still to go is the rest of its current segment, then each segment
 *   to the stop asked about (historicalEtaS). Gated, only for a bus on its
 *   way: not through a route's first stop, where buses wait for their
 *   departure time, nor for a bus held far past its segment's usual time.
 *   Each segment can take the times the buses just ahead drove it (recentS).
 * - **The feed.** Its own time, plus its usual error at that horizon for
 *   that service (bias), and the two blended by a weight per horizon
 *   (predictS). Without a position, or with no history for the stretch,
 *   it's the feed's time corrected; without the feed, history alone.
 *
 * Pure, with no I/O and nothing bigger than a Map: it runs in the Worker or
 * in a script (scripts/eta_backtest.mjs, which fits the model on some days
 * and scores it on later ones). Nothing in the answer path uses it yet: the
 * feed's own times stay what users see until a backtest on enough days says
 * this is better (docs/eta-model.md).
 */

import { HORIZONS, type Passing } from './eta.ts';
import { SGT_MS } from './config.ts';

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

/** Each bus's consecutive passings at adjacent stops of its route, as segments. */
export function segmentsOf(passings: (Passing & { seen?: number })[], routes: Record<string, Route>, lagMs = 0): Segment[] {
  const byBus = new Map<string, (Passing & { seen?: number })[]>();
  for (const p of passings) {
    const k = `${p.svc}|${p.plate}`;
    const list = byBus.get(k);
    if (list) list.push(p);
    else byBus.set(k, [p]);
  }
  const out: Segment[] = [];
  for (const list of byBus.values()) {
    list.sort((a, b) => a.t - b.t);
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

/** Median segment times: [count, median s], by stop pair and by stop pair and slot. */
export interface SegmentTable {
  v: 1;
  /** `svc|from|to` */
  all: Record<string, [number, number]>;
  /** `svc|from|to|wd|7` */
  slot: Record<string, [number, number]>;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The value at fraction [q] of the way up [xs] (nearest rank). */
export function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

function medians(groups: Map<string, number[]>): Record<string, [number, number]> {
  return Object.fromEntries([...groups].map(([k, xs]) => [k, [xs.length, Math.round(median(xs))]]));
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
  return { v: 1, all: medians(all), slot: medians(slot) };
}

export function buildTable(segments: Segment[]): SegmentTable {
  return tableOf([timesOf(segments)]);
}

/**
 * The time from [from] to [to] at [t]: the slot's median, pulled towards
 * the stop pair's overall median the fewer it has (SLOT_PRIOR). Null with
 * no history for the pair.
 */
export function segmentS(table: SegmentTable, svc: string, from: string, to: string, t: number): number | null {
  const k = `${svc}|${from}|${to}`;
  const all = table.all[k];
  if (!all) return null;
  const slot = table.slot[`${k}|${slotOf(t)}`];
  if (!slot) return all[1];
  return (slot[0] * slot[1] + SLOT_PRIOR * all[1]) / (slot[0] + SLOT_PRIOR);
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

/** How the walk to a stop is summed: see historicalEtaS. */
export interface HistoryOptions {
  /** Not through a route's first stop, where buses wait for their departure time. */
  gate?: boolean;
  /** Segments just driven, with these settings, beside history's medians. */
  recent?: { index: RecentIndex; at: number } & Recent;
}

/** The time from [from] to [to] at [t]: history's median, with the buses just ahead's (HistoryOptions.recent) where there are enough. */
function segmentWith(table: SegmentTable, svc: string, from: string, to: string, t: number, opts: HistoryOptions): number | null {
  const hist = segmentS(table, svc, from, to, t);
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

/** The whole model: the segment table, the feed's usual error, and the blend's weights. */
export interface EtaModel {
  v: 1;
  table: SegmentTable;
  /** The feed's median error, s (positive: the bus comes later than it says), by `svc|horizon` and `*|horizon`: [count, s]. */
  bias: Record<string, [number, number]>;
  /** Per horizon (HORIZONS), the weight on history against the corrected feed, 0 to 1. */
  weights: number[];
}

/** The feed's error at that horizon for that service, pulled towards every service's (BIAS_PRIOR). */
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
 * [history] is history alone; [gated], history through the layover gate,
 * and [recent], that with the buses just ahead (HistoryOptions), each the
 * feed's time where they can't answer, as they would be served; [blend],
 * the corrected feed with [recent]'s history.
 */
export interface Answers {
  feed: number | null;
  corrected: number | null;
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
  /** History's own answers, null where it couldn't: alone, gated, and gated with the buses just ahead (the blend's). */
  hist: { alone: number | null; gated: number | null; recent: number | null };
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
    const blended = predictS(model, q.svc, q.etaS, hist.recent);
    out.push({
      svc: q.svc,
      stop: q.stop,
      t: q.t,
      feedS: q.etaS,
      actualS: (came - q.t) / 1000,
      answers: { ...blended, history: hist.alone, gated: hist.gated ?? q.etaS, recent: hist.recent ?? q.etaS },
      hist,
    });
  }
  return out;
}

const WEIGHT_STEPS = 10;

/**
 * For each horizon, the blend's summed absolute error at each weight on
 * history from 0 to 1 in tenths, over the cases the blend's history (gated,
 * with the buses just ahead) could answer, and
 * how many there were. Sums add up across days, so a day's grid can be kept
 * and the weights fitted from many.
 */
export interface WeightGrid {
  sums: number[][];
  n: number[];
}

export function weightGrid(model: Pick<EtaModel, 'bias'>, cases: Case[]): WeightGrid {
  const sums = HORIZONS.map(() => Array.from({ length: WEIGHT_STEPS + 1 }, () => 0));
  const n = HORIZONS.map(() => 0);
  for (const c of cases) {
    const hist = c.hist.recent;
    if (hist === null) continue;
    const h = horizonOf(c.feedS);
    const corrected = Math.max(0, c.feedS + biasS(model, c.svc, c.feedS));
    n[h]++;
    for (let k = 0; k <= WEIGHT_STEPS; k++) {
      const w = k / WEIGHT_STEPS;
      sums[h][k] += Math.abs(c.actualS - (w * hist + (1 - w) * corrected));
    }
  }
  return { sums: sums.map((row) => row.map((x) => Math.round(x))), n };
}

/** Per horizon, the weight that erred least over [grids] together; 0 (the corrected feed) where none had a case. */
export function weightsFrom(grids: WeightGrid[]): number[] {
  return HORIZONS.map((_, h) => {
    if (!grids.some((g) => g.n[h] > 0)) return 0;
    let best = 0;
    let bestErr = Infinity;
    for (let k = 0; k <= WEIGHT_STEPS; k++) {
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

/** The feed's error at each horizon, per service and for all, from [cases]: [count, median s]. */
export function biasOf(errors: { svc: string; feedS: number; errS: number }[]): Record<string, [number, number]> {
  const groups = new Map<string, number[]>();
  for (const e of errors) {
    const h = horizonOf(e.feedS);
    push(groups, `${e.svc}|${h}`, e.errS);
    push(groups, `*|${h}`, e.errS);
  }
  return medians(groups);
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

/** How far off a set of answers was: absolute errors' mean and quantiles, and the mean signed error (positive: later than said). */
export interface ErrorStats {
  n: number;
  mae: number | null;
  p50: number | null;
  p90: number | null;
  bias: number | null;
}

export function errorStats(errs: number[]): ErrorStats {
  if (!errs.length) return { n: 0, mae: null, p50: null, p90: null, bias: null };
  const abs = errs.map(Math.abs);
  const r = (x: number) => Math.round(x * 10) / 10;
  return {
    n: errs.length,
    mae: r(abs.reduce((a, b) => a + b, 0) / abs.length),
    p50: r(quantile(abs, 0.5)),
    p90: r(quantile(abs, 0.9)),
    bias: r(errs.reduce((a, b) => a + b, 0) / errs.length),
  };
}

export const METHODS = ['feed', 'corrected', 'history', 'gated', 'recent', 'blend'] as const;
export type Method = (typeof METHODS)[number];

/**
 * Every method scored on the same cases, those every method could answer
 * (so history's gaps don't flatter or sink it), overall and by horizon
 * (by the feed's time). [coverage]: the share of cases history could answer.
 */
export function scoreCases(cases: Case[]): {
  coverage: number | null;
  overall: Record<Method, ErrorStats>;
  horizons: { label: string; stats: Record<Method, ErrorStats> }[];
} {
  const full = cases.filter((c) => METHODS.every((m) => c.answers[m] !== null));
  const statsFor = (cs: Case[]) =>
    Object.fromEntries(METHODS.map((m) => [m, errorStats(cs.map((c) => c.actualS - c.answers[m]!))])) as Record<Method, ErrorStats>;
  return {
    coverage: cases.length ? Math.round((full.length / cases.length) * 1000) / 1000 : null,
    overall: statsFor(full),
    horizons: HORIZONS.map((h, i) => ({ label: h.label, stats: statsFor(full.filter((c) => horizonOf(c.feedS) === i)) })),
  };
}
