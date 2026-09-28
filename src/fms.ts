/**
 * Bus-proxy client (inetapps.nus.edu.sg/univus/api/bus-proxy) and defensive
 * response normalisation.
 *
 * `normalize()` is the ONLY place that touches the raw FMS shape. It is
 * undocumented and has changed before, so this function is deliberately
 * tolerant and everything downstream assumes a clean Arrival[]. When the feed
 * shifts, exactly one function needs editing.
 */

import type { Arrival, Crowd, Env, StopArrivals } from './types.ts';
import { TTL } from './config.ts';
import { getSession, proxyEnvelope, proxyHeaders } from './auth.ts';
import type { Session } from './auth.ts';

/** Envelope keys the FMS wraps results in. It nests one level deeper than you
 *  expect on some endpoints, so unwrapping is a loop, not a single lookup. */
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

/** Find the result array, whatever depth the envelope buried it at. */
export function pickList(node: unknown, keys: string[]): unknown[] {
  const root = unwrap(node);
  if (Array.isArray(root)) return root;
  if (!root || typeof root !== 'object') return [];
  const o = root as Record<string, unknown>;
  for (const k of keys) {
    const v = unwrap(o[k]);
    if (Array.isArray(v)) return v;
  }
  for (const v of Object.values(o)) {
    const u = unwrap(v);
    if (Array.isArray(u)) return u;
  }
  return [];
}

const NO_BUS = new Set(['-', '--', '', 'n.a.', 'na', 'n/a', 'nil', 'null', 'undefined', '?']);

/**
 * Minutes-as-string -> seconds.
 *
 * "-" is null, NOT 0. Number(null) is 0 and Number("") is 0, which is the bug
 * that makes you sprint for a bus that does not exist. "Arr" is a real 0.
 */
export function parseEtaS(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') {
    return Number.isFinite(v) && v >= 0 ? Math.round(v * 60) : null;
  }
  const s = String(v).trim();
  const low = s.toLowerCase();
  if (NO_BUS.has(low)) return null;
  if (low.startsWith('arr')) return 0;
  if (low.startsWith('lv') || low.startsWith('left') || low.startsWith('dep')) return null;
  const cleaned = s.replace(/[^0-9.]/g, '');
  if (!cleaned || cleaned === '.') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 60);
}

/**
 * Crowd level. Nobody uses this well and at peak it is the real question --
 * not when the bus arrives but whether you will get on it. Plumbed through
 * from the start even though v1 barely uses it.
 */
