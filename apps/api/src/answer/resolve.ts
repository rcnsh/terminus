import type {
  Arrival,
  Candidate,
  Crowd,
  Graph,
  GraphIndex,
  Leg,
  Quality,
  ResolveInput,
  RouteIndex,
  ScoredOption,
  Stop,
  StopArrivals,
} from '../types.ts';
import { PUBLIC, RIDE, TRANSFER, WALK, isMeasured } from '../config.ts';
import type { TransferRoute } from './transfer.ts';
import { ROUTE_COLORS } from '../map/campus.ts';
import { haversineM } from '../geo.ts';
import { isPublic, publicRideS, rideMetres, svcName } from './public.ts';
import { buildingStops, footM, stopFootM } from './walk.ts';
import { footS, mins } from './format.ts';
import { listOf, m } from '../i18n.ts';
import { viaFrom } from './via.ts';
import { type Departure, FIRST_BUS_LEAD_S, type ServiceBoard, nextDeparture, serviceBoard } from './departures.ts';
import { type StoppedReason, headwayFor, inService, serviceClosedAt, serviceEndsAt, serviceResumesAt, stoppedReason } from './hours.ts';
import { type HomeWalk, atHome, residenceStops } from './residences.ts';
import { ON_TIME_SLACK_S } from '../timetable/profile.ts';

export { haversineM };

const indexCache = new WeakMap<Graph, GraphIndex>();

export function indexGraph(graph: Graph): GraphIndex {
  const hit = indexCache.get(graph);
  if (hit) return hit;

  const byCode = new Map<string, Stop>();
  for (const s of graph.stops) byCode.set(s.code, s);

  const routes = new Map<string, RouteIndex>();
  for (const [svc, raw] of Object.entries(graph.routes ?? {})) {
    let seq = raw.slice();
    const closes = seq.length > 2 && seq[0] === seq[seq.length - 1];
    const loop = graph.loops?.[svc] ?? closes;
    if (closes) seq = seq.slice(0, -1);
    const pos = new Map<string, number[]>();
    seq.forEach((code, i) => {
      const at = pos.get(code);
      if (at) at.push(i);
      else pos.set(code, [i]);
    });
    routes.set(svc, { seq, loop, pos });
  }

  const servingStop = new Map<string, string[]>();
  for (const [svc, r] of routes) {
    for (const code of new Set(r.seq)) {
      const at = servingStop.get(code);
      if (at) at.push(svc);
      else servingStop.set(code, [svc]);
    }
  }

  const idx: GraphIndex = { graph, byCode, routes, servingStop };
  indexCache.set(graph, idx);
  return idx;
}

export function legRideS(leg: Leg): number {
  return (leg.rideS ?? leg.hops * RIDE.secondsPerHop) + (leg.crossS ?? 0);
}

export function reach(idx: GraphIndex, svc: string, from: string, to: string): { hops: number; through?: true } | null {
  if (from === to) return { hops: 0 };
  const r = idx.routes.get(svc);
  if (!r) return null;
  const fromAt = r.pos.get(from);
  const toAt = r.pos.get(to);
  if (!fromAt || !toAt) return null;

  const origin = idx.graph.public?.[svc]?.origin;
  const endsAtFirst = origin === undefined || origin === r.seq[0];
  let best = Infinity;
  let through = false;
  const n = r.seq.length;
  for (const i of fromAt) {
    for (const j of toAt) {
      const hops = j > i ? j - i : r.loop ? j - i + n : Infinity;
      if (hops < best) {
        best = hops;
        through = j < i && (j > 0 || !endsAtFirst);
      }
    }
  }
  if (best === Infinity) return null;
  return through ? { hops: best, through: true } : { hops: best };
}

export function shuttleRideS(idx: GraphIndex, stops: string[], perHop: number): number {
  let s = 0;
  for (let k = 1; k < stops.length; k++) {
    const a = idx.byCode.get(stops[k - 1]);
    const b = idx.byCode.get(stops[k]);
    const m = a && b ? haversineM(a.lat, a.lon, b.lat, b.lon) : 0;
    s += Math.max(perHop, m / RIDE.longHopMs);
  }
  return Math.round(s);
}

export function rideStops(idx: GraphIndex, svc: string, from: string, to: string): string[] | null {
  const r = idx.routes.get(svc);
  if (!r?.pos.has(from) || !r.pos.has(to)) return from === to ? [from] : null;
  const span = rideSpan(idx, svc, from, to);
  if (!span) return null;
  return Array.from({ length: span.hops + 1 }, (_, k) => r.seq[(span.i + k) % r.seq.length]);
}

export function rideSpan(idx: GraphIndex, svc: string, from: string, to: string): { i: number; hops: number } | null {
  const r = idx.routes.get(svc);
  const fromAt = r?.pos.get(from);
  const toAt = r?.pos.get(to);
  if (!r || !fromAt || !toAt) return null;
  const n = r.seq.length;
  let best: { i: number; hops: number } | null = null;
  for (const i of fromAt) {
    for (const j of toAt) {
      const hops = j >= i ? j - i : r.loop ? j - i + n : Infinity;
      if (hops !== Infinity && (!best || hops < best.hops)) best = { i, hops };
    }
  }
  return best;
}

