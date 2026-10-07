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
import { MAX_ETA_S, TTL } from './config.ts';
import { UpstreamUnreachable, timedFetch } from './http.ts';
import { cacheBase, cachedFetch } from './edgecache.ts';
import { indexGraph } from './resolve.ts';

export const LTA_BASE = 'https://datamall2.mytransport.sg/ltaodataservice/';

export function ltaConfigured(env: Env): boolean {
  return Boolean(env.LTA_ACCOUNT_KEY);
}

/** DataMall refused us: the key is wrong or revoked (401), we're over the
 *  limit (429), or it is down (5xx). Any of them trips its breaker, as the
 *  same answers from NUS trip the shuttle feed's. */
export class LtaRefused extends Error {
  readonly status: number;
  constructor(status: number) {
    super(status >= 500 ? `DataMall answered HTTP ${status}` : `DataMall refused: HTTP ${status}`);
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
  const here = routesHere(graph, stopCode, serviceNo);
  if (here.length === 1) return here[0][0];
  const byDest = here.find(([, p]) => destinationCode !== null && p.dest === destinationCode);
  return byDest ? byDest[0] : null;
}

/** The graph's routes of `serviceNo` that call at `stopCode`. */
function routesHere(graph: Graph, stopCode: string, serviceNo: string) {
  const idx = indexGraph(graph);
  return Object.entries(graph.public ?? {}).filter(([key, p]) => p.svc === serviceNo && idx.routes.get(key)?.pos.has(stopCode));
}

const SLOTS = ['NextBus', 'NextBus2', 'NextBus3'];

/** A time with its zone, as DataMall sends it (+08:00). Without one,
 *  Date.parse reads it in the runtime's own zone, UTC on Workers: 8 h out. */
const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * One NextBus slot, by value: when the bus comes (epoch ms), `empty` for
 * the feed's empty slot (every field "", as at night), or `unreadable`:
 * not an object, no EstimatedArrival, or one that isn't a zoned time
 * within MAX_ETA_S.
 */
function readSlot(bus: unknown, nowMs: number): number | 'empty' | 'unreadable' {
  if (!bus || typeof bus !== 'object' || Array.isArray(bus)) return 'unreadable';
  const v = (bus as Record<string, unknown>).EstimatedArrival;
  if (v === '') return 'empty';
  if (typeof v !== 'string' || !ZONED.test(v.trim())) return 'unreadable';
  const at = Date.parse(v.trim());
  return Number.isFinite(at) && at - nowMs <= MAX_ETA_S * 1000 ? at : 'unreadable';
}

/**
 * Whether DataMall says the time is from a bus on the road: Monitored 1.
 * Anything else (0, false, missing, a word) is the timetable, so a change
 * in how the field is written can only make a time less sure, never pass
 * a timetabled one off as live.
 */
const monitored = (v: unknown) => v === 1 || v === true || (typeof v === 'string' && v.trim() === '1');

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
    for (const slot of SLOTS) {
      const at = readSlot(row[slot], nowMs);
      if (typeof at !== 'number') continue;
      const b = row[slot] as Record<string, unknown>;
      const svc = routeFor(graph, stopCode, serviceNo, b.DestinationCode == null ? null : String(b.DestinationCode));
      if (!svc) continue;
      // Seconds from now. A bus a minute gone is gone; one just due is "now".
      const etaS = Math.round((at - nowMs) / 1000);
      if (etaS < -60) continue;
      out.push({
        svc,
        etaS: Math.max(1, etaS),
        crowd: parseLoad(b.Load),
        plate: null,
        berth: null,
        ...(monitored(b.Monitored) ? {} : { scheduled: true }),
      });
    }
  }
  return out;
}

/**
 * Why a reply can't be read, or null, by the values normalizePublic() reads.
 * Read as it is, a reply whose fields moved says "no bus" for a service, or
 * every one: each public answer turns into a headway guess with nobody told.
 * So every service needs its NextBus, and every slot an EstimatedArrival
 * that is a time or the empty slot's "". Where both directions of a
 * service call, each bus needs its destination to say which it is running.
 *
 * Not problems: a service the graph doesn't know (it only knows the
 * campus's, and adds new ones weekly), a bus already gone, a destination
 * the graph doesn't end a route at (a short trip).
 */
export function publicProblem(raw: unknown, stopCode: string, graph: Graph, nowMs: number): string | null {
  const services = (raw as { Services?: unknown })?.Services;
  if (!Array.isArray(services)) return 'no Services list';
  for (const s of services) {
    if (!s || typeof s !== 'object') return 'a service it cannot read';
    const row = s as Record<string, unknown>;
    const serviceNo = String(row.ServiceNo ?? '').trim();
    if (!serviceNo) return 'a service with no ServiceNo';
    if (!('NextBus' in row)) return `no NextBus for ${serviceNo}`;
    for (const slot of SLOTS) {
      if (!(slot in row)) continue;
      const at = readSlot(row[slot], nowMs);
      if (at === 'unreadable') return `an arrival time it cannot read (${serviceNo})`;
      if (at === 'empty') continue;
      const dest = (row[slot] as Record<string, unknown>).DestinationCode;
      if ((dest == null || dest === '') && routesHere(graph, stopCode, serviceNo).length > 1) return `a bus with no destination (${serviceNo})`;
    }
  }
  return null;
}

/** One stop's public buses, straight from DataMall. `code` is the graph's stop; `ltaCode` LTA's for it. */
export async function fetchPublicArrivals(env: Env, graph: Graph, code: string, ltaCode: string, nowMs: number = Date.now()): Promise<StopArrivals> {
  if (!ltaConfigured(env)) throw new Error('DataMall not configured');
  const res = await timedFetch('DataMall', `${LTA_BASE}v3/BusArrival?BusStopCode=${encodeURIComponent(ltaCode)}`, {
    headers: { AccountKey: env.LTA_ACCOUNT_KEY!, accept: 'application/json' },
  });
  if (res.status === 401 || res.status === 429 || res.status >= 500) throw new LtaRefused(res.status);
  if (!res.ok) throw new Error(`DataMall answered HTTP ${res.status}`);
  const body: unknown = await res.json();
  const arrivals = normalizePublic(body, code, graph, nowMs);
  const problem = publicProblem(body, code, graph, nowMs);
  if (problem) throw new Error(`DataMall answered in an unknown shape (${problem})`);
  return { code, arrivals, fetchedAt: nowMs, stale: false, available: true };
}

/**
 * One stop's public buses through the edge cache (edgecache.ts): one call
 * per stop per TTL.arrivalsMs, stale served while a fresh one is fetched, a
 * failed stop not asked again for failMemoS. A refused key, a 429, a 5xx
 * or no answer at all (a timeout, a failed connection) quiets every stop
 * for breakerS: no other stop would fare better.
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
    breaker: { key: `${cacheBase()}/breaker-public`, trips: (err) => err instanceof LtaRefused || err instanceof UpstreamUnreachable, maxAgeS: TTL.breakerS },
    inflight,
  });
}

const inflight = new Map<string, Promise<StopArrivals>>();
