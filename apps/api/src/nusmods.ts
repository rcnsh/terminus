/**
 * NUSMods timetable import.
 *
 * A user pastes their NUSMods share URL; we turn it into the same kind of
 * recurring trips config.ts hardcodes -- except discovered from their real
 * schedule instead of hand-edited. The output is stateless: it encodes into
 * the user's personal /next link, so nothing about anyone's timetable is
 * stored server-side.
 *
 * The chain: share URL -> (module, lessonType, classNo) selections
 *   -> NUSMods API per module -> (day, startTime, venue)
 *   -> venue -> building -> geocoded coords -> nearest ISB stop
 *   -> a weekday/arrive-by/destination trip.
 *
 * Venue geocoding is the load-bearing bit and the reason this needs a bundled
 * table: NUSMods' own API no longer exposes venue coordinates (0 of ~600 carry
 * a location), so data/venues.json maps building -> nearest stop, precomputed
 * from the uNivUS mapvenue coordinates.
 */

import venuesJson from '../data/venues.json' with { type: 'json' };
import roomsJson from '../data/rooms.json' with { type: 'json' };
import { type LessonWeeks, type Term, termsForImport } from './calendar.ts';
import { m } from './i18n.ts';

/** Stop, routed walk and, from the NUSMods room map, where the building is (its rooms' mean point). */
type VenueEntry = { stop: string; m: number; lat?: number; lon?: number };
const VENUES = venuesJson as { venues: Record<string, VenueEntry> };
const ROOMS = roomsJson as { rooms: Record<string, VenueEntry & { name: string }> };

/** NUSMods lesson-type abbreviations, as used in the share URL. */
const LESSON_TYPES: Record<string, string> = {
  LEC: 'Lecture',
  TUT: 'Tutorial',
  LAB: 'Laboratory',
  SEC: 'Sectional Teaching',
  REC: 'Recitation',
  SEM: 'Seminar-Style Module Class',
  DLEC: 'Design Lecture',
  PLEC: 'Packaged Lecture',
  PTUT: 'Packaged Tutorial',
  TUT2: 'Tutorial Type 2',
  TUT3: 'Tutorial Type 3',
  WKSH: 'Workshop',
  WS: 'Workshop',
};

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface Selection {
  module: string;
  lessonType: string; // full name, e.g. "Lecture"
  classNo: string;
}

export interface ShareUrl {
  semester: number;
  selections: Selection[];
}

/**
 * Parse a NUSMods share URL.
 *
 *   .../timetable/sem-1/share?EC1101E=TUT:W11,LEC:2&MA1100=LEC:1&hidden=...
 *
 * Each module maps to comma-separated `SHORT:classNo` pairs. `hidden` and
 * `ta` are NUSMods view state, not lessons -- skip them.
 */
export function parseShareUrl(input: string): ShareUrl {
  if (input.length > 2000) throw new Error('share link too long');
  const url = new URL(input);
  if (url.protocol !== 'https:' || !/^(www\.)?nusmods\.com$/.test(url.hostname)) throw new Error('not a NUSMods link');
  // Special terms are st-i and st-ii in NUSMods' links: semesters 3 and 4.
  const semMatch = /\/(?:sem-([1-4])|st-(i{1,2}))(?:\/|$)/.exec(url.pathname);
  const semester = semMatch?.[1] ? Number(semMatch[1]) : semMatch?.[2] ? 2 + semMatch[2].length : 1;

  const selections: Selection[] = [];
  for (const [module, value] of url.searchParams) {
    if (module === 'hidden' || module === 'ta' || !value) continue;
    for (const pair of value.split(',')) {
      const [short, classNo] = pair.split(':');
      if (!short || !classNo) continue;
      selections.push({
        module,
        lessonType: LESSON_TYPES[short.toUpperCase()] ?? short,
        classNo,
      });
    }
  }
  return { semester, selections };
}

/** NUS academic year for a semester, as NUSMods writes it ("2026-2027"). */
export function acadYear(nowMs: number, semester: number): string {
  return termsForImport(semester, nowMs)[0].acadYear.replace('/', '-');
}

