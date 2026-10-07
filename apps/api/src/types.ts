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
  /** Per-IP limit on the map's reads from R2 (not on pieces already in the edge cache). */
  RL_MAP?: RateLimit;
  /** Unlocks /health?probe=1 and the /admin dashboard via the x-health-token header. Unset: neither. */
  HEALTH_TOKEN?: string;
  /** Opens /timelapse/* only (same header), for a machine that renders the videos. Unset: operator only. */
  TIMELAPSE_TOKEN?: string;
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
  /** One global ceiling on pairing-code guesses: a code is guessed against every live one at once. */
  RL_PAIR?: RateLimit;
  /** The site's own origin, set on the beta (site.ts). Unset: https://terminus.rcn.sh. */
  PUBLIC_ORIGIN?: string;
  /** The Analytics Engine dataset the dashboard queries. Unset: terminus. */
  AE_DATASET?: string;
  /** LTA DataMall account key, for public buses (lta.ts). Unset: no public buses. */
  LTA_ACCOUNT_KEY?: string;
  /** The timelapse recorder: one Durable Object per Singapore day (timelapsedo.ts). */
  TIMELAPSE?: DurableObjectNamespace;
  /** "on" lets the timelapse recorder poll; anything else, or unset, is off.
   *  KV config:timelapse overrides it without a deploy (timelapse.ts). */
  TIMELAPSE_ENABLED?: string;
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
   * The feed's own code for the stop the row is for. At a stop a route
   * passes twice it differs per visit -- COM3 returns both `COM3-D2-S` and
   * `COM3-D2-E` -- so it is the only thing distinguishing the two passes.
   * Opaque: compared, never read. Null where the feed gives a bare code.
   */
  berth: string | null;
  /**
   * The bus ends its run at this stop, so it can't be boarded here (the
   * feed's `-E` berth, read by normalize()). Absent otherwise.
   */
  ends?: true;
  /**
   * The time is from the operator's timetable, not a bus on the road (a
   * public bus LTA reports as unmonitored). Absent for a live time, and for
   * every shuttle: the shuttle feed only lists buses it sees.
   */
  scheduled?: true;
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
  /** The headline bus as a leg, for the card's journey (card.ts). Absent
   *  when the answer is to walk or nothing runs. */
  bus?: BusLeg | null;
  /** The other bus worth knowing about (`alt`), the same way. */
  altBus?: BusLeg | null;
  /** The answer is to walk the whole way: seconds on foot to the place
   *  itself, and why not a bus ("D1 would be 16 min", "Services ended for
   *  the night"), for the card's journey. Absent otherwise. */
  foot?: { s: number; why: string | null };
}

/** A bus to catch: where, when, and how long the walk and the ride take. */
export interface BusLeg {
  svc: string;
  /** Short stop name, and its code. */
  stop: string;
  stopCode: string;
  walkS: number;
  rideS: number;
  /** When it leaves the stop, and when you reach the destination stop, ISO. Null with no time. */
  board: string | null;
  arrive: string | null;
  /** Rests on a headway, not a live time. */
  estimated: boolean;
  /** Where to get off, when the bus only stops across the road from the destination. */
  off?: string;
  /** Where you get off (short name): the destination stop this bus calls at, or `off`. */
  toStop?: string;
  /** Seconds on foot from where you get off to the place itself (a room, a food court). Absent for a stop. */
  endWalkS?: number;
  /** A public bus, with a fare, unlike the free shuttle. Absent for a shuttle. */
  paid?: true;
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
  /** The walk from the stop you get off at to the destination itself (a
   *  class's room, a building you searched for, a food court), in seconds,
   *  and whether `leave.arrive` already counts it, as a class's leave-by
   *  aims at the room. Absent when the destination is the stop. */
  endWalk?: { s: number; inLeave: boolean };
  /** The user's walking speed in metres a second (their pace), for walk
   *  times an app shows itself, such as search results. Added by the route. */
  walkSpeedMs?: number;
  /** Resting or free: the next class, for its card (card.upcoming). Moved
   *  into the card by the route, not sent at the top level. */
  upcoming?: import('./card.ts').Upcoming | null;
  /** Display-ready text and the stale time (card.ts). Added last, by the route. */
  card?: import('./card.ts').Card;
}

