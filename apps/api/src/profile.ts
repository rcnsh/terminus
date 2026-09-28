/**
 * A user's saved setup, and the planner that turns it into "where next".
 *
 * The profile is one JSON document. It is validated in full on every write,
 * so the planner can trust what it reads back.
 */

import type { ImportedTrip } from './nusmods.ts';
import { sgt } from './config.ts';
import { type LessonWeeks, type Term, importedClassRuns } from './calendar.ts';

export interface Place {
  key: string;
  label: string;
  /** Destination stop code. */
  to: string;
}

export interface Home {
  lat: number;
  lon: number;
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
  /** From the NUSMods import. Replaced wholesale on re-import. */
  trips: ImportedTrip[];
  /** Entered by hand. Survives a re-import. */
  manual: ImportedTrip[];
  places: Place[];
  /** The NUSMods share link, kept so next semester is one click. */
  share: string | null;
  /** The semester `trips` were imported for. Null on imports from before 1.0. */
  term: Term | null;
}

export const DEFAULT_PROFILE: Profile = {
  home: null,
  gapHours: 2,
  dayStartMin: 6 * 60,
  dayEndMin: 18 * 60,
  trips: [],
  manual: [],
  places: [],
  share: null,
  term: null,
};

export const PROFILE_LIMITS = { trips: 100, places: 12, homeStops: 3, label: 60, placeLabel: 24 } as const;

type Result = { ok: true; profile: Profile } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/**
 * Validates a whole profile. Missing fields take their defaults, so a client
 * can send only what it knows about; anything present must be well formed.
 */
export function parseProfile(raw: unknown, isStop: (code: string) => boolean): Result {
  if (!isObj(raw)) return { ok: false, error: 'profile must be an object' };
  const p: Profile = structuredClone(DEFAULT_PROFILE);

  if (raw.home !== undefined && raw.home !== null) {
    const h = raw.home;
    if (!isObj(h) || typeof h.lat !== 'number' || typeof h.lon !== 'number') return { ok: false, error: 'home needs lat and lon' };
    if (Math.abs(h.lat) > 90 || Math.abs(h.lon) > 180) return { ok: false, error: 'home is not a coordinate' };
    const stops = h.stops ?? [];
    if (!Array.isArray(stops) || stops.length > PROFILE_LIMITS.homeStops || !stops.every((s) => typeof s === 'string' && isStop(s))) {
      return { ok: false, error: `home.stops must be up to ${PROFILE_LIMITS.homeStops} known stop codes` };
    }
    p.home = { lat: h.lat, lon: h.lon, stops: [...new Set(stops as string[])] };
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
      if (typeof t.to !== 'string' || !isStop(t.to)) return bad('to must be a known stop code');
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
      if (typeof pl.to !== 'string' || !isStop(pl.to)) return { ok: false, error: `places[${i}].to must be a known stop code` };
      keys.add(pl.key);
      p.places.push({ key: pl.key, label: pl.label.trim(), to: pl.to });
    }
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
    if (!Array.isArray(v.weeks) || !v.weeks.every((w) => isInt(w, 1, 30))) return false;
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
  return [
    ...profile.trips.filter((x) => x.day === day && importedClassRuns(x.weeks, profile.term, atMs)),
    ...profile.manual.filter((x) => x.day === day),
  ].sort((a, b) => a.arriveByMin - b.arriveByMin);
}

/** True when some imported classes predate week tracking and need a re-import. */
export function needsReimport(profile: Profile): boolean {
  return profile.trips.length > 0 && (profile.term === null || profile.trips.some((t) => t.weeks === undefined));
}

/* ------------------------------------------------------------------ */
/* Planner                                                            */
/* ------------------------------------------------------------------ */

export type PlanWhy = 'class' | 'home' | 'gap-home';

export interface Plan {
  /** Destination stop code. */
  to: string;
  label: string;
  why: PlanWhy;
  /** Where you are assumed to be when the client sends no location. */
  from: string | null;
  /** The class this plan is about, when there is one. */
  trip: ImportedTrip | null;
}

/** During a long gap, switch back from "home" to "next class" this long
 *  before the class starts. */