/** A value that is ALREADY in seconds (ConnectX eta_s). null if absent/blank. */
export function parseSeconds(v: unknown): number | null {
  if (v == null || v === '' || v === '-') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
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

/**
 * Crowding as the feed actually reports it: a headcount against a seat count,
 * not a low/medium/high string. Number(null) is 0, so the capacity guard has
 * to be explicit or an absent field reads as an empty bus.
 */
export function crowdFromLoad(capacity: unknown, ridership: unknown): Crowd | null {
  if (capacity == null || ridership == null) return null;
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

/**
 * Raw ShuttleService payload -> clean Arrival[].
 *
 * Note what is NOT used: `arrivalTime_ts`. It looks like an absolute arrival
 * time and would be strictly better than relative minutes across a cache TTL,
 * but real captures carry timestamps minutes in the PAST alongside a positive
 * `arrivalTime`. Trusting it produces negative ETAs. Relative minutes only.
 */
export function normalize(raw: unknown): Arrival[] {
  const list = pickList(raw, ['timings', 'shuttles', 'Shuttles', 'ShuttleService', 'services', 'arrivals']);
  const out: Arrival[] = [];

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const svc = String(field(item, 'name', 'route', 'serviceName', 'ShuttleName', 'svc') ?? '').trim();
    if (!svc) continue;

    // Which pass through this stop the row belongs to. See types.ts.
    const berth = plateOf(field(item, 'busStopCode', 'busstopcode'));

    const etas = pickList(field(item, '_etas', 'nextArrivals') ?? [], []);
    if (etas.length) {
      for (const e of etas) {
        if (!e || typeof e !== 'object') continue;
        const row = e as Record<string, unknown>;
        // Raw ConnectX gives both `eta` (whole minutes) and `eta_s` (seconds).
        // Prefer the seconds field: parseEtaS(minutes) rounds 24055 -> 24060.
        const etaS = parseSeconds(row.eta_s) ?? parseEtaS(field(row, 'eta', 'arrivalTime', 'ETA', 'time'));
        out.push({
          svc,
          etaS,
          crowd:
            crowdFromLoad(row.capacity, row.ridership) ??
            // `px` is ConnectX's per-arrival passenger field.
            parseCrowd(field(row, 'px', 'passengers', 'crowd', 'load', 'occupancy')),
          plate: plateOf(field(row, 'plate', 'vehiclePlate', 'veh_plate', 'vehicle')),
          berth,
        });
      }
      continue;
    }

    out.push({
      svc,
      etaS: parseEtaS(field(item, 'arrivalTime', 'eta', 'arrival')),
      crowd:
        crowdFromLoad(item.arrivalTime_capacity, item.arrivalTime_ridership) ??
        parseCrowd(field(item, 'passengers', 'crowd', 'load')),
      plate: plateOf(field(item, 'arrivalTime_veh_plate', 'vehiclePlate', 'plate')),
      berth,
    });
    const nextEta = parseEtaS(field(item, 'nextArrivalTime', 'nextEta'));
    if (nextEta != null) {
      out.push({
        svc,
        etaS: nextEta,
        crowd:
          crowdFromLoad(item.nextArrivalTime_capacity, item.nextArrivalTime_ridership) ??
          parseCrowd(field(item, 'nextPassengers', 'nextArrivalTime_passengers')),
        plate: plateOf(field(item, 'nextArrivalTime_veh_plate', 'nextVehiclePlate')),
        berth,
      });
    }
  }

  // Same service+eta reported twice by two shapes in one payload.
  const seen = new Set<string>();
  return out.filter((a) => {
    const k = `${a.svc}|${a.etaS}|${a.plate ?? ''}|${a.berth ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function fmsConfigured(env: Env): boolean {
  return Boolean(env.NEXTBUS_PROXY_BASE && env.NEXTBUS_PROXY_API_KEY);
}

/** POST {NEXTBUS_PROXY_BASE}/{endpoint}, e.g. .../bus-proxy/shuttle-service. */
export function proxyUrl(env: Env, endpoint: string): string {
  return `${(env.NEXTBUS_PROXY_BASE ?? '').replace(/\/+$/, '')}/${endpoint.replace(/^\//, '')}`;
}

interface ProxyBody {
  code?: string;
  msg?: string;
  data?: unknown;
}

/** The proxy wraps results as {code, msg, data}; anything but "00000" failed.
 *  Like the auth host, it reports failure at HTTP 200. */
export function proxyOk(body: unknown): body is ProxyBody {
  return typeof body === 'object' && body !== null && (body as ProxyBody).code === '00000';
}

async function proxyCall(
  env: Env,
  session: Session,
  endpoint: string,
  params: Record<string, string>,
): Promise<unknown> {
  const res = await fetch(proxyUrl(env, endpoint), {
    method: 'POST',
    headers: proxyHeaders(env, session.token),
    body: JSON.stringify({ ...(await proxyEnvelope(env, session)), ...params }),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${endpoint} non-JSON (${res.status}): ${text.slice(0, 80)}`);
  }
}

/**
 * One stop's arrivals via the bus proxy. Any non-"00000" code gets exactly one
 * retry with a freshly minted token; a second rejection THROWS, so the stop is
 * reported unavailable and the answer degrades to an honest `unknown` rather
 * than passing an empty result off as "the feed says no bus".
 */
export async function fetchArrivals(
  env: Env,
  code: string,
  nowMs: number = Date.now(),
): Promise<StopArrivals> {
  if (!fmsConfigured(env)) throw new Error('bus proxy not configured');
  let session = await getSession(env, nowMs);
  let body = await proxyCall(env, session, 'shuttle-service', { busstopname: code });
  if (!proxyOk(body)) {
    session = await getSession(env, nowMs, { force: true });
    body = await proxyCall(env, session, 'shuttle-service', { busstopname: code });
  }
  if (!proxyOk(body)) {
    const b = body as ProxyBody | null;
    throw new Error(`shuttle-service rejected: code=${b?.code ?? '?'} msg=${b?.msg ?? ''}`);
  }
  return { code, arrivals: normalize(body.data), fetchedAt: nowMs, stale: false, available: true };
}

/**
 * Fetch-on-demand with a 15-second edge cache.
 *
 * Keyed on the STOP CODE, not the request URL. The tile sends
 * getLastKnownLocation, whose coordinates jitter on every call, so a cache
 * keyed on the raw URL would never hit. Keying on the resolved stop is what
 * makes "one upstream call per stop per 15 seconds however hard the tile
 * refreshes" actually true, and it shares the entry between /next and /trip.
 */
export async function getArrivals(
  env: Env,
  ctx: ExecutionContext,
  code: string,
  nowMs: number = Date.now(),
): Promise<StopArrivals> {
  const cache = caches.default;
  const key = new Request(`https://nusbus-edge.internal/arrivals/${encodeURIComponent(code)}`);

  // LANDMINE: a Response body is single-use. Parse it ONCE, here, into a
  // variable. Reading `hit` again on the catch path below would turn
  // "upstream is down" into "the Worker is down" at the worst possible moment.
  let cached: StopArrivals | null = null;
  const hit = await cache.match(key);
  if (hit) {
    try {
      cached = (await hit.json()) as StopArrivals;
    } catch {
      cached = null;
    }
  }

  if (cached && nowMs - cached.fetchedAt < TTL.arrivalsMs) {
    return { ...cached, stale: false, available: true };
  }

  try {
    const fresh = await fetchArrivals(env, code, nowMs);
    ctx.waitUntil(
      cache.put(
        key,
        new Response(JSON.stringify(fresh), {
          headers: {
            'content-type': 'application/json',
            // Long max-age so the stale fallback survives; freshness is
            // decided above from fetchedAt, not by the cache.
            'cache-control': `max-age=${TTL.staleMaxS}`,
          },
        }),
      ),
    );
    return fresh;
  } catch (err) {
    if (cached) return { ...cached, stale: true, available: true };
    throw err;
  }
}