export interface Leave {
  /** ISO, whole seconds. */
  at: string;
  estimated: boolean;
  /** The bus's time is from an older reading (a stale feed, or a plan kept
   *  from an earlier answer): exact, but not live now. Absent otherwise. */
  stale?: true;
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
  /** Seconds on foot to the stop and on the bus, and the stop you get off
   *  at (short name), for the card's journey. */
  walkS?: number;
  rideS?: number;
  toStop?: string;
  /** Without an arrive-by (whose `arrive` is at the venue): the walk on from
   *  where you get off to the place itself, which `arrive` doesn't count. */
  endWalkS?: number;
  /** The bus is a public one, with a fare. Absent for a shuttle. */
  paid?: true;
  /** The graph's route for a public two-way service (`151/1`), which `svc`
   *  (`151`) can't name, so a kept plan can be followed. Absent otherwise. */
  route?: string;
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
  /** The full name ("Central Library" for CLB). Absent on a public-only stop. */
  longName?: string;
  lat: number;
  lon: number;
  /** Code of the directional twin ("Opp X" <-> "X"), if any. */
  opposite?: string | null;
  /**
   * Public buses call at this shelter too, under LTA's five-digit code
   * (data/public.json `merged`). Set only in the graph with public buses.
   */
  publicCode?: string;
  /** A stop only public buses call at (its code is LTA's). */
  public?: true;
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
  /**
   * service -> metres along the route at each stop of `routes[svc]`, where
   * known (public buses, from LTA's route data). Ride time comes from these
   * instead of a count of stops: a public route's stops are unevenly spaced,
   * and two campus stops in a row can be a long way round the island apart.
   */
  along?: Record<string, number[]>;
  /**
   * The public bus services (data/public.json), by route key. A two-way
   * service is two routes, `151/1` and `151/2`; `svc` is what it's called.
   */
  public?: Record<string, PublicService>;
}

/** A public bus service as the graph knows it. */
export interface PublicService {
  /** The number on the bus ("151"). */
  svc: string;
  /** SBST, SMRT, TTS or GAS. */
  operator: string;
  /** LTA codes of the first and last stop of the whole route, which the
   *  arrivals feed names on each bus: they tell a two-way service's directions apart. */
  origin: string;
  dest: string;
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
  /** Where you get off: the destination stop this bus calls at, or its twin. */
  to?: Stop;
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
  /**
   * A shelter both the shuttle and public buses call at has two feeds, and
   * one can fail or go stale without the other. Each feed's own state, where
   * it was asked; the fields above describe the two together (available
   * when either is, stale when either is).
   */
  feeds?: { shuttle?: FeedState; public?: FeedState };
}

/** One feed's answer for a stop, without the arrivals. */
export interface FeedState {
  fetchedAt: number;
  stale: boolean;
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
  /** When the arrivals behind this were fetched (epoch ms): how old a stale time is. */
  fetchedAt: number;
  /** The instant `boardS` and `totalS` count from (epoch ms): the request's now. */
  fromMs: number;
  /** Of `boardS`, the wait for a service that hasn't started yet, which you
   *  can spend wherever you are. Absent when it's running. */
  opensInS?: number;
  /**
   * True when this stop reports this service under more than one berth, so
   * the earliest ETA may belong to the pass going the other way. Until the
   * route sequence carries berth codes, this can only be declared, not fixed.
   */
  ambiguousBerth: boolean;
  /** Where to get off, when the bus only stops across the road from the destination. */
  off?: Stop;
  /** Where you get off: the destination stop this bus calls at, or its twin. */
  to?: Stop;
  /** A public bus, with a fare (public.ts). */
  paid?: true;
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
  /**
   * The user's own walk from home to their nearest home stop. Counts over
   * the residence's outline when the location is inside the residence
   * `preferStops` serve.
   */
  homeWalkS?: number;
  /** Metres per second on foot (the user's pace). Defaults to WALK.speedMs. */
  walkSpeedMs?: number;
  /** Set for a class: leave-by then aims at this, not the next bus. */
  arriveBy?: ArriveBy | null;
  /** Seconds on foot from the stop you get off at to the destination itself
   *  (a room, a building, a food court), for "LT3 in ~12 min". 0 for a stop. */
  endWalkS?: number;
  /** A place with several stops (a food court): the walk from each, by stop
   *  code, as the bus you take may not stop at the closest. */
  endWalkByStopS?: Record<string, number>;
  /** Where the room or building itself is, when known: within WALK.atVenueM of it you're there. */
  destAt?: { lat: number; lon: number } | null;
  /** Seconds per stop on a service, from measured rides (ridetimes.ts).
   *  RIDE.secondsPerHop where it has nothing. */
  hopS?: (svc: string) => number | null;
  /** Count the public buses at the stops too (the profile's `publicBuses`). */
  publicBuses?: boolean;
}