interface TimetableRow {
  lessonType: string;
  classNo: string;
  day: string;
  startTime: string; // "HHMM"
  endTime?: string; // "HHMM"
  venue: string;
  weeks?: LessonWeeks;
}

/** Venue code -> nearest ISB stop code. Tries the full code, then the building
 *  prefix ("AS3-0307" -> "AS3"), then progressively shorter prefixes. */
export function venueToStop(venue: string): { stop: string; m: number } | null {
  const v = venueEntry(venue);
  return v ? { stop: v.stop, m: v.m } : null;
}

function venueEntry(venue: string): VenueEntry | null {
  const v = venue.trim().toUpperCase();
  if (VENUES.venues[v]) return VENUES.venues[v];
  const building = v.split('-')[0];
  if (VENUES.venues[building]) return VENUES.venues[building];
  // Trailing digits sometimes distinguish rooms in a bare code (COM1 vs COM12).
  const stripped = building.replace(/\d+$/, '');
  if (stripped && VENUES.venues[stripped]) return VENUES.venues[stripped];
  return null;
}

/**
 * Where a venue is: the room itself when the room map places it, else its
 * building; null for a code the map has no position for.
 */
export function venueAt(venue: string): { lat: number; lon: number } | null {
  const v = venue.trim().toUpperCase();
  const e = ROOMS.rooms[v] ?? venueEntry(v);
  return e?.lat !== undefined && e.lon !== undefined ? { lat: e.lat, lon: e.lon } : null;
}

export interface ImportedTrip {
  day: number; // 0=Sun..6=Sat
  arriveByMin: number; // minutes past midnight SGT, class start
  endMin?: number; // minutes past midnight SGT, class end, when known
  /** NUSMods teaching weeks (or date range). Absent on manual entries, which run every week. */
  weeks?: LessonWeeks;
  /** From NUSMods, as today's classes have it (classesOn); never stored. Its
   *  end is taken as ENDS_EARLY_MIN before the timetable says (endOf). */
  nusmods?: true;
  to: string; // destination stop code
  label: string; // e.g. "CS1010S @ COM1"
  venue: string;
  unresolvedVenue?: boolean;
}

export interface ImportResult {
  trips: ImportedTrip[];
  /** Classes whose venue matched no stop, with enough detail to place them by hand. */
  unresolved: Array<{ module: string; venue: string; day: number; arriveByMin: number; endMin?: number; offCampus?: boolean }>;
  /** The semester the classes were read for. */
  term: Term;
  /** Modules NUSMods has no timetable for in that semester (typo, not offered). */
  missing: string[];
  /** Modules we could not fetch at all. Any of these means the import is incomplete. */
  failed: string[];
  /** Online or TBA lessons, which have no stop. */
  online: number;
}

type FetchLike = typeof fetch;

const hhmm = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(2));

/** At most this many modules per import: a full load is 5-7. */
export const MAX_MODULES = 15;
/** Codes like CS2040, GEA1000, CS2103T, ACC1701X. */
export const MODULE_CODE = /^[A-Z]{2,4}\d{4}[A-Z]{0,3}$/;
/** A room further than this from any stop is off campus (Duke-NUS, hospital). */
const OFF_CAMPUS_M = 1500;
const ONLINE_VENUE = /^(E-LEARN|ONLINE|TBA|ZOOM)/;
const FETCH_TIMEOUT_MS = 8000;

/** Distinct module codes in a share link, uppercased. */
export function shareModules(share: ShareUrl): string[] {
  return [...new Set(share.selections.map((s) => s.module.toUpperCase()))];
}

type ModuleFetch = { status: 'ok'; timetable: TimetableRow[] } | { status: 'missing' } | { status: 'failed' };

