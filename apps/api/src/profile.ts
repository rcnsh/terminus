/**
 * A user's saved setup, and the planner that turns it into "where next".
 *
 * The profile is one JSON document. It is validated in full on every write,
 * so the planner can trust what it reads back.
 */

import { type ImportedTrip, venueToStop } from './nusmods.ts';
import { sgt } from './config.ts';
import type { Timing, Why } from './types.ts';
import type { Upcoming } from './card.ts';

export type { Timing };
import { isoSeconds } from './format.ts';
import { clockAt, clockMin, slackText } from './clock.ts';
import { PACES, type Pace } from './walk.ts';
import { type LessonWeeks, type Term, dayOffReason, importedClassRuns, sgtDate, termEnded, termName } from './calendar.ts';
import { LANG_PREFS, type LangPref, m } from './i18n.ts';

export interface Place {
  key: string;
  label: string;
  /** Destination stop code. */
  to: string;
}

export interface UsualTime {
  /** The saved place's key. */
  place: string;
  day: number; // 0=Sun..6=Sat
  atMin: number; // minutes past midnight SGT, when to be there
}

export interface OnceTrip {
  date: string; // YYYY-MM-DD, Singapore
  arriveByMin: number;
  to: string;
  label: string;
}

/** A usual time or a one-off counts as an hour there, for what comes after it. */
export const PLACE_STAY_MIN = 60;

/**
 * Home is stops only. Exact coordinates of where someone lives are more than
 * the planner needs, and not something to keep for strangers.
 */
export interface Home {
  /** Usual boarding stops near home, best first. */
  stops: string[];
}

export interface Profile {
  home: Home | null;
  /** A gap between classes longer than this sends you home in between. */
  gapHours: number;
  /** Outside [dayStartMin, dayEndMin) the planned answer rests. Minutes
   *  past midnight SGT. */
  dayStartMin: number;
  dayEndMin: number;
  /** Walk from home to the home stop. Counts when a trip starts from home
   *  and the client sends no location. */
  homeWalkMin: number;
  /** How fast you walk. Scales every walk except homeWalkMin, which is yours. */
  walkPace: Pace;
  /** Aim one bus earlier when the bus you'd wait for is often busy. */
  fullBusMargin: boolean;
  /** Count the public buses (95, 151, ...) at the campus's stops too. They have a fare, so off until asked for. */
  publicBuses: boolean;
  /** One-time screens already shown (the web onboarding, "new: walking pace"). */
  seen: string[];
  /** From the NUSMods import. Replaced wholesale on re-import. */
  trips: ImportedTrip[];
  /** Entered by hand. Survives a re-import. */
  manual: ImportedTrip[];
  places: Place[];
  /** Saved places with a usual time (phase 8.3): "Gym, Tuesdays 18:00". Each
   *  is a trip on that day like a class, arriving by `atMin`. Kept apart from
   *  `places`, keyed by the place's key, so an older app rewriting the places
   *  can't drop them; one whose place is gone is ignored. */
  usual: UsualTime[];
  /** One-off trips (phase 8.3): "Science library at 14:00 today". A trip on
   *  its date only, like a class. Past dates are dropped when the profile is
   *  saved. */
  once: OnceTrip[];
  /** The NUSMods share link, kept so next semester is one click. */
  share: string | null;
  /** The semester `trips` were imported for. Null until something is imported. */
  term: Term | null;
  /** The language terminus speaks (phase 10): 'auto' follows each device. */
  lang: LangPref;
  /** 12- or 24-hour times; 'auto' follows each device. */
  clock: ClockPref;
  /** Stops pinned to the Buses tab, in the user's order: shuttle stops, or
   *  public stops by LTA's code. */
  pinnedStops: string[];
}

export type ClockPref = 'auto' | '12' | '24';
export const CLOCK_PREFS: readonly ClockPref[] = ['auto', '12', '24'];

export const DEFAULT_PROFILE: Profile = {
  home: null,
  gapHours: 2,
  dayStartMin: 6 * 60,
  dayEndMin: 18 * 60,
  homeWalkMin: 5,
  walkPace: 'normal',
  fullBusMargin: true,
  publicBuses: false,
  seen: [],
  trips: [],
  manual: [],
  places: [],
  usual: [],
  once: [],
  share: null,
  term: null,
  lang: 'auto',
  clock: 'auto',
  pinnedStops: [],
};

