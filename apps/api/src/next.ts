/**
 * /me/next's answer: where you're going now and how, from the timetable (or
 * a place you asked for), and which of today's trips it is about, so the
 * card can say what phase it's in (trip.ts).
 */

import type { Answer, Env, Graph, MeAnswer, PlaceChip, ResolveInput, Why } from './types.ts';
import type { MeDeps } from './me.ts';
import {
  HOME_BY_MIN,
  MAX_VENUE_WALK_S,
  type Profile,
  classKey,
  classStartMs,
  classesOn,
  isResting,
  nextClass,
  planFor,
  restDetail,
  restLabel,
  timingFor,
} from './profile.ts';
import { type ImportedTrip, venueToStop } from './nusmods.ts';
import { indexGraph, serviceEndsAt } from './resolve.ts';
import { haversineM } from './geo.ts';
import { clockAt, clockMin } from './clock.ts';
import { sgt } from './config.ts';
import { shortStop } from './format.ts';
import { landmark, targetStops } from './landmarks.ts';
import { atHome } from './residences.ts';
import { paceSpeed } from './walk.ts';
import { coordsFrom } from './http.ts';
import type { TripView } from './card.ts';
import { NO_PREFS, type TripPrefs } from './outcomes.ts';
import { ASSUME_MS, type Boarded, type DayRecord, RIDE_GRACE_MS, dayState, isFollowed, offStop, phaseFor, signalOf } from './trip.ts';

/** `?h12=1`: the client shows 12-hour times. Default 24-hour, as always. */
export const hour12 = (url: URL) => url.searchParams.get('h12') === '1';

/** In the evening, a location this close to a stop is on campus. */
export const ON_CAMPUS_M = 500;
/** "Last D2 from UTown in 18 min" shows from this long before the last one. */
export const LAST_BUS_WARN_MS = 45 * 60_000;
/** "Undo: going to CS2030" stays offered this long after "Not going". */
export const UNDO_MS = 10 * 60_000;

interface Dest {
  to: string;
  label: string;
  why: Why;
  from: string | null;
  trip?: ImportedTrip | null;
  fromVenue?: string | null;
}

export interface Planned {
  answer: MeAnswer;
  trip: TripView;
}

/** Stop code, or a NUSMods venue code resolved to its nearest stop. */
export function resolveTo(graph: Graph, raw: string): { to: string; label: string } | null {
  const code = raw.trim().toUpperCase();
  const stop = indexGraph(graph).byCode.get(code);
  if (stop) return { to: stop.code, label: shortStop(stop.name, 14) };
  // A food court: kept as its own code; tripAnswer expands it to its stops.
  const lm = landmark(code);
  if (lm) return { to: code, label: lm.name };
  const v = venueToStop(code);
  return v ? { to: v.stop, label: code.split('-')[0] } : null;
}

function base(nowMs: number, label: string, detail: string): Answer {
  return { label, detail, alt: null, stop: { code: '', name: '', confidence: 0 }, quality: 'unknown', asOf: new Date(nowMs).toISOString(), arrivals: [] };
}

/** In your residence with nothing left today: no bus, and what's next. */
function youreHome(profile: Profile, nowMs: number, homeStop: string | null, places: PlaceChip[], h12: boolean): MeAnswer {
  return {
    ...base(nowMs, "You're home", restDetail(profile, nowMs, h12)),
    stop: { code: homeStop ?? '', name: '', confidence: 1 },
    quality: 'live',
    arrived: true,
    leave: null,
    mode: 'trip',
    dest: { to: homeStop ?? '', label: 'Home', why: 'home' },
    places,
  };
}

/**
 * Nothing to catch today: said plainly, with what's next. No bus in the
 * headline: a bus you have no reason to take reads like advice. Departures
 * near you are on the Nearby tab.
 */
function freeAnswer(profile: Profile, nowMs: number, places: PlaceChip[], h12: boolean, skipped?: ReadonlySet<string>, away = false): MeAnswer {
  const hadClasses = classesOn(profile, nowMs).length > 0;
  const empty = !profile.trips.length && !profile.manual.length && !profile.usual.length && !profile.once.length;
  const label = away ? 'Not on campus today' : empty ? 'No timetable yet' : hadClasses ? 'No more classes today' : 'No classes today';
  const detail = empty ? 'Add your timetable in Settings. Buses near you are under Nearby.' : restDetail(profile, nowMs, h12, skipped);
  return { ...base(nowMs, label, detail), quality: 'ended', mode: 'free', dest: null, places };
}

