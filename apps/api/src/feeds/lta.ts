import type { Arrival, Crowd, Env, Graph, StopArrivals } from '../types.ts';
import { MAX_ETA_S, TTL } from '../config.ts';
import { UpstreamUnreachable, timedFetch } from '../http.ts';
import { cacheBase, cachedFetch } from './edgecache.ts';
import { GateBusy, throughGate } from './feedgate.ts';
import { noteBreakerOpen } from './feedwatch.ts';
import { onceEvery } from '../memo.ts';

export const LTA_BASE = 'https://datamall2.mytransport.sg/ltaodataservice/';

export function ltaConfigured(env: Env): boolean {
  return Boolean(env.LTA_ACCOUNT_KEY);
}

export class LtaRefused extends Error {
  readonly status: number;
  constructor(status: number) {
    super(status >= 500 ? `DataMall answered HTTP ${status}` : `DataMall refused: HTTP ${status}`);
    this.status = status;
  }
}

export function parseLoad(v: unknown): Crowd | null {
  const s = String(v ?? '')
    .trim()
    .toUpperCase();
  return s === 'SEA' ? 'low' : s === 'SDA' ? 'medium' : s === 'LSD' ? 'high' : null;
}

export function routeFor(graph: Graph, stopCode: string, serviceNo: string, destinationCode: string | null): string | null {
  const here = routesHere(graph, stopCode, serviceNo);
  if (here.length === 1) return here[0][0];
  const byDest = here.find(([, p]) => destinationCode !== null && p.dest === destinationCode);
  return byDest ? byDest[0] : null;
}

function routesHere(graph: Graph, stopCode: string, serviceNo: string) {
  return Object.entries(graph.public ?? {}).filter(([key, p]) => p.svc === serviceNo && graph.routes[key]?.includes(stopCode));
}

const SLOTS = ['NextBus', 'NextBus2', 'NextBus3'];

const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function readSlot(bus: unknown, nowMs: number): number | 'empty' | 'unreadable' {
  if (!bus || typeof bus !== 'object' || Array.isArray(bus)) return 'unreadable';
  const v = (bus as Record<string, unknown>).EstimatedArrival;
  if (v === '') return 'empty';
  if (typeof v !== 'string' || !ZONED.test(v.trim())) return 'unreadable';
  const at = Date.parse(v.trim());
  return Number.isFinite(at) && at - nowMs <= MAX_ETA_S * 1000 ? at : 'unreadable';
}

const monitored = (v: unknown) => v === 1 || v === true || (typeof v === 'string' && v.trim() === '1');

export function normalizePublic(raw: unknown, stopCode: string, graph: Graph, nowMs: number): Arrival[] {
  const out: Arrival[] = [];
  const unplaced = new Set<string>();
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
      if (!svc) {
        if (routesHere(graph, stopCode, serviceNo).length) unplaced.add(`${serviceNo} to ${String(b.DestinationCode ?? '?')}`);
        continue;
      }
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
  if (unplaced.size && unplacedWarnings.due(stopCode, nowMs))
    console.warn(`DataMall at ${stopCode}: buses matching neither direction left out: ${[...unplaced].slice(0, 4).join(', ')}`);
  return out;
}

const unplacedWarnings = onceEvery(3_600_000, 500);

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
      if ((dest == null || dest === '') && routesHere(graph, stopCode, serviceNo).length > 1)
        return `a bus with no destination (${serviceNo})`;
    }
  }
  return null;
}

export async function fetchPublicArrivals(
  env: Env,
  graph: Graph,
  code: string,
  ltaCode: string,
  nowMs: number = Date.now(),
): Promise<StopArrivals> {
  if (!ltaConfigured(env)) throw new Error('DataMall not configured');
  const res = await timedFetch('DataMall', `${LTA_BASE}v3/BusArrival?BusStopCode=${encodeURIComponent(ltaCode)}`, {
    headers: { AccountKey: env.LTA_ACCOUNT_KEY!, accept: 'application/json' },
  });
  if (res.status === 401 || res.status === 429 || res.status >= 500) throw new LtaRefused(res.status);
  if (!res.ok) throw new Error(`DataMall answered HTTP ${res.status}`);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`DataMall answered non-JSON (${res.status}): ${text.slice(0, 80)}`);
  }
  const arrivals = normalizePublic(body, code, graph, nowMs);
  const problem = publicProblem(body, code, graph, nowMs);
  if (problem) throw new Error(`DataMall answered in an unknown shape (${problem})`);
  return { code, arrivals, fetchedAt: nowMs, stale: false, available: true };
}

export async function getPublicArrivals(
  env: Env,
  ctx: ExecutionContext,
  graph: Graph,
  code: string,
  ltaCode: string,
  nowMs: number = Date.now(),
): Promise<StopArrivals> {
  return cachedFetch<StopArrivals>({
    ctx,
    nowMs,
    key: `${cacheBase()}/public/${encodeURIComponent(ltaCode)}`,
    failKey: `${cacheBase()}/failed-public/${encodeURIComponent(ltaCode)}`,
    fetch: () => throughGate(env, ctx, `public/${ltaCode}`, TTL.arrivalsMs, () => fetchPublicArrivals(env, graph, code, ltaCode, nowMs)),
    freshMs: TTL.arrivalsMs,
    staleMaxS: TTL.staleMaxS,
    failMemoS: TTL.failMemoS,
    raceMs: TTL.staleRaceMs,
    memoes: (err) => !(err instanceof GateBusy),
    breaker: {
      key: `${cacheBase()}/breaker-public`,
      opens: (err) => err instanceof LtaRefused || err instanceof UpstreamUnreachable,
      maxAgeS: TTL.breakerS,
      onOpen: (err) => noteBreakerOpen(env, 'lta', err, nowMs),
    },
    inflight,
  });
}

const inflight = new Map<string, Promise<StopArrivals>>();