export const PROFILE_LIMITS = {
  trips: 100,
  places: 12,
  homeStops: 3,
  label: 60,
  placeLabel: 24,
  usual: 30,
  once: 10,
  pinnedStops: 8,
  /** Minutes from home to the home stop, inclusive. */
  homeWalkMin: { min: 0, max: 30 },
} as const;

/**
 * The limits as the profile endpoints send them (`limits`), so the apps'
 * pickers and fields stop at the same place the server does, instead of
 * each keeping its own copy of these numbers.
 */
export function profileLimits() {
  const l = PROFILE_LIMITS;
  return {
    pinnedStops: l.pinnedStops,
    label: l.label,
    places: l.places,
    placeLabel: l.placeLabel,
    homeStops: l.homeStops,
    homeWalkMin: { min: l.homeWalkMin.min, max: l.homeWalkMin.max },
    trips: l.trips,
    usual: l.usual,
    once: l.once,
  };
}

type Result = { ok: true; profile: Profile } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/**
 * Validates a whole profile. Missing fields take their defaults, so a client
 * can send only what it knows about; anything present must be well formed.
 * `isPinnable` admits the public-only stops too, which a pin may name.
 */
export function parseProfile(
  raw: unknown,
  isStop: (code: string) => boolean,
  isPlace: (code: string) => boolean = isStop,
  isPinnable: (code: string) => boolean = isStop,
): Result {
  if (!isObj(raw)) return { ok: false, error: 'profile must be an object' };
  const p: Profile = structuredClone(DEFAULT_PROFILE);

  if (raw.home !== undefined && raw.home !== null) {
    const h = raw.home;
    // Older clients also send lat/lon; they are accepted and dropped.
    if (!isObj(h)) return { ok: false, error: 'home must be {stops: [...]}' };
    const stops = h.stops ?? [];
    if (!Array.isArray(stops) || stops.length > PROFILE_LIMITS.homeStops || !stops.every((s) => typeof s === 'string' && isStop(s))) {
      return { ok: false, error: `home.stops must be up to ${PROFILE_LIMITS.homeStops} known stop codes` };
    }
    const unique = [...new Set(stops as string[])];
    p.home = unique.length ? { stops: unique } : null;
  }

  if (raw.gapHours !== undefined) {
    if (typeof raw.gapHours !== 'number' || raw.gapHours < 0.5 || raw.gapHours > 12) {
      return { ok: false, error: 'gapHours must be between 0.5 and 12' };
    }
    p.gapHours = raw.gapHours;
  }

  for (const field of ['dayStartMin', 'dayEndMin'] as const) {
    if (raw[field] === undefined) continue;
    if (!isInt(raw[field], 0, 1439)) return { ok: false, error: `${field} must be minutes past midnight` };
    p[field] = raw[field] as number;
  }
  if (p.dayStartMin >= p.dayEndMin) return { ok: false, error: 'the day must start before it ends' };

  if (raw.walkPace !== undefined) {
    if (typeof raw.walkPace !== 'string' || !PACES.includes(raw.walkPace as Pace)) return { ok: false, error: 'walkPace must be slow, normal or fast' };
    p.walkPace = raw.walkPace as Pace;
  }

  if (raw.fullBusMargin !== undefined) {
    if (typeof raw.fullBusMargin !== 'boolean') return { ok: false, error: 'fullBusMargin must be true or false' };
    p.fullBusMargin = raw.fullBusMargin;
  }

  if (raw.publicBuses !== undefined) {
    if (typeof raw.publicBuses !== 'boolean') return { ok: false, error: 'publicBuses must be true or false' };
    p.publicBuses = raw.publicBuses;
  }

  if (raw.seen !== undefined) {
    const v = raw.seen;
    if (!Array.isArray(v) || v.length > 20 || !v.every((x) => typeof x === 'string' && /^[a-z0-9-]{1,32}$/.test(x))) {
      return { ok: false, error: 'seen must be a short list of names' };
    }
    p.seen = [...new Set(v as string[])];
  }

  if (raw.lang !== undefined) {
    if (typeof raw.lang !== 'string' || !LANG_PREFS.includes(raw.lang as LangPref)) return { ok: false, error: 'lang must be auto, en or zh' };
    p.lang = raw.lang as LangPref;
  }

  if (raw.clock !== undefined) {
    if (typeof raw.clock !== 'string' || !CLOCK_PREFS.includes(raw.clock as ClockPref)) return { ok: false, error: 'clock must be auto, 12 or 24' };
    p.clock = raw.clock as ClockPref;
  }

  if (raw.pinnedStops !== undefined) {
    const v = raw.pinnedStops;
    const codes = Array.isArray(v) && v.every((c) => typeof c === 'string') ? [...new Set((v as string[]).map((c) => c.trim().toUpperCase()))] : null;
    if (!codes || codes.length > PROFILE_LIMITS.pinnedStops || !codes.every(isPinnable)) {
      return { ok: false, error: 'pinnedStops must be up to 8 known stop codes' };
    }
    p.pinnedStops = codes;
  }

  if (raw.homeWalkMin !== undefined) {
    if (!isInt(raw.homeWalkMin, PROFILE_LIMITS.homeWalkMin.min, PROFILE_LIMITS.homeWalkMin.max)) return { ok: false, error: 'homeWalkMin must be 0 to 30 minutes' };
    p.homeWalkMin = raw.homeWalkMin;
  }

  for (const field of ['trips', 'manual'] as const) {
    if (raw[field] === undefined) continue;
    const list = raw[field];
    if (!Array.isArray(list) || list.length > PROFILE_LIMITS.trips) return { ok: false, error: `${field} must be a list of up to ${PROFILE_LIMITS.trips}` };
    const out: ImportedTrip[] = [];
    for (const [i, t] of list.entries()) {
      const bad = (why: string): Result => ({ ok: false, error: `${field}[${i}]: ${why}` });
      if (!isObj(t)) return bad('not an object');
      if (!isInt(t.day, 0, 6)) return bad('day must be 0 (Sun) to 6 (Sat)');
      if (!isInt(t.arriveByMin, 0, 1439)) return bad('arriveByMin must be minutes past midnight');
      if (t.endMin !== undefined && !isInt(t.endMin, t.arriveByMin + 1, 1440)) return bad('endMin must be after arriveByMin');
      if (typeof t.to !== 'string' || !isPlace(t.to)) return bad('to must be a known stop or place code');
      if (!str(t.label, PROFILE_LIMITS.label)) return bad(`label must be 1-${PROFILE_LIMITS.label} characters`);
      const venue = typeof t.venue === 'string' ? t.venue.slice(0, 40) : '';
      const weeks = parseWeeks(t.weeks);
      if (weeks === false) return bad('weeks must be a list of week numbers or a date range');
      out.push({
        day: t.day,
        arriveByMin: t.arriveByMin,
        ...(t.endMin !== undefined ? { endMin: t.endMin as number } : {}),
        ...(weeks ? { weeks } : {}),
        to: t.to,
        label: t.label.trim(),
        venue,
      });
    }
    out.sort((a, b) => a.day - b.day || a.arriveByMin - b.arriveByMin);
    p[field] = out;
  }

  if (raw.places !== undefined) {
    const list = raw.places;
    if (!Array.isArray(list) || list.length > PROFILE_LIMITS.places) return { ok: false, error: `places must be a list of up to ${PROFILE_LIMITS.places}` };
    const keys = new Set<string>();
    for (const [i, pl] of list.entries()) {
      if (!isObj(pl) || typeof pl.key !== 'string' || !/^[a-z0-9-]{1,24}$/.test(pl.key)) return { ok: false, error: `places[${i}].key must be 1-24 of a-z, 0-9, -` };
      if (keys.has(pl.key)) return { ok: false, error: `places[${i}].key is a duplicate` };
      if (!str(pl.label, PROFILE_LIMITS.placeLabel)) return { ok: false, error: `places[${i}].label must be 1-${PROFILE_LIMITS.placeLabel} characters` };
      if (typeof pl.to !== 'string' || !isPlace(pl.to)) return { ok: false, error: `places[${i}].to must be a known stop or place code` };
      keys.add(pl.key);
      p.places.push({ key: pl.key, label: pl.label.trim(), to: pl.to });
    }
  }

  if (raw.usual !== undefined) {
    const list = raw.usual;
    if (!Array.isArray(list) || list.length > PROFILE_LIMITS.usual) return { ok: false, error: `usual must be a list of up to ${PROFILE_LIMITS.usual}` };
    for (const [i, u] of list.entries()) {
      const bad = (why: string): Result => ({ ok: false, error: `usual[${i}]: ${why}` });
      if (!isObj(u) || typeof u.place !== 'string' || !/^[a-z0-9-]{1,24}$/.test(u.place)) return bad('place must be a saved place key');
      if (!isInt(u.day, 0, 6)) return bad('day must be 0 (Sun) to 6 (Sat)');
      if (!isInt(u.atMin, 0, 1439)) return bad('atMin must be minutes past midnight');
      p.usual.push({ place: u.place, day: u.day, atMin: u.atMin });
    }
    p.usual.sort((a, b) => a.day - b.day || a.atMin - b.atMin);
  }

  if (raw.once !== undefined) {
    const list = raw.once;
    if (!Array.isArray(list) || list.length > PROFILE_LIMITS.once) return { ok: false, error: `once must be a list of up to ${PROFILE_LIMITS.once}` };
    for (const [i, o] of list.entries()) {
      const bad = (why: string): Result => ({ ok: false, error: `once[${i}]: ${why}` });
      if (!isObj(o) || typeof o.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.date)) return bad('date must be YYYY-MM-DD');
      if (!isInt(o.arriveByMin, 0, 1439)) return bad('arriveByMin must be minutes past midnight');
      if (typeof o.to !== 'string' || !isPlace(o.to)) return bad('to must be a known stop or place code');
      if (!str(o.label, PROFILE_LIMITS.label)) return bad(`label must be 1-${PROFILE_LIMITS.label} characters`);
      p.once.push({ date: o.date, arriveByMin: o.arriveByMin, to: o.to, label: o.label.trim() });
    }
    p.once.sort((a, b) => a.date.localeCompare(b.date) || a.arriveByMin - b.arriveByMin);
  }

  if (raw.term !== undefined && raw.term !== null) {
    const t = raw.term;
    if (!isObj(t) || typeof t.acadYear !== 'string' || !/^\d{4}\/\d{4}$/.test(t.acadYear) || !isInt(t.semester, 1, 4)) {
      return { ok: false, error: 'term must be {acadYear: "2026/2027", semester: 1-4}' };
    }
    p.term = { acadYear: t.acadYear, semester: t.semester };
  }

  if (raw.share !== undefined && raw.share !== null) {
    if (typeof raw.share !== 'string' || raw.share.length > 2000) return { ok: false, error: 'share must be a NUSMods link' };
    p.share = raw.share;
  }

  return { ok: true, profile: p };
}

