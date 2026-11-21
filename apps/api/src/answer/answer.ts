import type { Answer, Arrival, Env, FeedState, Graph, ResolveInput, ScoredOption, Stop, StopArrivals } from '../types.ts';
import { STEP, WALK } from '../config.ts';
import { getArrivals } from '../feeds/fms.ts';
import { getPublicArrivals } from '../feeds/lta.ts';
import { publicCodeOf, shuttleCalls, svcName } from './public.ts';
import { buildAnswer, shortStop } from './format.ts';
import {
  candidateStops,
  confidence,
  endWalkFromS,
  haversineM,
  indexGraph,
  nearestStop,
  pickAlt,
  scoreOptions,
  wholeWalk,
} from './resolve.ts';
import { logAnswer, logBoard } from '../ops/analytics.ts';
import { type LeaveInput, departureOf, departures, leaveBy, publicLeave } from './leave.ts';
import { stepFrom } from './step.ts';
import { loadCrowdRisk, recordCrowds } from './crowd.ts';
import { planTransfers } from './transfer.ts';
import { GRAPH, GRAPH_PUBLIC } from './graph.ts';
import { m } from '../i18n.ts';

export interface MeDeps {
  answerFor: (env: Env, ctx: ExecutionContext, input: ResolveInput, label: string | null, nowMs: number) => Promise<Answer>;
  collectArrivals: (env: Env, ctx: ExecutionContext, codes: string[], nowMs: number, graph?: Graph) => Promise<Map<string, StopArrivals>>;
}

const unreached = (code: string, nowMs: number): StopArrivals => ({ code, arrivals: [], fetchedAt: nowMs, stale: false, available: false });

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
      if (!stop) return unreached(code, nowMs);
      const pub = publicCodeOf(stop);
      const shuttle = shuttleCalls(stop);
      const [s, p] = await Promise.all([
        shuttle ? getArrivals(env, ctx, code, nowMs, (sa) => ctx.waitUntil(logBoard(env, sa))).catch(() => null) : undefined,
        pub ? getPublicArrivals(env, ctx, graph, code, pub, nowMs).catch(() => null) : undefined,
      ]);
      if (s === undefined) return p ?? unreached(code, nowMs);
      if (p === undefined) return s ?? unreached(code, nowMs);
      return mergeFeeds(code, nowMs, s, p);
    }),
  );
  return new Map(codes.map((code, i) => [code, settled[i]]));
}

export function mergeFeeds(code: string, nowMs: number, shuttle: StopArrivals | null, pub: StopArrivals | null): StopArrivals {
  const state = (sa: StopArrivals | null): FeedState =>
    sa ? { fetchedAt: sa.fetchedAt, stale: sa.stale, available: sa.available } : { fetchedAt: nowMs, stale: false, available: false };
  const up = [shuttle, pub].filter((sa): sa is StopArrivals => sa !== null && sa.available);
  return {
    code,
    arrivals: [...(shuttle?.arrivals ?? []), ...(pub?.arrivals ?? [])],
    fetchedAt: up.length ? Math.min(...up.map((sa) => sa.fetchedAt)) : nowMs,
    stale: up.some((sa) => sa.stale),
    available: up.length > 0,
    feeds: { shuttle: state(shuttle), public: state(pub) },
    ...(shuttle?.unread ? { unread: shuttle.unread } : {}),
  };
}

