/**
 * /me/next's answer: where you're going now and how, from the timetable (or
 * a place you asked for), and which of today's trips it is about, so the
 * card can say what phase it's in (trip.ts).
 */

import type { Answer, Env, FeedState, Graph, MeAnswer, PlaceChip, ResolveInput, StopArrivals, Why } from './types.ts';
import type { MeDeps } from './me.ts';
import {
  HOME_BY_MIN,
  MAX_VENUE_WALK_S,
  type Plan,
  type Profile,
  classKey,
  classStartMs,
  classesOn,
  endOf,
  isResting,
  nextClass,
  planFor,
  reachedEarly,
  restDetail,
  restLabel,
  timingFor,
  upcomingClass,
} from './profile.ts';
import { type ImportedTrip, venueAt, venueToStop } from './nusmods.ts';
import { feedFor, indexGraph, serviceEndsAt } from './resolve.ts';
import { haversineM } from './geo.ts';
import { clockAt, clockMin, slackText } from './clock.ts';
import { sgt } from './config.ts';
import { isoSeconds, shortStop } from './format.ts';
import { landmark, targetStops } from './landmarks.ts';
import { atHome } from './residences.ts';
import { paceSpeed } from './walk.ts';
import { coordsFrom } from './http.ts';
import type { TripView } from './card.ts';
import { NO_PREFS, type TripPrefs } from './outcomes.ts';
import { ASSUME_MS, type Boarded, type DayRecord, RIDE_GRACE_MS, dayState, leaveOf, offStop, phaseFor, signalOf } from './trip.ts';
import { choosePlan, planOfLeave } from './plan.ts';
import { m } from './i18n.ts';

/**
 * 12-hour times: the account's choice when it made one, else the client's
 * own (`?h12=1`). Default 24-hour, as always.
 */
export const hour12 = (url: URL, profile?: Pick<Profile, 'clock'>) =>
  profile?.clock === '12' ? true : profile?.clock === '24' ? false : url.searchParams.get('h12') === '1';

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
  /** A room or building searched for, reached on foot from its stop `to`. */
  venue?: string | null;
}

/** The destination as the answer names it. */
const destOf = (d: Dest): NonNullable<MeAnswer['dest']> => ({ to: d.to, label: d.label, why: d.why });

/** A trip home's key: after the day's last class, or in a long gap. */
const homeKey = (plan: Pick<Plan, 'why' | 'lastEndMin' | 'from'>) => (plan.why === 'home' ? `home:${plan.lastEndMin}` : `gap-home:${plan.from}`);

export interface Planned {
  answer: MeAnswer;
  trip: TripView;
}

/** Stop code, or a NUSMods venue code resolved to its nearest stop (kept as `venue`, for the walk from it). */
export function resolveTo(graph: Graph, raw: string): { to: string; label: string; venue?: string } | null {
  const code = raw.trim().toUpperCase();
  const stop = indexGraph(graph).byCode.get(code);
  if (stop) return { to: stop.code, label: shortStop(stop.name, 14) };
  // A food court: kept as its own code; tripAnswer expands it to its stops.
  const lm = landmark(code);
  if (lm) return { to: code, label: lm.name };
  const v = venueToStop(code);
  return v ? { to: v.stop, label: code.split('-')[0], venue: code } : null;
}

/** The next class's card, with stop codes named from the graph. */
function upcoming(graph: Graph, profile: Profile, nowMs: number, h12: boolean, skipped?: ReadonlySet<string>) {
  const idx = indexGraph(graph);
  return upcomingClass(profile, nowMs, h12, (code) => shortStop(idx.byCode.get(code)?.name ?? code), skipped);
}

function base(nowMs: number, label: string, detail: string): Answer {
  return { label, detail, alt: null, stop: { code: '', name: '', confidence: 0 }, quality: 'unknown', asOf: new Date(nowMs).toISOString(), arrivals: [] };
}