/** undefined = absent, false = malformed. */
function parseWeeks(v: unknown): LessonWeeks | undefined | false {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v.length <= 20 && v.every((w) => isInt(w, 1, 20)) ? (v as number[]) : false;
  if (!isObj(v)) return false;
  const date = /^\d{4}-\d{2}-\d{2}$/;
  if (typeof v.start !== 'string' || typeof v.end !== 'string' || !date.test(v.start) || !date.test(v.end)) return false;
  const out: LessonWeeks = { start: v.start, end: v.end };
  if (v.weekInterval !== undefined) {
    if (!isInt(v.weekInterval, 1, 10)) return false;
    out.weekInterval = v.weekInterval;
  }
  if (v.weeks !== undefined) {
    if (!Array.isArray(v.weeks) || v.weeks.length > 30 || !v.weeks.every((w) => isInt(w, 1, 30))) return false;
    out.weeks = v.weeks as number[];
  }
  return out;
}

/**
 * The classes actually on for the SGT day containing `atMs`: manual entries
 * every week, imported ones only when the academic calendar says they run.
 */
export function classesOn(profile: Profile, atMs: number): ImportedTrip[] {
  const day = sgt(atMs).day;
  const date = sgtDate(atMs);
  // Places at their usual time and one-off trips are trips like classes: an
  // hour there, then whatever comes next.
  const stay = (arriveByMin: number) => Math.min(1440, arriveByMin + PLACE_STAY_MIN);
  const usual = (profile.usual ?? []).flatMap((u) => {
    const pl = u.day === day ? profile.places.find((p) => p.key === u.place) : undefined;
    return pl ? [{ day, arriveByMin: u.atMin, endMin: stay(u.atMin), to: pl.to, label: pl.label, venue: '' }] : [];
  });
  const once = (profile.once ?? []).filter((o) => o.date === date).map((o) => ({ day, arriveByMin: o.arriveByMin, endMin: stay(o.arriveByMin), to: o.to, label: o.label, venue: '' }));
  return [
    ...profile.trips.filter((x) => x.day === day && importedClassRuns(x.weeks, profile.term, atMs)).map((x) => ({ ...x, nusmods: true as const })),
    ...profile.manual.filter((x) => x.day === day),
    ...usual,
    ...once,
  ].sort((a, b) => a.arriveByMin - b.arriveByMin);
}

