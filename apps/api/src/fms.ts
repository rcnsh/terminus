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
import { MAX_ETA_S, TTL } from './config.ts';
import { timedFetch } from './http.ts';
import { cacheBase, cachedFetch, flagged } from './edgecache.ts';
import { UpstreamHttpError, UpstreamRejected, getSession, mintWith, proxyEnvelope, proxyHeaders, renewSession } from './auth.ts';
import type { Session } from './auth.ts';
import graphJson from '../data/stops.json' with { type: 'json' };

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

const isRow = (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x);

/**
 * The result array, whatever depth the envelope buried it at, or null when
 * there is none. Under one of [keys] any array is the list, an empty one
 * included. Under a name it doesn't know, only an array of rows is: the
 * shuttle reply carries `hints`, a list of strings, beside its `shuttles`,
 * and taking that for the board when `shuttles` is renamed or gone would
 * read every service as "no bus".
 */
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

/** Find the result array, whatever depth the envelope buried it at; [] if none. */
export function pickList(node: unknown, keys: string[]): unknown[] {
  return findList(node, keys) ?? [];
}

/** Where the feed's rows are, by the names the arrivals and bus lists have had. */
const ARRIVAL_LIST_KEYS = ['timings', 'shuttles', 'Shuttles', 'ShuttleService', 'services', 'arrivals'];
const BUS_LIST_KEYS = ['activebus', 'activeBus', 'ActiveBus', 'buses'];
const BUS_PLATE_KEYS = ['vehplate', 'veh_plate', 'vehiclePlate', 'plate'];

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
    return Number.isFinite(v) && v >= 0 ? capped(Math.round(v * 60)) : null;
  }
  const s = String(v).trim();
  const low = s.toLowerCase();
  if (NO_BUS.has(low)) return null;
  if (low.startsWith('arr')) return 0;
  if (low.startsWith('lv') || low.startsWith('left') || low.startsWith('dep')) return null;
  // A minus or a clock time isn't minutes to go: stripping the rest would
  // read "-3" as 3 min and "12:30" as 1230 min.
  if (/[-:]/.test(s)) return null;
  const cleaned = s.replace(/[^0-9.]/g, '');
  if (!cleaned || cleaned === '.') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return capped(Math.round(n * 60));
}

/** A time to go past MAX_ETA_S isn't a bus: null, as unreadable. */
const capped = (s: number): number | null => (Number.isFinite(s) && s <= MAX_ETA_S ? s : null);

/**
 * A value that is ALREADY in seconds (ConnectX eta_s): a number, or a string
 * of digits. Anything else is null, never 0: Number(' '), Number(false) and
 * Number([]) are all 0, which would read as a bus arriving now.
 */
export function parseSeconds(v: unknown): number | null {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v)) n = Number(v);
  else return null;
  return Number.isFinite(n) && n >= 0 ? capped(Math.round(n)) : null;
}

/**
 * Whether a raw time is the feed saying "no bus" ("-", blank, "Lv", ...),
 * which parseEtaS() reads as null on purpose, as opposed to a time it
 * couldn't read at all.
 */
function saysNoBus(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const low = v.trim().toLowerCase();
  return NO_BUS.has(low) || low.startsWith('lv') || low.startsWith('left') || low.startsWith('dep');
}

/**
 * Crowd level from a word, a colour or a percentage. At peak it is the real
 * question: not when the bus arrives, but whether you will get on it.
 */
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

/** The services the stop graph knows. */
const KNOWN_SERVICES: ReadonlySet<string> = new Set(Object.keys((graphJson as { routes: Record<string, unknown> }).routes));

/** Each known service by its name without spaces, in capitals. */
const SERVICE_NAMES = new Map([...KNOWN_SERVICES].map((s) => [s.replace(/\s+/g, '').toUpperCase(), s]));

/**
 * A row's service name, as the graph spells it: "d2" and "D 2" are D2,
 * which everything downstream compares with ===. A name it doesn't know
 * passes as it is (a new route before the weekly scrape). Only a string or
 * a number is a name.
 */
function serviceOf(v: unknown): string {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  const s = String(v).trim();
  return SERVICE_NAMES.get(s.replace(/\s+/g, '').toUpperCase()) ?? s;
}