/** In your residence with nothing left today: no bus, and what's next. */
function youreHome(graph: Graph, profile: Profile, nowMs: number, homeStop: string | null, places: PlaceChip[], h12: boolean, skipped?: ReadonlySet<string>): MeAnswer {
  return {
    ...base(nowMs, m().youreHome, restDetail(profile, nowMs, h12, skipped)),
    upcoming: upcoming(graph, profile, nowMs, h12, skipped),
    stop: { code: homeStop ?? '', name: '', confidence: 1 },
    quality: 'live',
    arrived: true,
    leave: null,
    mode: 'trip',
    dest: { to: homeStop ?? '', label: m().home, why: 'home' },
    places,
  };
}

/**
 * Nothing to catch today: said plainly, with what's next. No bus in the
 * headline: a bus you have no reason to take reads like advice. Departures
 * near you are on the Nearby tab.
 */
function freeAnswer(graph: Graph, profile: Profile, nowMs: number, places: PlaceChip[], h12: boolean, skipped?: ReadonlySet<string>, away = false): MeAnswer {
  const hadClasses = classesOn(profile, nowMs).length > 0;
  const empty = !profile.trips.length && !profile.manual.length && !profile.usual.length && !profile.once.length;
  const label = away ? m().notOnCampus : empty ? m().noTimetableYet : hadClasses ? m().noMoreClassesToday : m().noClassesToday;
  const detail = empty ? m().addTimetableHint : restDetail(profile, nowMs, h12, skipped);
  return { ...base(nowMs, label, detail), quality: 'ended', mode: 'free', dest: null, places, upcoming: empty ? null : upcoming(graph, profile, nowMs, h12, skipped) };
}

function restAnswer(graph: Graph, profile: Profile, nowMs: number, places: PlaceChip[], h12: boolean): MeAnswer {
  return { ...base(nowMs, restLabel(profile, nowMs, h12), restDetail(profile, nowMs, h12)), quality: 'ended', mode: 'rest', dest: null, places, upcoming: upcoming(graph, profile, nowMs, h12) };
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
      ...base(nowMs, m().addHomeStop, m().addHomeStopHint),
      mode: 'trip',
      dest: destOf(dest),
      places,
    };
  }
  const venue = dest.trip?.venue || dest.venue;
  const venueM = venue ? (venueToStop(venue)?.m ?? 0) : 0;
  // A class or a room searched for has its room's walk; a food court the walk from its nearest stop.
  const venueWalkS = Math.round((venueM || targetStops(dest.to).walkM) / speed);
  // Past this the room's stop is not really its stop (bad data): no walk at all.
  const endWalkS = venueWalkS <= MAX_VENUE_WALK_S ? venueWalkS : 0;
  // A food court with several stops: the walk from each, for whichever the bus gets you off at.
  const lm = venueM ? null : landmark(dest.to);
  const endWalkByStopS = lm && Object.keys(lm.stops).length > 1 ? Object.fromEntries(Object.entries(lm.stops).map(([code, m]) => [code, Math.round(m / speed)])) : undefined;
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
    ...(profile.home ? { homeWalkS: profile.homeWalkMin * 60 } : {}),
    walkSpeedMs: speed,
    arriveBy: dest.trip && venueWalkS <= MAX_VENUE_WALK_S ? { atMs: classStartMs(dest.trip, nowMs), venueWalkS, fullBusMargin: profile.fullBusMargin, ...(oneEarlier ? { oneEarlier } : {}) } : null,
    endWalkS,
    ...(endWalkByStopS ? { endWalkByStopS } : {}),
    destAt: venue ? venueAt(venue) : null,
    ...(profile.publicBuses ? { publicBuses: true } : {}),
  };
  const answer = await deps.answerFor(env, ctx, input, dest.label, nowMs);
  // For a class, say whether you'll make it: stop arrival plus the walk
  // from the stop to the venue, against the start time.
  const timing = dest.trip ? timingFor(answer.arriveAt, dest.trip, venueWalkS, nowMs, h12, answer.leave?.estimated === true) : null;
  const endWalk = endWalkS > 0 ? { endWalk: { s: endWalkS, inLeave: input.arriveBy != null } } : {};
  return { ...answer, mode: 'trip', dest: destOf(dest), timing, places, ...endWalk };
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
  return m().lastBus(svc, a.leave.stop, Math.max(1, Math.round((ends - nowMs) / 60_000)));
}

