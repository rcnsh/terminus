/**
 * Direction resolution.
 *
 * NUS stops come in directional pairs metres apart ("Kent Ridge MRT" / "Opp
 * Kent Ridge MRT"). That gap is inside GPS error near dense buildings, so
 * picking the nearer stop is wrong roughly half the time -- and it is the
 * specific wrong answer that makes you miss a bus you can see.
 *
 * So: never rank by distance. Rank by whether the destination is genuinely
 * downstream in the scraped route sequence, and score walking and riding in
 * the same unit (seconds) so the trade-off is legible.
 */

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

/** Riding, plus the walk back across the road when the bus stops on the far side. */
export function legRideS(leg: Leg): number {
  return (leg.rideS ?? leg.hops * RIDE.secondsPerHop) + (leg.crossS ?? 0);
}

/**
 * Is `to` genuinely downstream of `from` on `svc`?
 *
 * Linear route: only if it comes later in the sequence. Loop route: always,
 * by wrapping -- but the hop count blows up, and the scorer converts hops to
 * seconds, so riding the wrong way round loses on cost rather than on a
 * special case. Returns null when unreachable.
 *
 * `through` when the ride goes on past the loop's terminal: the run ends
 * there (the feed lists a shuttle's under an -E berth, and a public loop
 * ends at its interchange), so it's the next run on from there, not the
 * same bus. A shuttle loop starts at its terminal; a public one's
 * interchange can be off campus, between its last campus stop and its first.
 */
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
        // Wrapping round to the terminal itself is getting off there; to any stop after it, riding on.
        through = j < i && (j > 0 || !endsAtFirst);
      }
    }
  }
  if (best === Infinity) return null;
  return through ? { hops: best, through: true } : { hops: best };
}

/**
 * Seconds riding `svc` along `stops`: `perHop` a stop, but no faster than
 * RIDE.longHopMs over a long one. Route P's stops are kilometres apart
 * (Kent Vale to the Bukit Timah campus), where a count of stops says
 * minutes for a ride of a quarter of an hour.
 */
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

/**
 * The stops ridden on `svc` from `from` to `to`, both included, the same way
 * round as `reach` counts them (the fewest hops, wrapping on a loop). Null
 * when `to` isn't downstream.
 */
export function rideStops(idx: GraphIndex, svc: string, from: string, to: string): string[] | null {
  const r = idx.routes.get(svc);
  if (!r?.pos.has(from) || !r.pos.has(to)) return from === to ? [from] : null;
  const span = rideSpan(idx, svc, from, to);
  if (!span) return null;
  return Array.from({ length: span.hops + 1 }, (_, k) => r.seq[(span.i + k) % r.seq.length]);
}

/**
 * Where on `svc`'s route a ride from `from` to `to` starts (the index in its
 * stop sequence) and how many hops it takes, as rideStops counts them.
 */
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

/** The user's walk from home to their home stops, in metres at their pace, when they've said it. */
function homeWalk(input: ResolveInput): HomeWalk | null {
  if (input.homeWalkS == null || !input.preferStops?.length) return null;
  return { stops: input.preferStops, m: input.homeWalkS * (input.walkSpeedMs ?? WALK.speedMs) };
}

/** A stop a trip can end at, and the walk across the road from it when it's the opposite stop. */
export interface Target {
  code: string;
  crossS: number;
  /** A stop near the destination (`nearStopWalks`): somewhere to get off and walk on, not to be. */
  near?: true;
  /** Near: the walk on from it, in seconds, and what that walk counts for in choosing (weighted). */
  walkS?: number;
  costS?: number;
}

/**
 * Going to a stop itself, the other stops within WALK.nearStopM of it on
 * foot (the routed walk), with the walk from each in seconds: a bus that
 * passes close by gets you there too. Callers pass it as `endWalkByStopS`
 * for a stop, never for home or a room, which have their own stops.
 */
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

/**
 * Every stop that serves the destination, and the far side of each road.
 * Either side will do: arriving at "Opp UHC" gets you to UHC. Without this,
 * a route that only serves the far side never counts, and the answer takes
 * a longer bus to the exact stop. Getting off on the far side costs the walk
 * back across, which is part of the journey.
 *
 * Any other stop with a walk on from it (`endWalkByStopS`: a stop near the
 * destination, from nearStopWalks) is one too, its walk weighted as walking
 * is in choosing where to get off.
 */
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

/**
 * `svc` from `fromCode` to whichever target gets you there soonest, the
 * walk across the road included; null when it goes to none of them.
 */