export async function answerFor(
  env: Env,
  ctx: ExecutionContext,
  input: ResolveInput,
  destLabel: string | null,
  nowMs: number,
  collect: typeof collectArrivals = collectArrivals,
): Promise<Answer> {
  const graph = input.publicBuses ? GRAPH_PUBLIC : GRAPH;
  const idx = indexGraph(graph);
  const cands = candidateStops(graph, input, { nowMs });
  const originStop = input.originCode ? (idx.byCode.get(input.originCode) ?? null) : null;
  const fallbackStop = cands[0]?.stop ?? originStop;

  const dest = input.to ? idx.byCode.get(input.to) : undefined;
  const destSides = [input.to, ...(input.destAt ? [] : (input.toAlso ?? []))]
    .map((c) => (c ? idx.byCode.get(c) : undefined))
    .filter((s): s is Stop => Boolean(s))
    .flatMap((s) => {
      const opp = s.opposite ? idx.byCode.get(s.opposite) : undefined;
      return opp ? [s, opp] : [s];
    });
  const walkS = (d: Stop) =>
    input.lat != null ? haversineM(input.lat, input.lon!, d.lat, d.lon) / WALK.speedMs : input.originCode === d.code ? 0 : Infinity;
  const atDest = destSides.filter((d) => walkS(d) < 45).sort((a, b) => walkS(a) - walkS(b))[0];
  const atVenue =
    input.lat != null && input.destAt != null && haversineM(input.lat, input.lon!, input.destAt.lat, input.destAt.lon) <= WALK.atVenueM;
  if (dest && (atDest || atVenue)) return arrivedAnswer(atDest ?? dest, destLabel, nowMs);
  if (!cands.length) {
    return { ...needsSetupAnswer(nowMs), label: m().noStartPoint, detail: m().noStartPointHint };
  }

  const transfers = planTransfers(graph, input, cands);
  const crowdLoad =
    input.arriveBy && env.DB
      ? loadCrowdRisk(
          env.DB,
          cands.map((c) => c.stop.code),
          nowMs,
        )
      : undefined;
  const byStop = await collect(env, ctx, [...cands.map((c) => c.stop.code), ...transfers.fetch], nowMs, graph);

  if (env.DB) ctx.waitUntil(recordCrowds(env.DB, byStop, nowMs));
  const crowdRisk = await crowdLoad;

  const endWalk = (o: ScoredOption) => endWalkFromS(input, o.to?.code);
  const walkWeight = input.walkWeight ?? WALK.sunWeight;
  const options = scoreOptions(graph, cands, byStop, nowMs, endWalk, {
    walkWeight,
    ...(input.arriveBy ? { openBy: input.arriveBy.atMs } : {}),
    ...(transfers.routes.length ? { transfers: transfers.routes } : {}),
  });
  const alt = pickAlt(options);
  const chosen = options[0]?.stop.code ?? fallbackStop?.code ?? '';
  const arrivals: Arrival[] = (byStop.get(chosen)?.arrivals ?? []).map((a) =>
    a.svc === svcName(a.svc) ? a : { ...a, svc: svcName(a.svc) },
  );

  const walk = wholeWalk(graph, input, originStop ?? fallbackStop);
  const walkAllS = walk?.s ?? null;
  const walkEndS = walk?.endS ?? endWalkFromS(input);
  const answer = buildAnswer({
    options,
    alt,
    fallbackStop,
    nearestStop: nearestStop(graph, input.lat, input.lon),
    origin: input.lat == null ? originStop : null,
    destLabel,
    walkAllS,
    endWalk,
    walkEndS,
    walkWeight,
    confidence: confidence(options, input.lat != null, endWalk, walkWeight),
    arrivals,
    nowMs,
  });
  const walking = answer.departsAt == null && answer.arriveAt != null;
  const leaveInput: LeaveInput = {
    options,
    candidates: cands,
    byStop,
    graph,
    arriveBy: input.arriveBy,
    walkAllS: walking ? walkAllS : null,
    walkEndS,
    endWalk,
    walkWeight,
    nowMs,
    crowdRisk,
  };
  answer.leave = leaveBy(leaveInput);
  if (input.step) Object.assign(answer, withSteps(answer, leaveInput, input.step, walking, nowMs));

  if (input.log !== false)
    logAnswer(env, {
      answer,
      best: options[0] ?? null,
      dest: input.to,
      hadCoords: input.lat != null,
      walkAllS,
    });

  return answer;
}

export function withSteps(
  answer: Answer,
  f: LeaveInput,
  step: NonNullable<ResolveInput['step']>,
  walking: boolean,
  nowMs: number,
): Pick<Answer, 'steps' | 'leave'> {
  const firstMs = answer.departsAt ? Date.parse(answer.departsAt) : nowMs;
  const lastArriveMs = f.arriveBy ? f.arriveBy.atMs + STEP.lateMaxS * 1000 : null;
  const until = lastArriveMs ?? Math.max(firstMs, nowMs) + STEP.laterMaxS * 1000 + STEP_WALK_MS;
  const all = departures(f, until, step.target);
  const best = f.options[0];
  const headline = !walking && best && answer.departsAt ? departureOf(all, best) : null;
  const leave = answer.leave && !f.arriveBy && headline ? { ...answer.leave, bus: headline.bus } : answer.leave;
  const own = leave ? (leave.svc ? leave : null) : headline;
  const s = stepFrom({ trip: step.trip, own, all, target: step.target, lastArriveMs, nowMs });
  if (!s) return { steps: null };
  return s.steps.moved ? { steps: s.steps, leave: publicLeave(s.leave) } : { steps: s.steps };
}

const STEP_WALK_MS = 30 * 60_000;

export function unlogged<D extends { answerFor: typeof answerFor }>(deps: D): D {
  return { ...deps, answerFor: (env, ctx, input, label, nowMs) => deps.answerFor(env, ctx, { ...input, log: false }, label, nowMs) };
}

export function arrivedAnswer(stop: Stop, destLabel: string | null, nowMs: number): Answer {
  return {
    label: m().youreHere,
    detail:
      destLabel && !destLabel.includes(' @ ') && destLabel !== stop.name && destLabel !== shortStop(stop.name, 14)
        ? m().destIsAt(destLabel, stop.name)
        : m().youreAt(stop.name),
    alt: null,
    stop: { code: stop.code, name: stop.name, confidence: 1 },
    quality: 'live',
    asOf: new Date(nowMs).toISOString(),
    arrivals: [],
    arrived: true,
    leave: null,
  };
}

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