function homeWalk(input: ResolveInput): HomeWalk | null {
  if (input.homeWalkS == null || !input.preferStops?.length) return null;
  return { stops: input.preferStops, m: input.homeWalkS * (input.walkSpeedMs ?? WALK.speedMs) };
}

export interface Target {
  code: string;
  crossS: number;
  near?: true;
  walkS?: number;
  costS?: number;
}

export function nearStopWalks(graph: Graph, code: string, speed: number = WALK.speedMs): Record<string, number> | undefined {
  const idx = indexGraph(graph);
  const dest = idx.byCode.get(code);
  if (!dest) return undefined;
  const out: Record<string, number> = {};
  for (const s of graph.stops) {
    if (s.code === dest.code || s.code === dest.opposite || s.public) continue;
    if (haversineM(s.lat, s.lon, dest.lat, dest.lon) > WALK.nearStopM) continue;
    const m = stopFootM(s, dest);
    if (m <= WALK.nearStopM) out[s.code] = Math.round(m / speed);
  }
  return Object.keys(out).length ? out : undefined;
}

export function targetsFor(idx: GraphIndex, input: ResolveInput): Target[] {
  if (!input.to) return [];
  const speed = input.walkSpeedMs ?? WALK.speedMs;
  const out: Target[] = [input.to, ...(input.toAlso ?? [])].flatMap((code) => {
    const s = idx.byCode.get(code);
    if (!s) return [];
    const opp = s.opposite ? idx.byCode.get(s.opposite) : undefined;
    return [{ code, crossS: 0 }, ...(opp ? [{ code: opp.code, crossS: Math.round(stopFootM(opp, s) / speed) }] : [])];
  });
  const weight = input.walkWeight ?? WALK.sunWeight;
  for (const [code, walkS] of Object.entries(input.endWalkByStopS ?? {})) {
    if (idx.byCode.has(code) && !out.some((t) => t.code === code)) {
      out.push({ code, crossS: 0, near: true, walkS, costS: Math.round(walkS * weight) });
    }
  }
  return out;
}

export function bestLeg(graph: Graph, idx: GraphIndex, svc: string, fromCode: string, targets: Target[]): Leg | null {
  let best: { hops: number; crossS: number; code: string; rideS?: number; near?: true; costS?: number } | null = null;
  const pub = isPublic(graph, svc);
  const cost = (b: { hops: number; crossS: number; rideS?: number; costS?: number }) =>
    (b.rideS ?? b.hops * RIDE.secondsPerHop) + b.crossS + (b.costS ?? 0);
  const from = targets.find((t) => t.near && t.code === fromCode);
  for (const t of targets) {
    if (t.near && (t.code === fromCode || (from && t.walkS! >= from.walkS!))) continue;
    const r = reach(idx, svc, fromCode, t.code);
    if (!r) continue;
    const m = pub ? rideMetres(idx, svc, fromCode, t.code) : null;
    const stops = m === null ? rideStops(idx, svc, fromCode, t.code) : null;
    let rideS = m !== null ? publicRideS(m) : stops ? shuttleRideS(idx, stops, RIDE.secondsPerHop) : r.hops * RIDE.secondsPerHop;
    if (r.through) rideS += headwayFor(graph, svc);
    const cand = {
      hops: r.hops,
      crossS: t.crossS,
      code: t.code,
      ...(rideS !== r.hops * RIDE.secondsPerHop ? { rideS } : {}),
      ...(t.near ? { near: t.near, costS: t.costS } : {}),
    };
    if (!best || cost(cand) < cost(best)) best = cand;
  }
  if (!best) return null;
  return {
    svc,
    hops: best.hops,
    ...(best.rideS !== undefined ? { rideS: best.rideS } : {}),
    ...(best.crossS ? { crossS: best.crossS, off: idx.byCode.get(best.code)! } : {}),
    ...(best.near ? { off: idx.byCode.get(best.code)! } : {}),
    to: idx.byCode.get(best.code)!,
  };
}

function atStop(input: ResolveInput, idx: GraphIndex, stop: Stop): boolean {
  if (input.lat == null || input.lon == null) return false;
  const d = haversineM(input.lat, input.lon, stop.lat, stop.lon);
  if (d > WALK.atStopM) return false;
  const opp = stop.opposite ? idx.byCode.get(stop.opposite) : undefined;
  return !opp || haversineM(input.lat, input.lon, opp.lat, opp.lon) >= d;
}

const SLOW_RIDE = 2;

export function endWalkFromS(input: ResolveInput, code?: string): number {
  return input.endWalkByStopS?.[code ?? input.to ?? ''] ?? input.endWalkS ?? 0;
}

export function runsAt(graph: Graph, svc: string, atMs: number): 'yes' | 'maybe' | 'no' {
  if (inService(graph, svc, atMs)) return 'yes';
  const opens = serviceResumesAt(graph, svc, atMs);
  if (opens !== null && opens - atMs <= FIRST_BUS_LEAD_S * 1000) return 'maybe';
  const closed = serviceClosedAt(graph, svc, atMs);
  const idx = indexGraph(graph);
  const runS = shuttleRideS(idx, idx.routes.get(svc)?.seq ?? [], RIDE.secondsPerHop);
  return closed !== null && atMs - closed <= SLOW_RIDE * runS * 1000 ? 'maybe' : 'no';
}