export function bestLeg(graph: Graph, idx: GraphIndex, svc: string, fromCode: string, targets: Target[]): Leg | null {
  let best: { hops: number; crossS: number; code: string; rideS?: number; near?: true; costS?: number } | null = null;
  // A public bus rides by the metres along its route (public.ts): its
  // campus stops can be a long way round the island apart.
  const pub = isPublic(graph, svc);
  const cost = (b: { hops: number; crossS: number; rideS?: number; costS?: number }) =>
    (b.rideS ?? b.hops * RIDE.secondsPerHop) + b.crossS + (b.costS ?? 0);
  // Already near: a bus is worth it only to a stop with a shorter walk on.
  const from = targets.find((t) => t.near && t.code === fromCode);
  for (const t of targets) {
    if (t.near && (t.code === fromCode || (from && t.walkS! >= from.walkS!))) continue;
    const r = reach(idx, svc, fromCode, t.code);
    if (!r) continue;
    const m = pub ? rideMetres(idx, svc, fromCode, t.code) : null;
    const stops = m === null ? rideStops(idx, svc, fromCode, t.code) : null;
    let rideS = m !== null ? publicRideS(m) : stops ? shuttleRideS(idx, stops, RIDE.secondsPerHop) : r.hops * RIDE.secondsPerHop;
    // Past the terminal it's the next run: about a headway's wait there.
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
    // A stop near the destination is where to get off too; the walk on is the trip's end walk.
    ...(best.near ? { off: idx.byCode.get(best.code)! } : {}),
    to: idx.byCode.get(best.code)!,
  };
}

/**
 * Located at `stop` (WALK.atStopM), on its side of the road: the stop
 * across is a crossing away, however close it looks.
 */
function atStop(input: ResolveInput, idx: GraphIndex, stop: Stop): boolean {
  if (input.lat == null || input.lon == null) return false;
  const d = haversineM(input.lat, input.lon, stop.lat, stop.lon);
  if (d > WALK.atStopM) return false;
  const opp = stop.opposite ? idx.byCode.get(stop.opposite) : undefined;
  return !opp || haversineM(input.lat, input.lon, opp.lat, opp.lon) >= d;
}

/**
 * How many times its usual ride a bus may take, where a stop is ruled out
 * on it: RIDE.secondsPerHop is a guess, and a bus waits at a stop.
 */
const SLOW_RIDE = 2;

/** The walk on from the stop a bus drops you at (`code`; the destination's own, without one) to the place itself, s. */
export function endWalkFromS(input: ResolveInput, code?: string): number {
  return input.endWalkByStopS?.[code ?? input.to ?? ''] ?? input.endWalkS ?? 0;
}

/**
 * Whether `svc` has buses at `atMs`, by its hours: 'yes' when it's running;
 * 'maybe' just outside them, when the feed can still list one (and a time
 * from the feed is a bus, scoreLeg): about to start, as beforeOpening
 * believes its first buses, or stopped so lately that its last bus may
 * still be out on a slow run; else 'no'. Only for the order stops are asked
 * about in: whether a bus comes is the feed's to say.
 */
export function runsAt(graph: Graph, svc: string, atMs: number): 'yes' | 'maybe' | 'no' {
  if (inService(graph, svc, atMs)) return 'yes';
  const opens = serviceResumesAt(graph, svc, atMs);
  if (opens !== null && opens - atMs <= FIRST_BUS_LEAD_S * 1000) return 'maybe';
  const closed = serviceClosedAt(graph, svc, atMs);
  const idx = indexGraph(graph);
  const runS = shuttleRideS(idx, idx.routes.get(svc)?.seq ?? [], RIDE.secondsPerHop);
  return closed !== null && atMs - closed <= SLOW_RIDE * runS * 1000 ? 'maybe' : 'no';
}

/**
 * How long the trip from a stop is likely to take, s, before anything is
 * fetched: the walk to it (`walkS`), half a headway's wait, the ride, and the
 * walk on from where the bus drops you, each second on foot weighted and a
 * fare counted as the ranking does (rankCostS). The best of `legs`, each by
 * its headway at `atMs` (its usual one, without); Infinity with none.
 */
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

/**
 * Stops worth fetching arrivals for. Bounded by WALK.maxCandidates so one
 * request never fans out into a dozen upstream calls.
 *
 * With a location and a destination, those are the stops in range
 * (WALK.tripRadiusM) likeliest to get you there soonest, worked out from the
 * route data alone (likelyTripS), not the nearest: a stop a minute further
 * on, or across the road, often has the bus that goes straight there.
 * `nowMs` puts the stops whose shuttles are running first.
 *
 * `any`: the stops near you whether or not a bus from them goes there, with
 * the legs that do (often none). Where no single bus does, these are where a
 * trip with a change of bus can start (transfer.ts).
 */
