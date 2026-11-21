import type { Candidate, Graph, GraphIndex, Leg, ResolveInput, Stop } from '../types.ts';
import { TRANSFER, WALK } from '../config.ts';
import { type Target, bestLeg, candidateStops, endWalkFromS, indexGraph, legRideS, reach, targetsFor } from './resolve.ts';
import { headwayFor } from './hours.ts';
import { isPublic } from './public.ts';
import { stopFootM } from './walk.ts';
import { Lru, perScope } from '../memo.ts';

export interface TransferRoute {
  origin: Stop;
  distM: number;
  walkS: number;
  here?: true;
  leg1: Leg;
  at: Stop;
  board: Stop;
  crossS: number;
  leg2: Leg;
  costS: number;
}

interface Route {
  leg1: Leg;
  at: Stop;
  board: Stop;
  crossM: number;
  leg2: Leg;
}

const routesFor = perScope(() => new Lru<string, Route[]>(500));

const halfWay = (graph: Graph, svc: string) => headwayFor(graph, svc) / 2;

export function transferRoutes(graph: Graph, origin: Stop, targets: Target[]): Route[] {
  const byKey = routesFor(graph);
  const key = `${origin.code}|${targets.map((t) => `${t.code}:${t.crossS}:${t.costS ?? 0}`).join(',')}`;
  const hit = byKey.get(key);
  if (hit) return hit;

  const idx = indexGraph(graph);
  const targetCodes = new Set(targets.filter((t) => !t.near).map((t) => t.code));
  const shuttle = (svc: string) => !isPublic(graph, svc);
  const legCost = (leg: Leg) => legRideS(leg) + (targets.find((t) => t.near && t.code === leg.to?.code)?.costS ?? 0);
  const best = new Map<string, { route: Route; s: number }>();
  for (const svc1 of (idx.servingStop.get(origin.code) ?? []).filter(shuttle)) {
    const stay = bestLeg(graph, idx, svc1, origin.code, targets);
    for (const code of new Set(idx.routes.get(svc1)?.seq ?? [])) {
      if (code === origin.code || targetCodes.has(code)) continue;
      const r = reach(idx, svc1, origin.code, code);
      if (!r || r.hops === 0 || r.through) continue;
      const leg1 = bestLeg(graph, idx, svc1, origin.code, [{ code, crossS: 0 }]);
      const at = idx.byCode.get(code);
      if (!leg1 || !at) continue;
      const opp = at.opposite ? idx.byCode.get(at.opposite) : undefined;
      for (const board of opp ? [at, opp] : [at]) {
        if (board.code === origin.code || board.code === origin.opposite || targetCodes.has(board.code)) continue;
        const crossM = board === at ? 0 : stopFootM(at, board);
        for (const svc2 of (idx.servingStop.get(board.code) ?? []).filter(shuttle)) {
          if (svc2 === svc1) continue;
          const leg2 = bestLeg(graph, idx, svc2, board.code, targets);
          if (!leg2) continue;
          const onS = legRideS(leg1) + crossM / WALK.speedMs + TRANSFER.changeBufferS + halfWay(graph, svc2) + legCost(leg2);
          if (stay && legCost(stay) <= onS) continue;
          const s = halfWay(graph, svc1) + onS;
          const direct2 = bestLeg(graph, idx, svc2, origin.code, targets);
          if (direct2 && halfWay(graph, svc2) + legCost(direct2) <= s) continue;
          const k = `${svc1}|${svc2}|${board.code}`;
          const was = best.get(k);
          if (!was || s < was.s) best.set(k, { route: { leg1, at, board, crossM, leg2 }, s });
        }
      }
    }
  }
  const out = [...best.values()].sort((a, b) => a.s - b.s).map((b) => b.route);
  byKey.set(key, out);
  return out;
}

export interface TransferPlan {
  routes: TransferRoute[];
  fetch: string[];
}

const NONE: TransferPlan = { routes: [], fetch: [] };
const ROUTES_MAX = 8;

export function planTransfers(graph: Graph, input: ResolveInput, cands: Candidate[]): TransferPlan {
  if (!input.to || TRANSFER.mode === 'off') return NONE;
  const idx: GraphIndex = indexGraph(graph);
  const targets = targetsFor(idx, input);
  const own = targets.filter((t) => !t.near);
  const direct = cands.some((c) => c.legs.some((l) => bestLeg(graph, idx, l.svc, c.stop.code, own)));
  if (direct && TRANSFER.mode !== 'beats') return NONE;
  const speed = input.walkSpeedMs ?? WALK.speedMs;
  const endS = (leg: Leg) => endWalkFromS(input, leg.to?.code);

  const origins = candidateStops(graph, input, { any: true })
    .filter((c) => !c.stop.public)
    .sort((a, b) => a.walkS - b.walkS)
    .slice(0, WALK.maxCandidates);
  const legs = cands.flatMap((c) => c.legs.map((l) => c.walkS + halfWay(graph, l.svc) + legRideS(l) + endS(l)));
  const beat = legs.length ? Math.min(...legs) : Infinity;

  const all: TransferRoute[] = origins.flatMap((o) =>
    transferRoutes(graph, o.stop, targets).map((r) => {
      const crossS = Math.round(r.crossM / speed);
      const costS =
        o.walkS +
        halfWay(graph, r.leg1.svc) +
        legRideS(r.leg1) +
        crossS +
        TRANSFER.changeBufferS +
        halfWay(graph, r.leg2.svc) +
        legRideS(r.leg2) +
        endS(r.leg2);
      return {
        origin: o.stop,
        distM: o.distM,
        walkS: o.walkS,
        ...(o.here ? { here: true as const } : {}),
        leg1: r.leg1,
        at: r.at,
        board: r.board,
        crossS,
        leg2: r.leg2,
        costS,
      };
    }),
  );
  const worth = all.filter((r) => r.costS + TRANSFER.worthS < beat).sort((a, b) => a.costS - b.costS);

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