export function likelyTripS(graph: Graph, input: ResolveInput, walkS: number, legs: Leg[], atMs?: number): number {
  const weight = input.walkWeight ?? WALK.sunWeight;
  let best = Infinity;
  for (const leg of legs) {
    const onFootS = (walkS + endWalkFromS(input, leg.to?.code)) * weight;
    const fareS = isPublic(graph, leg.svc) ? PUBLIC.fareWorthS : 0;
    best = Math.min(best, onFootS + headwayFor(graph, leg.svc, atMs) / 2 + legRideS(leg) + fareS);
  }
  return best;
}

export function candidateStops(graph: Graph, input: ResolveInput, opts: { any?: boolean; nowMs?: number } = {}): Candidate[] {
  const idx = indexGraph(graph);
  const { to } = input;

  const speed = input.walkSpeedMs ?? WALK.speedMs;
  const targets = targetsFor(idx, input);
  const targetCodes = new Set(targets.filter((t) => !t.near).map((t) => t.code));
  const legMemo = new Map<string, Leg[]>();
  const legsFrom = (stop: Stop): Leg[] => {
    let legs = legMemo.get(stop.code);
    if (!legs) {
      legs = (idx.servingStop.get(stop.code) ?? []).flatMap((svc) => bestLeg(graph, idx, svc, stop.code, targets) ?? []);
      legMemo.set(stop.code, legs);
    }
    return legs;
  };
  const reaches = (stop: Stop) => !to || (!targetCodes.has(stop.code) && (opts.any || legsFrom(stop).length > 0));

  let base: Array<{ stop: Stop; distM: number; footM: number; startS?: number }>;
  const hw = homeWalk(input);
  const home = input.lat != null && input.lon != null ? residenceStops(input.lat, input.lon, idx.byCode, hw) : null;
  const yours = Boolean(hw && atHome(input.lat, input.lon, hw.stops));

  const likeliest = <C extends { stop: Stop; footM: number }>(stops: C[]): C[] => {
    const { nowMs } = opts;
    const walks = new Map(stops.map((c) => [c, atStop(input, idx, c.stop) ? 0 : c.footM / speed]));
    const walkTo = (c: C) => walks.get(c)!;
    const frees = new Map(stops.map((c) => [c, legsFrom(c.stop).filter((l) => !isPublic(graph, l.svc))]));
    const free = (c: C) => frees.get(c)!;
    const through = (svc: string, from: Stop, off: string) => Boolean(reach(idx, svc, from.code, off)?.through);
    const sameBuses = (b: C, a: C) =>
      a !== b &&
      free(b).every((leg) => {
        const off = leg.to?.code ?? '';
        if (!free(a).some((l) => l.svc === leg.svc && l.to?.code === off)) return false;
        if (rideStops(idx, leg.svc, b.stop.code, off)?.includes(a.stop.code)) return walkTo(b) >= walkTo(a);
        if (through(leg.svc, a.stop, off) !== through(leg.svc, b.stop, off)) return false;
        const on = rideStops(idx, leg.svc, a.stop.code, off)?.includes(b.stop.code)
          ? rideStops(idx, leg.svc, a.stop.code, b.stop.code)
          : null;
        return on !== null && walkTo(b) >= walkTo(a) + SLOW_RIDE * shuttleRideS(idx, on, RIDE.secondsPerHop);
      });
    const [PUBLIC_ONLY, NOT_RUNNING] = [3, 4];
    const by = input.arriveBy;
    const ran = new Map<string, ReturnType<typeof runsAt>>();
    const runs = (svc: string, atMs: number) => {
      const key = `${svc}|${atMs}`;
      if (!ran.has(key)) ran.set(key, runsAt(graph, svc, atMs));
      return ran.get(key)!;
    };
    const sure = (leg: Leg): number => {
      if (nowMs === undefined) return 0;
      const onS = by ? (by.walkByStopS?.[leg.to?.code ?? ''] ?? by.venueWalkS) : 0;
      const boardMs = by ? Math.max(nowMs, by.atMs - (ON_TIME_SLACK_S + onS + legRideS(leg)) * 1000) : nowMs;
      const [then, now] = [runs(leg.svc, boardMs), runs(leg.svc, nowMs)];
      return then === 'yes' ? 0 : now === 'yes' ? 1 : then === 'maybe' || now === 'maybe' ? 2 : NOT_RUNNING;
    };
    const place = (c: C): { tier: number; s: number } | null => {
      const paid = legsFrom(c.stop).filter((l) => isPublic(graph, l.svc));
      const publicOnly = paid.length ? { tier: PUBLIC_ONLY, s: likelyTripS(graph, input, walkTo(c), paid, nowMs) } : null;
      const legs = c.stop.code !== input.step?.target?.stop && stops.some((a) => sameBuses(c, a)) ? [] : free(c);
      if (!legs.length) return publicOnly;
      const tiers = legs.map(sure);
      const tier = Math.min(...tiers);
      if (tier === NOT_RUNNING && publicOnly) return publicOnly;
      const surest = legs.filter((_, i) => tiers[i] === tier);
      const atMs = tier === 0 ? (by?.atMs ?? nowMs) : tier === NOT_RUNNING ? undefined : nowMs;
      return { tier, s: likelyTripS(graph, input, walkTo(c), surest, atMs) };
    };
    const placed = new Map<C, { tier: number; s: number }>();
    for (const c of stops) {
      const p = place(c);
      if (p) placed.set(c, p);
    }
    const byLikely = [...placed.keys()].sort((a, b) => placed.get(a)!.tier - placed.get(b)!.tier || placed.get(a)!.s - placed.get(b)!.s);
    const shuttle = byLikely.filter((c) => placed.get(c)!.tier !== PUBLIC_ONLY);
    const nearest = shuttle.reduce<C | undefined>((n, c) => (n && walkTo(n) <= walkTo(c) ? n : c), undefined);
    const first = (c: C) => c.stop.code === input.step?.target?.stop || c === nearest;
    const own = targets.filter((t) => !t.near);
    const there = (c: C) =>
      placed.get(c)!.tier === PUBLIC_ONLY ||
      (idx.servingStop.get(c.stop.code) ?? []).some(
        (svc) => !isPublic(graph, svc) && own.some((t) => reach(idx, svc, c.stop.code, t.code)),
      );
    let nearOnly = 0;
    return [...byLikely.filter(first), ...byLikely.filter((c) => !first(c))]
      .filter((c) => first(c) || there(c) || nearOnly++ < 1)
      .slice(0, WALK.maxCandidates);
  };
  if (home) {
    base = home;
  } else if (input.lat != null && input.lon != null) {
    const all = graph.stops
      .map((stop) => ({ stop, distM: haversineM(input.lat!, input.lon!, stop.lat, stop.lon) }))
      .sort((a, b) => a.distM - b.distM)
      .map((c) => ({ ...c, footM: footM(input.lat!, input.lon!, c.stop) }));
    const inRange = all.filter((c) => c.distM <= WALK.maxRadiusM);
    const byLikelyTrip = Boolean(to) && !opts.any;
    const inTrip = byLikelyTrip ? all.filter((c) => c.distM <= WALK.tripRadiusM) : inRange;
    const inside = buildingStops(input.lat, input.lon, idx.byCode);
    const shuttle = (inside ?? inTrip).filter((c) => !c.stop.public);
    const byBus = shuttle.filter((c) => reaches(c.stop));
    const picked = new Set(byLikelyTrip ? likeliest(byBus) : byBus.slice(0, WALK.maxCandidates));
    const near = byBus.filter((c) => picked.has(c));
    const publicOnly = inRange.find((c) => c.stop.public && reaches(c.stop));
    if (publicOnly) near.push(publicOnly);
    for (const code of input.preferStops ?? []) {
      const c = (inside ?? all).find((x) => x.stop.code === code);
      if (c && c.distM <= WALK.maxRadiusM && !near.includes(c)) near.push(c);
    }
    base = near.length ? near : shuttle.length ? shuttle.slice(0, 1) : all.slice(0, 1);
  } else {
    const stop = input.originCode ? idx.byCode.get(input.originCode) : undefined;
    if (!stop) return [];
    const startS = (code: string) => input.originWalkByStopS?.[code] ?? input.originWalkS ?? 0;
    const origins = [stop, ...(input.originAlso ?? []).flatMap((code) => idx.byCode.get(code) ?? [])];
    base = [];
    for (const s of origins)
      if (!base.some((b) => b.stop.code === s.code)) base.push({ stop: s, distM: 0, footM: 0, startS: startS(s.code) });
    for (const s of origins) {
      const opp = s.opposite ? idx.byCode.get(s.opposite) : undefined;
      if (opp && !base.some((b) => b.stop.code === opp.code)) {
        base.push({ stop: opp, distM: haversineM(s.lat, s.lon, opp.lat, opp.lon), footM: stopFootM(s, opp), startS: startS(s.code) });
      }
    }
    if (input.preferStops?.includes(stop.code)) {
      for (const code of input.preferStops) {
        const s = idx.byCode.get(code);
        if (s && !base.some((b) => b.stop.code === code)) base.push({ stop: s, distM: 0, footM: 0 });
      }
    }
  }

  const out: Candidate[] = base.map(({ stop, distM, footM: foot, startS }) => {
    const legs: Leg[] = !to
      ? (idx.servingStop.get(stop.code) ?? []).map((svc) => ({ svc, hops: 0 }))
      : targetCodes.has(stop.code)
        ? []
        : legsFrom(stop);
    if (!yours && atStop(input, idx, stop)) return { stop, distM, walkS: 0, here: true as const, legs };
    const walkS = input.lat != null ? Math.round(foot / speed) : (startS ?? input.originWalkS ?? 0) + Math.round(foot / speed);
    return { stop, distM, walkS, legs };
  });

  if (opts.any) return out;
  const useful = out.filter((c) => c.legs.length > 0);
  return useful.length ? useful : out.slice(0, 1);
}