/** A trip skipped a moment ago, offered back as "Undo". */
function undoOf(day: DayRecord | null, nowMs: number): TripView['undo'] {
  const recent = Object.entries(day?.trips ?? {})
    .filter(([, r]) => r.kind === 'skipped' && !r.away && nowMs - r.at < UNDO_MS)
    .sort(([, a], [, b]) => b.at - a.at)[0];
  return recent ? { key: recent[0], label: recent[1].label ?? null } : null;
}

/**
 * The arrivals at the stop you get off at, from the feed the bus you're on
 * is in: LTA's for a public bus, through the public graph, so a ride on the
 * 151 never costs NUS a call that can't list it.
 */
function rideStopArrivals(env: Env, ctx: ExecutionContext, deps: MeDeps, b: Boarded, nowMs: number): Promise<StopArrivals | undefined> {
  const graph = b.paid ? (deps.publicGraph ?? deps.graph) : deps.graph;
  return deps.collectArrivals(env, ctx, [b.alightCode!], nowMs, graph).then((byStop) => byStop.get(b.alightCode!));
}

/**
 * The feed the bus you're on is reported by, when it answered fresh. At a
 * shelter both feeds call at, the stop's own fetch time and state are the
 * two together (the older, stale when either is); the bus's times count
 * from its own feed's fetch.
 */
export function rideFeed(sa: StopArrivals | undefined, b: Pick<Boarded, 'paid'>): FeedState | null {
  const feed = feedFor(sa, b.paid === true);
  return feed && feed.available !== false && !feed.stale ? feed : null;
}

/** The service as the feed's rows name it: a public bus's route (`151/1`) when its number can't. */
const rideSvc = (b: Boarded): string => b.route ?? b.svc;

/**
 * When the bus you're on reaches your stop, from the feed: the same plate in
 * that stop's arrivals. Null without a plate, or once it's no longer listed
 * there (it has arrived, or the feed dropped it); the tap's estimate is used then.
 */
export async function liveArrival(env: Env, ctx: ExecutionContext, deps: MeDeps, b: Boarded, nowMs: number): Promise<string | null> {
  if (!b.plate || !b.alightCode) return null;
  const sa = await rideStopArrivals(env, ctx, deps, b, nowMs);
  const feed = rideFeed(sa, b);
  if (!sa || !feed) return null;
  // A loop can list the same bus twice at one stop; the first pass is the one.
  const etas = sa.arrivals.filter((x) => x.plate === b.plate && x.svc === rideSvc(b) && x.etaS !== null).map((x) => x.etaS!);
  if (!etas.length) return null;
  const at = feed.fetchedAt + Math.min(...etas) * 1000;
  return at > nowMs ? isoSeconds(at) : null;
}

/**
 * When the next bus of the service reaches the stop you get off at, from the
 * feed, whichever bus it is. The guess once the bus you said you were on
 * should have got you there and nothing says you're there: you may have
 * caught the one after it. Null without the feed, or with nothing due.
 */
export async function nextArrival(env: Env, ctx: ExecutionContext, deps: MeDeps, b: Boarded, nowMs: number): Promise<string | null> {
  if (!b.alightCode) return null;
  const sa = await rideStopArrivals(env, ctx, deps, b, nowMs);
  const feed = rideFeed(sa, b);
  if (!sa || !feed) return null;
  const due = sa.arrivals.filter((x) => x.svc === rideSvc(b) && x.etaS !== null).map((x) => feed.fetchedAt + x.etaS! * 1000).filter((at) => at > nowMs);
  return due.length ? isoSeconds(Math.min(...due)) : null;
}