export type ReimportReason = 'ended';

/**
 * Why the imported timetable needs a fresh import, or null when it doesn't:
 * 'ended' once its semester (exams included) is over and the classes will
 * never run again.
 */
export function reimportReason(profile: Profile, nowMs: number): ReimportReason | null {
  if (!profile.trips.length || !profile.term) return null;
  return termEnded(profile.term, nowMs) ? 'ended' : null;
}

export function needsReimport(profile: Profile, nowMs: number): boolean {
  return reimportReason(profile, nowMs) !== null;
}

/* ------------------------------------------------------------------ */
/* Planner                                                            */
/* ------------------------------------------------------------------ */

export type PlanWhy = Exclude<Why, 'place'>;

export interface Plan {
  /** Destination stop code. */
  to: string;
  label: string;
  why: PlanWhy;
  /** Where you are assumed to be when the client sends no location. */
  from: string | null;
  /** The class this plan is about, when there is one. */
  trip: ImportedTrip | null;
  /** The room you're leaving, when `from` is the last class's stop: the walk
   *  from it to the stop counts. Null when starting from home. */
  fromVenue: string | null;
  /** Home after the last class: when that class ends, minutes past midnight. */
  lastEndMin?: number;
}

/** A class stays the target this long after it starts: you may still be on
 *  the way, and "next: the 14:00" would be wrong while you're on the bus. */