export interface BoardRow {
  svc: string;
  etaS: number | null;
  quality: Quality;
  ambiguousBerth: boolean;
  paid?: true;
  later: { etaS: number; quality: Quality; eta: string }[];
  color: string | null;
  towards: string[];
  via: string[];
  crowd: Crowd | null;
  endsAt: string | null;
  running: boolean;
  stopped?: StoppedReason;
  resumesAt?: string | null;
  eta: string | null;
  laterText: string | null;
  toText: string;
}

interface NearbyTimes {
  at: string;
}

export type NearbyRow = Omit<BoardRow, 'later'> & {
  dest?: string;
  destPlace?: string | null;
  at: string | null;
  later: (BoardRow['later'][number] & NearbyTimes)[];
};

export const NEARBY_LATER = 2;

export function nearbyRow(r: BoardRow, nowMs: number, guessed: Departure[] = []): NearbyRow {
  const at = (etaS: number) => new Date(Math.round((nowMs + etaS * 1000) / 60_000) * 60_000).toISOString().replace('.000Z', 'Z');
  const later = [...r.later];
  if (r.running && r.etaS != null && !r.paid) {
    for (const d of guessed) {
      if (later.length >= NEARBY_LATER) break;
      if (d.kind !== 'estimate' || d.arrival) continue;
      if (d.opens) break;
      const etaS = Math.round((d.earliest - nowMs) / 1000);
      later.push({ etaS, quality: 'scheduled', eta: etaText(etaS, 'scheduled') });
    }
  }
  return {
    ...r,
    laterText: thenText(later),
    at: r.etaS == null ? null : at(r.etaS),
    later: later.map((b) => ({ ...b, at: at(b.etaS) })),
  };
}