export const GAP_RETURN_MIN = 60;
/** Classes with no known end are assumed to last this long. */
const DEFAULT_CLASS_MIN = 60;

const endOf = (t: ImportedTrip) => t.endMin ?? t.arriveByMin + DEFAULT_CLASS_MIN;

/**
 * Where you should be heading now, from today's classes only:
 *
 * - before the first class: to it, from home
 * - between classes: to the next one, unless the gap is longer than
 *   gapHours, in which case home until GAP_RETURN_MIN before it
 * - after the last class: home
 * - no classes today: null, and the client shows nearby departures
 *
 * A class counts as "next" until it starts.
 */
export function planFor(profile: Profile, nowMs: number): Plan | null {
  const t = sgt(nowMs);
  const nowMin = t.minutes;
  const today = classesOn(profile, nowMs);
  if (!today.length) return null;

  const homeStop = profile.home?.stops[0] ?? null;
  const next = today.find((x) => x.arriveByMin > nowMin) ?? null;
  const prev = [...today].reverse().find((x) => x.arriveByMin <= nowMin) ?? null;

  if (!next) {
    // After the last class of the day.
    if (!homeStop) return null;
    return { to: homeStop, label: 'Home', why: 'home', from: prev!.to, trip: null };
  }
  if (!prev) {
    return { to: next.to, label: next.label, why: 'class', from: homeStop, trip: next };
  }

  const gapMin = next.arriveByMin - endOf(prev);
  const returnAt = next.arriveByMin - GAP_RETURN_MIN;
  if (homeStop && gapMin > profile.gapHours * 60 && nowMin < returnAt && homeStop !== next.to) {
    // Still in class: nothing to catch yet, but the answer is the trip home.
    return { to: homeStop, label: 'Home', why: 'gap-home', from: prev.to, trip: null };
  }
  // In a long gap after going home, the origin is home, not the last class.
  const wentHome = homeStop && gapMin > profile.gapHours * 60 && nowMin >= endOf(prev);
  return { to: next.to, label: next.label, why: 'class', from: wentHome ? homeStop : prev.to, trip: next };
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
  const t = sgt(nowMs);
  const today = classesOn(profile, nowMs);
  const start = Math.min(profile.dayStartMin, ...today.map((x) => x.arriveByMin - MORNING_LEAD_MIN));
  const end = Math.max(profile.dayEndMin, ...today.map((x) => endOf(x) + EVENING_GRACE_MIN));
  return t.minutes < start || t.minutes >= end;
}

/** How far ahead to look for the next class: a whole semester break. */
const LOOKAHEAD_DAYS = 120;

/** The first class after now, and how many days ahead it is. */
export function nextClass(profile: Profile, nowMs: number): { trip: ImportedTrip; daysAhead: number } | null {
  const t = sgt(nowMs);
  for (let ahead = 0; ahead <= LOOKAHEAD_DAYS; ahead++) {
    const found = classesOn(profile, nowMs + ahead * 86_400_000).find((x) => ahead > 0 || x.arriveByMin > t.minutes);
    if (found) return { trip: found, daysAhead: ahead };
  }
  return null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Mon 28 Sep" in SGT. Built by hand: Intl output varies by runtime. */
function shortDate(atMs: number): string {
  const d = new Date(atMs + 8 * 3_600_000);
  return `${DAY_NAMES[d.getUTCDay()].slice(0, 3)} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Next: CS2030 @ COM1, tomorrow 10:00", or a plain line when nothing is scheduled. */
export function restDetail(profile: Profile, nowMs: number): string {
  const n = nextClass(profile, nowMs);
  if (!n) return 'Nothing on your timetable';
  const hh = String(Math.floor(n.trip.arriveByMin / 60)).padStart(2, '0');
  const mm = String(n.trip.arriveByMin % 60).padStart(2, '0');
  const when =
    n.daysAhead === 0
      ? 'today'
      : n.daysAhead === 1
        ? 'tomorrow'
        : n.daysAhead < 7
          ? DAY_NAMES[n.trip.day]
          : shortDate(nowMs + n.daysAhead * 86_400_000);
  return `Next: ${n.trip.label}, ${when} ${hh}:${mm}`;
}