export const LATE_GRACE_MIN = 15;
/** With no location, you're taken to be home this long after the last class
 *  ends; until then the answer is the trip home. */
export const HOME_BY_MIN = 60;

/** Which of today's classes a trip signal is about. Stable for the day. */
export function classKey(t: ImportedTrip): string {
  return `${t.day}:${t.arriveByMin}:${t.to}`;
}

/** What the day's trip signals say about today's classes. */
export interface DayState {
  /** "Not going": dropped for today. */
  skipped: ReadonlySet<string>;
  /** Reached (you said so, or were seen there): no longer the target. */
  done: ReadonlySet<string>;
  /** Its bus was missed and nothing since says you got there: not where you're coming from. */
  missed?: ReadonlySet<string>;
}

export const NO_DAY_STATE: DayState = { skipped: new Set(), done: new Set() };

/** During a long gap, switch back from "home" to "next class" this long
 *  before the class starts. */
export const GAP_RETURN_MIN = 60;
/** Classes with no known end are assumed to last this long. */
const DEFAULT_CLASS_MIN = 60;
/**
 * NUS classes end about half an hour before the timetable's end time, to
 * leave time to get to the next one. What comes after a class (the trip home,
 * a gap long enough to go home in, "In CS2030 till") goes by when it really
 * ends: too early is better than too late. Only for NUSMods classes; times
 * entered by hand are taken as given.
 */
export const ENDS_EARLY_MIN = 30;