export const THEN_MAX = 2;

export function etaText(etaS: number, quality: Quality): string {
  if (!approxQ(quality)) return mins(etaS);
  return m().approx(mins(Math.max(etaS, 60)));
}

const approxQ = (q: Quality): boolean => q === 'scheduled' || q === 'stale';

export function thenText(later: { etaS: number; quality: Quality }[]): string | null {
  if (!later.length) return null;
  const n = (s: number) => String(Math.max(1, Math.round(s / 60)));
  return m().thenMin(listOf(later.slice(0, THEN_MAX).map((x) => (approxQ(x.quality) ? m().approx(n(x.etaS)) : n(x.etaS)))));
}

export function towardsText(towards: string[]): string {
  if (!towards.length) return m().endsHere;
  return towards.length > 1 ? m().towardsTwo(towards[0], towards[1]) : m().towardsOne(towards[0]);
}

export const displayName = (stop: Stop | undefined, code: string): string => stop?.longName ?? stop?.name ?? code;

export function towardsFrom(idx: GraphIndex, svc: string, stopCode: string): string[] {
  const r = idx.routes.get(svc);
  const at = r?.pos.get(stopCode);
  if (!r || !at) return [];
  const nextOf = (i: number): number | null => (i + 1 < r.seq.length ? i + 1 : r.loop ? 0 : null);
  const n = nextOf(at[0]);
  if (n === null) return [];
  const next = r.seq[n];
  const end = r.loop ? r.seq[0] : r.seq[r.seq.length - 1];
  const codes = next === end ? [next] : [next, end];
  return codes.map((c) => displayName(idx.byCode.get(c), c));
}

const ONE_LINE_PLACE = 12;

export function nearbyDest(
  idx: GraphIndex,
  svc: string,
  stopCode: string,
  via: string[],
  towards: string[] = [],
): { dest: string; destPlace: string | null } {
  const here = (idx.servingStop.get(stopCode) ?? []).filter((k) => svcName(k) === svc);
  const same = (k: string) => towardsFrom(idx, k, stopCode).join('\u0000') === towards.join('\u0000');
  const key = idx.routes.has(svc) ? svc : (here.find(same) ?? here[0] ?? svc);
  const r = idx.routes.get(key);
  const at = r?.pos.get(stopCode);
  if (!r || !at) return { dest: towardsText(towardsFrom(idx, key, stopCode)), destPlace: null };
  const short = (c: string) => idx.byCode.get(c)?.name ?? c;
  const n = at[0] + 1 < r.seq.length ? at[0] + 1 : r.loop ? 0 : null;
  if (n === null) return { dest: m().endsHere, destPlace: null };
  const end = r.loop ? r.seq[0] : r.seq[r.seq.length - 1];
  const viaPlace = r.loop ? (via[0] ?? (end === stopCode ? short(r.seq[n]) : null)) : null;
  const raw = viaPlace ?? short(end);
  const place = raw.length <= ONE_LINE_PLACE ? raw.replaceAll(' ', '\u00a0') : raw;
  return { dest: viaPlace ? m().loopVia(place) : m().towardsOne(place), destPlace: place };
}

export const BOARD_GONE_S = 60;

export function boardAsOf(sas: (StopArrivals | undefined)[], nowMs: number): number {
  const times = sas.filter((sa): sa is StopArrivals => sa !== undefined && sa.available !== false).map((sa) => sa.fetchedAt);
  return times.length ? Math.min(nowMs, ...times) : nowMs;
}

