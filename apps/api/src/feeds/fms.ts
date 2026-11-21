import type { Arrival, Crowd, Env, StopArrivals } from '../types.ts';
import { MAX_ETA_S, TTL } from '../config.ts';
import { UpstreamUnreachable, timedFetch } from '../http.ts';
import { cacheBase, cachedFetch, flagged } from './edgecache.ts';
import { GateBusy, throughGate } from './feedgate.ts';
import { noteBreakerOpen } from './feedwatch.ts';
import { writeRow } from '../analytics-rows.ts';
import {
  UpstreamHttpError,
  UpstreamRejected,
  MintQuiet,
  NO_REMINT_CODES,
  getSession,
  markIfOutdated,
  mintWith,
  proxyEnvelope,
  proxyHeaders,
  redactDetail,
  renewAhead,
  renewSession,
} from './auth.ts';
import type { Session } from './auth.ts';
import graphJson from '../../data/stops.json' with { type: 'json' };

const WRAPPER_KEYS = [
  'ShuttleServiceResult',
  'BusStopsResult',
  'PickupPointResult',
  'ServiceDescriptionResult',
  'etas',
  'result',
  'Result',
  'data',
  'Data',
  'response',
];

export function unwrap(node: unknown): unknown {
  let cur = node;
  for (let i = 0; i < 8; i++) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return cur;
    const o = cur as Record<string, unknown>;
    const key = WRAPPER_KEYS.find((k) => k in o);
    if (!key) return cur;
    cur = o[key];
  }
  return cur;
}

const isRow = (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x);

function findList(node: unknown, keys: string[]): unknown[] | null {
  const root = unwrap(node);
  if (Array.isArray(root)) return root;
  if (!root || typeof root !== 'object') return null;
  const o = root as Record<string, unknown>;
  for (const k of keys) {
    const v = unwrap(o[k]);
    if (Array.isArray(v)) return v;
  }
  for (const v of Object.values(o)) {
    const u = unwrap(v);
    if (Array.isArray(u) && u.some(isRow)) return u;
  }
  return null;
}

export function pickList(node: unknown, keys: string[]): unknown[] {
  return findList(node, keys) ?? [];
}

const ARRIVAL_LIST_KEYS = ['timings', 'shuttles', 'Shuttles', 'ShuttleService', 'services', 'arrivals'];
const BUS_LIST_KEYS = ['activebus', 'activeBus', 'ActiveBus', 'buses'];
const BUS_PLATE_KEYS = ['vehplate', 'veh_plate', 'vehiclePlate', 'plate'];

const NO_BUS = new Set(['-', '--', '', 'n.a.', 'na', 'n/a', 'nil', 'null', 'undefined', '?']);
const departed = (low: string): boolean => low.startsWith('lv') || low.startsWith('left') || low.startsWith('dep');

export function parseEtaS(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') {
    return Number.isFinite(v) && v >= 0 ? capped(Math.round(v * 60)) : null;
  }
  const s = String(v).trim();
  const low = s.toLowerCase();
  if (NO_BUS.has(low)) return null;
  if (low.startsWith('arr')) return 0;
  if (departed(low)) return null;
  if (/[-:]/.test(s)) return null;
  const cleaned = s.replace(/[^0-9.]/g, '');
  if (!cleaned || cleaned === '.') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return capped(Math.round(n * 60));
}

const capped = (s: number): number | null => (Number.isFinite(s) && s <= MAX_ETA_S ? s : null);

export function parseSeconds(v: unknown): number | null {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v)) n = Number(v);
  else return null;
  return Number.isFinite(n) && n >= 0 ? capped(Math.round(n)) : null;
}

function saysNoBus(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const low = v.trim().toLowerCase();
  return NO_BUS.has(low) || departed(low);
}