export function candidateStops(graph: Graph, input: ResolveInput, opts: { any?: boolean; nowMs?: number } = {}): Candidate[] {
  const idx = indexGraph(graph);
  const { to } = input;

  const speed = input.walkSpeedMs ?? WALK.speedMs;
  const targets = targetsFor(idx, input);
  // Where you'd be there already: a stop near it is still somewhere to get on.
  const targetCodes = new Set(targets.filter((t) => !t.near).map((t) => t.code));
  // Each stop's buses there, worked out once: where to get off is the stop
  // that gets you there soonest, crossing included (bestLeg).
  const legMemo = new Map<string, Leg[]>();
  const legsFrom = (stop: Stop): Leg[] => {
    let legs = legMemo.get(stop.code);
    if (!legs) {
      legs = (idx.servingStop.get(stop.code) ?? []).flatMap((svc) => bestLeg(graph, idx, svc, stop.code, targets) ?? []);
      legMemo.set(stop.code, legs);
    }
    return legs;
  };
  // A stop worth a fetch: some bus from it goes there, or to a stop near it
  // (any stop, with no destination).
  const reaches = (stop: Stop) => !to || (!targetCodes.has(stop.code) && (opts.any || legsFrom(stop).length > 0));

  // `startS`: without coordinates, the walk to where `footM` starts from.
  let base: Array<{ stop: Stop; distM: number; footM: number; startS?: number }>;
  const hw = homeWalk(input);
  const home = input.lat != null && input.lon != null ? residenceStops(input.lat, input.lon, idx.byCode, hw) : null;
  // In the residence you live in, the walk to your stop is the one you set.
  const yours = Boolean(hw && atHome(input.lat, input.lon, hw.stops));

  // Of the stops in range with a bus there, the few to ask the feed about:
  // the likeliest to get you there soonest (likelyTripS), not the nearest.
  const likeliest = <C extends { stop: Stop; footM: number }>(stops: C[]): C[] => {
    const { nowMs } = opts;
    const walks = new Map(stops.map((c) => [c, atStop(input, idx, c.stop) ? 0 : c.footM / speed]));
    const walkTo = (c: C) => walks.get(c)!;
    const frees = new Map(stops.map((c) => [c, legsFrom(c.stop).filter((l) => !isPublic(graph, l.svc))]));
    const free = (c: C) => frees.get(c)!;
    // Not a stop where you'd only catch shuttles you can catch at another, a
    // shorter walk away: every one from `b` calls at `a` too, and any of
    // them you'd be at `b` for you'd be at `a` for. Up the line from `a`,
    // that's whenever `b` is the longer walk. Down the line, when walking to
    // `b` takes at least the walk to `a` and SLOW_RIDE times the bus's usual
    // ride on from it (less, and you might just make at `b` a bus missed at
    // `a`), and never past the terminal: a run starts there whatever has
    // pulled in.
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
    // How sure a shuttle leg's bus is, with the time known: 0 running when
    // you'd ride it (now, or by a class's latest board, as its leave-by
    // counts it: leave.ts), 1 running now though not for the class (the one
    // to go by now), 2 just outside its hours at either time, when the feed
    // may still list one. NOT_RUNNING otherwise: the hours are a table kept
    // by hand, so the feed is still asked where a place is spare.
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
    // Where a stop comes among the rest: by its surest shuttles first, then
    // by how long the trip on one of those is likely to take. A stop with
    // only a public bus there, or only shuttles another stop has, comes
    // after every stop with a shuttle that has buses: public buses add to
    // the answer and never push a free bus out of it.
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
    // First, whatever the others look like: the stop of a bus you chose
    // (step.ts), and the stop you're standing at or else the nearest. Its
    // bus may be the one pulling in, and it's the one you're most likely
    // walking to, which mustn't drop out of the answer on the way. Then the
    // likeliest, and of those the ones none of whose shuttles call at the
    // destination itself take one place between them, so a stop with a bus
    // there has one whenever there is such a stop.
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
    // Range is the straight line; the walk itself follows the paths.
    const all = graph.stops
      .map((stop) => ({ stop, distM: haversineM(input.lat!, input.lon!, stop.lat, stop.lon) }))
      .sort((a, b) => a.distM - b.distM)
      .map((c) => ({ ...c, footM: footM(input.lat!, input.lon!, c.stop) }));
    const inRange = all.filter((c) => c.distM <= WALK.maxRadiusM);
    // Picked by their likely trip, from further off: only there can a longer walk be shown to pay.
    const byLikelyTrip = Boolean(to) && !opts.any;
    const inTrip = byLikelyTrip ? all.filter((c) => c.distM <= WALK.tripRadiusM) : inRange;
    // In a building, its shuttle stops by the paths from it: the straight
    // line can cross a hill or a road nobody crosses (buildingStops).
    const inside = buildingStops(input.lat, input.lon, idx.byCode);
    // A few shuttle stops that go there, and the nearest stop only public
    // buses call at as one more: turning public buses on adds options and
    // never crowds a shuttle stop out of the answer. A stop no bus to the
    // destination calls at would only take a fetch and push out one that does.
    const shuttle = (inside ?? inTrip).filter((c) => !c.stop.public);
    const byBus = shuttle.filter((c) => reaches(c.stop));
    const picked = new Set(byLikelyTrip ? likeliest(byBus) : byBus.slice(0, WALK.maxCandidates));
    const near = byBus.filter((c) => picked.has(c));
    const publicOnly = inRange.find((c) => c.stop.public && reaches(c.stop));
    if (publicOnly) near.push(publicOnly);
    // A user's usual stops (near home) join the set when in range, so a dense
    // cluster of closer stops cannot push out the one they actually use.
    for (const code of input.preferStops ?? []) {
      const c = (inside ?? all).find((x) => x.stop.code === code);
      if (c && c.distM <= WALK.maxRadiusM && !near.includes(c)) near.push(c);
    }
    // Never answer "no stop nearby" -- degrade to the nearest one, however far.
    base = near.length ? near : shuttle.length ? shuttle.slice(0, 1) : all.slice(0, 1);
  } else {
    const stop = input.originCode ? idx.byCode.get(input.originCode) : undefined;
    if (!stop) return [];
    // Starting from home: the walk to the stop decides which bus is catchable.
    // From a room more than one stop serves, each of them, with its own walk
    // from the room: the nearer stop's bus isn't always the one to take.
    const startS = (code: string) => input.originWalkByStopS?.[code] ?? input.originWalkS ?? 0;
    const origins = [stop, ...(input.originAlso ?? []).flatMap((code) => idx.byCode.get(code) ?? [])];
    base = [];
    for (const s of origins)
      if (!base.some((b) => b.stop.code === s.code)) base.push({ stop: s, distM: 0, footM: 0, startS: startS(s.code) });
    // The far side of the road, a crossing further: the bus you want may
    // only call there, and nothing says which side you'll come out on.
    for (const s of origins) {
      const opp = s.opposite ? idx.byCode.get(s.opposite) : undefined;
      if (opp && !base.some((b) => b.stop.code === opp.code)) {
        base.push({ stop: opp, distM: haversineM(s.lat, s.lon, opp.lat, opp.lon), footM: stopFootM(s, opp), startS: startS(s.code) });
      }
    }
    // From home, every home stop: the walk from home (originWalkS) is to each.
    if (input.preferStops?.includes(stop.code)) {
      for (const code of input.preferStops) {
        const s = idx.byCode.get(code);
        if (s && !base.some((b) => b.stop.code === code)) base.push({ stop: s, distM: 0, footM: 0 });
      }
    }
  }

  const out: Candidate[] = base.map(({ stop, distM, footM: foot, startS }) => {
    // Standing at the destination is not a boarding option. reach() returns
    // 0 hops for from === to, which would otherwise rank first every time.
    const legs: Leg[] = !to
      ? (idx.servingStop.get(stop.code) ?? []).map((svc) => ({ svc, hops: 0 }))
      : targetCodes.has(stop.code)
        ? []
        : legsFrom(stop);
    // Starting from home or a room without coordinates: that walk comes
    // first, and a crossing to the far side's stop after it.
    // Standing at the stop by where the phone is, there's no walk to it:
    // a few metres of GPS drift mustn't cost you the bus pulling in. Not
    // inside the residence you live in: there the walk is from your room
    // (residences.ts), which a fix by the stop can't see.
    if (!yours && atStop(input, idx, stop)) return { stop, distM, walkS: 0, here: true as const, legs };
    const walkS = input.lat != null ? Math.round(foot / speed) : (startS ?? input.originWalkS ?? 0) + Math.round(foot / speed);
    return { stop, distM, walkS, legs };
  });

  if (opts.any) return out;
  const useful = out.filter((c) => c.legs.length > 0);
  // If nothing here reaches the destination, keep the nearest stop so the
  // formatter can still offer a walk instead of a blank tile.
  return useful.length ? useful : out.slice(0, 1);
}