export function boardAt(
  graph: Graph,
  idx: GraphIndex,
  stopCode: string,
  sa: StopArrivals | undefined,
  nowMs: number,
  opts: { stopped?: boolean; boards?: Map<string, ServiceBoard> } = {},
): BoardRow[] {
  const services = idx.servingStop.get(stopCode) ?? [];
  const out: BoardRow[] = [];

  for (const svc of services) {
    const sb = serviceBoard(graph, sa, svc, nowMs);
    opts.boards?.set(svc, sb);
    const { paid: pub, available, ambiguousBerth, stale, fetchedAt, live } = sb;
    const ageS = fetchedAt !== undefined && available ? Math.max(0, (nowMs - fetchedAt) / 1000) : 0;
    const etas = live
      .map((b) => b.arrival as Arrival & { etaS: number })
      .filter((a) => a.etaS - ageS >= -BOARD_GONE_S)
      .map((a) => ({ ...a, etaS: Math.max(0, Math.round(a.etaS - ageS)) }))
      .sort((a, b) => a.etaS - b.etaS);

    let quality: Quality;
    let etaS: number | null = null;
    if (etas.length) {
      quality = etas[0].scheduled ? 'scheduled' : 'live';
      etaS = etas[0].etaS;
    } else if (!inService(graph, svc, nowMs)) {
      if (!opts.stopped) continue;
      const resumes = serviceResumesAt(graph, svc, nowMs);
      out.push({
        svc: svcName(svc),
        etaS: null,
        quality: 'ended',
        ambiguousBerth: false,
        ...(pub ? { paid: true as const } : {}),
        later: [],
        color: ROUTE_COLORS[svcName(svc)] ?? null,
        towards: towardsFrom(idx, svc, stopCode),
        via: viaFrom(idx, svc, stopCode),
        crowd: null,
        endsAt: null,
        running: false,
        stopped: stoppedReason(graph, svc, nowMs) ?? 'ended',
        resumesAt: resumes === null ? null : new Date(resumes).toISOString(),
        eta: null,
        laterText: null,
        toText: towardsText(towardsFrom(idx, svc, stopCode)),
      });
      continue;
    } else if (!available) {
      quality = 'unknown';
    } else {
      quality = 'scheduled';
    }
    const aged = (q: Quality): Quality => (stale && q === 'live' ? 'stale' : q);
    quality = aged(quality);
    const later = etas.slice(1).map((a) => {
      const q = aged(a.scheduled ? 'scheduled' : 'live');
      return { etaS: a.etaS, quality: q, eta: etaText(a.etaS, q) };
    });
    const towards = towardsFrom(idx, svc, stopCode);

    const ends = serviceEndsAt(graph, svc, nowMs);
    out.push({
      svc: svcName(svc),
      etaS,
      quality,
      ambiguousBerth,
      ...(pub ? { paid: true as const } : {}),
      later,
      color: ROUTE_COLORS[svcName(svc)] ?? null,
      towards,
      via: viaFrom(idx, svc, stopCode),
      crowd: etas[0]?.crowd ?? null,
      endsAt: ends === null ? null : new Date(ends).toISOString(),
      running: true,
      eta: etaS === null ? null : etaText(etaS, quality),
      laterText: thenText(later),
      toText: towardsText(towards),
    });
  }

  out.sort(
    (a, b) =>
      Number(a.running === false) - Number(b.running === false) ||
      Number(a.paid === true) - Number(b.paid === true) ||
      Number(isMeasured(b.quality)) - Number(isMeasured(a.quality)) ||
      (a.etaS ?? Infinity) - (b.etaS ?? Infinity) ||
      a.svc.localeCompare(b.svc),
  );
  return out;
}

const SURE: Quality[] = ['unknown', 'scheduled', 'stale', 'live'];

export function worseOf(a: Quality, b: Quality): Quality {
  return SURE.indexOf(a) <= SURE.indexOf(b) ? a : b;
}

export interface ScoredLeg {
  boardS: number;
  rideS: number;
  quality: Quality;
  arrival: Arrival | null;
  bus: string;
  fetchedAt: number;
  opensInS: number;
  ambiguousBerth: boolean;
  paid: boolean;
}

export const readyS = (o: { walkS: number; here?: true }): number => (o.here ? -WALK.dwellS : o.walkS + WALK.boardBufferS);