async function fetchModule(fetchImpl: FetchLike, apiBase: string, ay: string, module: string, semester: number): Promise<ModuleFetch> {
  try {
    // Module data changes a few times a semester: a day at the edge is plenty,
    // and a class of students importing the same modules costs NUSMods once.
    const res = await fetchImpl(`${apiBase}/${ay}/modules/${encodeURIComponent(module)}.json`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cf: { cacheTtl: 86_400, cacheEverything: true },
    } as RequestInit);
    if (res.status === 404) return { status: 'missing' };
    if (!res.ok) return { status: 'failed' };
    const mod = (await res.json()) as { semesterData?: Array<{ semester: number; timetable: TimetableRow[] }> };
    const sem = mod.semesterData?.find((x) => x.semester === semester);
    return sem ? { status: 'ok', timetable: sem.timetable } : { status: 'missing' };
  } catch {
    return { status: 'failed' };
  }
}

/**
 * Resolve selections into trips by querying NUSMods, one fetch per distinct
 * module, in parallel. A selection with no matching class (stale share link)
 * is skipped. The caller decides what to do with `failed`: an import that
 * could not reach NUSMods must never replace a working timetable.
 *
 * Throws only for input the caller should have rejected: too many modules or
 * a malformed module code.
 */
export async function resolveTrips(
  share: ShareUrl,
  nowMs: number,
  fetchImpl: FetchLike = fetch,
  apiBase = 'https://api.nusmods.com/v2',
): Promise<ImportResult> {
  const modules = shareModules(share);
  if (modules.length > MAX_MODULES) throw new ImportInputError(m().tooManyModules(modules.length, MAX_MODULES));
  const bad = modules.find((m) => !MODULE_CODE.test(m));
  if (bad) throw new ImportInputError(m().notAModule(bad.slice(0, 20)));

  // A sem-1 link in July means the coming August. If NUSMods has nothing for
  // that year yet, the semester just gone is the next best reading.
  const terms = termsForImport(share.semester, nowMs);
  let term = terms[0];
  let fetched = await Promise.all(modules.map((m) => fetchModule(fetchImpl, apiBase, term.acadYear.replace('/', '-'), m, share.semester)));
  if (terms[1] && fetched.every((f) => f.status === 'missing')) {
    term = terms[1];
    fetched = await Promise.all(modules.map((m) => fetchModule(fetchImpl, apiBase, term.acadYear.replace('/', '-'), m, share.semester)));
  }

  const trips: ImportedTrip[] = [];
  const unresolved: ImportResult['unresolved'] = [];
  const missing: string[] = [];
  const failed: string[] = [];
  let online = 0;

  modules.forEach((module, i) => {
    const f = fetched[i];
    if (f.status === 'missing') return void missing.push(module);
    if (f.status === 'failed') return void failed.push(module);
    const sels = share.selections.filter((s) => s.module.toUpperCase() === module);
    for (const sel of sels) {
      const rows = f.timetable.filter((r) => r.lessonType === sel.lessonType && r.classNo === sel.classNo);
      for (const r of rows) {
        const day = DAYS.indexOf(r.day);
        if (day < 0) continue;
        const venue = (r.venue ?? '').trim();
        if (!venue || ONLINE_VENUE.test(venue.toUpperCase())) {
          online++;
          continue;
        }
        const start = hhmm(r.startTime);
        const end = r.endTime ? { endMin: hhmm(r.endTime) } : {};
        const resolved = venueToStop(venue);
        if (!resolved || resolved.m > OFF_CAMPUS_M) {
          unresolved.push({ module, venue, day, arriveByMin: start, ...end, ...(resolved ? { offCampus: true } : {}) });
          continue;
        }
        trips.push({
          day,
          arriveByMin: start,
          ...end,
          ...(r.weeks ? { weeks: r.weeks } : {}),
          to: resolved.stop,
          label: `${module} @ ${venue.split('-')[0]}`.slice(0, 60),
          venue,
        });
      }
    }
  });

  // A stable order makes the encoded link deterministic.
  trips.sort((a, b) => a.day - b.day || a.arriveByMin - b.arriveByMin || a.to.localeCompare(b.to));
  return { trips, unresolved, term, missing, failed, online };
}

/** Bad input to an import, as opposed to NUSMods failing. */
export class ImportInputError extends Error {}