function restAnswer(profile: Profile, nowMs: number, places: PlaceChip[], h12: boolean): MeAnswer {
  return { ...base(nowMs, restLabel(profile, nowMs, h12), restDetail(profile, nowMs, h12)), quality: 'ended', mode: 'rest', dest: null, places };
}

/**
 * Without a location, the walk to the stop you're assumed to start from:
 * from the room you're in when that's the last class's stop, from home when
 * it's the home stop.
 */
function originWalkS(dest: { from: string | null; fromVenue?: string | null }, homeStop: string | null, homeWalkMin: number, speed: number): number {
  if (dest.fromVenue) {
    const m = venueToStop(dest.fromVenue)?.m ?? 0;
    const s = Math.round(m / speed);
    // Past this the room's stop is not really its stop (bad data).
    return s <= MAX_VENUE_WALK_S ? s : 0;
  }
  return dest.from !== null && dest.from === homeStop ? homeWalkMin * 60 : 0;
}

/** How to get to `dest` now: the bus, the leave-by and, for a class, whether you'll make it. */
export async function tripAnswer(
  env: Env,
  ctx: ExecutionContext,
  nowMs: number,
  deps: MeDeps,
  profile: Profile,
  dest: Dest,
  at: { lat: number | null; lon: number | null },
  places: PlaceChip[],
  h12: boolean,
  oneEarlier = false,
): Promise<MeAnswer> {
  const { lat, lon } = at;
  const speed = paceSpeed(profile.walkPace);
  const homeStop = profile.home?.stops[0] ?? null;
  // A class to go to but nowhere to start from: without this the resolver
  // has no stop to check and says "Services ended" at 9 am.
  if (lat === null && !dest.from) {
    return {
      ...base(nowMs, 'Add a home stop', 'Pick where your day starts in Settings, or turn on location'),
      mode: 'trip',
      dest: { to: dest.to, label: dest.label, why: dest.why },
      places,
    };
  }
  const venueM = dest.trip?.venue ? (venueToStop(dest.trip.venue)?.m ?? 0) : 0;
  // A class has its room's walk; a food court the walk from its nearest stop.
  const venueWalkS = Math.round((venueM || targetStops(dest.to).walkM) / speed);
  // A place served by several stops arrives at whichever is quicker.
  const target = targetStops(dest.to);
  const input: ResolveInput = {
    lat,
    lon,
    to: target.to,
    toAlso: target.also,
    originCode: lat === null && dest.from ? targetStops(dest.from).to : null,
    preferStops: profile.home?.stops ?? [],
    originWalkS: lat === null ? originWalkS(dest, homeStop, profile.homeWalkMin, speed) : 0,
    walkSpeedMs: speed,
    arriveBy: dest.trip && venueWalkS <= MAX_VENUE_WALK_S ? { atMs: classStartMs(dest.trip, nowMs), venueWalkS, fullBusMargin: profile.fullBusMargin, ...(oneEarlier ? { oneEarlier } : {}) } : null,
  };
  const answer = await deps.answerFor(env, ctx, input, dest.label, nowMs);
  // For a class, say whether you'll make it: stop arrival plus the walk
  // from the stop to the venue, against the start time.
  const timing = dest.trip ? timingFor(answer.arriveAt, dest.trip, venueWalkS, nowMs, h12) : null;
  return { ...answer, mode: 'trip', dest: { to: dest.to, label: dest.label, why: dest.why }, timing, places };
}

function onCampus(graph: Graph, lat: number, lon: number): boolean {
  return graph.stops.some((s) => haversineM(lat, lon, s.lat, s.lon) <= ON_CAMPUS_M);
}

/** "Last D2 from UTown in 18 min", when the bus home is about to stop running. */
function lastBusWarning(graph: Graph, a: MeAnswer, nowMs: number): string | null {
  const svc = a.leave?.svc;
  if (!svc || !a.leave?.stop) return null;
  const ends = serviceEndsAt(graph, svc, nowMs);
  if (ends === null || ends <= nowMs || ends - nowMs > LAST_BUS_WARN_MS) return null;
  return `Last ${svc} from ${a.leave.stop} in ${Math.max(1, Math.round((ends - nowMs) / 60_000))} min`;
}

