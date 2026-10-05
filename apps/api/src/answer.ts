/**
 * The answer engine: stops near you (or your origin), their arrivals, the
 * best option and a worded Answer. Used by the public routes in index.ts and
 * by /me/next in me.ts (through MeDeps).
 */


import type { Answer, Arrival, Env, ResolveInput, ScoredOption, Stop, StopArrivals } from './types.ts';
import { WALK } from './config.ts';
import { getArrivals } from './fms.ts';
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

import { GRAPH } from './graph.ts';
import { m } from './i18n.ts';

export async function collectArrivals(
  env: Env,
  ctx: ExecutionContext,
  codes: string[],
  nowMs: number,
): Promise<Map<string, StopArrivals>> {
  const settled = await Promise.allSettled(codes.map((c) => getArrivals(env, ctx, c, nowMs)));
  const out = new Map<string, StopArrivals>();
  settled.forEach((r, i) => {
    // A failed stop still gets an entry, marked unavailable. Dropping it here
    // would make "we could not reach the feed" indistinguishable from "the
    // feed says no bus is coming", and the second one gets a headway guess.
    out.set(
      codes[i],
      r.status === 'fulfilled'
        ? r.value
        : { code: codes[i], arrivals: [], fetchedAt: nowMs, stale: false, available: false },
    );
  });
  return out;
}

/** The one function that turns a request into an Answer. */
export async function answerFor(
  env: Env,
  ctx: ExecutionContext,
  input: ResolveInput,
  destLabel: string | null,
  nowMs: number,
): Promise<Answer> {
  const idx = indexGraph(GRAPH);
  // Measured seconds between stops, where enough rides have been seen (phase 8.2).
  if (!input.hopS) {
    const hopS = hopSecondsFor(await loadTable(env, nowMs), nowMs);
    if (hopS) input = { ...input, hopS };
  }
  const cands = candidateStops(GRAPH, input);
  const originStop = input.originCode ? (idx.byCode.get(input.originCode) ?? null) : null;
  const fallbackStop = cands[0]?.stop ?? originStop;

  // Already there: two classes in a row at the same stop, or standing at it.
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
  if (dest && atDest) return arrivedAnswer(dest, destLabel, nowMs);
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
  );

  // Tally who's packed for the full-bus risk, off the response path.
  if (env.DB) ctx.waitUntil(recordCrowds(env.DB, byStop, nowMs));
  const crowdRisk = input.arriveBy && env.DB ? await loadCrowdRisk(env.DB, cands.map((c) => c.stop.code), nowMs) : undefined;

  const options = scoreOptions(GRAPH, cands, byStop, nowMs);
  const alt = pickAlt(options);
  const chosen = options[0]?.stop.code ?? fallbackStop?.code ?? '';
  const arrivals: Arrival[] = byStop.get(chosen)?.arrivals ?? [];

  const walkAllS = walkAllTheWayS(GRAPH, input, fallbackStop);
  // On from where a bus gets you off to the place itself, from that stop: a
  // food court's other stop can be further from it than its first.
  const endWalk = (o: ScoredOption) => input.endWalkByStopS?.[o.to?.code ?? input.to ?? ''] ?? input.endWalkS ?? 0;
  const answer = buildAnswer({
    options,
    alt,
    fallbackStop,
    nearestStop: nearestStop(GRAPH, input.lat, input.lon),
    destLabel,
    walkAllS,
    endWalk,
    walkEndS: input.endWalkByStopS?.[input.to ?? ''] ?? input.endWalkS ?? 0,
    confidence: confidence(options, input.lat != null),
    arrivals,
    nowMs,
  });
  // departsAt null with an arrival time: the answer is to walk.
  const walking = answer.departsAt == null && answer.arriveAt != null;
  answer.leave = leaveBy({
    options,
    candidates: cands,
    byStop,
    graph: GRAPH,
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

