/** Environment bindings. Everything optional except KV, so /health can report
 *  what is missing instead of the Worker failing to boot. */
export interface Env {
  NUSBUS_KV: KVNamespace;
  /** Optional. Absent in tests and in dev without the binding; logging no-ops. */
  NUSBUS_AE?: AnalyticsEngineDataset;

  NEXTBUS_AUTH_BASE?: string;
  /** e.g. https://inetapps.nus.edu.sg/univus/api/bus-proxy */
  NEXTBUS_PROXY_BASE?: string;
  /** Fixed app constant sent as x-api-key to the bus proxy. */
  NEXTBUS_PROXY_API_KEY?: string;
  NEXTBUS_APP_VERSION?: string;
  /** Optional. Any 16 hex chars; generated and persisted in KV when absent. */
  NEXTBUS_DEVICE_ID?: string;
  NEXTBUS_HTD_API?: string;
  NEXTBUS_APP_API?: string;
  NEXTBUS_REQUESTED_BY?: string;
  NEXTBUS_SECURED_REQUEST?: string;

  /** App builds for /download/*. */
  DOWNLOADS?: R2Bucket;
  /** The static website (apps/web/public). Absent in tests. */
  ASSETS?: Fetcher;
  /** Accounts (migrations/). Optional so the public API runs without it. */
  DB?: D1Database;
  /** Cloudflare Email Sending, for sign-in links. */
  EMAIL?: SendEmail;
  /** Sender for sign-in links; must be on a domain onboarded to Email Sending. */
  EMAIL_FROM?: string;
  /** Workers rate limiting, keyed per IP, on sign-in and pairing. */
  RL_AUTH?: RateLimit;
  /** Where outage alerts go. A secret, so it never lands in the repo. */
  ALERT_EMAIL?: string;
  /** Turnstile on sign-in. The site key is public; without the secret the check is skipped. */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  /** Per-IP limit on the public answer routes. */
  RL_PUBLIC?: RateLimit;
  /** Per-account limit on /me. */
  RL_ME?: RateLimit;
}

/* ------------------------------------------------------------------ */
/* Public API contract                                                 */
/* ------------------------------------------------------------------ */

/**
 * 'scheduled' means the feed answered and had no vehicle, so a headway is the
 * honest guess. 'unknown' means we never reached the feed at all. Collapsing
 * those two produces a confident-looking minute count invented out of
 * nothing, which is the worst thing a tile can show.
 */
export type Quality = 'live' | 'scheduled' | 'ended' | 'stale' | 'unknown';
export type Crowd = 'low' | 'medium' | 'high';

export interface Arrival {
  svc: string;
  /** Seconds until arrival. null means "no bus", never 0. */
  etaS: number | null;
  crowd: Crowd | null;
  plate: string | null;
  /**
   * Raw `busStopCode` from the feed. At a stop a route passes twice this
   * carries a per-visit suffix -- COM3 returns both `COM3-D2-S` and
   * `COM3-D2-E` -- so it is the only thing distinguishing the two passes.
   * Null where the feed gives a bare code.
   */
  berth: string | null;
}

export interface Answer {
  /** "D2 - 4 min". Hard cap 40 chars; target ~16 (see format.ts). */
  label: string;
  detail: string;
  alt: string | null;
  stop: { code: string; name: string; confidence: number };
  quality: Quality;
  /** ISO. On a stale answer this is the ORIGINAL fetch time. */
  asOf: string;
  arrivals: Arrival[];
  /**
   * When the bus leaves the boarding stop, as a clock time. Clients count
   * down from this instead of trusting `label` after it was fetched. Null
   * when there is no bus to board or no live time for it.
   */
  departsAt?: string | null;
  /** When you reach the destination stop (by bus, or on foot for a walk answer). */
  arriveAt?: string | null;
}

/* ------------------------------------------------------------------ */
/* Stop graph (data/stops.json)                                        */
/* ------------------------------------------------------------------ */

export interface Stop {
  code: string;
  name: string;
  lat: number;
  lon: number;
  /** Code of the directional twin ("Opp X" <-> "X"), if any. */
  opposite?: string | null;
}

/** [openHHMM, closeHHMM] in SGT, or null for "does not run". */
export type DayWindow = [string, string] | null;

export interface ServiceHours {
  weekday?: DayWindow;
  saturday?: DayWindow;
  sunday?: DayWindow;
}

export interface Graph {
  generated: string;
  stops: Stop[];
  /** service -> ordered stop codes. THE ordering is what makes direction work. */
  routes: Record<string, string[]>;
  /** service -> true if the route closes back on itself. Inferred when absent. */
  loops?: Record<string, boolean>;
  serviceHours?: Record<string, ServiceHours>;
  /** service -> mean headway in seconds, when known. Falls back to config. */
  headwayS?: Record<string, number>;
}

export interface RouteIndex {
  seq: string[];
  loop: boolean;
  /** stop code -> every position it occupies in seq */
  pos: Map<string, number[]>;
}

export interface GraphIndex {
  graph: Graph;
  byCode: Map<string, Stop>;
  routes: Map<string, RouteIndex>;
  servingStop: Map<string, string[]>;
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

export interface Leg {
  svc: string;
  /** Stops ridden from the boarding stop to the destination. */
  hops: number;
}

export interface Candidate {
  stop: Stop;
  distM: number;
  walkS: number;
  legs: Leg[];
}

export interface StopArrivals {
  code: string;
  arrivals: Arrival[];
  /** Epoch ms of the ORIGINAL upstream fetch. */
  fetchedAt: number;
  stale: boolean;
  /** False when the fetch failed outright: no data, as opposed to no bus. */
  available: boolean;
}

export interface ScoredOption {
  stop: Stop;
  svc: string;
  distM: number;
  walkS: number;
  hops: number;
  /** Seconds from now until you can board. Always >= walkS + buffer. */
  boardS: number;
  rideS: number;
  totalS: number;
  quality: Quality;
  arrival: Arrival | null;
  fetchedAt: number;
  /**
   * True when this stop reports this service under more than one berth, so
   * the earliest ETA may belong to the pass going the other way. Until the
   * route sequence carries berth codes, this can only be declared, not fixed.
   */
  ambiguousBerth: boolean;
}

export interface ResolveInput {
  lat: number | null;
  lon: number | null;
  /** Destination stop code, or null for "just tell me what is coming". */
  to: string | null;
  /** Used when lat/lon are absent. */
  originCode: string | null;
  /**
   * Stops always considered when within walking range, even if three closer
   * stops would otherwise crowd them out. A user's usual stops near home.
   */
  preferStops?: string[];
}
