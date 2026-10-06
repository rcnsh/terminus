/**
 * The answer engine: stops near you (or your origin), their arrivals, the
 * best option and a worded Answer. Used by the public routes in index.ts and
 * by /me/next in me.ts (through MeDeps).
 */


import type { Answer, Arrival, Env, FeedState, Graph, ResolveInput, ScoredOption, Stop, StopArrivals } from './types.ts';
import { WALK } from './config.ts';
import { getArrivals } from './fms.ts';
import { getPublicArrivals } from './lta.ts';
import { publicCodeOf, shuttleCalls, svcName } from './public.ts';
import { buildAnswer, shortStop } from './format.ts';
import {
  candidateStops,
  confidence,
  haversineM,
  indexGraph,
  nearestStop,
  pickAlt,
  scoreOptions,
  walkAllTheWayS,
} from './resolve.ts';
import { logAnswer } from './analytics.ts';
import { leaveBy } from './leave.ts';
import { loadCrowdRisk, recordCrowds } from './crowd.ts';
import { hopSecondsFor, loadTable } from './ridetimes.ts';

import { GRAPH, GRAPH_PUBLIC } from './graph.ts';
import { m } from './i18n.ts';

/** The feed could not be reached: no data, as opposed to no bus. */
const unreached = (code: string, nowMs: number): StopArrivals => ({ code, arrivals: [], fetchedAt: nowMs, stale: false, available: false });

/**
 * Arrivals at each stop. In the graph with public buses, a stop is asked of
 * the feeds that call there: the shuttle's, LTA's for its public code, or
 * both at a shelter they share, whose answers are merged (`feeds` keeps each
 * one's state, so one feed down doesn't read as the other saying "no bus").
 */
export async function collectArrivals(
  env: Env,
  ctx: ExecutionContext,
  codes: string[],
  nowMs: number,
  graph: Graph = GRAPH,
): Promise<Map<string, StopArrivals>> {
  const idx = indexGraph(graph);
  const settled = await Promise.all(
    codes.map(async (code) => {
      const stop = idx.byCode.get(code);
      const pub = stop ? publicCodeOf(stop) : null;
      const shuttle = stop ? shuttleCalls(stop) : true;
      // A failed stop still gets an entry, marked unavailable. Dropping it here
      // would make "we could not reach the feed" indistinguishable from "the
      // feed says no bus is coming", and the second one gets a headway guess.
      const [s, p] = await Promise.all([
        shuttle ? getArrivals(env, ctx, code, nowMs).catch(() => null) : undefined,
        pub ? getPublicArrivals(env, ctx, graph, code, pub, nowMs).catch(() => null) : undefined,
      ]);
      if (s === undefined) return p ?? unreached(code, nowMs);
      if (p === undefined) return s ?? unreached(code, nowMs);
      return mergeFeeds(code, nowMs, s, p);
    }),
  );
  return new Map(codes.map((code, i) => [code, settled[i]]));
}

/** Two feeds' answers for one shelter as one board, each feed's state kept. */
export function mergeFeeds(code: string, nowMs: number, shuttle: StopArrivals | null, pub: StopArrivals | null): StopArrivals {
  const state = (sa: StopArrivals | null): FeedState => (sa ? { fetchedAt: sa.fetchedAt, stale: sa.stale, available: sa.available } : { fetchedAt: nowMs, stale: false, available: false });
  const up = [shuttle, pub].filter((sa): sa is StopArrivals => sa !== null && sa.available);
  return {
    code,
    arrivals: [...(shuttle?.arrivals ?? []), ...(pub?.arrivals ?? [])],
    // The times count from each feed's own fetch (see scoreOptions); the
    // whole takes the older, the honest "as of".
    fetchedAt: up.length ? Math.min(...up.map((sa) => sa.fetchedAt)) : nowMs,
    stale: up.some((sa) => sa.stale),
    available: up.length > 0,
    feeds: { shuttle: state(shuttle), public: state(pub) },
  };
}