/**
 * A trip skipped a moment ago, offered back as "Undo"; or one taken as
 * reached from the phone's location, offered back as "Not there yet".
 */
function undoOf(day: DayRecord | null, nowMs: number): TripView['undo'] {
  const recent = Object.entries(day?.trips ?? {})
    .filter(([, r]) => ((r.kind === 'skipped' && !r.away) || (r.kind === 'arrived' && r.detected)) && nowMs - r.at < UNDO_MS)
    .sort(([, a], [, b]) => b.at - a.at)[0];
  if (!recent) return null;
  const [key, r] = recent;
  return { key, label: r.label ?? 'it', ...(r.kind === 'arrived' ? { arrived: true } : {}) };
}

/**
 * When the bus you're on reaches your stop, from the feed: the same plate in
 * that stop's arrivals. Null without a plate, or once it's no longer listed
 * there (it has arrived, or the feed dropped it); the tap's estimate is used then.
 */
export async function liveArrival(env: Env, ctx: ExecutionContext, deps: MeDeps, b: Boarded, nowMs: number): Promise<string | null> {
  if (!b.plate || !b.alightCode) return null;
  const sa = (await deps.collectArrivals(env, ctx, [b.alightCode], nowMs)).get(b.alightCode);
  if (!sa?.available || sa.stale) return null;
  // A loop can list the same bus twice at one stop; the first pass is the one.
  const etas = sa.arrivals.filter((x) => x.plate === b.plate && x.svc === b.svc && x.etaS !== null).map((x) => x.etaS!);
  if (!etas.length) return null;
  const at = sa.fetchedAt + Math.min(...etas) * 1000;
  return at > nowMs ? new Date(Math.round(at / 1000) * 1000).toISOString().replace('.000Z', 'Z') : null;
}

/** On the bus you said you'd caught: where it gets you, not the next bus. */
function ridingAnswer(nowMs: number, dest: Dest, b: Boarded, live: boolean, places: PlaceChip[], h12: boolean, profile: Profile): MeAnswer {
  const off = offStop(b) ?? dest.label;
  const arrive = b.arrive ? Date.parse(b.arrive) : null;
  let detail = arrive !== null ? `Off at ${off} · arrive ${live ? '' : '~'}${clockAt(arrive, h12)}` : `Off at ${off}`;
  let timing = null;
  if (dest.trip && b.arrive) {
    const venueM = dest.trip.venue ? (venueToStop(dest.trip.venue)?.m ?? 0) : 0;
    timing = timingFor(b.arrive, dest.trip, Math.round(venueM / paceSpeed(profile.walkPace)), nowMs, h12);
    if (timing) detail += ` · ${timing.status === 'late' ? timing.text : timing.text.split(' · ')[1] ?? ''}`.replace(/ · $/, '');
  }
  return {
    ...base(nowMs, `On the ${b.svc}`, detail),
    quality: live ? 'live' : 'scheduled',
    arriveAt: b.arrive ?? undefined,
    mode: 'trip',
    dest: { to: dest.to, label: dest.label, why: dest.why },
    timing,
    places,
  };
}

/** Reached by now, by the bus you were on: the next thing, and where you are. */
function thereAnswer(profile: Profile, nowMs: number, dest: Dest, places: PlaceChip[], h12: boolean): MeAnswer {
  const next = nextClass(profile, nowMs);
  const end = dest.trip?.endMin;
  const label = dest.trip ? `In ${dest.trip.label}` : `At ${dest.label}`;
  const detail = [end ? `till ${clockMin(end, h12)}` : null, next ? restDetail(profile, nowMs, h12) : null]
    .filter(Boolean)
    .join(' · ');
  return { ...base(nowMs, label, detail || "You're there"), quality: 'live', arrived: true, leave: null, mode: 'trip', dest: { to: dest.to, label: dest.label, why: dest.why }, places };
}

/**
 * The planned (or asked-for) answer and the trip it's about. `day` is
 * today's trip signals, or null when there are none.
 */
