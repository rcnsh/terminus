/**
 * Changing buses: a trip on two shuttles, the first to a stop the second
 * calls at, where no single bus goes there (or, in TRANSFER.mode 'beats',
 * where one is much slower).
 *
 * Which changes are worth asking the feed about is decided here from the
 * route data alone, before any fetch: the change stops are ranked by a
 * timetable guess of the whole trip (half a headway's wait for each bus),
 * and at most TRANSFER.maxFetch of them, beyond the stops near you, have
 * their arrivals fetched. scoreOptions() then times each route on the live
 * arrivals at both stops.
 *
 * One change at most, at the stop the first bus drops you or across the
 * road from it, and shuttles only: a public bus's fare and its feed (LTA's)
 * would each need their own rules.
 */

import type { Candidate, Graph, GraphIndex, Leg, ResolveInput, Stop } from './types.ts';
import { TRANSFER, WALK } from './config.ts';
import { type Target, bestLeg, candidateStops, headwayFor, indexGraph, legRideS, reach, targetsFor } from './resolve.ts';
import { isPublic } from './public.ts';
import { stopFootM } from './walk.ts';

/** A way there with one change, as the route data has it (no times yet). */
export interface TransferRoute {
  /** Where the trip starts, and the walk there, as a candidate stop's. */
  origin: Stop;
  distM: number;
  walkS: number;
  /** The first bus, to `at`. */
  leg1: Leg;
  at: Stop;
  /** Where the second bus goes from: `at`, or its twin across the road. */
  board: Stop;
  crossS: number;
  /** The second bus, to the destination. */
  leg2: Leg;
  /** The timetable guess of the trip from setting off (the walk included)
   *  to the place itself: how routes are ranked before any fetch. */
  costS: number;
}

/** A route from one stop, without the walk to it (memoised: the graph never changes). */
interface Route {
  leg1: Leg;
  at: Stop;
  board: Stop;
  crossM: number;
  leg2: Leg;
}

/** Whole-trip guesses from a stop past this are no use to anyone. */
const MEMO_MAX = 500;
const memo = new WeakMap<Graph, Map<string, Route[]>>();

/** Half a headway: the wait for a bus you turn up for without a time. */
const halfWay = (graph: Graph, svc: string) => headwayFor(graph, svc) / 2;

/**
 * Every way from `origin` to one of `targets` with one change of shuttle,
 * the best change stop for each pair of services. Not a change that a
 * single bus does as well: staying on the first bus, or catching the
 * second at the start.
 */
export function transferRoutes(graph: Graph, origin: Stop, targets: Target[]): Route[] {
  let byKey = memo.get(graph);
  if (!byKey) memo.set(graph, (byKey = new Map()));
  const key = `${origin.code}|${targets.map((t) => `${t.code}:${t.crossS}`).join(',')}`;
  const hit = byKey.get(key);
  if (hit) return hit;

  const idx = indexGraph(graph);
  const targetCodes = new Set(targets.map((t) => t.code));
  const shuttle = (svc: string) => !isPublic(graph, svc);
  const best = new Map<string, { route: Route; s: number }>();
  for (const svc1 of (idx.servingStop.get(origin.code) ?? []).filter(shuttle)) {
    const stay = bestLeg(graph, idx, svc1, origin.code, targets);
    for (const code of new Set(idx.routes.get(svc1)?.seq ?? [])) {
      if (code === origin.code || targetCodes.has(code)) continue;
      const r = reach(idx, svc1, origin.code, code);
      // Past the terminal is the next run: change before it, not after.
      if (!r || r.hops === 0 || r.through) continue;
      const leg1 = bestLeg(graph, idx, svc1, origin.code, [{ code, crossS: 0 }]);
      const at = idx.byCode.get(code);
      if (!leg1 || !at) continue;
      const twin = at.opposite ? idx.byCode.get(at.opposite) : undefined;
      for (const board of twin ? [at, twin] : [at]) {
        // Back where you started, or already there.
        if (board.code === origin.code || board.code === origin.opposite || targetCodes.has(board.code)) continue;
        const crossM = board === at ? 0 : stopFootM(at, board);
        for (const svc2 of (idx.servingStop.get(board.code) ?? []).filter(shuttle)) {
          if (svc2 === svc1) continue;
          const leg2 = bestLeg(graph, idx, svc2, board.code, targets);
          if (!leg2) continue;
          const onS = legRideS(leg1) + crossM / WALK.speedMs + TRANSFER.changeBufferS + halfWay(graph, svc2) + legRideS(leg2);
          // Staying on the first bus gets there as soon.
          if (stay && legRideS(stay) <= onS) continue;
          const s = halfWay(graph, svc1) + onS;
          // The second bus from the start does too.
          const direct2 = bestLeg(graph, idx, svc2, origin.code, targets);
          if (direct2 && halfWay(graph, svc2) + legRideS(direct2) <= s) continue;
          const k = `${svc1}|${svc2}|${board.code}`;
          const was = best.get(k);
          if (!was || s < was.s) best.set(k, { route: { leg1, at, board, crossM, leg2 }, s });
        }
      }
    }
  }
  const out = [...best.values()].sort((a, b) => a.s - b.s).map((b) => b.route);
  if (byKey.size >= MEMO_MAX) byKey.clear();
  byKey.set(key, out);
  return out;
}