export function scoreLeg(
  graph: Graph,
  leg: Leg,
  sa: StopArrivals | undefined,
  nowMs: number,
  earliestS: number,
  opts: { openBy?: number } = {},
): ScoredLeg | null {
  const sb = serviceBoard(graph, sa, leg.svc, nowMs);
  const fetchedAt = sb.fetchedAt ?? nowMs;
  const ageS = Math.max(0, (nowMs - fetchedAt) / 1000);
  const earliest = earliestS + ageS;
  const fromMs = fetchedAt + earliest * 1000;
  const sOf = (ms: number) => (ms - fetchedAt) / 1000;
  const available = sb.available;
  let opensInS = 0;
  const running = inService(graph, leg.svc, nowMs);

  const d = nextDeparture(graph, sb, leg.svc, fromMs, nowMs);
  if (!d) return null;
  if (d.opens) {
    if (running || opts.openBy === undefined || d.earliest > opts.openBy) return null;
    opensInS = Math.max(0, sOf(d.earliest) - earliest);
  }
  const boardS = sOf((d.earliest + d.latest) / 2);
  let quality: Quality = d.arrival ? (d.arrival.scheduled ? 'scheduled' : 'live') : !running || available ? 'scheduled' : 'unknown';
  const arrival = d.arrival ?? null;

  if (sb.stale && quality === 'live') quality = 'stale';

  return {
    boardS: Math.round(boardS - ageS),
    rideS: legRideS(leg),
    quality,
    arrival,
    bus: d.id,
    fetchedAt,
    opensInS,
    ambiguousBerth: sb.ambiguousBerth,
    paid: sb.paid,
  };
}

function rankCostS(o: ScoredOption, endWalk: (o: ScoredOption) => number, walkWeight: number): number {
  return (
    o.totalS + endWalk(o) + (walkWeight - 1) * footS(o, endWalk(o)) + (o.paid ? PUBLIC.fareWorthS : 0) + (o.change ? TRANSFER.worthS : 0)
  );
}

export function scoreOptions(
  graph: Graph,
  candidates: Candidate[],
  arrivalsByStop: Map<string, StopArrivals>,
  nowMs: number,
  endWalk: (o: ScoredOption) => number = () => 0,
  opts: { openBy?: number; transfers?: TransferRoute[]; walkWeight?: number } = {},
): ScoredOption[] {
  const out: ScoredOption[] = [];
  const legOpts = opts.openBy !== undefined ? { openBy: opts.openBy } : {};

  for (const r of opts.transfers ?? []) {
    const s1 = scoreLeg(graph, r.leg1, arrivalsByStop.get(r.origin.code), nowMs, readyS(r), legOpts);
    if (!s1) continue;
    const reachS = s1.boardS + s1.rideS;
    const s2 = scoreLeg(graph, r.leg2, arrivalsByStop.get(r.board.code), nowMs, reachS + r.crossS + TRANSFER.changeBufferS, legOpts);
    if (!s2) continue;
    out.push({
      stop: r.origin,
      svc: r.leg1.svc,
      distM: r.distM,
      walkS: r.walkS,
      ...(r.here ? { here: true as const } : {}),
      hops: r.leg1.hops + r.leg2.hops,
      boardS: s1.boardS,
      rideS: s1.rideS,
      totalS: s2.boardS + s2.rideS,
      quality: worseOf(s1.quality, s2.quality),
      arrival: s1.arrival,
      bus: s1.bus,
      fetchedAt: Math.min(s1.fetchedAt, s2.fetchedAt),
      fromMs: nowMs,
      ...(s1.opensInS > 0 ? { opensInS: Math.round(s1.opensInS) } : {}),
      ambiguousBerth: s1.ambiguousBerth || s2.ambiguousBerth,
      ...(r.leg2.off ? { off: r.leg2.off } : {}),
      ...(r.leg2.to ? { to: r.leg2.to } : {}),
      change: {
        at: r.at,
        stop: r.board,
        crossS: r.crossS,
        svc: r.leg2.svc,
        hops: r.leg2.hops,
        reachS,
        boardS: s2.boardS,
        rideS: s2.rideS,
        quality: s2.quality,
        arrival: s2.arrival,
        fetchedAt: s2.fetchedAt,
        ambiguousBerth: s2.ambiguousBerth,
      },
    });
  }

  for (const c of candidates) {
    const sa = arrivalsByStop.get(c.stop.code);
    for (const leg of c.legs) {
      const s = scoreLeg(graph, leg, sa, nowMs, readyS(c), legOpts);
      if (!s) continue;
      out.push({
        stop: c.stop,
        svc: leg.svc,
        distM: c.distM,
        walkS: c.walkS,
        ...(c.here ? { here: true as const } : {}),
        hops: leg.hops,
        boardS: s.boardS,
        rideS: s.rideS,
        totalS: s.boardS + s.rideS,
        quality: s.quality,
        arrival: s.arrival,
        bus: s.bus,
        fetchedAt: s.fetchedAt,
        fromMs: nowMs,
        ...(s.opensInS > 0 ? { opensInS: Math.round(s.opensInS) } : {}),
        ambiguousBerth: s.ambiguousBerth,
        ...(leg.off ? { off: leg.off } : {}),
        ...(leg.to ? { to: leg.to } : {}),
        ...(s.paid ? { paid: true as const } : {}),
      });
    }
  }

  const costS = (o: ScoredOption) => rankCostS(o, endWalk, opts.walkWeight ?? WALK.sunWeight);
  out.sort(
    (a, b) =>
      Number(isMeasured(b.quality)) - Number(isMeasured(a.quality)) ||
      costS(a) - costS(b) ||
      a.walkS - b.walkS ||
      a.svc.localeCompare(b.svc) ||
      (a.change?.svc ?? '').localeCompare(b.change?.svc ?? ''),
  );
  if (out[0]?.change) {
    const single = out.findIndex((o) => !o.change);
    if (single > 0 && out[single].quality !== 'unknown' && costS(out[single]) <= costS(out[0])) out.unshift(...out.splice(single, 1));
  }
  if (out[0]?.paid) {
    const free = out.findIndex((o) => !o.paid);
    if (free > 0 && out[free].quality !== 'unknown' && costS(out[free]) <= costS(out[0])) out.unshift(...out.splice(free, 1));
  }
  return out;
}