export interface BoardRow {
  /** What's on the bus ("D2", "151"). */
  svc: string;
  /** Seconds until arrival. null means "no live time to show", never 0. */
  etaS: number | null;
  quality: Quality;
  ambiguousBerth: boolean;
  /** A public bus, with a fare. Absent for a shuttle. */
  paid?: true;
  /** The buses after that one, soonest first, as far as the feed knows them,
   *  each with its time in words (`eta`, as the row's). */
  later: { etaS: number; quality: Quality; eta: string }[];
  /** The service's colour (#rrggbb), as on the buses; null for one NUS hasn't painted. */
  color: string | null;
  /** Where it goes from here: the next stop's name, then the stop the route
   *  ends at. One name when they're the same; none at the end of the line. */
  towards: string[];
  /** The well-known places it passes from here, in order, up to three
   *  ("UTown", "Kent Ridge MRT"; via.ts), for someone who doesn't know the
   *  routes yet. Empty when it passes none. */
  via: string[];
  /** How full the first bus is, from the feed; null when it doesn't say. */
  crowd: Crowd | null;
  /** When the service stops running today (ISO); null when its hours are unknown or it's outside them. */
  endsAt: string | null;
  /** False only on a row for a service outside its hours, listed when asked for (`stopped`). */
  running: boolean;
  /** Why it isn't running. Only on a row that isn't. */
  stopped?: StoppedReason;
  /** When it next starts (ISO), or null when no start is found. Only on a row that isn't running. */
  resumesAt?: string | null;
  /** `etaS` in words: "4 min", "now", "~6 min" for a timetable or stale time. Null with no time. */
  eta: string | null;
  /** The next few buses after it: "then 12, ~20 min". Null when the feed gives none.
   *  Not called `then`, which would make a row look like a promise to `await`. */
  laterText: string | null;
  /** `towards` in words: "to Central Library, Kent Vale"; "Ends here" at the end of the line. */
  toText: string;
}

/** A bus on a Nearby row: when it comes by the clock. */
interface NearbyTimes {
  /** When it arrives, to the minute (ISO). */
  at: string;
}