/** Where a row keeps its service and its time, by the names the feed has used. */
const ROW_NAME = ['name', 'route', 'serviceName', 'ShuttleName', 'svc'];
const ROW_TIME = ['arrivalTime', 'eta', 'arrival'];
const ROW_NEXT_TIME = ['nextArrivalTime', 'nextEta'];
const ETA_TIME = ['eta', 'arrivalTime', 'ETA', 'time'];
const ETA_LISTS = ['_etas', 'nextArrivals'];

/**
 * Raw ShuttleService payload -> clean Arrival[].
 *
 * Note what is NOT used: `arrivalTime_ts`. It looks like an absolute arrival
 * time and would be strictly better than relative minutes across a cache TTL,
 * but real captures carry timestamps minutes in the PAST alongside a positive
 * `arrivalTime`. Trusting it produces negative ETAs. Relative minutes only.
 */
export function normalize(raw: unknown): Arrival[] {
  const list = pickList(raw, ARRIVAL_LIST_KEYS);
  const out: Arrival[] = [];

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const svc = serviceOf(field(item, ...ROW_NAME));
    if (!svc) continue;

    // Which pass through this stop the row belongs to. See types.ts. At a
    // terminus the feed names the run that ends here with an `-E` suffix;
    // that is read here, so nothing downstream knows how the feed spells it.
    const berth = plateOf(field(item, 'busStopCode', 'busstopcode'));
    const ends = berth?.toUpperCase().endsWith('-E') ? { ends: true as const } : {};

    const etas = pickList(field(item, ...ETA_LISTS) ?? [], []);
    if (etas.length) {
      for (const e of etas) {
        if (!e || typeof e !== 'object') continue;
        const row = e as Record<string, unknown>;
        // Raw ConnectX gives both `eta` (whole minutes) and `eta_s` (seconds).
        // Prefer the seconds field: parseEtaS(minutes) rounds 24055 -> 24060.
        const etaS = parseSeconds(row.eta_s) ?? parseEtaS(field(row, ...ETA_TIME));
        out.push({
          svc,
          etaS,
          crowd:
            crowdFromLoad(row.capacity, row.ridership) ??
            // `px` is ConnectX's per-arrival passenger field.
            parseCrowd(field(row, 'px', 'passengers', 'crowd', 'load', 'occupancy')),
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
      crowd:
        crowdFromLoad(item.arrivalTime_capacity, item.arrivalTime_ridership) ??
        parseCrowd(field(item, 'passengers', 'crowd', 'load')),
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

  // Same service+eta reported twice by two shapes in one payload.
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

/**
 * How one row's times read, by the values normalize() reads: `read` when
 * one is a time or the feed's "no bus" ("-", or an empty list of
 * arrivals), `garbled` when one is there but isn't either (a clock time,
 * a changed unit, a word), `missing` when there's nothing to read (the
 * fields renamed, or null).
 */
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
      // As normalize() reads them: the seconds when they read, else the minutes.
      if (parseSeconds(e.eta_s) != null) read = true;
      else if (field(e, ...ETA_TIME) != null) see(field(e, ...ETA_TIME), parseEtaS);
      else see(e.eta_s, parseSeconds);
    }
    return { read, garbled };
  }
  // A list of something else isn't arrivals; an empty one is the feed's "no bus".
  if (listed.length) garbled = true;
  else if (list != null) read = true;
  see(field(item, ...ROW_TIME), parseEtaS);
  // The next bus can be garbled too, but on its own it doesn't make the row
  // read: with the first time gone, the second would pass for the soonest.
  const next = field(item, ...ROW_NEXT_TIME);
  if (next != null && parseEtaS(next) == null && !saysNoBus(next)) garbled = true;
  return { read, garbled };
}

/**
 * Why an arrivals payload that has rows can't be read as a board, or null.
 *
 * hasList() catches a reply with no list at all. This catches the subtler
 * changes: the list is still there but its rows aren't what normalize()
 * reads, or their values aren't. Taken as it is, such a board says "no bus"
 * for a service (or every one), so its card turns into headway guesses, or
 * leads with another service while the one that's really next is missing,
 * and the monitor's probe sees a healthy feed and never says anything.
 * Thrown instead, it reads as the feed being down: stale or "No live data"
 * on the card, the monitor's email, the feed-down notice.
 *
 * Checked row by row, by value: each row needs a time or the feed's "no
 * bus" ("-" passes; a time renamed, null, or in a format it can't read
 * doesn't). One service that changed shape is enough, because the rest of
 * the board then hides it.
 */
export function arrivalsProblem(raw: unknown, arrivals: Arrival[] = normalize(raw), known: ReadonlySet<string> = KNOWN_SERVICES): string | null {
  const rows = objects(pickList(raw, ARRIVAL_LIST_KEYS));
  if (!rows.length) return null;
  if (!arrivals.length) return 'no row names a service';
  if (!arrivals.some((a) => known.has(a.svc))) return `no service it names is known (${[...new Set(arrivals.map((a) => a.svc))].slice(0, 4).join(', ')})`;
  // Not checked: how far away the times are, up to MAX_ETA_S. After midnight
  // every real arrival is the next morning's, hours away (fixtures/connectx-*.json).
  const times = rows
    .map((r) => ({ svc: serviceOf(field(r, ...ROW_NAME)), row: r }))
    .filter((t) => t.svc)
    .map((t) => ({ svc: t.svc, ...rowTimes(t.row) }));
  const garbled = times.filter((t) => t.garbled).map((t) => t.svc);
  if (garbled.length) return `a time it cannot read (${[...new Set(garbled)].slice(0, 4).join(', ')})`;
  if (!times.some((t) => t.read)) return 'no row has an arrival time';
  const missing = times.filter((t) => !t.read).map((t) => t.svc);
  if (missing.length) return `no arrival time for ${[...new Set(missing)].slice(0, 4).join(', ')}`;
  return null;
}

/** A bus the feed lists with no fix yet: 0, 0. A real bus without a place.
 *  Null and blank aren't 0, though Number() says they are. */
const zero = (v: unknown) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number(v) === 0;
const noFixYet = (r: Record<string, unknown>) => zero(field(r, 'lat', 'latitude')) && zero(field(r, 'lng', 'lon', 'longitude'));

/**
 * Why a bus list with rows can't be read, or null: no row has a plate, or
 * none a position, or there are both and not one bus could be read from
 * them (positions null, swapped or in another format; plates blank). Read
 * as it is, that list is "No D2 buses running right now" on the map, and a
 * round with no bus for the timelapse recorder, which stops for the day
 * after a few. A list whose every bus has no fix yet (0, 0) is real.
 */
export function busesProblem(raw: unknown, buses: RawBus[] = normalizeBuses(raw)): string | null {
  const rows = objects(pickList(raw, BUS_LIST_KEYS));
  if (!rows.length) return null;
  if (!rows.some((r) => hasKey(r, ...BUS_PLATE_KEYS))) return 'no row has a plate';
  if (!rows.some((r) => hasKey(r, 'lat', 'latitude') && hasKey(r, 'lng', 'lon', 'longitude'))) return 'no row has a position';
  if (!buses.length && !rows.some(noFixYet)) return 'no bus has a plate and a position it can read';
  return null;
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
  const res = await timedFetch(endpoint, proxyUrl(env, endpoint), {
    method: 'POST',
    headers: proxyHeaders(env, session.token),
    body: JSON.stringify({ ...(await proxyEnvelope(env, session)), ...params }),
  });
  // Refusals come at HTTP 200 with a code; any other status is the host
  // itself saying no (busy, down), which no token can fix, so it isn't retried.
  if (!res.ok) throw new UpstreamHttpError(endpoint, res.status);
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${endpoint} non-JSON (${res.status}): ${text.slice(0, 80)}`);
  }
}

/**
 * Codes a fresh token cannot fix: a refused app version (10009) and refused
 * API keys (10000). Re-minting on these only adds load while NUS is unhappy.
 */
export const NO_REMINT_CODES = new Set(['10009', '10000']);

/**
/**
 * After a refused call: the session to try once more with, or null for no
 * retry. Only a refusal a token might fix gets one, and only with a token
 * other than the refused one (renewSession), so a code that keeps coming
 * back costs one call per key per failMemoS, not a mint and two calls.
 */
async function retryable(env: Env, nowMs: number, session: Session, body: unknown, onMint?: () => void): Promise<Session | null> {
  if (proxyOk(body) || NO_REMINT_CODES.has(String((body as ProxyBody | null)?.code))) return null;
  return renewSession(env, nowMs, session, onMint);
}

/**
 * One call to the bus proxy, accepted. A rejection gets at most one retry
 * with a fresher token (retryable), unless its code says a token cannot
 * help; a second rejection THROWS. [onCall] is told of each request to NUS
 * (a re-mint included), so the timelapse recorder counts what a poll cost.
 */
async function acceptedCall(env: Env, endpoint: string, params: Record<string, string>, nowMs: number, onCall?: () => void): Promise<ProxyBody> {
  if (!fmsConfigured(env)) throw new Error('bus proxy not configured');
  const session = await getSession(env, nowMs);
  onCall?.();
  let body = await proxyCall(env, session, endpoint, params);
  const renewed = await retryable(env, nowMs, session, body, onCall);
  if (renewed) {
    onCall?.();
    body = await proxyCall(env, renewed, endpoint, params);
  }
  if (!proxyOk(body)) {
    const b = body as ProxyBody | null;
    throw new UpstreamRejected(String(b?.code ?? '?'), `${endpoint} rejected: code=${b?.code ?? '?'} msg=${String(b?.msg ?? '').slice(0, 120)}`, JSON.stringify(body));
  }
  return body;
}

/**
 * One stop's arrivals via the bus proxy (acceptedCall). A refusal throws, so
 * the stop is reported unavailable and the answer degrades to an honest
 * `unknown` rather than passing an empty result off as "the feed says no bus".
 */
export async function fetchArrivals(
  env: Env,
  code: string,
  nowMs: number = Date.now(),
): Promise<StopArrivals> {
  const body = await acceptedCall(env, 'shuttle-service', { busstopname: code }, nowMs);
  // "00000" with no list anywhere is not "no bus": the payload changed shape,
  // and reading it as an empty board would print confident headway guesses.
  if (!hasList(body.data, ARRIVAL_LIST_KEYS)) throw new Error('shuttle-service answered in an unknown shape (no arrivals list)');
  const arrivals = normalize(body.data);
  const problem = arrivalsProblem(body.data, arrivals);
  if (problem) throw new Error(`shuttle-service answered in an unknown shape (${problem})`);
  return { code, arrivals, fetchedAt: nowMs, stale: false, available: true };
}

/**
 * Whether NUS accepts a version string: a token mint plus one shuttle-service
 * call with it, since a refusal (10009) could come from either. false means
 * refused as out of date; any other failure throws, because it says nothing
 * about the version.
 */
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

/** Whether a payload carries its list at all, even an empty one, by
 *  pickList's rules: under a name it doesn't know, only a list of rows. */
export function hasList(data: unknown, keys: string[] = ARRIVAL_LIST_KEYS): boolean {
  return findList(data, keys) !== null;
}

/**
 * One stop's arrivals, fetched on demand through the edge cache (edgecache.ts).
 *
 * Keyed on the STOP CODE, not the request URL. The tile sends
 * getLastKnownLocation, whose coordinates jitter on every call, so a cache
 * keyed on the raw URL would never hit. Keying on the resolved stop is what
 * makes "one upstream call per stop per 15 seconds however hard the tile
 * refreshes" true per location, and it shares the entry between /next and
 * /trip. A refused version or key (NO_REMINT_CODES) trips the feed's
 * breaker, which stops every stop for breakerS: a fresh token can't fix it.
 */
export async function getArrivals(
  env: Env,
  ctx: ExecutionContext,
  code: string,
  nowMs: number = Date.now(),
): Promise<StopArrivals> {
  return cachedFetch<StopArrivals>({
    ctx,
    nowMs,
    key: `${cacheBase()}/arrivals/${encodeURIComponent(code)}`,
    failKey: `${cacheBase()}/failed/${encodeURIComponent(code)}`,
    fetch: () => fetchArrivals(env, code, nowMs),
    freshMs: TTL.arrivalsMs,
    staleMaxS: TTL.staleMaxS,
    failMemoS: TTL.failMemoS,
    raceMs: TTL.staleRaceMs,
    breaker: BREAKER,
    inflight,
  });
}

/**
 * Whether a failure says NUS will refuse every call for a while, whichever
 * stop it's for: a refused version or key, or the host itself answering
 * 429 (slow down) or 5xx (down), the mint's host included.
 */
export function tripsBreaker(err: unknown): boolean {
  if (err instanceof UpstreamRejected) return NO_REMINT_CODES.has(err.code);
  return err instanceof UpstreamHttpError && (err.status === 429 || err.status >= 500);
}

/** The shuttle feed's breaker: such a failure stops every call for breakerS. */
const BREAKER = {
  get key() {
    return `${cacheBase()}/breaker`;
  },
  trips: tripsBreaker,
  maxAgeS: TTL.breakerS,
};

/** Whether the feed's breaker is open here: NUS refused us a moment ago, and
 *  nothing should ask it again until it closes. */
export async function breakerOpen(): Promise<boolean> {
  return flagged(BREAKER.key);
}

/** One upstream fetch per stop per isolate, however many requests want it. */
const inflight = new Map<string, Promise<StopArrivals>>();

/* ------------------------------------------------------------------ */
/* Live bus positions (active-bus)                                     */
/* ------------------------------------------------------------------ */

/** One bus as the feed reports it, before it is placed on its route. */
export interface RawBus {
  plate: string;
  lat: number;
  lon: number;
  /** Degrees clockwise from north; null when the feed leaves it out. */
  heading: number | null;
  /** km/h, as reported; 0 when standing. */
  speed: number;
  crowd: Crowd | null;
}

export interface ActiveBuses {
  svc: string;
  buses: RawBus[];
  fetchedAt: number;
  stale: boolean;
}

/**
 * active-bus's reply, tolerantly: {ActiveBusCount, TimeStamp, activebus: [
 * {vehplate, lat, lng, speed, direction, loadInfo: {occupancy, crowdLevel,
 * capacity, ridership}}]}. A bus without a position on Earth is dropped.
 */
export function normalizeBuses(data: unknown): RawBus[] {
  const out: RawBus[] = [];
  for (const raw of pickList(data, BUS_LIST_KEYS)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const plate = plateOf(field(item, ...BUS_PLATE_KEYS));
    // Missing or blank is missing, not 0 (Number(null) and Number('') are 0).
    const num = (v: unknown) => (v == null || v === '' ? NaN : Number(v));
    const lat = num(field(item, 'lat', 'latitude'));
    const lon = num(field(item, 'lng', 'lon', 'longitude'));
    if (!plate || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) continue;
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

/** One service's buses, with one retry on a rejection, as fetchArrivals.
 *  [onCall] is told of each request to NUS (acceptedCall). */
export async function fetchActiveBuses(env: Env, svc: string, nowMs: number = Date.now(), onCall?: () => void): Promise<ActiveBuses> {
  const body = await acceptedCall(env, 'active-bus', { route_code: svc }, nowMs, onCall);
  // No list at all is a changed payload, not "no buses running".
  if (!hasList(body.data, BUS_LIST_KEYS)) throw new Error('active-bus answered in an unknown shape (no bus list)');
  // Rows it can't read would show as "No D2 buses running right now".
  const buses = normalizeBuses(body.data);
  const problem = busesProblem(body.data, buses);
  if (problem) throw new Error(`active-bus answered in an unknown shape (${problem})`);
  return { svc, buses, fetchedAt: nowMs, stale: false };
}

/**
 * One service's buses through the edge cache: one upstream call per service
 * per TTL.busesMs however many people watch it. The same quiet-under-failure
 * rules as getArrivals: a failed service waits failMemoS, the version
 * breaker stops everything, and a stale answer beats none. [onUpstream] is
 * called for each request this call itself makes to NUS (not a cache hit,
 * not a fetch another request started; a retry and its token are more), so
 * the timelapse recorder can count its real load.
 */
export async function getBuses(env: Env, ctx: ExecutionContext, svc: string, nowMs: number = Date.now(), onUpstream?: () => void): Promise<ActiveBuses> {
  // No stale race: the map polls every few seconds and would rather wait
  // for the fresh positions than see a stale jump.
  return cachedFetch<ActiveBuses>({
    ctx,
    nowMs,
    key: `${cacheBase()}/buses/${encodeURIComponent(svc)}`,
    failKey: `${cacheBase()}/failed-buses/${encodeURIComponent(svc)}`,
    fetch: () => fetchActiveBuses(env, svc, nowMs, onUpstream),
    freshMs: TTL.busesMs,
    staleMaxS: TTL.staleMaxS,
    failMemoS: TTL.failMemoS,
    breaker: BREAKER,
    inflight: inflightBuses,
  });
}

const inflightBuses = new Map<string, Promise<ActiveBuses>>();
