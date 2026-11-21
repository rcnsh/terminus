import type { MeAnswer } from '../types.ts';
import { type Phase, type Plan, type TripRecord, seenOnBus, tripEnd } from './trip.ts';
import { haversineM } from '../geo.ts';
import { GRAPH } from './graph.ts';
import { indexGraph } from './resolve.ts';
import { headwayMs } from './departures.ts';
import { HOME_BY_MIN, LATE_GRACE_MIN } from '../timetable/profile.ts';

export const DUE_MS = 5 * 60_000;
export const WAIT_EARLY_MS = 15 * 60_000;
export const AT_STOP_M = 80;
export const RIDE_GRACE_MS = 10 * 60_000;
export const ASSUME_MS = 3 * 60_000;
export const CHANGE_GRACE_MS = 30_000;

export function secondLeavesMs(c: Plan): number | null {
  if (!c.board) return null;
  const at = Date.parse(c.board);
  if (!c.estimated) return at;
  return at + headwayMs(GRAPH, c.svc, at);
}

export interface Lookups {
  liveArrival(b: Plan): Promise<string | null>;
  secondBus(b: Plan): Promise<{ change: Plan; live: boolean }>;
  nextArrival(b: Plan): Promise<string | null>;
}

export type At = { lat: number | null; lon: number | null };

const NOWHERE: At = { lat: null, lon: null };

interface Where {
  located: boolean;
  decided: boolean;
  atStop(code: string): boolean;
  onBus(b: Plan, ms: number): boolean;
}

function whereOf({ lat, lon }: At): Where {
  const located = lat !== null && lon !== null;
  const notOn = new WeakSet<Plan>();
  const w: Where = {
    located,
    decided: false,
    atStop(code) {
      const s = located ? indexGraph(GRAPH).byCode.get(code) : undefined;
      const yes = s !== undefined && haversineM(lat!, lon!, s.lat, s.lon) <= AT_STOP_M;
      if (yes) w.decided = true;
      return yes;
    },
    onBus(b, ms) {
      if (!located || notOn.has(b)) return false;
      const yes = seenOnBus(b, lat!, lon!, ms);
      if (yes) w.decided = true;
      else notOn.add(b);
      return yes;
    },
  };
  return w;
}

export interface TripPlan {
  fresh: MeAnswer;
  answer: MeAnswer;
  bus: Plan | null;
}

export interface TripIn {
  at: At;
  rec?: TripRecord;
  home?: { lastEndMs: number; homeBy?: number; restsMs?: number | null } | null;
  classAtMs?: number | null;
  planned(): Promise<TripPlan>;
  seenBus?(): Promise<Plan | null>;
}

export type Aboard = { phase: 'riding' | 'waiting'; b: Plan; live: boolean };

export type OnBus = Aboard | 'missed' | null;

export type Verdict =
  | { kind: 'past' }
  | { kind: 'home' }
  | { kind: 'aboard'; on: OnBus }
  | { kind: 'there' }
  | { kind: 'held' }
  | { kind: 'missed' }
  | { kind: 'seen'; on: Aboard; seenNow: boolean }
  | { kind: 'gone'; phase: Phase }
  | { kind: 'plan'; phase: Phase };

export function phaseOf(v: Verdict): Phase {
  switch (v.kind) {
    case 'past':
    case 'home':
    case 'held':
      return 'idle';
    case 'aboard':
      return v.on === null ? 'arrived' : v.on === 'missed' ? 'missed' : v.on.phase;
    case 'there':
      return 'arrived';
    case 'missed':
      return 'missed';
    case 'seen':
      return v.on.phase;
    case 'gone':
    case 'plan':
      return v.phase;
  }
}

export function shown(v: Verdict): string {
  if (v.kind === 'past' || v.kind === 'home') return v.kind;
  const on = v.kind === 'aboard' || v.kind === 'seen' ? v.on : null;
  const bus = on && on !== 'missed' ? (on.b.change ? 'first' : 'last') : '';
  return `${phaseOf(v)}:${v.kind === 'gone' ? 'gone' : ''}:${bus}`;
}

export interface Clock {
  readonly ms: number;
  reached(atMs: number, leave?: boolean): boolean;
}

function noting(ms: number, noted: Map<number, boolean>): Clock {
  return {
    ms,
    reached(atMs, leave = false) {
      if (Number.isFinite(atMs) && atMs > ms) noted.set(atMs, noted.get(atMs) === true || leave);
      return ms >= atMs;
    },
  };
}

export const LEAVE_GAP_MS = 30_000;

export interface Change {
  at: number;
  leave: boolean;
  firm?: number;
}

const MAX_MOMENTS = 64;

class NotPlanned extends Error {}

const onlyNotPlanned =
  <T>(otherwise: T) =>
  (e: unknown): T => {
    if (e instanceof NotPlanned) return otherwise;
    throw e;
  };