export const endOf = (t: ImportedTrip) => {
  const end = t.endMin ?? t.arriveByMin + DEFAULT_CLASS_MIN;
  return t.nusmods ? Math.max(t.arriveByMin + 15, end - ENDS_EARLY_MIN) : end;
};

/**
 * Where you should be heading now, from today's classes only:
 *
 * - before the first class: to it, from home
 * - between classes: to the next one, unless the gap is longer than
 *   gapHours, in which case home until GAP_RETURN_MIN before it
 * - after the last class: home
 * - no classes today: null, and the client shows nearby departures
 *
 * A class counts as "next" until LATE_GRACE_MIN after it starts, or until
 * it's reached. A skipped class is left out; a reached one still counts as
 * where you're coming from, and one whose bus was missed doesn't.
 */
export function planFor(profile: Profile, nowMs: number, state: DayState = NO_DAY_STATE): Plan | null {
  const t = sgt(nowMs);
  const nowMin = t.minutes;
  const today = classesOn(profile, nowMs).filter((x) => !state.skipped.has(classKey(x)));
  if (!today.length) return null;

  const homeStop = profile.home?.stops[0] ?? null;
  const next = today.find((x) => !state.done.has(classKey(x)) && x.arriveByMin + LATE_GRACE_MIN > nowMin) ?? null;
  // Where you're coming from: the last class you went to. One whose bus you
  // missed (and that nothing since says you reached) is not it: without a
  // location you'd be planned from a room you never got to.
  const prev = [...today].reverse().find((x) => x !== next && !state.missed?.has(classKey(x)) && (x.arriveByMin <= nowMin || state.done.has(classKey(x)))) ?? null;

  if (!next) {
    // After the last class of the day. Its trip home taken off today: staying.
    if (!homeStop || !prev || state.skipped.has(`home:${endOf(prev)}`)) return null;
    return { to: homeStop, label: m().home, why: 'home', from: prev.to, trip: null, fromVenue: prev.venue || null, lastEndMin: endOf(prev) };
  }
  if (!prev) {
    return { to: next.to, label: next.label, why: 'class', from: homeStop, trip: next, fromVenue: null };
  }

  const gapMin = next.arriveByMin - endOf(prev);
  const returnAt = next.arriveByMin - GAP_RETURN_MIN;
  // A long gap goes home in between, unless that trip was taken off today.
  const goesHome = homeStop && gapMin > profile.gapHours * 60 && !state.skipped.has(`gap-home:${prev.to}`);
  if (goesHome && nowMin < returnAt && homeStop !== next.to) {
    // Still in class: nothing to catch yet, but the answer is the trip home.
    return { to: homeStop, label: m().home, why: 'gap-home', from: prev.to, trip: null, fromVenue: prev.venue || null };
  }
  // In a long gap after going home, the origin is home, not the last class.
  const wentHome = goesHome && nowMin >= endOf(prev);
  return { to: next.to, label: next.label, why: 'class', from: wentHome ? homeStop : prev.to, trip: next, fromVenue: wentHome ? null : prev.venue || null };
}

/**
 * A class reached before it starts (seen there, or said so): that's where
 * you are, rather than the next class or the trip home after it. The latest
 * one, if a few are.
 */
export function reachedEarly(profile: Profile, nowMs: number, done: ReadonlySet<string>): ImportedTrip | null {
  const nowMin = sgt(nowMs).minutes;
  return classesOn(profile, nowMs).filter((c) => done.has(classKey(c)) && nowMin < c.arriveByMin).at(-1) ?? null;
}

/* ------------------------------------------------------------------ */
/* Resting hours                                                      */
/* ------------------------------------------------------------------ */

/** A class running past dayEnd keeps the day open this long after it ends,
 *  so the trip home still gets an answer. */
export const EVENING_GRACE_MIN = 45;
/** A class starting near or before dayStart opens the day this early. */
export const MORNING_LEAD_MIN = 90;

/**
 * Whether the planned answer should rest: outside the user's day, stretched
 * to cover any class that starts early or ends late.
 */
export function isResting(profile: Profile, nowMs: number): boolean {
  return restSide(profile, nowMs) !== null;
}

