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

import type { Stop } from './types.ts';
import venuesJson from '../data/venues.json' with { type: 'json' };

const VENUES = venuesJson as { venues: Record<string, { stop: string; m: number }> };

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
  const url = new URL(input);
  const semMatch = /sem-(\d)/.exec(url.pathname);
  const semester = semMatch ? Number(semMatch[1]) : 1;

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

/** NUS academic year for a semester, from today. Sem 1 starts in August. */
export function acadYear(nowMs: number, semester: number): string {
  const d = new Date(nowMs + 8 * 3600_000); // SGT
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  // Aug-Dec is sem 1 of AY y..y+1; Jan-Jul belongs to the AY that began last y-1.
  const startYear = m >= 8 ? y : y - 1;
  return `${startYear}-${startYear + 1}`;
}

interface TimetableRow {
  lessonType: string;
  classNo: string;
  day: string;
  startTime: string; // "HHMM"
  venue: string;
}

/** Venue code -> nearest ISB stop code. Tries the full code, then the building
 *  prefix ("AS3-0307" -> "AS3"), then progressively shorter prefixes. */
export function venueToStop(venue: string): { stop: string; m: number } | null {
  const v = venue.trim().toUpperCase();
  if (VENUES.venues[v]) return VENUES.venues[v];
  const building = v.split('-')[0];
  if (VENUES.venues[building]) return VENUES.venues[building];
  // Trailing digits sometimes distinguish rooms in a bare code (COM1 vs COM12).
  const stripped = building.replace(/\d+$/, '');
  for (const key of Object.keys(VENUES.venues)) {
    if (key === building) return VENUES.venues[key];
  }
  if (stripped && VENUES.venues[stripped]) return VENUES.venues[stripped];
  return null;
}

export interface ImportedTrip {
  day: number; // 0=Sun..6=Sat
  arriveByMin: number; // minutes past midnight SGT, class start
  to: string; // destination stop code
  label: string; // e.g. "CS1010S @ COM1"
  venue: string;
  unresolvedVenue?: boolean;
}

export interface ImportResult {
  trips: ImportedTrip[];
  unresolved: Array<{ module: string; venue: string }>;
}

type FetchLike = typeof fetch;

/**
 * Resolve selections into trips by querying NUSMods. One fetch per distinct
 * module; a selection with no matching class (stale share link) is skipped.
 */
export async function resolveTrips(
  share: ShareUrl,
  nowMs: number,
  fetchImpl: FetchLike = fetch,
  apiBase = 'https://api.nusmods.com/v2',
): Promise<ImportResult> {
  const ay = acadYear(nowMs, share.semester);
  const byModule = new Map<string, Selection[]>();
  for (const s of share.selections) {
    const arr = byModule.get(s.module) ?? [];
    arr.push(s);
    byModule.set(s.module, arr);
  }

  const trips: ImportedTrip[] = [];
  const unresolved: ImportResult['unresolved'] = [];

  for (const [module, sels] of byModule) {
    const res = await fetchImpl(`${apiBase}/${ay}/modules/${module}.json`);
    if (!res.ok) continue;
    const mod = (await res.json()) as {
      semesterData?: Array<{ semester: number; timetable: TimetableRow[] }>;
    };
    const sem = mod.semesterData?.find((s) => s.semester === share.semester);
    if (!sem) continue;

    for (const sel of sels) {
      const rows = sem.timetable.filter(
        (r) => r.lessonType === sel.lessonType && r.classNo === sel.classNo,
      );
      for (const r of rows) {
        const day = DAYS.indexOf(r.day);
        if (day < 0) continue;
        const resolved = venueToStop(r.venue);
        if (!resolved) {
          unresolved.push({ module, venue: r.venue });
          continue;
        }
        trips.push({
          day,
          arriveByMin: Number(r.startTime.slice(0, 2)) * 60 + Number(r.startTime.slice(2)),
          to: resolved.stop,
          label: `${module} @ ${r.venue.split('-')[0]}`,
          venue: r.venue,
        });
      }
    }
  }

  // A stable order makes the encoded link deterministic.
  trips.sort((a, b) => a.day - b.day || a.arriveByMin - b.arriveByMin || a.to.localeCompare(b.to));
  return { trips, unresolved };
}

/* ------------------------------------------------------------------ */
/* Stateless encoding: the personal /next link IS the timetable        */
/* ------------------------------------------------------------------ */

export interface Timetable {
  home: string | null; // origin stop for calls without coordinates
  trips: ImportedTrip[];
}

/** Compact form: [home, [[day, min, to, label], ...]] -> base64url(JSON). */
export function encodeTimetable(tt: Timetable): string {
  const compact = [tt.home ?? '', tt.trips.map((t) => [t.day, t.arriveByMin, t.to, t.label])];
  const json = JSON.stringify(compact);
  return btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function decodeTimetable(encoded: string): Timetable | null {
  try {
    const pad = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(escape(atob(pad + '='.repeat((4 - (pad.length % 4)) % 4))));
    const [home, rows] = JSON.parse(json) as [string, Array<[number, number, string, string]>];
    return {
      home: home || null,
      trips: rows.map(([day, arriveByMin, to, label]) => ({
        day,
        arriveByMin,
        to,
        label,
        venue: '',
      })),
    };
  } catch {
    return null;
  }
}

/**
 * The next class today whose start is still ahead (plus a lead so you are not
 * offered a bus you cannot possibly make). Falls back to the first class of
 * the next day that has any. Returns null when the timetable is empty.
 */
export function nextTrip(tt: Timetable, nowMs: number, leadMin = 0): ImportedTrip | null {
  const d = new Date(nowMs + 8 * 3600_000);
  const today = d.getUTCDay();
  const nowMin = d.getUTCHours() * 60 + d.getUTCMinutes();

  const upcomingToday = tt.trips
    .filter((t) => t.day === today && t.arriveByMin - leadMin >= nowMin)
    .sort((a, b) => a.arriveByMin - b.arriveByMin);
  if (upcomingToday.length) return upcomingToday[0];

  for (let ahead = 1; ahead <= 7; ahead++) {
    const day = (today + ahead) % 7;
    const dayTrips = tt.trips.filter((t) => t.day === day).sort((a, b) => a.arriveByMin - b.arriveByMin);
    if (dayTrips.length) return dayTrips[0];
  }
  return null;
}
