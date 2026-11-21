export interface Env {
  KV: KVNamespace;
  AE?: AnalyticsEngineDataset;

  NEXTBUS_AUTH_BASE?: string;
  NEXTBUS_PROXY_BASE?: string;
  NEXTBUS_PROXY_API_KEY?: string;
  NEXTBUS_APP_VERSION?: string;
  NEXTBUS_DEVICE_ID?: string;
  NEXTBUS_HTD_API?: string;
  NEXTBUS_APP_API?: string;
  NEXTBUS_REQUESTED_BY?: string;
  NEXTBUS_SECURED_REQUEST?: string;

  FILES?: R2Bucket;
  ASSETS?: Fetcher;
  DB?: D1Database;
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  RL_AUTH?: RateLimit;
  ALERT_EMAIL?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_HOSTNAMES?: string;
  RL_PUBLIC?: RateLimit;
  RL_ME?: RateLimit;
  RL_MAP?: RateLimit;
  HEALTH_TOKEN?: string;
  TIMELAPSE_TOKEN?: string;
  SCRAPE_TOKEN?: string;
  ANALYTICS_TOKEN?: string;
  HEARTBEAT_URL?: string;
  CF_ACCOUNT_ID?: string;
  RL_MAIL?: RateLimit;
  TRIPS?: DurableObjectNamespace;
  FCM_SERVICE_ACCOUNT?: string;
  VAPID_PRIVATE_KEY?: string;
  APNS_KEY?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_TOPIC?: string;
  APPLE_TEAM_ID?: string;
  RL_ANON?: RateLimit;
  RL_PAIR?: RateLimit;
  PUBLIC_ORIGIN?: string;
  LINK_ORIGIN?: string;
  MOVE_PAGES?: string;
  AE_DATASET?: string;
  LTA_ACCOUNT_KEY?: string;
  TIMELAPSE?: DurableObjectNamespace;
  FEED_GATE?: DurableObjectNamespace;
  TIMELAPSE_ENABLED?: string;
  ETA_MODEL?: string;
}

export type Quality = 'live' | 'scheduled' | 'ended' | 'stale' | 'unknown';
export type Crowd = 'low' | 'medium' | 'high';

export interface Arrival {
  svc: string;
  etaS: number | null;
  crowd: Crowd | null;
  plate: string | null;
  berth: string | null;
  ends?: true;
  scheduled?: true;
}

export interface Answer {
  label: string;
  detail: string;
  alt: string | null;
  stop: { code: string; name: string; confidence: number };
  quality: Quality;
  asOf: string;
  arrivals: Arrival[];
  departsAt?: string | null;
  arriveAt?: string | null;
  arrived?: boolean;
  leave?: Leave | null;
  steps?: import('./answer/step.ts').Steps | null;
  bus?: BusLeg | null;
  altBus?: BusLeg | null;
  foot?: { s: number; why: string | null };
}

export interface BusLeg {
  svc: string;
  stop: string;
  stopCode: string;
  walkS: number;
  rideS: number;
  board: string | null;
  arrive: string | null;
  estimated: boolean;
  off?: string;
  toStop?: string;
  endWalkS?: number;
  paid?: true;
  change?: BusChange;
}

export interface BusChange {
  svc: string;
  from: string;
  fromCode: string;
  stop: string;
  stopCode: string;
  crossS?: number;
  reach: string | null;
  board: string | null;
  rideS: number;
  estimated: boolean;
}

export type Mode = 'trip' | 'nearby' | 'rest' | 'free';
export type Why = 'class' | 'home' | 'gap-home' | 'place';

export interface Dest {
  to: string;
  label: string;
  why: Why;
  place?: true;
}

export interface PlaceChip {
  key: string;
  label: string;
}

export interface Timing {
  status: 'on-time' | 'tight' | 'late';
  text: string;
  classAt: string;
  reachAt: string;
}

export interface MeAnswer extends Answer {
  mode: Mode;
  dest: Dest | null;
  places: PlaceChip[];
  timing?: Timing | null;
  refreshAt?: string;
  warning?: string | null;
  endWalk?: { s: number; inLeave: boolean };
  walkSpeedMs?: number;
  upcoming?: import('./answer/card.ts').Upcoming | null;
  card?: import('./answer/card.ts').Card;
}