/** Which end of the day we are resting at, with today's effective start. */
export function restSide(profile: Profile, nowMs: number): { side: 'before' | 'after'; startMin: number } | null {
  const t = sgt(nowMs);
  const today = classesOn(profile, nowMs);
  const start = Math.max(0, Math.min(profile.dayStartMin, ...today.map((x) => x.arriveByMin - MORNING_LEAD_MIN)));
  const end = Math.max(profile.dayEndMin, ...today.map((x) => endOf(x) + EVENING_GRACE_MIN));
  if (t.minutes < start) return { side: 'before', startMin: start };
  if (t.minutes >= end) return { side: 'after', startMin: start };
  return null;
}

/**
 * The next moment the planned answer can change by itself: a class starts,
 * ends, or reaches its gap's return time, or the day starts or ends. Clients
 * refresh then instead of guessing. Falls back to the next SGT midnight.
 */
export function planChangesAt(profile: Profile, nowMs: number): number {
  const t = sgt(nowMs);
  const midnight = nowMs - (t.minutes * 60_000 + (nowMs % 60_000));
  const today = classesOn(profile, nowMs);
  const start = Math.max(0, Math.min(profile.dayStartMin, ...today.map((x) => x.arriveByMin - MORNING_LEAD_MIN)));
  const end = Math.max(profile.dayEndMin, ...today.map((x) => endOf(x) + EVENING_GRACE_MIN));
  const marks = [start, end, ...today.flatMap((x) => [x.arriveByMin, x.arriveByMin + LATE_GRACE_MIN, endOf(x), endOf(x) + HOME_BY_MIN, x.arriveByMin - GAP_RETURN_MIN])];
  const next = marks.filter((m) => m > t.minutes && m < 1440).sort((a, b) => a - b)[0];
  return midnight + (next ?? 1440) * 60_000;
}


/**
 * The resting headline. "Done for today" at 05:00 beside "Next: ..., today
 * 10:00" reads as a contradiction, so the morning says when the day starts.
 */
export function restLabel(profile: Profile, nowMs: number, h12 = false): string {
  const r = restSide(profile, nowMs);
  if (r?.side === 'before' && classesOn(profile, nowMs).length) return m().dayStarts(clockMin(r.startMin, h12));
  return m().doneForToday;
}

/** How far ahead to look for the next class: a whole semester break. */
const LOOKAHEAD_DAYS = 120;

/** The first class after now, and how many days ahead it is. Today's skipped classes don't count. */
export function nextClass(profile: Profile, nowMs: number, skipped: ReadonlySet<string> = NO_DAY_STATE.skipped): { trip: ImportedTrip; daysAhead: number } | null {
  const t = sgt(nowMs);
  for (let ahead = 0; ahead <= LOOKAHEAD_DAYS; ahead++) {
    const found = classesOn(profile, nowMs + ahead * 86_400_000).find((x) => ahead > 0 || (x.arriveByMin > t.minutes && !skipped.has(classKey(x))));
    if (found) return { trip: found, daysAhead: ahead };
  }
  return null;
}

/** "Mon 28 Sep" in SGT. Built by hand: Intl output varies by runtime. */
function shortDate(atMs: number): string {
  const d = new Date(atMs + 8 * 3_600_000);
  return m().shortDate(d.getUTCDay(), d.getUTCDate(), d.getUTCMonth());
}

/** "Next: CS2030 @ COM1, tomorrow 10:00", or a plain line when nothing is scheduled. */
export function restDetail(profile: Profile, nowMs: number, h12 = false, skipped: ReadonlySet<string> = NO_DAY_STATE.skipped): string {
  if (reimportReason(profile, nowMs) === 'ended' && profile.term) {
    return m().timetableFor(termName(profile.term));
  }
  const n = nextClass(profile, nowMs, skipped);
  // Recess, exams, a public holiday: say why today is empty, next class or not
  // (in reading week and the exams, the semester's classes are all behind you).
  const off = classesOn(profile, nowMs).length ? null : dayOffReason(nowMs);
  if (!n) return profile.trips.length || profile.manual.length ? (off ? `${off} · ${m().noClassesComing}` : m().noClassesComing) : m().nothingOnTimetable;
  const when =
    n.daysAhead === 0
      ? m().today
      : n.daysAhead === 1
        ? m().tomorrow
        : n.daysAhead < 7
          ? m().dayNames[n.trip.day]
          : shortDate(nowMs + n.daysAhead * 86_400_000);
  return m().nextClass(off, n.trip.label, when, clockMin(n.trip.arriveByMin, h12));
}