/** The one function that turns a request into an Answer. */
export async function answerFor(
  env: Env,
  ctx: ExecutionContext,
  input: ResolveInput,
  destLabel: string | null,
  nowMs: number,
): Promise<Answer> {
  // With public buses on, the graph that has them: more services at the same stops.
  const graph = input.publicBuses ? GRAPH_PUBLIC : GRAPH;
  const idx = indexGraph(graph);
  // Measured seconds between stops, where enough rides have been seen (phase 8.2).
  if (!input.hopS) {
    const hopS = hopSecondsFor(await loadTable(env, nowMs), nowMs);
    if (hopS) input = { ...input, hopS };
  }
  const cands = candidateStops(graph, input);
  const originStop = input.originCode ? (idx.byCode.get(input.originCode) ?? null) : null;
  const fallbackStop = cands[0]?.stop ?? originStop;

  // Already there: two classes in a row at the same stop, standing at it, or
  // in the room itself (a lecture theatre can be 100 m from its stop).
  // Without this the degrade ladder says "Walk · now" and marks it ended.
  const dest = input.to ? idx.byCode.get(input.to) : undefined;
  // Either side of the road counts as there, same as for routing, and so does
  // any other stop serving the same place.
  const destSides = [input.to, ...(input.toAlso ?? [])]
    .map((c) => (c ? idx.byCode.get(c) : undefined))
    .filter((s): s is Stop => Boolean(s))
    .flatMap((s) => [s, ...(s.opposite && idx.byCode.get(s.opposite) ? [idx.byCode.get(s.opposite)!] : [])]);
  const atDest = destSides.find((d) =>
    input.lat != null
      ? haversineM(input.lat, input.lon!, d.lat, d.lon) / WALK.speedMs < 45
      : input.originCode === d.code,
  );
  const atVenue = input.lat != null && input.destAt != null && haversineM(input.lat, input.lon!, input.destAt.lat, input.destAt.lon) <= WALK.atVenueM;
  if (dest && (atDest || atVenue)) return arrivedAnswer(dest, destLabel, nowMs);
  // No coordinates and no origin stop: nothing to resolve from. Saying
  // "No buses running" here would be a claim about the network.
  if (!cands.length) {
    return { ...needsSetupAnswer(nowMs), label: m().noStartPoint, detail: m().noStartPointHint };
  }

  const byStop = await collectArrivals(
    env,
    ctx,
    cands.map((c) => c.stop.code),
    nowMs,
    graph,
  );

  // Tally who's packed for the full-bus risk, off the response path.
  if (env.DB) ctx.waitUntil(recordCrowds(env.DB, byStop, nowMs));
  const crowdRisk = input.arriveBy && env.DB ? await loadCrowdRisk(env.DB, cands.map((c) => c.stop.code), nowMs) : undefined;

  // On from where a bus gets you off to the place itself, from that stop: a
  // food court's other stop can be further from it than its first.
  const endWalk = (o: ScoredOption) => input.endWalkByStopS?.[o.to?.code ?? input.to ?? ''] ?? input.endWalkS ?? 0;
  const options = scoreOptions(graph, cands, byStop, nowMs, endWalk);
  const alt = pickAlt(options);
  const chosen = options[0]?.stop.code ?? fallbackStop?.code ?? '';
  // As the buses are named: a two-way public route's key carries its direction.
  const arrivals: Arrival[] = (byStop.get(chosen)?.arrivals ?? []).map((a) => (a.svc === svcName(a.svc) ? a : { ...a, svc: svcName(a.svc) }));

  const walkAllS = walkAllTheWayS(graph, input, fallbackStop);
  const answer = buildAnswer({
    options,
    alt,
    fallbackStop,
    nearestStop: nearestStop(graph, input.lat, input.lon),
    destLabel,
    walkAllS,
    endWalk,
    walkEndS: input.endWalkByStopS?.[input.to ?? ''] ?? input.endWalkS ?? 0,
    confidence: confidence(options, input.lat != null, endWalk),
    arrivals,
    nowMs,
  });
  // departsAt null with an arrival time: the answer is to walk.
  const walking = answer.departsAt == null && answer.arriveAt != null;
  answer.leave = leaveBy({
    options,
    candidates: cands,
    byStop,
    graph,
    arriveBy: input.arriveBy,
    walkAllS: walking ? walkAllS : null,
    endWalk,
    nowMs,
    crowdRisk,
  });

  // Synchronous, non-blocking, and swallows its own errors. Deliberately not
  // behind waitUntil: there is nothing to await.
  logAnswer(env, {
    answer,
    best: options[0] ?? null,
    dest: input.to,
    hadCoords: input.lat != null,
    walkAllS,
  });

  return answer;
}

/** You are at the destination's stop. `live` because it is a current,
 *  certain answer, even though no bus data was needed for it. */
export function arrivedAnswer(stop: Stop, destLabel: string | null, nowMs: number): Answer {
  return {
    label: m().youreHere,
    // A place's stop is worth naming ("The Deck is at UTown"); a class's label
    // already says where it is ("GEA1000 @ UTown is at UTown" said it twice).
    detail:
      destLabel && !destLabel.includes(' @ ') && destLabel !== stop.name && destLabel !== shortStop(stop.name, 14) ? m().destIsAt(destLabel, stop.name) : m().youreAt(stop.name),
    alt: null,
    stop: { code: stop.code, name: stop.name, confidence: 1 },
    quality: 'live',
    asOf: new Date(nowMs).toISOString(),
    arrivals: [],
    arrived: true,
    leave: null,
  };
}

/** Honest zero-config answer when we have no location or destination to
 *  resolve. Not an error, and not a fake bus. */
export function needsSetupAnswer(nowMs: number): Answer {
  return {
    label: m().setUp,
    detail: m().setUpHint,
    alt: null,
    stop: { code: '', name: '', confidence: 0 },
    quality: 'unknown',
    asOf: new Date(nowMs).toISOString(),
    arrivals: [],
  };
}