export interface Leave {
  at: string;
  estimated: boolean;
  stale?: true;
  svc: string | null;
  stop: string | null;
  board: string | null;
  arrive: string | null;
  note?: string | null;
  off?: string;
  stopCode?: string;
  offCode?: string;
  walkS?: number;
  rideS?: number;
  toStop?: string;
  toCode?: string;
  endWalkS?: number;
  paid?: true;
  route?: string;
  change?: BusChange;
}

export interface ArriveBy {
  atMs: number;
  venueWalkS: number;
  walkByStopS?: Record<string, number>;
  fullBusMargin?: boolean;
  oneEarlier?: boolean;
}

export interface Stop {
  code: string;
  name: string;
  longName?: string;
  lat: number;
  lon: number;
  opposite?: string | null;
  publicCode?: string;
  public?: true;
}

export type DayWindow = [string, string] | null;

export interface ServiceHours {
  weekday?: DayWindow;
  saturday?: DayWindow;
  sunday?: DayWindow;
}

export type DayKind = 'weekday' | 'saturday' | 'sunday';

export type HeadwaysByTime = Partial<Record<'term' | 'vacation', Partial<Record<DayKind, { all: number; hours: Record<string, number> }>>>>;

export interface Graph {
  generated: string;
  stops: Stop[];
  routes: Record<string, string[]>;
  loops?: Record<string, boolean>;
  serviceHours?: Record<string, ServiceHours>;
  headwayS?: Record<string, number>;
  headwaysByTime?: Record<string, HeadwaysByTime>;
  along?: Record<string, number[]>;
  public?: Record<string, PublicService>;
}

export interface PublicService {
  svc: string;
  operator: string;
  origin: string;
  dest: string;
}

export interface RouteIndex {
  seq: string[];
  loop: boolean;
  pos: Map<string, number[]>;
}

export interface GraphIndex {
  graph: Graph;
  byCode: Map<string, Stop>;
  routes: Map<string, RouteIndex>;
  servingStop: Map<string, string[]>;
}

export interface Leg {
  svc: string;
  hops: number;
  rideS?: number;
  crossS?: number;
  off?: Stop;
  to?: Stop;
}

export interface Candidate {
  stop: Stop;
  distM: number;
  walkS: number;
  here?: true;
  legs: Leg[];
}

export interface StopArrivals {
  code: string;
  arrivals: Arrival[];
  fetchedAt: number;
  stale: boolean;
  available: boolean;
  feeds?: { shuttle?: FeedState; public?: FeedState };
  unread?: string[];
}

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
  here?: true;
  hops: number;
  boardS: number;
  rideS: number;
  totalS: number;
  quality: Quality;
  arrival: Arrival | null;
  bus?: string;
  fetchedAt: number;
  fromMs: number;
  opensInS?: number;
  ambiguousBerth: boolean;
  off?: Stop;
  to?: Stop;
  paid?: true;
  change?: ScoredChange;
}

export interface ScoredChange {
  at: Stop;
  stop: Stop;
  crossS: number;
  svc: string;
  hops: number;
  reachS: number;
  boardS: number;
  rideS: number;
  quality: Quality;
  arrival: Arrival | null;
  fetchedAt: number;
  ambiguousBerth: boolean;
}

export interface ResolveInput {
  lat: number | null;
  lon: number | null;
  to: string | null;
  toAlso?: string[];
  originCode: string | null;
  preferStops?: string[];
  originWalkS?: number;
  originAlso?: string[];
  originWalkByStopS?: Record<string, number>;
  homeWalkS?: number;
  walkSpeedMs?: number;
  walkWeight?: number;
  arriveBy?: ArriveBy | null;
  endWalkS?: number;
  endWalkByStopS?: Record<string, number>;
  destAt?: { lat: number; lon: number } | null;
  step?: { trip: string; target: import('./answer/step.ts').StepTarget | null };
  publicBuses?: boolean;
  log?: boolean;
}