/** On the bus you said you'd caught: where it gets you, not the next bus. */
function ridingAnswer(nowMs: number, dest: Dest, b: Boarded, live: boolean, places: PlaceChip[], h12: boolean, profile: Profile): MeAnswer {
  const off = offStop(b) ?? dest.label;
  const arrive = b.arrive ? Date.parse(b.arrive) : null;
  let detail = arrive !== null ? `${m().offAtCap(off)} · ${m().arriveAt(live ? clockAt(arrive, h12) : m().approx(clockAt(arrive, h12)))}` : m().offAtCap(off);
  let timing = null;
  if (dest.trip && b.arrive) {
    const venueM = dest.trip.venue ? (venueToStop(dest.trip.venue)?.m ?? 0) : 0;
    const walkS = Math.round(venueM / paceSpeed(profile.walkPace));
    timing = timingFor(b.arrive, dest.trip, walkS, nowMs, h12, !live);
    // Late: "~3 min late"; otherwise only the spare time, as the arrival is already said.
    if (timing) detail += ` · ${timing.status === 'late' ? timing.text : slackText((Date.parse(timing.classAt) - Date.parse(timing.reachAt!)) / 1000)}`;
  }
  return {
    ...base(nowMs, m().onThe(b.svc), detail),
    quality: live ? 'live' : 'scheduled',
    arriveAt: b.arrive ?? undefined,
    mode: 'trip',
    dest: destOf(dest),
    timing,
    places,
  };
}

/** Reached by now, by the bus you were on: the next thing, and where you are. */
function thereAnswer(profile: Profile, nowMs: number, dest: Dest, places: PlaceChip[], h12: boolean, skipped?: ReadonlySet<string>): MeAnswer {
  const next = nextClass(profile, nowMs);
  // When it really ends: about half an hour early for a NUSMods class (endOf).
  const end = dest.trip?.endMin !== undefined ? endOf(dest.trip) : undefined;
  // There before it starts: when it starts, not "In GEA1000".
  const early = dest.trip && sgt(nowMs).minutes < dest.trip.arriveByMin;
  const label = early ? m().youreThere : dest.trip ? m().inClass(dest.trip.label) : m().atPlace(dest.label);
  const when = early ? m().startsAt(dest.trip!.label, clockMin(dest.trip!.arriveByMin, h12)) : end ? m().till(dest.trip?.nusmods ? m().approx(clockMin(end, h12)) : clockMin(end, h12)) : null;
  const detail = [when, !early && next ? restDetail(profile, nowMs, h12, skipped) : null]
    .filter(Boolean)
    .join(' · ');
  return { ...base(nowMs, label, detail || m().youreThere), quality: 'live', arrived: true, leave: null, mode: 'trip', dest: destOf(dest), places };
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
    ...reachedOf(url, nowMs, profile, day, p),
    remind: !(p.trip.key && prefs.quiet.has(p.trip.key)),
    // Never in the middle of a trip.
    suggestion: p.trip.phase === 'idle' || p.trip.phase === 'arrived' ? prefs.suggestion : null,
  };
  return { answer: p.answer, trip };
}