async function changesOf<V>(
  decide: (c: Clock) => Promise<V>,
  nowMs: number,
  same: (a: V, b: V) => boolean,
): Promise<{ now: V; next: Change | null }> {
  const noted = new Map<number, boolean>();
  const now = await decide(noting(nowMs, noted));
  let next: Change | null = null;
  let was = now;
  for (let i = 0; noted.size; i++) {
    const at = Math.min(...noted.keys());
    const leave = noted.get(at)!;
    noted.delete(at);
    if (next && at >= nowMs + LEAVE_GAP_MS) break;
    if (i >= MAX_MOMENTS) return { now, next: next ?? { at, leave } };
    const more = new Map<number, boolean>();
    const then = await decide(noting(at, more)).catch(onlyNotPlanned(null));
    if (then === null || !same(was, then)) {
      if (next && !leave) return { now, next: { ...next, firm: at } };
      next ??= { at, leave };
      if (then === null || !leave) break;
      was = then;
    }
    for (const [m, l] of more) noted.set(m, noted.get(m) === true || l);
  }
  return { now, next };
}

function remembered(look: Lookups): { now: Lookups; later: Lookups } {
  const asked = new Map<string, Promise<unknown>>();
  const keyOf = (name: string, { seen: _seen, ...b }: Plan) => `${name}:${JSON.stringify(b)}`;
  const keep = <T>(name: string, b: Plan, ask: () => Promise<T>): Promise<T> => {
    const k = keyOf(name, b);
    if (!asked.has(k)) asked.set(k, ask());
    return asked.get(k) as Promise<T>;
  };
  const kept = <T>(name: string, b: Plan, otherwise: T): Promise<T> =>
    (asked.get(keyOf(name, b)) as Promise<T> | undefined) ?? Promise.resolve(otherwise);
  return {
    now: {
      liveArrival: (b) => keep('live', b, () => look.liveArrival(b)),
      secondBus: (b) => keep('second', b, () => look.secondBus(b)),
      nextArrival: (b) => keep('next', b, () => look.nextArrival(b)),
    },
    later: {
      liveArrival: (b) => kept('live', b, null),
      secondBus: (b) => kept('second', b, { change: b.change!, live: false }),
      nextArrival: (b) => kept('next', b, null),
    },
  };
}

export async function tripPhase(
  t: TripIn,
  nowMs: number,
  look: Lookups,
): Promise<{ verdict: Verdict; changesAt: Change | null; wakesAt: Change | null }> {
  const feed = remembered(look);
  let planned: Promise<TripPlan> | undefined;
  const asNow: TripIn = { ...t, planned: () => (planned ??= t.planned()) };
  let seenNow = false;
  const asLater: TripIn = {
    ...t,
    planned: async () => {
      if (!planned) throw new NotPlanned();
      const p = await planned;
      return seenNow && p.bus ? { ...p, bus: { ...p.bus, seen: true } } : p;
    },
    seenBus: async () => {
      const bus = planned ? (await planned).bus : null;
      return bus && (bus.seen || seenNow) ? bus : null;
    },
  };
  let first = true;
  const here = whereOf(t.at);
  const { now, next } = await changesOf(
    async (c) => {
      if (!first) return phaseAt(asLater, here, c, feed.later);
      first = false;
      const v = await phaseAt(asNow, here, c, feed.now, feed.later);
      seenNow = v.kind === 'seen' && v.seenNow;
      return v;
    },
    nowMs,
    (a, b) => shown(a) === shown(b),
  );
  if (!here.decided) return { verdict: now, changesAt: next, wakesAt: next };
  const nowhere = whereOf(NOWHERE);
  const wakesAt = await changesOf(
    (c) => phaseAt(asLater, nowhere, c, feed.later),
    nowMs,
    (a, b) => shown(a) === shown(b),
  )
    .then((r) => r.next)
    .catch(onlyNotPlanned(next));
  return { verdict: now, changesAt: next, wakesAt };
}

export async function answerPhase(
  a: MeAnswer,
  rec: TripRecord | undefined,
  at: At,
  nowMs: number,
): Promise<{ phase: Phase; changesAt: Change | null; wakesAt: Change | null }> {
  const end = rec?.kind === 'boarded' && rec.boarded ? tripEnd(rec.boarded) : null;
  const from = (w: Where) =>
    changesOf(
      async (c) => (end === null ? phaseFor(a, rec, c, w) : c.reached(Date.parse(end) + RIDE_GRACE_MS) ? 'arrived' : 'riding'),
      nowMs,
      (x, y) => x === y,
    );
  const here = whereOf(at);
  const { now, next } = await from(here);
  const wakesAt = here.decided ? (await from(whereOf(NOWHERE))).next : next;
  return { phase: now, changesAt: next, wakesAt };
}