/** A board row on Nearby, with each bus's clock time. */
export type NearbyRow = Omit<BoardRow, 'later'> & {
  /** Where it's going, short: "to PGP Foyer", "via UTown" for a loop (nearbyDest). */
  dest?: string;
  /** The place named in `dest`, for a client that sets it apart from the words around it; null with none. */
  destPlace?: string | null;
  /** When the first bus arrives, to the minute (ISO); null with no time. */
  at: string | null;
  later: (BoardRow['later'][number] & NearbyTimes)[];
};

/** How many buses after the next one a Nearby row shows: its Then and After columns. */
export const NEARBY_LATER = 2;

/**
 * A Nearby row with each bus's clock time, rounded to the minute, as it's
 * read. Nearby shows every bus as it comes, whoever is asking: it doesn't
 * weigh the walk to the stop.
 *
 * The shuttle feed gives two buses a service; where it gives fewer than
 * Nearby's three, the rest are the service's estimated departures after
 * the last one (`guessed`, departures.ts, which keeps them to the
 * service's hours), marked `scheduled`, never live. Not for a public bus,
 * whose own timetable LTA gives.
 */
export function nearbyRow(r: BoardRow, nowMs: number, guessed: Departure[] = []): NearbyRow {
  const at = (etaS: number) => new Date(Math.round((nowMs + etaS * 1000) / 60_000) * 60_000).toISOString().replace('.000Z', 'Z');
  const later = [...r.later];
  if (r.running && r.etaS != null && !r.paid) {
    for (const d of guessed) {
      if (later.length >= NEARBY_LATER) break;
      if (d.kind !== 'estimate' || d.arrival) continue;
      // Past its last bus, the next are when it starts again: not "then".
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

/** How many later buses a row's `laterText` names: more is noise on a phone. */
export const THEN_MAX = 2;

/**
 * A time on a board, in words: a timetable time is marked as an estimate
 * ("~6 min"), and so is a stale one, counted down from an old reading as the
 * card's are. An estimate is never "now", which would pass for a bus at the
 * stop: under a minute it's "~1 min".
 */
export function etaText(etaS: number, quality: Quality): string {
  if (!approxQ(quality)) return mins(etaS);
  return m().approx(mins(Math.max(etaS, 60)));
}

/** Whether a board time is a guess rather than a fresh live one. */
const approxQ = (q: Quality): boolean => q === 'scheduled' || q === 'stale';

/**
 * "then 12, ~20 min": the later buses as whole minutes (never under 1, as a
 * row's own time never says "0 min"), each timetable or stale one marked. Null with none.
 */
export function thenText(later: { etaS: number; quality: Quality }[]): string | null {
  if (!later.length) return null;
  const n = (s: number) => String(Math.max(1, Math.round(s / 60)));
  return m().thenMin(listOf(later.slice(0, THEN_MAX).map((x) => (approxQ(x.quality) ? m().approx(n(x.etaS)) : n(x.etaS)))));
}

/** `towards` in words (see BoardRow.toText). */
export function towardsText(towards: string[]): string {
  if (!towards.length) return m().endsHere;
  return towards.length > 1 ? m().towardsTwo(towards[0], towards[1]) : m().towardsOne(towards[0]);
}

/** A stop's name as a sign would give it ("Central Library", not "CLB"). */
export const displayName = (stop: Stop | undefined, code: string): string => stop?.longName ?? stop?.name ?? code;

/**
 * Where `svc` goes from `stopCode`: [the next stop, the stop the route ends
 * at], by name. A loop runs on from its last stop to its first, and ends
 * where it started. At the end of a line there is nowhere on to go: [].
 * A stop the route calls at twice is taken at its first call.
 */
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

/** How long a place's name may be and still be kept on one line (its spaces made non-breaking), so "via" wraps alone. */
const ONE_LINE_PLACE = 12;

/**
 * Where a Nearby row's bus is going, short enough for a row beside three
 * times, in the names the stops' plates use: "to PGP Foyer". A loop ends
 * where it started, which says nothing about which way it's going (both D1
 * and D2 end at COM 3, even at COM 3), so a loop says the first well-known
 * place it passes from here ("via UTown"); with none, where it ends ("to KR
 * Bus Ter"), unless that's this stop, its first, where it says its next.
 * `destPlace` is the place alone, for a client that sets it apart from the
 * words around it. A short name is kept whole on one line. `svc` is the
 * row's name: a two-way public bus ("151") is two routes ("151/1",
 * "151/2"), and the one meant is the one calling here; where both do, the
 * one whose way on is the row's `towards`.
 */
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

/**
 * How far past its time a bus on a board is taken as gone. The feed's times
 * are whole minutes, so one listed as arriving may still be at the stop a
 * little after; past this, it has left.
 */
export const BOARD_GONE_S = 60;

/**
 * When the boards made from these stops' arrivals are from: the oldest
 * fetch among the feeds that answered (a cached or stale answer's original
 * time), else now. Clients say "Updated N ago" from it.
 */
export function boardAsOf(sas: (StopArrivals | undefined)[], nowMs: number): number {
  const times = sas.filter((sa): sa is StopArrivals => sa !== undefined && sa.available !== false).map((sa) => sa.fetchedAt);
  return times.length ? Math.min(nowMs, ...times) : nowMs;
}

/**
 * What is coming at a single stop, for every service that stops there --
 * the map's tap-a-stop popover. Deliberately destination-less: no walk time,
 * no hops, no "can I reach it" cutoff, because the visitor is already
 * standing there (or checking before they leave), not racing to catch one.
 * Shares its quality ladder and berth handling with scoreOptions() so a stop
 * never disagrees with itself between the Now answer and the map.
 *
 * A service outside its hours with no time from the feed is left out, or,
 * with `stopped`, listed after the others as not running, with why and when
 * it starts again. One the feed still gives a time for is running: the feed
 * is what's on the road, the hours only a guide.
 *
 * `boards`, when given, gets each service's board as read here, by the
 * graph's service, so a caller asking more of it (Nearby's guessed buses)
 * doesn't read the feed's rows again.
 */
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
    // The feed's times count from its fetch, and a cached or stale answer is
    // that much older: counted from now, as scoreOptions does, and a bus
    // whose time is well past is gone, not "now".
    const ageS = fetchedAt !== undefined && available ? Math.max(0, (nowMs - fetchedAt) / 1000) : 0;
    const etas = live
      .map((b) => b.arrival as Arrival & { etaS: number })
      .filter((a) => a.etaS - ageS >= -BOARD_GONE_S)
      .map((a) => ({ ...a, etaS: Math.max(0, Math.round(a.etaS - ageS)) }))
      .sort((a, b) => a.etaS - b.etaS);

    let quality: Quality;
    let etaS: number | null = null;
    if (etas.length) {
      // A time from the operator's timetable is an estimate, not a bus seen.
      quality = etas[0].scheduled ? 'scheduled' : 'live';
      etaS = etas[0].etaS;
    } else if (!inService(graph, svc, nowMs)) {
      if (!opts.stopped) continue; // not running: left out unless asked for
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
    // Only a real arrival goes stale; a guess stays a guess.
    const aged = (q: Quality): Quality => (stale && q === 'live' ? 'stale' : q);
    quality = aged(quality);
    // Each later bus keeps its own quality: a timetabled one after a live one stays a guess.
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
      // Worded here, so every client says the same.
      eta: etaS === null ? null : etaText(etaS, quality),
      laterText: thenText(later),
      toText: towardsText(towards),
    });
  }

  out.sort(
    (a, b) =>
      // Not running: after every service that is, by name.
      Number(a.running === false) - Number(b.running === false) ||
      // Public buses after the campus ones: the free bus is what most want.
      Number(a.paid === true) - Number(b.paid === true) ||
      Number(isMeasured(b.quality)) - Number(isMeasured(a.quality)) ||
      (a.etaS ?? Infinity) - (b.etaS ?? Infinity) ||
      a.svc.localeCompare(b.svc),
  );
  return out;
}

