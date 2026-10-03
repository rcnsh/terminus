/** Environment bindings. Everything optional except KV, so /health can report
 *  what is missing instead of the Worker failing to boot. */
export interface Env {
  KV: KVNamespace;
  /** Optional. Absent in tests and in dev without the binding; logging no-ops. */
  AE?: AnalyticsEngineDataset;

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
  /** Unlocks /health?probe=1 and the /admin dashboard via the x-health-token header. Unset: neither. */
  HEALTH_TOKEN?: string;
  /** Optional. An API token with Account Analytics Read, so the dashboard can
   *  query Analytics Engine. Without it the dashboard skips those charts. */
  ANALYTICS_TOKEN?: string;
  /** The account that owns the Analytics Engine dataset. */
  CF_ACCOUNT_ID?: string;
  /** One global ceiling on sign-in emails. */
  RL_MAIL?: RateLimit;
  /** The trip engine: one Durable Object per user holding today's trip signals (trip.ts). */
  TRIPS?: DurableObjectNamespace;
  /** Firebase service account JSON, for push (push.ts). Unset: no push. */
  FCM_SERVICE_ACCOUNT?: string;
  /** Web Push's VAPID key, a P-256 private JWK (webpush.ts). */
  VAPID_PRIVATE_KEY?: string;
  /** One global ceiling on new anonymous accounts (apps can't run Turnstile). */
  RL_ANON?: RateLimit;
  /** The site's own origin, set on the beta (site.ts). Unset: https://terminus.rcn.sh. */
  PUBLIC_ORIGIN?: string;
  /** The Analytics Engine dataset the dashboard queries. Unset: terminus. */
  AE_DATASET?: string;
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
  /** You are already at the destination: show "you're here", no bus, no countdown. */
  arrived?: boolean;
  /**
   * The latest time to set off. For a class, the latest that still gets you
   * there on time; otherwise, for the bus in `departsAt`. `estimated` when
   * it rests on a headway rather than a live time.
   */
  leave?: Leave | null;
}

/* ------------------------------------------------------------------ */
/* /me/next: the personal answer every client renders                  */
/* ------------------------------------------------------------------ */

/** What kind of answer: a trip somewhere, what's near you, or resting. */
/** 'free': a day with no classes (or none left to plan): nothing to catch. */
export type Mode = 'trip' | 'nearby' | 'rest' | 'free';
/** Why you're going there. */
export type Why = 'class' | 'home' | 'gap-home' | 'place';

export interface Dest {
  to: string;
  label: string;
  why: Why;
}

/** A saved place, as a one-tap chip. */
export interface PlaceChip {
  key: string;
  label: string;
}

export interface Timing {
  status: 'on-time' | 'tight' | 'late';
  /** "Arrive 09:56 · 4 min early", "Arrive 09:59 · just in time", "~5 min late". */
  text: string;
  /** Class start, ISO. */
  classAt: string;
  /** When you reach the class on the headline bus, ISO. */
  reachAt: string;
}

/**
 * The /me/next response. Clients parse this in Api.kt, Api.swift and the
 * account page; test/fixtures/answers holds one of each kind, checked by the
 * golden test here and parsed by the Android and Mac unit tests.
 */
export interface MeAnswer extends Answer {
  mode: Mode;
  dest: Dest | null;
  places: PlaceChip[];
  timing?: Timing | null;
  /** Planned answers only: when the plan changes by itself. */
  refreshAt?: string;
  /** "Last D2 from UTown in 18 min", on the way home near the end of service. */
  warning?: string | null;
  /** The user's walking speed in metres a second (their pace), for walk
   *  times an app shows itself, such as search results. Added by the route. */
  walkSpeedMs?: number;
  /** Display-ready text and the stale time (card.ts). Added last, by the route. */
  card?: import('./card.ts').Card;
}

export interface Leave {
  /** ISO, whole seconds. */
  at: string;
  estimated: boolean;
  /** The bus this is for, and where to board it. Null when walking. */
  svc: string | null;
  stop: string | null;
  /** When that bus leaves the stop, ISO. With no live times, when you reach
   *  the stop (`estimated`). Null when walking. */
  board: string | null;
  /** When you get there that way: the venue for a class, else the stop. ISO. */
  arrive: string | null;
  /** A reason the time is earlier than it could be ("D2 is often busy…"). Display verbatim. */
  note?: string | null;
  /** Where to get off, when the bus only stops across the road from the
   *  destination. Absent otherwise. Short stop name. */
  off?: string;
  /** Stop codes: where to board, and where to get off when that's across the
   *  road (otherwise the destination's own stop). For matching a bus in the feed. */
  stopCode?: string;
  offCode?: string;
}

/** A time to be somewhere by, for the leave-by calculation. */
export interface ArriveBy {
  /** Epoch ms you must be at the venue by (class start). */
  atMs: number;
  /** Walk from the destination stop to the venue. */
  venueWalkS: number;
  /** Aim one bus earlier when the one to wait for is often busy. */
  fullBusMargin?: boolean;
  /** Leave one bus earlier for this class: a suggestion the user accepted (outcomes.ts). */
  oneEarlier?: boolean;
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
  /** Seconds on the bus, when measured ride times say (ridetimes.ts); else
   *  hops times RIDE.secondsPerHop. */
  rideS?: number;
  /** Seconds to walk across from where the bus stops to the destination's
   *  side of the road, when it only calls at the twin. Absent when it's 0. */
  crossS?: number;
  /** Where to get off, when that's the twin rather than the destination. */
  off?: Stop;
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
  /** Where to get off, when the bus only stops across the road from the destination. */
  off?: Stop;
}

export interface ResolveInput {
  lat: number | null;
  lon: number | null;
  /** Destination stop code, or null for "just tell me what is coming". */
  to: string | null;
  /** More stops that serve the same destination (a food court's other stop). */
  toAlso?: string[];
  /** Used when lat/lon are absent. */
  originCode: string | null;
  /**
   * Stops always considered when within walking range, even if three closer
   * stops would otherwise crowd them out. A user's usual stops near home.
   */
  preferStops?: string[];
  /** Walk to `originCode` when there are no coordinates (home to home stop). */
  originWalkS?: number;
  /** Metres per second on foot (the user's pace). Defaults to WALK.speedMs. */
  walkSpeedMs?: number;
  /** Set for a class: leave-by then aims at this, not the next bus. */
  arriveBy?: ArriveBy | null;
  /** Seconds per stop on a service, from measured rides (ridetimes.ts).
   *  RIDE.secondsPerHop where it has nothing. */
  hopS?: (svc: string) => number | null;
}