export function parseCrowd(v: unknown): Crowd | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v < 34 ? 'low' : v < 67 ? 'medium' : 'high';
  }
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseCrowd(Number(s));
  if (s.startsWith('lo') || s.startsWith('empt') || s.startsWith('seat') || s === 'green') return 'low';
  if (s.startsWith('med') || s.startsWith('stand') || s.startsWith('mod') || s === 'amber' || s === 'yellow') return 'medium';
  if (s.startsWith('hi') || s.startsWith('full') || s.startsWith('crowd') || s === 'red') return 'high';
  return null;
}

export function crowdFromLoad(capacity: unknown, ridership: unknown): Crowd | null {
  if (capacity == null || ridership == null || (typeof ridership === 'string' && !ridership.trim())) return null;
  const cap = Number(capacity);
  const rid = Number(ridership);
  if (!Number.isFinite(cap) || cap <= 0 || !Number.isFinite(rid) || rid < 0) return null;
  return parseCrowd(Math.round((rid / cap) * 100));
}

function plateOf(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s && s !== '-' ? s : null;
}

function field(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] != null) return o[k];
  return null;
}

const KNOWN_SERVICES: ReadonlySet<string> = new Set(Object.keys((graphJson as { routes: Record<string, unknown> }).routes));

const SERVICE_NAMES = new Map([...KNOWN_SERVICES].map((s) => [s.replace(/\s+/g, '').toUpperCase(), s]));

function serviceOf(v: unknown): string {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  const s = String(v).trim();
  return SERVICE_NAMES.get(s.replace(/\s+/g, '').toUpperCase()) ?? s;
}

const ROW_NAME = ['name', 'route', 'serviceName', 'ShuttleName', 'svc'];
const ROW_TIME = ['arrivalTime', 'eta', 'arrival'];
const ROW_NEXT_TIME = ['nextArrivalTime', 'nextEta'];
const ETA_TIME = ['eta', 'arrivalTime', 'ETA', 'time'];
const ETA_LISTS = ['_etas', 'nextArrivals'];