async function phaseAt(t: TripIn, w: Where, c: Clock, look: Lookups, known: Lookups = look): Promise<Verdict> {
  if (t.classAtMs != null && c.reached(t.classAtMs + LATE_GRACE_MIN * 60_000)) return { kind: 'past' };
  if (t.home?.restsMs != null && c.reached(t.home.restsMs)) return { kind: 'past' };
  if (t.home && w.located) w.decided = true;
  else if (t.home) {
    const by = t.home.homeBy ?? t.home.lastEndMs + HOME_BY_MIN * 60_000;
    const onIt = t.rec?.kind === 'boarded' ? (t.rec.boarded ?? null) : t.rec ? null : ((await t.seenBus?.()) ?? null);
    const there = onIt ? await knownArrival(onIt, known) : null;
    if (c.reached(there === null ? by : Math.max(by, there))) return { kind: 'home' };
  }
  if (t.rec?.kind === 'boarded' && t.rec.boarded) return { kind: 'aboard', on: await onBus(t.rec.boarded, w, c, look) };

  const { fresh, answer, bus } = await t.planned();
  if (fresh.arrived && t.classAtMs != null && !c.reached(t.classAtMs)) return { kind: 'there' };
  if (t.home && !t.rec && !c.reached(t.home.lastEndMs)) return { kind: 'held' };

  if (!t.rec && bus?.board && !answer.arrived && c.reached(Date.parse(bus.board) + ASSUME_MS)) {
    if (phaseFor(answer, undefined, c, w) === 'waiting') return { kind: 'missed' };
    const onSecond = (b: Plan) => Boolean(b.change?.board && c.reached(Date.parse(b.change.board)) && w.onBus(b.change, c.ms));
    const seenNow = !bus.seen && w.located && (w.onBus(bus, c.ms) || onSecond(bus));
    if (bus.seen || seenNow) {
      const on = await onBus(bus, w, c, look);
      if (on && on !== 'missed') return { kind: 'seen', on, seenNow };
    }
    const phase = phaseFor(fresh, undefined, c, w);
    return { kind: 'gone', phase: phase === 'idle' || phase === 'due' ? 'heading' : phase };
  }
  return { kind: 'plan', phase: phaseFor(answer, t.rec, c, w) };
}

function phaseFor(a: MeAnswer, rec: TripRecord | undefined, c: Clock, w: Where): Phase {
  if (a.arrived) return 'arrived';
  if (rec?.kind === 'boarded') return 'riding';
  if (rec?.kind === 'missed') return 'missed';
  if (rec?.kind === 'arrived') return 'arrived';
  const leaveAt = a.leave?.at ? Date.parse(a.leave.at) : null;
  const code = a.leave?.stopCode ?? a.stop.code;
  if (code && a.leave?.svc && w.atStop(code) && (leaveAt === null || c.reached(leaveAt - WAIT_EARLY_MS, true))) return 'waiting';
  if (rec?.kind === 'left') return 'heading';
  if (leaveAt === null) return 'idle';
  if (c.reached(leaveAt, true)) return 'heading';
  if (c.reached(leaveAt - DUE_MS, true)) return 'due';
  return 'idle';
}

async function onBus(b: Plan, w: Where, c: Clock, look: Lookups): Promise<OnBus> {
  const second = b.change;
  if (second) {
    const leaves = secondLeavesMs(second);
    const before = leaves === null || !c.reached(leaves + CHANGE_GRACE_MS);
    const live = before ? await liveBy(b, c, look) : null;
    if (live !== null || !b.arrive || !c.reached(Date.parse(b.arrive)))
      return { phase: 'riding', b: live ? { ...b, arrive: live } : b, live: live !== null };
    const fed = await look.secondBus(b);
    const cur = { ...b, change: fed.change };
    const gone = secondLeavesMs(fed.change);
    if (gone === null || !c.reached(gone + CHANGE_GRACE_MS)) return { phase: 'waiting', b: cur, live: fed.live };
    if (second.stopCode && w.atStop(second.stopCode) && c.reached(gone + ASSUME_MS)) return 'missed';
    return onBus(fed.change, w, c, look);
  }
  const live = await liveBy(b, c, look);
  const arrive = live ?? b.arrive;
  if (arrive === null || !c.reached(Date.parse(arrive)))
    return { phase: 'riding', b: live ? { ...b, arrive: live } : b, live: live !== null };
  if (c.reached(Date.parse(arrive) + RIDE_GRACE_MS)) return null;
  return { phase: 'riding', b: { ...b, arrive: await look.nextArrival(b) }, live: false };
}

async function knownArrival(b: Plan, known: Lookups): Promise<number | null> {
  const last = b.change ? (await known.secondBus(b)).change : b;
  const live = await known.liveArrival(last);
  return live === null ? null : Date.parse(live);
}

async function liveBy(b: Plan, c: Clock, look: Lookups): Promise<string | null> {
  const live = await look.liveArrival(b);
  return live !== null && !c.reached(Date.parse(live)) ? live : null;
}