/** How sure each kind of time is, least first (see the degrade ladder in format.ts). */
const SURE: Quality[] = ['unknown', 'scheduled', 'stale', 'live'];

/** The less sure of two times. */
export function worseOf(a: Quality, b: Quality): Quality {
  return SURE.indexOf(a) <= SURE.indexOf(b) ? a : b;
}

/** One bus scored at its stop: when you board it and how sure that is (scoreLeg). */
export interface ScoredLeg {
  /** Seconds from now. */
  boardS: number;
  rideS: number;
  quality: Quality;
  arrival: Arrival | null;
  /** Which departure it is (departures.ts `id`). */
  bus: string;
  fetchedAt: number;
  /** Of `boardS`, the wait for the service to start; 0 when it's running. */
  opensInS: number;
  ambiguousBerth: boolean;
  paid: boolean;
}

/**
 * How soon from now you can board a bus, in seconds: the walk to the stop
 * and WALK.boardBufferS to spare. At the stop, a little before now: a bus
 * the feed had as arriving is still standing there (WALK.dwellS).
 */
export const readyS = (o: { walkS: number; here?: true }): number => (o.here ? -WALK.dwellS : o.walkS + WALK.boardBufferS);

/**
 * The bus of `leg`'s service you can board at the stop whose arrivals are
 * `sa`, being there `earliestS` from now at the soonest. Null when there is
 * none to catch: the service has ended, or doesn't start in time.
 */