export function normalize(raw: unknown): Arrival[] {
  const list = pickList(raw, ARRIVAL_LIST_KEYS);
  const out: Arrival[] = [];

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const svc = serviceOf(field(item, ...ROW_NAME));
    if (!svc) continue;

    const berth = plateOf(field(item, 'busStopCode', 'busstopcode'));
    const ends = berth?.toUpperCase().endsWith('-E') ? { ends: true as const } : {};

    const etas = pickList(field(item, ...ETA_LISTS) ?? [], []);
    if (etas.length) {
      for (const e of etas) {
        if (!e || typeof e !== 'object') continue;
        const row = e as Record<string, unknown>;
        const etaS = parseSeconds(row.eta_s) ?? parseEtaS(field(row, ...ETA_TIME));
        out.push({
          svc,
          etaS,
          crowd: crowdFromLoad(row.capacity, row.ridership) ?? parseCrowd(field(row, 'px', 'passengers', 'crowd', 'load', 'occupancy')),
          plate: plateOf(field(row, 'plate', 'vehiclePlate', 'veh_plate', 'vehicle')),
          berth,
          ...ends,
        });
      }
      continue;
    }

    out.push({
      svc,
      etaS: parseEtaS(field(item, ...ROW_TIME)),
      crowd: crowdFromLoad(item.arrivalTime_capacity, item.arrivalTime_ridership) ?? parseCrowd(field(item, 'passengers', 'crowd', 'load')),
      plate: plateOf(field(item, 'arrivalTime_veh_plate', 'vehiclePlate', 'plate')),
      berth,
      ...ends,
    });
    const nextEta = parseEtaS(field(item, ...ROW_NEXT_TIME));
    if (nextEta != null) {
      out.push({
        svc,
        etaS: nextEta,
        crowd:
          crowdFromLoad(item.nextArrivalTime_capacity, item.nextArrivalTime_ridership) ??
          parseCrowd(field(item, 'nextPassengers', 'nextArrivalTime_passengers')),
        plate: plateOf(field(item, 'nextArrivalTime_veh_plate', 'nextVehiclePlate')),
        berth,
        ...ends,
      });
    }
  }

  const seen = new Set<string>();
  return out.filter((a) => {
    const k = `${a.svc}|${a.etaS}|${a.plate ?? ''}|${a.berth ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const objects = (list: unknown[]) => list.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
const hasKey = (o: Record<string, unknown>, ...keys: string[]) => keys.some((k) => o[k] !== undefined);

function rowTimes(item: Record<string, unknown>): { read: boolean; garbled: boolean } {
  let read = false;
  let garbled = false;
  const see = (v: unknown, parse: (v: unknown) => number | null) => {
    if (v == null) return;
    if (parse(v) != null || saysNoBus(v)) read = true;
    else garbled = true;
  };
  const list = field(item, ...ETA_LISTS);
  const listed = pickList(list ?? [], []);
  const etas = objects(listed);
  if (etas.length) {
    for (const e of etas) {
      if (parseSeconds(e.eta_s) != null) read = true;
      else if (field(e, ...ETA_TIME) != null) see(field(e, ...ETA_TIME), parseEtaS);
      else see(e.eta_s, parseSeconds);
    }
    return { read, garbled };
  }
  if (listed.length) garbled = true;
  else if (list != null) read = true;
  see(field(item, ...ROW_TIME), parseEtaS);
  const next = field(item, ...ROW_NEXT_TIME);
  if (next != null && parseEtaS(next) == null && !saysNoBus(next)) garbled = true;
  return { read, garbled };
}

function rowsRead(raw: unknown): { svc: string; read: boolean; garbled: boolean }[] {
  return objects(pickList(raw, ARRIVAL_LIST_KEYS))
    .map((r) => ({ svc: serviceOf(field(r, ...ROW_NAME)), row: r }))
    .filter((t): t is { svc: string; row: Record<string, unknown> } => Boolean(t.svc))
    .map((t) => ({ svc: t.svc, ...rowTimes(t.row) }));
}

export function arrivalsProblem(
  raw: unknown,
  arrivals: Arrival[] = normalize(raw),
  known: ReadonlySet<string> = KNOWN_SERVICES,
): string | null {
  const rows = objects(pickList(raw, ARRIVAL_LIST_KEYS));
  if (!rows.length) return null;
  if (!arrivals.length) return 'no row names a service';
  if (!arrivals.some((a) => known.has(a.svc)))
    return `no service it names is known (${[...new Set(arrivals.map((a) => a.svc))].slice(0, 4).join(', ')})`;
  const times = rowsRead(raw);
  if (times.some((t) => t.read && !t.garbled)) return null;
  const garbled = times.filter((t) => t.garbled).map((t) => t.svc);
  if (garbled.length) return `a time it cannot read (${[...new Set(garbled)].slice(0, 4).join(', ')})`;
  return 'no row has an arrival time';
}

export function arrivalsUnread(raw: unknown): string[] {
  return [
    ...new Set(
      rowsRead(raw)
        .filter((t) => t.garbled || !t.read)
        .map((t) => t.svc),
    ),
  ];
}

const zero = (v: unknown) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number(v) === 0;
const noFixYet = (r: Record<string, unknown>) => zero(field(r, 'lat', 'latitude')) && zero(field(r, 'lng', 'lon', 'longitude'));

export function busesProblem(raw: unknown, buses: RawBus[] = normalizeBuses(raw)): string | null {
  const rows = objects(pickList(raw, BUS_LIST_KEYS));
  if (!rows.length) return null;
  if (!rows.some((r) => hasKey(r, ...BUS_PLATE_KEYS))) return 'no row has a plate';
  if (!rows.some((r) => hasKey(r, 'lat', 'latitude') && hasKey(r, 'lng', 'lon', 'longitude'))) return 'no row has a position';
  if (!buses.length && !rows.every(noFixYet)) return 'no bus has a plate and a position it can read';
  return null;
}

export function fmsConfigured(env: Env): boolean {
  return Boolean(env.NEXTBUS_PROXY_BASE && env.NEXTBUS_PROXY_API_KEY);
}

export function proxyUrl(env: Env, endpoint: string): string {
  return `${(env.NEXTBUS_PROXY_BASE ?? '').replace(/\/+$/, '')}/${endpoint.replace(/^\//, '')}`;
}

interface ProxyBody {
  code?: string;
  msg?: string;
  data?: unknown;
}

export function proxyOk(body: unknown): body is ProxyBody {
  return typeof body === 'object' && body !== null && (body as ProxyBody).code === '00000';
}

async function proxyCall(env: Env, session: Session, endpoint: string, params: Record<string, string>): Promise<unknown> {
  const res = await timedFetch(endpoint, proxyUrl(env, endpoint), {
    method: 'POST',
    headers: proxyHeaders(env, session.token),
    body: JSON.stringify({ ...(await proxyEnvelope(env, session)), ...params }),
  });
  if (!res.ok) throw new UpstreamHttpError(endpoint, res.status);
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${endpoint} non-JSON (${res.status}): ${text.slice(0, 80)}`);
  }
}

async function retryable(env: Env, nowMs: number, session: Session, body: unknown, onMint?: () => void): Promise<Session | null> {
  if (proxyOk(body) || NO_REMINT_CODES.has(String((body as ProxyBody | null)?.code))) return null;
  return renewSession(env, nowMs, session, onMint);
}

async function acceptedCall(
  env: Env,
  endpoint: string,
  params: Record<string, string>,
  nowMs: number,
  onCall?: () => void,
): Promise<{ body: ProxyBody; sentAtMs: number }> {
  if (!fmsConfigured(env)) throw new Error('bus proxy not configured');
  const startMs = Date.now();
  const sinceNow = () => nowMs + Math.max(0, Date.now() - startMs);
  const session = await getSession(env, nowMs, { onMint: onCall });
  onCall?.();
  let sentAtMs = sinceNow();
  let body = await proxyCall(env, session, endpoint, params);
  const renewed = await retryable(env, nowMs, session, body, onCall);
  if (renewed) {
    onCall?.();
    sentAtMs = sinceNow();
    body = await proxyCall(env, renewed, endpoint, params);
  }
  if (!proxyOk(body)) {
    const b = body as ProxyBody | null;
    const err = new UpstreamRejected(
      String(b?.code ?? '?'),
      `${endpoint} rejected: code=${b?.code ?? '?'} msg=${String(b?.msg ?? '').slice(0, 120)}`,
      JSON.stringify(body),
    );
    err.version = (renewed ?? session).version;
    await markIfOutdated(env, err);
    throw err;
  }
  return { body, sentAtMs };
}

export const MAX_STAMP_LAG_S = 90;

export function stampLagS(data: unknown, sentAtMs: number): number {
  const root = unwrap(data);
  const raw = root && typeof root === 'object' ? (root as Record<string, unknown>).TimeStamp : undefined;
  if (typeof raw !== 'string') return 0;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})?$/.exec(raw.trim());
  if (!m) return 0;
  const at = Date.parse(`${m[1]}T${m[2]}${m[3] ?? '+08:00'}`);
  if (!Number.isFinite(at)) return 0;
  const lagS = Math.round((sentAtMs - at) / 1000);
  return lagS > 0 && lagS <= MAX_STAMP_LAG_S ? lagS : 0;
}

export async function fetchArrivals(env: Env, code: string, nowMs: number = Date.now()): Promise<StopArrivals> {
  const { body, sentAtMs } = await acceptedCall(env, 'shuttle-service', { busstopname: code }, nowMs);
  if (!hasList(body.data, ARRIVAL_LIST_KEYS)) throw new Error('shuttle-service answered in an unknown shape (no arrivals list)');
  const lagS = stampLagS(body.data, sentAtMs);
  const arrivals = normalize(body.data).map((a) => (lagS && a.etaS !== null ? { ...a, etaS: Math.max(0, a.etaS - lagS) } : a));
  const problem = arrivalsProblem(body.data, arrivals);
  if (problem) throw new Error(`shuttle-service answered in an unknown shape (${problem})`);
  const unread = arrivalsUnread(body.data);
  if (!unread.length) return { code, arrivals, fetchedAt: sentAtMs, stale: false, available: true };
  console.warn(`shuttle-service at ${code}: times it cannot read for ${unread.slice(0, 4).join(', ')}`);
  return { code, arrivals: arrivals.filter((a) => !unread.includes(a.svc)), fetchedAt: sentAtMs, stale: false, available: true, unread };
}

export async function tryVersion(env: Env, version: string, stop: string, nowMs: number = Date.now()): Promise<boolean> {
  let session;
  try {
    session = await mintWith(env, version, nowMs);
  } catch (err) {
    if (err instanceof UpstreamRejected && err.code === '10009') return false;
    throw err;
  }
  const body = await proxyCall(env, session, 'shuttle-service', { busstopname: stop });
  if (proxyOk(body)) return true;
  const code = String((body as ProxyBody | null)?.code ?? '?');
  if (code === '10009') return false;
  throw new UpstreamRejected(code, `shuttle-service rejected a candidate version: code=${code}`, JSON.stringify(body));
}

export function hasList(data: unknown, keys: string[] = ARRIVAL_LIST_KEYS): boolean {
  return findList(data, keys) !== null;
}

export async function getArrivals(
  env: Env,
  ctx: ExecutionContext,
  code: string,
  nowMs: number = Date.now(),
  onFetched?: (sa: StopArrivals) => void,
): Promise<StopArrivals> {
  return cachedFetch<StopArrivals>({
    ctx,
    nowMs,
    key: `${cacheBase()}/arrivals/${encodeURIComponent(code)}`,
    failKey: `${cacheBase()}/failed/${encodeURIComponent(code)}`,
    fetch: () =>
      throughGate(env, ctx, `arrivals/${code}`, TTL.arrivalsMs, async () => {
        const sa = await fetchArrivals(env, code, nowMs);
        try {
          onFetched?.(sa);
        } catch {}
        return sa;
      }),
    freshMs: TTL.arrivalsMs,
    staleMaxS: TTL.staleMaxS,
    failMemoS: TTL.failMemoS,
    raceMs: TTL.staleRaceMs,
    memoes: notOutdated,
    breaker: { ...breaker(), onOpen: (err) => noteBreakerOpen(env, 'nus', err, nowMs) },
    inflight,
    onFail: (err) => noteFailure(env, 'arrivals', code, err, nowMs),
  });
}

export function opensBreaker(err: unknown): boolean {
  if (err instanceof UpstreamRejected) return NO_REMINT_CODES.has(err.code) && !err.outdated;
  if (err instanceof UpstreamUnreachable) return true;
  return err instanceof UpstreamHttpError && (err.status === 429 || err.status >= 500);
}

const notOutdated = (err: unknown): boolean => !(err instanceof UpstreamRejected && err.outdated) && !(err instanceof GateBusy);

export function failureReason(err: unknown): string {
  const msg = err instanceof Error ? (err.name && err.name !== 'Error' ? `${err.name}: ${err.message}` : err.message) : String(err);
  return redactDetail(msg)
    .replace(/eyJ[\w.-]{8,}/g, '[redacted]')
    .slice(0, 160);
}

const noted = new Map<string, number>();
const NOTE_AGAIN_MS = 10 * 60_000;

export function resetFailureNotes(): void {
  noted.clear();
}

export function noteFailure(env: Env, what: 'arrivals' | 'buses', key: string, err: unknown, nowMs: number = Date.now()): void {
  if (!notOutdated(err) || err instanceof MintQuiet) return;
  const reason = failureReason(err);
  const seen = `${what} ${key} ${reason.replace(/\d+/g, '#').slice(0, 60)}`;
  const last = noted.get(seen);
  if (last !== undefined && nowMs - last < NOTE_AGAIN_MS && nowMs >= last) return;
  if (noted.size > 500) noted.clear();
  noted.set(seen, nowMs);
  console.warn(`NUS ${what} for ${key} failed: ${reason}`);
  writeRow(env, 'error', { route: `feed ${what}`, reason });
}

export async function renewToken(env: Env, nowMs: number): Promise<boolean> {
  if (!fmsConfigured(env) || (await breakerOpen())) return false;
  return renewAhead(env, nowMs).catch((err) => {
    if (err instanceof MintQuiet) return false;
    throw err;
  });
}

const breaker = () => ({ key: `${cacheBase()}/breaker`, opens: opensBreaker, maxAgeS: TTL.breakerS });

export async function breakerOpen(): Promise<boolean> {
  return flagged(breaker().key);
}

const inflight = new Map<string, Promise<StopArrivals>>();

export interface RawBus {
  plate: string;
  lat: number;
  lon: number;
  heading: number | null;
  speed: number;
  crowd: Crowd | null;
}

export interface ActiveBuses {
  svc: string;
  buses: RawBus[];
  fetchedAt: number;
  stale: boolean;
}

export function normalizeBuses(data: unknown): RawBus[] {
  const out: RawBus[] = [];
  for (const raw of pickList(data, BUS_LIST_KEYS)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const plate = plateOf(field(item, ...BUS_PLATE_KEYS));
    const num = (v: unknown) => (v == null || v === '' ? NaN : Number(v));
    const lat = num(field(item, 'lat', 'latitude'));
    const lon = num(field(item, 'lng', 'lon', 'longitude'));
    if (!plate || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0))
      continue;
    const dir = num(field(item, 'direction', 'heading', 'bearing'));
    const speed = Number(field(item, 'speed'));
    const load = (item.loadInfo ?? {}) as Record<string, unknown>;
    out.push({
      plate,
      lat,
      lon,
      heading: Number.isFinite(dir) ? ((dir % 360) + 360) % 360 : null,
      speed: Number.isFinite(speed) && speed > 0 ? speed : 0,
      crowd: crowdFromLoad(load.capacity, load.ridership) ?? parseCrowd(load.crowdLevel),
    });
  }
  return out;
}

export async function fetchActiveBuses(env: Env, svc: string, nowMs: number = Date.now(), onCall?: () => void): Promise<ActiveBuses> {
  const { body, sentAtMs } = await acceptedCall(env, 'active-bus', { route_code: svc }, nowMs, onCall);
  if (!hasList(body.data, BUS_LIST_KEYS)) throw new Error('active-bus answered in an unknown shape (no bus list)');
  const buses = normalizeBuses(body.data);
  const problem = busesProblem(body.data, buses);
  if (problem) throw new Error(`active-bus answered in an unknown shape (${problem})`);
  return { svc, buses, fetchedAt: sentAtMs, stale: false };
}

export async function getBuses(
  env: Env,
  ctx: ExecutionContext,
  svc: string,
  nowMs: number = Date.now(),
  onUpstream?: () => void,
): Promise<ActiveBuses> {
  return cachedFetch<ActiveBuses>({
    ctx,
    nowMs,
    key: `${cacheBase()}/buses/${encodeURIComponent(svc)}`,
    failKey: `${cacheBase()}/failed-buses/${encodeURIComponent(svc)}`,
    fetch: () => throughGate(env, ctx, `buses/${svc}`, TTL.busesMs, () => fetchActiveBuses(env, svc, nowMs, onUpstream)),
    freshMs: TTL.busesMs,
    staleMaxS: TTL.staleMaxS,
    failMemoS: TTL.failMemoS,
    memoes: notOutdated,
    breaker: { ...breaker(), onOpen: (err) => noteBreakerOpen(env, 'nus', err, nowMs) },
    inflight: inflightBuses,
    onFail: (err) => noteFailure(env, 'buses', svc, err, nowMs),
  });
}

const inflightBuses = new Map<string, Promise<ActiveBuses>>();