async function plannedTrip(url: URL, env: Env, ctx: ExecutionContext, nowMs: number, deps: MeDeps, profile: Profile, day: DayRecord | null, prefs: TripPrefs): Promise<Planned> {
  const at = coordsFrom(url);
  const { lat, lon } = at;
  const h12 = hour12(url, profile);
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
    // Not a stop, room or saved place (a favourite since removed, say): the
    // day's own answer, as if none had been asked for. A free day's "No more
    // classes today" would be untrue with a class still to come.
  }

  const homeHere = atHome(lat, lon, profile.home?.stops ?? []);
  if (isResting(profile, nowMs)) {
    // Evenings: on campus and not at home, the way home rather than a moon.
    if (homeStop && lat !== null && lon !== null && !homeHere && onCampus(deps.graph, lat, lon)) {
      const dest: Dest = { to: homeStop, label: m().home, why: 'home', from: null };
      const answer = await tripAnswer(env, ctx, nowMs, deps, profile, dest, at, places, h12);
      return withPhase({ ...answer, warning: lastBusWarning(deps.graph, answer, nowMs) }, 'home:evening');
    }
    return idle(restAnswer(deps.graph, profile, nowMs, places, h12));
  }

  const state = dayState(day);
  const plan = planFor(profile, nowMs, state);
  if (!plan) {
    const free = freeAnswer(deps.graph, profile, nowMs, places, h12, state.skipped, state.away);
    return { answer: free, trip: { key: null, phase: 'idle', undo, ...(state.away ? { away: true } : {}) } };
  }

  // Already at a class that hasn't started (seen there, or said so): that's
  // where you are, not the next class or the trip home after it.
  const early = reachedEarly(profile, nowMs, state.done);
  if (early) {
    const k = classKey(early);
    const there: Dest = { to: early.to, label: early.label, why: 'class', from: null, trip: early, fromVenue: null };
    return { answer: thereAnswer(profile, nowMs, there, places, h12, state.skipped), trip: { key: k, phase: 'arrived', rec: signalOf(day, k), undo } };
  }

  let dest: Dest = { to: plan.to, label: plan.label, why: plan.why, from: plan.from, trip: plan.trip, fromVenue: plan.fromVenue };
  let key = plan.trip ? classKey(plan.trip) : homeKey(plan);

  if (plan.why === 'home' || plan.why === 'gap-home') {
    // Already in your residence: "Home" is not somewhere to go.
    if (homeHere || state.done.has(key)) {
      // The next class still on today: not one taken off.
      const next = nextClass(profile, nowMs, state.skipped);
      if (plan.why !== 'gap-home' || next?.daysAhead !== 0) return idle(youreHome(deps.graph, profile, nowMs, homeStop, places, h12, state.skipped));
      // Between classes: when to leave home for the next one.
      dest = { to: next.trip.to, label: next.trip.label, why: 'class', from: homeStop, trip: next.trip, fromVenue: null };
      key = classKey(next.trip);
    } else if (plan.why === 'home' && lat === null && plan.lastEndMin !== undefined && sgt(nowMs).minutes >= plan.lastEndMin + HOME_BY_MIN) {
      // No location, and long enough since the last class to be home by now.
      return idle(youreHome(deps.graph, profile, nowMs, homeStop, places, h12, state.skipped));
    }
  }

  const rec = signalOf(day, key);
  if (rec?.kind === 'boarded' && rec.boarded) {
    const onBus = await riding(rec.boarded);
    if (onBus) return { answer: onBus.answer, trip: { key, phase: 'riding', rec: { ...rec, boarded: onBus.b }, undo } };
    // The bus you were on should have got you there by now.
    return { answer: thereAnswer(profile, nowMs, dest, places, h12, state.skipped), trip: { key, phase: 'arrived', rec, undo } };
  }

  const fresh = await tripAnswer(env, ctx, nowMs, deps, profile, dest, at, places, h12, prefs.earlier.has(key));

  // Seen at the class's stop before it starts: the same answer the next
  // request gives once this one has noted it reached (reachedEarly), not the
  // bare "You're here" that would flip to it a moment later.
  if (fresh.arrived && dest.why === 'class' && dest.trip && sgt(nowMs).minutes < dest.trip.arriveByMin) {
    return { answer: thereAnswer(profile, nowMs, dest, places, h12, state.skipped), trip: { key, phase: 'arrived', rec, undo } };
  }

  // Which bus the trip is about, the same on every device (plan.ts).
  const located = lat !== null && lon !== null;
  const stored = day?.plans?.[key];
  const made = planOfLeave(fresh.leave, located, dest.to);
  const { bus, save } = choosePlan({ stored, made, located, classAtMs: dest.trip ? classStartMs(dest.trip, nowMs) : null, nowMs });
  // Every device says that bus: the card, the notifications and Today.
  // A miss is the exception:
  // then the answer is the next way there. The plan's times are from an
  // earlier answer: never shown as live.
  const kept = bus && bus !== made && rec?.kind !== 'missed';
  const answer: MeAnswer = kept ? { ...fresh, leave: { ...leaveOf(bus), stale: true } } : fresh;

  const home = dest.why === 'home' || dest.why === 'gap-home';
  const out = withPhase(home ? { ...answer, warning: lastBusWarning(deps.graph, answer, nowMs) } : answer, key);
  // Still in the day's last class: the way home is the answer, but that trip
  // hasn't started ("Time to get going" in the middle of a lecture), and
  // nothing about its bus is assumed until the class ends.
  if (dest.why === 'home' && plan.lastEndMin !== undefined && sgt(nowMs).minutes < plan.lastEndMin && !out.trip.rec) {
    return { answer: out.answer, trip: { ...out.trip, phase: 'idle' } };
  }

  if (save) out.trip.planChanged = true;

  // Nobody said what happened and the bus left a while ago: the plan worked
  // (most people catch the bus they were told to), unless a location still
  // has you at its stop. Assumed, never recorded as a signal.
  if (!out.trip.rec && bus && !answer.arrived && nowMs >= Date.parse(bus.board!) + ASSUME_MS) {
    // Still at the stop now (this request's location), not just earlier:
    // missed, and the answer is the next way there.
    if (phaseFor(answer, undefined, nowMs, at) === 'waiting') return { answer: fresh, trip: { ...out.trip, phase: 'missed', assumed: true, plan: bus, planChanged: false } };
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
    if (arrive === null || nowMs < arrive) return { answer: ridingAnswer(nowMs, dest, cur, live !== null, places, h12, profile), b: cur };
    if (nowMs >= arrive + RIDE_GRACE_MS) return null;
    // That arrival has passed and nothing says you're there: you caught the
    // bus after it, or it's running late. A time in the past is no answer,
    // so the next bus of the service due at your stop is the guess, marked
    // as one; with nothing due, the card says only where to get off.
    const later = await nextArrival(env, ctx, deps, b, nowMs);
    const guess = { ...b, arrive: later };
    return { answer: ridingAnswer(nowMs, dest, guess, false, places, h12, profile), b: guess };
  }
}

/**
 * A trip this request's location says is over: you're at the destination, or
 * in your residence during a trip home. Noted (by the caller) as reached, so
 * a device without a location (the widget, the background refresh, the Mac)
 * stops assuming you're still on the way, and plans what comes next too.
 */
function reachedOf(url: URL, nowMs: number, profile: Profile, day: DayRecord | null, p: Planned): { reached?: string } {
  const { lat, lon } = coordsFrom(url);
  if (lat === null || lon === null) return {};
  const key = p.trip.key;
  if (key && p.trip.phase === 'arrived' && p.answer.arrived) {
    const r = day?.trips[key];
    return r && r.kind !== 'boarded' ? {} : { reached: key };
  }
  if (url.searchParams.get('place') || url.searchParams.get('to') || isResting(profile, nowMs)) return {};
  if (!atHome(lat, lon, profile.home?.stops ?? [])) return {};
  const plan = planFor(profile, nowMs, dayState(day));
  if (!plan || (plan.why !== 'home' && plan.why !== 'gap-home')) return {};
  const home = homeKey(plan);
  return day?.trips[home] ? {} : { reached: home };
}
