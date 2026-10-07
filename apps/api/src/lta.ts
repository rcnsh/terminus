/**
 * LTA DataMall client: the public buses at one stop.
 *
 * `normalizePublic()` is the ONLY place that touches DataMall's shape. The
 * feed is documented (the DataMall API user guide), but a feed is a feed:
 * read tolerantly here, and everything downstream sees a clean Arrival[].
 *
 * Each call names a stop by LTA's five-digit code and gets the next three
 * buses per service: an arrival time, whether it's from a bus on the road or
 * the timetable, and how full it is. The feed moves every 20 s and answers
 * in about half a second. It goes through the same edge cache as the shuttle
 * feed (TTL.arrivalsMs), so a stop costs one call per 15 s however many ask.
 *
 * Contains information from LTA DataMall, under the Singapore Open Data
 * Licence.
 */

import type { Arrival, Crowd, Env, Graph, StopArrivals } from './types.ts';
import { TTL } from './config.ts';
import { timedFetch } from './http.ts';
import { cacheBase, cachedFetch } from './edgecache.ts';
import { indexGraph } from './resolve.ts';

export const LTA_BASE = 'https://datamall2.mytransport.sg/ltaodataservice/';

export function ltaConfigured(env: Env): boolean {
  return Boolean(env.LTA_ACCOUNT_KEY);
}

/** DataMall refused us: the key is wrong or revoked (401), or we're over the limit (429). */
export class LtaRefused extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`DataMall refused: HTTP ${status}`);
    this.status = status;
  }
}

/** SEA (seats), SDA (standing), LSD (limited standing), as the guide names them. */
export function parseLoad(v: unknown): Crowd | null {
  const s = String(v ?? '').trim().toUpperCase();
  return s === 'SEA' ? 'low' : s === 'SDA' ? 'medium' : s === 'LSD' ? 'high' : null;
}

/**
 * Which route of the graph a bus on `serviceNo` at `stopCode` is running.
 * A loop or one-way service is one route named after it. A two-way service
 * is two (`151/1`, `151/2`), and only one of them calls at most stops; where
 * both do, the bus's destination (the whole route's last stop) tells.
 */
export function routeFor(graph: Graph, stopCode: string, serviceNo: string, destinationCode: string | null): string | null {
  const idx = indexGraph(graph);
  const here = Object.entries(graph.public ?? {}).filter(([key, p]) => p.svc === serviceNo && idx.routes.get(key)?.pos.has(stopCode));
  if (here.length === 1) return here[0][0];
  const byDest = here.find(([, p]) => destinationCode !== null && p.dest === destinationCode);
  return byDest ? byDest[0] : null;
}

/**
 * DataMall's BusArrival reply -> clean Arrival[] for the graph's stop `stopCode`.
 *
 * {BusStopCode, Services: [{ServiceNo, Operator, NextBus, NextBus2, NextBus3}]},
 * each bus {EstimatedArrival (ISO, +08:00), Monitored (1 live, 0 timetable),
 * Load, Latitude, Longitude, OriginCode, DestinationCode, VisitNumber, Type}.
 * A bus with no arrival time is an empty slot (at night there may be one bus
 * left). Services the graph doesn't know are dropped: this is the campus's
 * stops, and every service that calls at them is in the graph.
 */
export function normalizePublic(raw: unknown, stopCode: string, graph: Graph, nowMs: number): Arrival[] {
  const out: Arrival[] = [];
  const services = (raw as { Services?: unknown })?.Services;
  if (!Array.isArray(services)) return out;
  for (const s of services) {
    if (!s || typeof s !== 'object') continue;
    const row = s as Record<string, unknown>;
    const serviceNo = String(row.ServiceNo ?? '').trim();
    if (!serviceNo) continue;
    for (const slot of ['NextBus', 'NextBus2', 'NextBus3']) {
      const bus = row[slot];
      if (!bus || typeof bus !== 'object') continue;
      const b = bus as Record<string, unknown>;
      const at = typeof b.EstimatedArrival === 'string' && b.EstimatedArrival ? Date.parse(b.EstimatedArrival) : NaN;
      if (!Number.isFinite(at)) continue;
      const svc = routeFor(graph, stopCode, serviceNo, b.DestinationCode == null ? null : String(b.DestinationCode));
      if (!svc) continue;
      // Seconds from now. A bus a minute gone is gone; one just due is "now".
      const etaS = Math.round((at - nowMs) / 1000);
      if (etaS < -60) continue;
      const monitored = String(b.Monitored ?? '1') !== '0';
      out.push({
        svc,
        etaS: Math.max(1, etaS),
        crowd: parseLoad(b.Load),
        plate: null,
        berth: null,
        ...(monitored ? {} : { scheduled: true }),
      });
    }
  }
  return out;
}