export async function planned(
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  nowMs: number,
  deps: MeDeps,
  profile: Profile,
  day: DayRecord | null,
  prefs: TripPrefs = NO_PREFS,
): Promise<Planned> {
  const p = await plannedTrip(url, env, ctx, nowMs, deps, profile, day, prefs);
  // What the user chose for their trips, and what terminus has to suggest.
  const trip: TripView = {
    ...p.trip,
    ...(p.trip.key && isFollowed(day, nowMs) ? { followed: true } : {}),
    askMuted: prefs.askMuted,
    remind: !(p.trip.key && prefs.quiet.has(p.trip.key)),
    // Never in the middle of a trip.
    suggestion: p.trip.phase === 'idle' || p.trip.phase === 'arrived' ? prefs.suggestion : null,
  };
  return { answer: p.answer, trip };
}

async function plannedTrip(url: URL, env: Env, ctx: ExecutionContext, nowMs: number, deps: MeDeps, profile: Profile, day: DayRecord | null, prefs: TripPrefs): Promise<Planned> {
  const at = coordsFrom(url);
  const { lat, lon } = at;
  const h12 = hour12(url);
  const homeStop = profile.home?.stops[0] ?? null;
  const places: PlaceChip[] = profile.places.map(({ key, label }) => ({ key, label }));
  const undo = undoOf(day, nowMs);
  const idle = (answer: MeAnswer): Planned => ({ answer, trip: { key: null, phase: 'idle', undo } });

  // A place or stop you asked for: an ad-hoc trip, not tracked.
  const placeKey = url.searchParams.get('place');
  const toRaw = url.searchParams.get('to');
  if (placeKey || toRaw) {
    let dest: Dest | null = null;
    if (placeKey) {
      const pl = profile.places.find((p) => p.key === placeKey);
      if (pl) dest = { to: pl.to, label: pl.label, why: 'place', from: homeStop };
    } else {
      const r = resolveTo(deps.graph, toRaw!);
      if (r) dest = { ...r, why: 'place', from: homeStop };
    }
    if (dest) return idle(await tripAnswer(env, ctx, nowMs, deps, profile, dest, at, places, h12));
    return idle(freeAnswer(profile, nowMs, places, h12));
  }

  const homeHere = atHome(lat, lon, profile.home?.stops ?? []);
  if (isResting(profile, nowMs)) {
    // Evenings: on campus and not at home, the way home rather than a moon.
    if (homeStop && lat !== null && lon !== null && !homeHere && onCampus(deps.graph, lat, lon)) {
      const dest: Dest = { to: homeStop, label: 'Home', why: 'home', from: null };
      const answer = await tripAnswer(env, ctx, nowMs, deps, profile, dest, at, places, h12);
      return withPhase({ ...answer, warning: lastBusWarning(deps.graph, answer, nowMs) }, 'home:evening');
    }
    return idle(restAnswer(profile, nowMs, places, h12));
  }

  const state = dayState(day);
  const plan = planFor(profile, nowMs, state);
  if (!plan) {
    const free = freeAnswer(profile, nowMs, places, h12, state.skipped, state.away);
    return { answer: free, trip: { key: null, phase: 'idle', undo, ...(state.away ? { away: true } : {}) } };
  }

  let dest: Dest = { to: plan.to, label: plan.label, why: plan.why, from: plan.from, trip: plan.trip, fromVenue: plan.fromVenue };
  let key = plan.trip ? classKey(plan.trip) : plan.why === 'home' ? `home:${plan.lastEndMin}` : `gap-home:${plan.from}`;

  if (plan.why === 'home' || plan.why === 'gap-home') {
    // Already in your residence: "Home" is not somewhere to go.
    if (homeHere || state.done.has(key)) {
      const next = nextClass(profile, nowMs);
      if (plan.why !== 'gap-home' || next?.daysAhead !== 0) return idle(youreHome(profile, nowMs, homeStop, places, h12));
      // Between classes: when to leave home for the next one.
      dest = { to: next.trip.to, label: next.trip.label, why: 'class', from: homeStop, trip: next.trip, fromVenue: null };
      key = classKey(next.trip);
    } else if (plan.why === 'home' && lat === null && plan.lastEndMin !== undefined && sgt(nowMs).minutes >= plan.lastEndMin + HOME_BY_MIN) {
      // No location, and long enough since the last class to be home by now.
      return idle(youreHome(profile, nowMs, homeStop, places, h12));
    }
  }

  const rec = signalOf(day, key);
  if (rec?.kind === 'boarded' && rec.boarded) {
    const onBus = await riding(rec.boarded);
    if (onBus) return { answer: onBus.answer, trip: { key, phase: 'riding', rec: { ...rec, boarded: onBus.b }, undo } };
    // The bus you were on should have got you there by now.
    return { answer: thereAnswer(profile, nowMs, dest, places, h12), trip: { key, phase: 'arrived', rec, undo } };
  }

  const answer = await tripAnswer(env, ctx, nowMs, deps, profile, dest, at, places, h12, prefs.earlier.has(key));
  const home = dest.why === 'home' || dest.why === 'gap-home';
  const out = withPhase(home ? { ...answer, warning: lastBusWarning(deps.graph, answer, nowMs) } : answer, key);
  // Still in the day's last class: the way home is the answer, but that trip
  // hasn't started ("Time to get going" in the middle of a lecture), and
  // nothing about its bus is assumed or followed until the class ends.
  if (dest.why === 'home' && plan.lastEndMin !== undefined && sgt(nowMs).minutes < plan.lastEndMin && !out.trip.rec) {
    return { answer: out.answer, trip: { ...out.trip, phase: 'idle' } };
  }

  // Nobody answered "On the 9:41 D2?" and the bus left a while ago: the plan
  // worked (most people catch the bus they were told to), unless a location
  // still has you at the stop. Assumed, never recorded as a signal.
  const l = answer.leave;
  const stored = day?.plans?.[key];
  // From the leave time you were given, the plan is that bus until it has
  // left and been asked about, whatever the answer says now. Past the leave
  // time the answer moves on to a later bus (you may not have gone), and
  // devices with and without a location plan from different stops; letting
  // either replace the plan would mean the bus you were told to catch never
  // leaves as the plan, and the question is never asked. Before then, a
  // device without a location (the widget, the background refresh) plans from
  // where the timetable puts you, and doesn't replace a plan made from where
  // the phone actually is.
  const located = lat !== null && lon !== null;
  const frozen = stored?.board && nowMs >= Math.min(Date.parse(stored.board), stored.leave ? Date.parse(stored.leave) : Infinity) ? stored : null;
  const bus: Boarded | null =
    frozen ??
    (l?.svc && l.board ? { svc: l.svc, stop: l.stop ?? '', board: l.board, ...(l.at ? { leave: l.at } : {}), ...(located ? { located: true } : {}), arrive: l.arrive, ...(l.off ? { off: l.off } : {}), ...(l.stopCode ? { stopCode: l.stopCode } : {}), alightCode: l.offCode ?? dest.to } : null);
  if (bus && !frozen && (stored?.board !== bus.board || stored?.svc !== bus.svc) && (located || !stored?.located)) out.trip.planChanged = true;
  // Someone said detection got this trip wrong: nothing is assumed either.
  const undetected = day?.trips[key]?.kind === 'undetected';
  // Having been at the stop is not an answer about the bus.
  const answered = out.trip.rec !== undefined && out.trip.rec.kind !== 'waiting';
  if (!answered && !undetected && bus && !answer.arrived && nowMs >= Date.parse(bus.board!) + ASSUME_MS) {
    // Still at the stop now (this request's location), not just earlier: missed.
    if (phaseFor(answer, undefined, nowMs, at) === 'waiting') return { answer, trip: { ...out.trip, phase: 'missed', assumed: true, plan: bus, planChanged: false } };
    const onBus = await riding(bus);
    if (onBus) return { answer: onBus.answer, trip: { key, phase: 'riding', undo, assumed: true, plan: onBus.b } };
  }
  return bus ? { ...out, trip: { ...out.trip, plan: bus } } : out;

  function withPhase(answer: MeAnswer, tripKey: string): Planned {
    const r = signalOf(day, tripKey);
    return { answer, trip: { key: tripKey, phase: phaseFor(answer, r, nowMs, at), rec: r, undo } };
  }

  /** The riding answer while the bus should still be on its way, with the feed's arrival when there is one. */
  async function riding(b: Boarded): Promise<{ answer: MeAnswer; b: Boarded } | null> {
    const live = await liveArrival(env, ctx, deps, b, nowMs);
    const cur = live ? { ...b, arrive: live } : b;
    const arrive = cur.arrive ? Date.parse(cur.arrive) : null;
    if (arrive !== null && nowMs >= arrive + RIDE_GRACE_MS) return null;
    return { answer: ridingAnswer(nowMs, dest, cur, live !== null, places, h12, profile), b: cur };
  }
}