export function pickAlt(options: ScoredOption[]): ScoredOption | null {
  const best = options[0];
  if (!best) return null;
  if (best.change)
    return options.find((o) => !o.change) ?? options.find((o) => o.svc !== best.svc || o.change?.svc !== best.change?.svc) ?? null;
  const single = options.filter((o) => !o.change);
  return (
    single.find((o) => o.svc !== best.svc) ??
    single.find((o) => o.stop.code !== best.stop.code && o.totalS - best.totalS <= WALK.mentionWithinS) ??
    null
  );
}

export function confidence(
  options: ScoredOption[],
  hasCoords: boolean,
  endWalk: (o: ScoredOption) => number = () => 0,
  walkWeight: number = WALK.sunWeight,
): number {
  if (!options.length) return 0;
  const best = options[0];
  const ceiling = best.ambiguousBerth ? 0.5 : best.change ? 0.85 : 0.97;
  if (!hasCoords) return Math.min(0.75, ceiling);
  const other = options.find((o) => o.stop.code !== best.stop.code);
  if (!other) return Math.min(0.9, ceiling);
  const marginS = rankCostS(other, endWalk, walkWeight) - rankCostS(best, endWalk, walkWeight);
  return Math.round(Math.max(0.5, Math.min(ceiling, 0.5 + marginS / 600)) * 100) / 100;
}

export function nearestStop(graph: Graph, lat: number | null, lon: number | null): Stop | null {
  if (lat == null || lon == null) return null;
  let best: Stop | null = null;
  let bestD = Infinity;
  for (const stop of graph.stops) {
    const d = haversineM(lat, lon, stop.lat, stop.lon);
    if (d < bestD) {
      bestD = d;
      best = stop;
    }
  }
  return best;
}

export function walkAllTheWayS(
  graph: Graph,
  input: ResolveInput,
  fallbackFrom: Stop | null,
  destCode: string | null = input.to,
): number | null {
  const idx = indexGraph(graph);
  const dest = destCode ? idx.byCode.get(destCode) : null;
  if (!dest) return null;
  const speed = input.walkSpeedMs ?? WALK.speedMs;
  if (input.lat != null && input.lon != null) {
    const { lat, lon } = input;
    const home = residenceStops(lat, lon, idx.byCode, homeWalk(input)) ?? buildingStops(lat, lon, idx.byCode);
    if (home) {
      const via = Math.min(...home.map((h) => (h.stop.code === dest.code ? h.footM : h.footM + stopFootM(h.stop, dest))));
      return Math.round(Math.max(via, footM(lat, lon, dest)) / speed);
    }
    const near = graph.stops
      .map((stop) => ({ stop, d: haversineM(lat, lon, stop.lat, stop.lon) }))
      .filter((c) => c.d <= WALK.maxRadiusM)
      .sort((a, b) => a.d - b.d)
      .slice(0, WALK.maxCandidates);
    const via = near.map((c) => footM(lat, lon, c.stop) + (c.stop.code === dest.code ? 0 : stopFootM(c.stop, dest)));
    const direct = haversineM(lat, lon, dest.lat, dest.lon) <= WALK.maxRadiusM || !via.length ? [footM(lat, lon, dest)] : [];
    return Math.round(Math.min(...via, ...direct) / speed);
  }
  if (!fallbackFrom) return null;
  const from = [fallbackFrom, ...(input.originAlso ?? []).flatMap((code) => idx.byCode.get(code) ?? [])];
  return Math.min(
    ...from.map((s) => Math.round(stopFootM(s, dest) / speed) + (input.originWalkByStopS?.[s.code] ?? input.originWalkS ?? 0)),
  );
}

export function wholeWalk(graph: Graph, input: ResolveInput, fallbackFrom: Stop | null): { s: number; endS: number } | null {
  if (!input.to) return null;
  const endOf = (code: string) => endWalkFromS(input, code);
  let best: { s: number; endS: number } | null = null;
  for (const code of [input.to, ...(input.toAlso ?? [])]) {
    const s = walkAllTheWayS(graph, input, fallbackFrom, code);
    if (s !== null && (!best || s + endOf(code) < best.s + best.endS)) best = { s, endS: endOf(code) };
  }
  const { lat, lon, destAt } = input;
  if (lat != null && lon != null && destAt && haversineM(lat, lon, destAt.lat, destAt.lon) <= WALK.maxRadiusM) {
    const room = { code: input.to, lat: destAt.lat, lon: destAt.lon } as Stop;
    const s = Math.round(footM(lat, lon, room) / (input.walkSpeedMs ?? WALK.speedMs));
    if (!best || s < best.s + best.endS) best = { s, endS: 0 };
  }
  return best;
}