export function scoreLeg(
  graph: Graph,
  leg: Leg,
  sa: StopArrivals | undefined,
  nowMs: number,
  earliestS: number,
  opts: { openBy?: number } = {},
): ScoredLeg | null {
  // The feed this service's arrivals came from: at a shelter the shuttle
  // and public buses share, each feed's own fetch time and state.
  const sb = serviceBoard(graph, sa, leg.svc, nowMs);
  // Times here count from when the arrivals were fetched (departsAt is
  // fetchedAt + boardS), so the walk counts from then too: a bus that
  // left while a cached or stale answer aged can't be caught.
  const fetchedAt = sb.fetchedAt ?? nowMs;
  const ageS = Math.max(0, (nowMs - fetchedAt) / 1000);
  const earliest = earliestS + ageS;
  const fromMs = fetchedAt + earliest * 1000;
  const sOf = (ms: number) => (ms - fetchedAt) / 1000;
  // A missing entry means we never reached the feed -- not that no bus is
  // coming. Those are different answers and must not collapse into one.
  const available = sb.available;
  // Waiting for the service to start, which you can do wherever you are.
  let opensInS = 0;
  const running = inService(graph, leg.svc, nowMs);

  // The first bus you can physically reach, not the first bus listed; past
  // the feed's list, a guess. None once the service has closed: the feed
  // still lists its last buses, and there's no bus after them.
  const d = nextDeparture(graph, sb, leg.svc, fromMs, nowMs);
  if (!d) return null;
  if (d.opens) {
    // It waits for the service to start, which only a class can do
    // (`openBy`), and only when it starts in time. Running now, the next
    // start is tomorrow's: you'd reach the stop after the last bus.
    if (running || opts.openBy === undefined || d.earliest > opts.openBy) return null;
    opensInS = Math.max(0, sOf(d.earliest) - earliest);
  }
  // A guess with nothing to step from is the middle of its window: half a headway's wait.
  const boardS = sOf((d.earliest + d.latest) / 2);
  // A time from the operator's timetable (a public bus not yet on the
  // road) is an estimate, however exact it looks. Unreached: keep the
  // option -- the graph still says this service goes where you are going
  // -- but boardS here is only an ordering key. The formatter must never
  // print a time for an 'unknown' option.
  let quality: Quality = d.arrival ? (d.arrival.scheduled ? 'scheduled' : 'live') : !running || available ? 'scheduled' : 'unknown';
  const arrival = d.arrival ?? null;

  // Only a real arrival goes stale; a headway guess stays a guess, never
  // ranked or worded as measured.
  if (sb.stale && quality === 'live') quality = 'stale';

  // From now: the times above count from the fetch, and a cached or
  // stale answer is that much older. Comparing them with a walk that
  // starts now, or with another stop's fresher times, needs one clock.
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

/** What an option costs as the options are ranked, in seconds to the place itself (see scoreOptions). */
function rankCostS(o: ScoredOption, endWalk: (o: ScoredOption) => number, walkWeight: number): number {
  return (
    o.totalS + endWalk(o) + (walkWeight - 1) * footS(o, endWalk(o)) + (o.paid ? PUBLIC.fareWorthS : 0) + (o.change ? TRANSFER.worthS : 0)
  );
}

/**
 * Convert candidates plus live arrivals into ranked options, all in seconds
 * from now. Options whose service has ended are dropped entirely, and so is
 * a guessed bus after the service stops for the day.
 */
export function scoreOptions(
  graph: Graph,
  candidates: Candidate[],
  arrivalsByStop: Map<string, StopArrivals>,
  nowMs: number,
  /** The walk on from where an option gets you off to the place itself: a
   *  food court's stops are different walks from it, so it counts in the ranking. */
  endWalk: (o: ScoredOption) => number = () => 0,
  /** `openBy`: a service not running yet that starts before this (epoch ms)
   *  is kept, its first bus guessed from its start. For a class: at 06:30 the
   *  08:00 class's bus is the D2 that starts at 07:15, not "Services ended".
   *  `transfers`: trips with a change of bus to time as well (planTransfers),
   *  their stops' arrivals in `arrivalsByStop` with the rest.
   *  `walkWeight`: what a second on foot costs against one waiting or
   *  riding (WALK.sunWeight), so a longer walk for a sooner bus must save more. */
  opts: { openBy?: number; transfers?: TransferRoute[]; walkWeight?: number } = {},
): ScoredOption[] {
  const out: ScoredOption[] = [];
  const legOpts = opts.openBy !== undefined ? { openBy: opts.openBy } : {};

  for (const r of opts.transfers ?? []) {
    const s1 = scoreLeg(graph, r.leg1, arrivalsByStop.get(r.origin.code), nowMs, readyS(r), legOpts);
    if (!s1) continue;
    // The second bus is the first you can catch once the first gets you
    // there: off it, across the road if need be, and ready to board.
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
      // A trip is as sure as its less sure bus: a guessed second bus makes
      // the whole of it a guess, never ranked over a measured single bus.
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

  // Measurements beat estimates outright; within a tier, time to the place
  // itself decides, a public bus's fare counting as PUBLIC.fareWorthS of it:
  // it wins only when it clearly saves time over the free shuttle.
  // A change of bus counts as TRANSFER.worthS of it, the same way, and every
  // second on foot as more than a second at the stop (walkWeight).
  const costS = (o: ScoredOption) => rankCostS(o, endWalk, opts.walkWeight ?? WALK.sunWeight);
  out.sort(
    (a, b) =>
      Number(isMeasured(b.quality)) - Number(isMeasured(a.quality)) ||
      costS(a) - costS(b) ||
      a.walkS - b.walkS ||
      a.svc.localeCompare(b.svc) ||
      (a.change?.svc ?? '').localeCompare(b.change?.svc ?? ''),
  );
  // Likewise a change of bus that is measured over a single bus that is
  // only a guess: unless it saves what the change is worth, the single bus.
  if (out[0]?.change) {
    const single = out.findIndex((o) => !o.change);
    if (single > 0 && out[single].quality !== 'unknown' && costS(out[single]) <= costS(out[0])) out.unshift(...out.splice(single, 1));
  }
  // A live public bus outranks a free bus that only has a headway guess by
  // tier, but the fare still has to be worth it: unless it beats the best
  // free option's time by what the fare is worth, the free bus is the answer.
  // A free bus with no times at all has nothing to beat it with: its time is
  // only a sort key, and an estimate never goes over a measurement.
  if (out[0]?.paid) {
    const free = out.findIndex((o) => !o.paid);
    if (free > 0 && out[free].quality !== 'unknown' && costS(out[free]) <= costS(out[0])) out.unshift(...out.splice(free, 1));
  }
  return out;
}

/**
 * The second option. Must differ in its first leg -- two variants of the same
 * service off the same stop is not a choice, it is noise. The same service
 * from another stop is a choice only when it gets you there about as soon:
 * across the road it's usually the same bus the wrong way round the loop.
 */
export function pickAlt(options: ScoredOption[]): ScoredOption | null {
  const best = options[0];
  if (!best) return null;
  // After a change of bus, the single bus it beat, when there is one; after
  // a single bus, never a change, which it beat.
  if (best.change)
    return options.find((o) => !o.change) ?? options.find((o) => o.svc !== best.svc || o.change?.svc !== best.change?.svc) ?? null;
  const single = options.filter((o) => !o.change);
  return (
    single.find((o) => o.svc !== best.svc) ??
    single.find((o) => o.stop.code !== best.stop.code && o.totalS - best.totalS <= WALK.mentionWithinS) ??
    null
  );
}

/**
 * How sure we are this is the right stop, from the margin over the best
 * option at a *different* stop. A tight margin means the hop-count guess in
 * RIDE.secondsPerHop is doing the deciding, which it is not good enough for.
 */
export function confidence(
  options: ScoredOption[],
  hasCoords: boolean,
  endWalk: (o: ScoredOption) => number = () => 0,
  walkWeight: number = WALK.sunWeight,
): number {
  if (!options.length) return 0;
  const best = options[0];
  // Two passes of the same service through this stop and no way to tell which
  // one the ETA belongs to. No amount of margin elsewhere earns that back.
  // A change of bus is two rides priced by RIDE.secondsPerHop, and a wait
  // between them that is a guess unless the second bus is in the feed.
  const ceiling = best.ambiguousBerth ? 0.5 : best.change ? 0.85 : 0.97;
  if (!hasCoords) return Math.min(0.75, ceiling); // exact stop, but only an assumption about where you are
  const other = options.find((o) => o.stop.code !== best.stop.code);
  if (!other) return Math.min(0.9, ceiling);
  // The margin to the place itself, as the options are ranked (scoreOptions):
  // a fare or a change of bus narrows it, since a ride-time guess that
  // small could flip the ranking.
  const marginS = rankCostS(other, endWalk, walkWeight) - rankCostS(best, endWalk, walkWeight);
  return Math.round(Math.max(0.5, Math.min(ceiling, 0.5 + marginS / 600)) * 100) / 100;
}

/**
 * The nearest stop, full stop -- including one that reaches nothing. The
 * formatter needs it to say "cross the road", which is the single most
 * valuable line in the product: you are standing at a stop, and without that
 * cue you will board the bus you can see.
 */
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

/**
 * Seconds on foot to the destination's stop `destCode` (input.to without
 * one), for the walk-or-bus comparison and the "service ended" answer.
 */
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
    // In a residence or a building, walk out by its own stops: the straight
    // line can cross a hill the path goes round.
    const home = residenceStops(lat, lon, idx.byCode, homeWalk(input)) ?? buildingStops(lat, lon, idx.byCode);
    if (home) {
      const via = Math.min(...home.map((h) => (h.stop.code === dest.code ? h.footM : h.footM + stopFootM(h.stop, dest))));
      return Math.round(Math.max(via, footM(lat, lon, dest)) / speed);
    }
    // Elsewhere, out by the stops near you and on along the paths between
    // stops (walks.json). The straight line with its detour is for a walk to
    // a stop nearby; across campus it can be half the real walk, or double it.
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
  // From the origin stop, the walk to it (from home) comes first, same as for
  // the bus; from a room several stops serve, out by whichever is shortest.
  const from = [fallbackFrom, ...(input.originAlso ?? []).flatMap((code) => idx.byCode.get(code) ?? [])];
  return Math.min(
    ...from.map((s) => Math.round(stopFootM(s, dest) / speed) + (input.originWalkByStopS?.[s.code] ?? input.originWalkS ?? 0)),
  );
}

/**
 * The walk the whole way: `s` on foot to a stop of the destination and
 * `endS` on from it to the place itself (a room, a food court), by
 * whichever of its stops makes the walk shortest. Straight to the room
 * when it's near enough to walk to directly (`endS` 0): a room 120 m away
 * can be 400 m from the stop it's listed under, on the other side.
 */
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
    // With the paths' detour of the room's own stop, the nearest one known.
    const room = { code: input.to, lat: destAt.lat, lon: destAt.lon } as Stop;
    const s = Math.round(footM(lat, lon, room) / (input.walkSpeedMs ?? WALK.speedMs));
    if (!best || s < best.s + best.endS) best = { s, endS: 0 };
  }
  return best;
}