/** The routes worth timing, and the change stops to fetch for them. */
export interface TransferPlan {
  routes: TransferRoute[];
  /** Stops to fetch on top of the candidates': the routes' starts and change stops. */
  fetch: string[];
}

const NONE: TransferPlan = { routes: [], fetch: [] };
/** Routes timed per answer: each is two lookups in arrivals already fetched. */
const ROUTES_MAX = 8;

/**
 * Which trips with a change to time, before anything is fetched. Only with
 * a destination; where a single bus goes there, only in 'beats' mode and
 * only a change that beats it by TRANSFER.worthS on the timetable guess.
 * The routes come cheapest first, with at most TRANSFER.maxFetch stops
 * fetched for them beyond those the answer fetches anyway.
 */
export function planTransfers(graph: Graph, input: ResolveInput, cands: Candidate[]): TransferPlan {
  if (!input.to || TRANSFER.mode === 'off') return NONE;
  const direct = cands.some((c) => c.legs.length > 0);
  if (direct && TRANSFER.mode !== 'beats') return NONE;
  const idx: GraphIndex = indexGraph(graph);
  const targets = targetsFor(idx, input);
  const speed = input.walkSpeedMs ?? WALK.speedMs;
  const endS = (leg: Leg) => input.endWalkByStopS?.[leg.to?.code ?? input.to ?? ''] ?? input.endWalkS ?? 0;

  // The stops near you, whether or not a bus from them goes there: a change
  // can start where no single bus does (K from CLB, to change to P).
  const origins = candidateStops(graph, input, { any: true })
    .filter((c) => !c.stop.public)
    .sort((a, b) => a.walkS - b.walkS)
    .slice(0, WALK.maxCandidates);
  const beat = direct
    ? Math.min(...cands.flatMap((c) => c.legs.map((l) => c.walkS + halfWay(graph, l.svc) + legRideS(l) + endS(l))))
    : Infinity;

  const all: TransferRoute[] = origins.flatMap((o) =>
    transferRoutes(graph, o.stop, targets).map((r) => {
      const crossS = Math.round(r.crossM / speed);
      const costS = o.walkS + halfWay(graph, r.leg1.svc) + legRideS(r.leg1) + crossS + TRANSFER.changeBufferS + halfWay(graph, r.leg2.svc) + legRideS(r.leg2) + endS(r.leg2);
      return { origin: o.stop, distM: o.distM, walkS: o.walkS, leg1: r.leg1, at: r.at, board: r.board, crossS, leg2: r.leg2, costS };
    }),
  );
  const worth = all.filter((r) => r.costS + TRANSFER.worthS < beat).sort((a, b) => a.costS - b.costS);

  // Fetched anyway: the candidates, and where no bus goes there, the stops
  // near you that a change starts from, which stand in for them (all the
  // answer would have had is the nearest stop, with no bus there). Any
  // other stop counts towards TRANSFER.maxFetch.
  const have = new Set([...cands.map((c) => c.stop.code), ...(direct ? [] : origins.map((o) => o.stop.code))]);
  const added = new Set<string>();
  const routes: TransferRoute[] = [];
  for (const r of worth) {
    if (routes.length >= ROUTES_MAX) break;
    const fresh = [...new Set([r.origin.code, r.board.code])].filter((c) => !have.has(c) && !added.has(c));
    if (added.size + fresh.length > TRANSFER.maxFetch) continue;
    for (const c of fresh) added.add(c);
    routes.push(r);
  }
  const cand = new Set(cands.map((c) => c.stop.code));
  const fetch = [...new Set([...routes.map((r) => r.origin.code), ...added])].filter((c) => !cand.has(c));
  return { routes, fetch };
}
