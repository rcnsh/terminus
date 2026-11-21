import venuesJson from '../../data/venues.json' with { type: 'json' };
import roomsJson from '../../data/rooms.json' with { type: 'json' };
import { type LessonWeeks, type Term, termsForImport } from './calendar.ts';
import { m } from '../i18n.ts';

type VenueEntry = { stop: string; m: number; lat?: number; lon?: number; stops?: Record<string, number> };
const VENUES = venuesJson as { venues: Record<string, VenueEntry> };
const ROOMS = roomsJson as { rooms: Record<string, VenueEntry & { name: string }> };

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
  lessonType: string;
  classNo: string;
}

export interface ShareUrl {
  semester: number;
  selections: Selection[];
}

export function parseShareUrl(input: string): ShareUrl {
  if (input.length > 2000) throw new Error('share link too long');
  const url = new URL(input);
  if (url.protocol !== 'https:' || !/^(www\.)?nusmods\.com$/.test(url.hostname)) throw new Error('not a NUSMods link');
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

const nusmodsYear = (t: Term): string => t.acadYear.replace('/', '-');

export function acadYear(nowMs: number, semester: number): string {
  return nusmodsYear(termsForImport(semester, nowMs)[0]);
}

interface TimetableRow {
  lessonType: string;
  classNo: string;
  day: string;
  startTime: string;
  endTime?: string;
  venue: string;
  weeks?: LessonWeeks;
}

export function venueToStop(venue: string): { stop: string; m: number } | null {
  const v = venueEntry(venue);
  return v ? { stop: v.stop, m: v.m } : null;
}

export function venueStops(venue: string): { to: string; also: string[]; walkM: Record<string, number> } | null {
  const v = venueEntry(venue);
  if (!v) return null;
  const walkM = v.stops ?? { [v.stop]: v.m };
  const [to, ...also] = Object.keys(walkM);
  return { to, also, walkM };
}

function venueEntry(venue: string): VenueEntry | null {
  const v = venue.trim().toUpperCase();
  if (VENUES.venues[v]) return VENUES.venues[v];
  const code = venueBuilding(v);
  return code ? VENUES.venues[code] : null;
}

export function venueBuilding(venue: string): string | null {
  const building = venue.trim().toUpperCase().split('-')[0];
  if (VENUES.venues[building]) return building;
  const stripped = building.replace(/\d+$/, '');
  if (stripped && VENUES.venues[stripped]) return stripped;
  return null;
}

export function venueAt(venue: string): { lat: number; lon: number } | null {
  const v = venue.trim().toUpperCase();
  for (const e of [ROOMS.rooms[v], venueEntry(v)]) if (e?.lat !== undefined && e.lon !== undefined) return { lat: e.lat, lon: e.lon };
  return null;
}

export interface TimetableClass {
  day: number;
  arriveByMin: number;
  endMin?: number;
  weeks?: LessonWeeks;
  nusmods?: true;
  place?: true;
  to: string;
  label: string;
  venue: string;
  unresolvedVenue?: boolean;
}

export interface ImportResult {
  trips: TimetableClass[];
  unresolved: Array<{ module: string; venue: string; day: number; arriveByMin: number; endMin?: number; offCampus?: boolean }>;
  term: Term;
  missing: string[];
  failed: string[];
  online: number;
}

type FetchLike = typeof fetch;

const hhmm = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(2));

export const MAX_MODULES = 15;
export const MODULE_CODE = /^[A-Z]{2,4}\d{4}[A-Z]{0,3}$/;
const OFF_CAMPUS_M = 1500;
const ONLINE_VENUE = /^(E-LEARN|ONLINE|TBA|ZOOM)/;
const FETCH_TIMEOUT_MS = 8000;

export function shareModules(share: ShareUrl): string[] {
  return [...new Set(share.selections.map((s) => s.module.toUpperCase()))];
}

type ModuleFetch = { status: 'ok'; timetable: TimetableRow[] } | { status: 'missing' } | { status: 'failed' };

async function fetchModule(fetchImpl: FetchLike, apiBase: string, ay: string, module: string, semester: number): Promise<ModuleFetch> {
  try {
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

  const terms = termsForImport(share.semester, nowMs);
  const fetchTerm = (t: Term) => Promise.all(modules.map((m) => fetchModule(fetchImpl, apiBase, nusmodsYear(t), m, share.semester)));
  let term = terms[0];
  let fetched = await fetchTerm(term);
  if (terms[1] && fetched.every((f) => f.status === 'missing')) {
    term = terms[1];
    fetched = await fetchTerm(term);
  }

  const trips: TimetableClass[] = [];
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

  trips.sort((a, b) => a.day - b.day || a.arriveByMin - b.arriveByMin || a.to.localeCompare(b.to));
  return { trips, unresolved, term, missing, failed, online };
}

export class ImportInputError extends Error {}