/**
 * The next class as its own card's lines (card.upcoming): when, what and
 * where, from the timetable alone. Null when nothing is coming, or the
 * timetable has ended. `stopName` names a stop code.
 */
export function upcomingClass(profile: Profile, nowMs: number, h12: boolean, stopName: (code: string) => string, skipped: ReadonlySet<string> = NO_DAY_STATE.skipped): Upcoming | null {
  if (reimportReason(profile, nowMs) === 'ended') return null;
  const n = nextClass(profile, nowMs, skipped);
  if (!n) return null;
  const day = nowMs + n.daysAhead * 86_400_000;
  const when =
    n.daysAhead === 0
      ? m().upcomingToday
      : n.daysAhead === 1
        ? m().upcomingTomorrow(new Date(day + 8 * 3_600_000).getUTCDay())
        : n.daysAhead < 7
          ? m().dayNames[n.trip.day]
          : shortDate(day);
  // "CS2030 @ COM1": the module, without the room the line under it gives.
  const name = n.trip.label.split(' @ ')[0];
  const venue = n.trip.venue?.trim();
  // The room's stop as it is now, not as it was when the timetable was saved.
  const stop = stopName((venue && venueToStop(venue)?.stop) || n.trip.to);
  return {
    when,
    title: m().classAt(name, clockMin(n.trip.arriveByMin, h12)),
    where: venue && venue.toUpperCase() !== n.trip.to.toUpperCase() ? m().atVenueGetOff(venue, stop) : m().atPlace(stop),
    off: classesOn(profile, nowMs).length ? null : dayOffReason(nowMs),
  };
}

/* ------------------------------------------------------------------ */
/* Will I make it?                                                    */
/* ------------------------------------------------------------------ */

export type OnTime = 'on-time' | 'tight' | 'late';


/** At least this much spare time counts as comfortably on time. */
export const ON_TIME_SLACK_S = 180;

/**
 * Compare when you'd reach the class (arrival at the stop plus the walk to
 * the venue) with when it starts. The class is today's: the planner only
 * plans today.
 */
/** Past this, the stop is not really the venue's stop (off campus, bad data):
 *  a lateness figure would be noise. */
export const MAX_VENUE_WALK_S = 20 * 60;

/** When today's (SGT) run of this class starts, epoch ms. */
export function classStartMs(trip: ImportedTrip, nowMs: number): number {
  const day = new Date(nowMs + 8 * 3_600_000);
  const midnight = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) - 8 * 3_600_000;
  return midnight + trip.arriveByMin * 60_000;
}

/** `estimated`: the arrival is a guess (a timetable bus, a ride without a
 *  measured time), so its clock gets the same "~" as the card's. */
export function timingFor(arriveAtIso: string | null | undefined, trip: ImportedTrip, walkToVenueS: number, nowMs: number, h12 = false, estimated = false): Timing | null {
  if (!arriveAtIso || walkToVenueS > MAX_VENUE_WALK_S) return null;
  const classAt = classStartMs(trip, nowMs);
  const reachMs = Date.parse(arriveAtIso) + walkToVenueS * 1000;
  const slackS = Math.round((classAt - reachMs) / 1000);
  const status: OnTime = slackS >= ON_TIME_SLACK_S ? 'on-time' : slackS >= 0 ? 'tight' : 'late';
  // Same words as the class card (clock.ts): the colour carries "tight".
  const text = status === 'late' ? m().lateBy(Math.max(1, Math.round(-slackS / 60))) : m().arrive(estimated ? m().approx(clockAt(reachMs, h12)) : clockAt(reachMs, h12), slackText(slackS));
  return { status, text, classAt: isoSeconds(classAt), reachAt: isoSeconds(reachMs) };
}