/**
 * Why a reply with services can't be read, or null. A reply with services
 * and not one usable bus means the shape moved under us: read as "no bus"
 * it would turn every public answer into a headway guess with nobody told.
 */
export function publicProblem(raw: unknown, arrivals: Arrival[]): string | null {
  const services = (raw as { Services?: unknown })?.Services;
  if (!Array.isArray(services)) return 'no Services list';
  if (!services.length || arrivals.length) return null;
  const buses = services.flatMap((s) => (s && typeof s === 'object' ? [(s as Record<string, unknown>).NextBus] : [])).filter((b) => b && typeof b === 'object') as Record<string, unknown>[];
  if (!buses.length) return null; // services listed with no bus on each: a real "no bus"
  if (!buses.some((b) => typeof b.EstimatedArrival === 'string' && b.EstimatedArrival)) return null; // every slot empty
  return 'no bus could be placed on a route';
}

/** One stop's public buses, straight from DataMall. `code` is the graph's stop; `ltaCode` LTA's for it. */
export async function fetchPublicArrivals(env: Env, graph: Graph, code: string, ltaCode: string, nowMs: number = Date.now()): Promise<StopArrivals> {
  if (!ltaConfigured(env)) throw new Error('DataMall not configured');
  const res = await timedFetch('DataMall', `${LTA_BASE}v3/BusArrival?BusStopCode=${encodeURIComponent(ltaCode)}`, {
    headers: { AccountKey: env.LTA_ACCOUNT_KEY!, accept: 'application/json' },
  });
  if (res.status === 401 || res.status === 429) throw new LtaRefused(res.status);
  if (!res.ok) throw new Error(`DataMall answered HTTP ${res.status}`);
  const body: unknown = await res.json();
  const arrivals = normalizePublic(body, code, graph, nowMs);
  const problem = publicProblem(body, arrivals);
  if (problem) throw new Error(`DataMall answered in an unknown shape (${problem})`);
  return { code, arrivals, fetchedAt: nowMs, stale: false, available: true };
}

/**
 * One stop's public buses through the edge cache (edgecache.ts): one call
 * per stop per TTL.arrivalsMs, stale served while a fresh one is fetched, a
 * failed stop not asked again for failMemoS. A refused key quiets every
 * stop for breakerS: it won't be right again until someone fixes it.
 */
export async function getPublicArrivals(env: Env, ctx: ExecutionContext, graph: Graph, code: string, ltaCode: string, nowMs: number = Date.now()): Promise<StopArrivals> {
  return cachedFetch<StopArrivals>({
    ctx,
    nowMs,
    key: `${cacheBase()}/public/${encodeURIComponent(ltaCode)}`,
    failKey: `${cacheBase()}/failed-public/${encodeURIComponent(ltaCode)}`,
    fetch: () => fetchPublicArrivals(env, graph, code, ltaCode, nowMs),
    freshMs: TTL.arrivalsMs,
    staleMaxS: TTL.staleMaxS,
    failMemoS: TTL.failMemoS,
    raceMs: TTL.staleRaceMs,
    breaker: { key: `${cacheBase()}/breaker-public`, trips: (err) => err instanceof LtaRefused, maxAgeS: TTL.breakerS },
    inflight,
  });
}

const inflight = new Map<string, Promise<StopArrivals>>();
