/**
 * The NUS academic calendar, so imported classes only count in the weeks they
 * actually run: not in recess, reading or exam weeks, not on public holidays,
 * not outside their own semester, and only in the teaching weeks NUSMods
 * lists for them (many tutorials and labs start in week 2 or 3).
 *
 * data/calendar.json is built by scripts/fetch_calendar.py from NUSMods'
 * semester start dates and MOM's public holidays.
 */

import calendarJson from '../data/calendar.json' with { type: 'json' };

interface CalendarData {
  semesters: Array<{ acadYear: string; semester: number; start: string }>;
  holidays: Array<{ date: string; name: string }>;
}

const DATA = calendarJson as CalendarData;
const DAY_MS = 86_400_000;
const SGT_MS = 8 * 3_600_000;

export type WeekKind = 'instructional' | 'recess' | 'reading' | 'exam' | 'vacation';

export interface TermDay {
  acadYear: string | null;
  semester: number | null;
  kind: WeekKind;
  /** Teaching week number (1-13, or 1-6 in special terms); null outside teaching weeks. */
  week: number | null;
  /** Public holiday name, if today is one. */
  holiday: string | null;
}

/** An imported class's NUSMods `weeks`: a list of teaching weeks, or a date range. */
export type LessonWeeks =
  | number[]
  | { start: string; end: string; weekInterval?: number; weeks?: number[] };

/** SGT calendar date (YYYY-MM-DD) for an instant. */
export function sgtDate(nowMs: number): string {
  return new Date(nowMs + SGT_MS).toISOString().slice(0, 10);
}

/** Midnight SGT of a YYYY-MM-DD date, as epoch ms. */
function sgtMidnight(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) - SGT_MS;
}

export function termDay(nowMs: number, data: CalendarData = DATA): TermDay {
  const today = sgtDate(nowMs);
  const holiday = data.holidays.find((h) => h.date === today)?.name ?? null;
  const dayStart = sgtMidnight(today);

  // Latest semester that has started.
  const started = data.semesters
    .filter((s) => sgtMidnight(s.start) <= dayStart)
    .sort((a, b) => a.start.localeCompare(b.start))
    .at(-1);
  if (!started) return { acadYear: null, semester: null, kind: 'vacation', week: null, holiday };

  const k = Math.floor((dayStart - sgtMidnight(started.start)) / (7 * DAY_MS)) + 1;
  const base = { acadYear: started.acadYear, semester: started.semester, holiday };

  if (started.semester >= 3) {
    // Special terms: six teaching weeks, no recess.
    return k <= 6 ? { ...base, kind: 'instructional', week: k } : { ...base, kind: 'vacation', week: null };
  }
  if (k <= 6) return { ...base, kind: 'instructional', week: k };
  if (k === 7) return { ...base, kind: 'recess', week: null };
  if (k <= 14) return { ...base, kind: 'instructional', week: k - 1 };
  if (k === 15) return { ...base, kind: 'reading', week: null };
  if (k <= 17) return { ...base, kind: 'exam', week: null };
  return { ...base, kind: 'vacation', week: null };
}

export interface Term {
  acadYear: string;
  semester: number;
}

/**
 * Whether an imported class runs on this day. `term` is the semester the
 * timetable was imported for; without one (an import from before terms were
 * recorded), any teaching week of any semester counts.
 */
export function importedClassRuns(
  weeks: LessonWeeks | undefined,
  term: Term | null,
  nowMs: number,
  data: CalendarData = DATA,
): boolean {
  const d = termDay(nowMs, data);
  if (d.holiday) return false;

  // A date-range lesson runs on its own dates, whatever the teaching week.
  if (weeks && !Array.isArray(weeks)) {
    const day = sgtMidnight(sgtDate(nowMs));
    const start = sgtMidnight(weeks.start);
    if (day < start || day > sgtMidnight(weeks.end)) return false;
    const n = Math.floor((day - start) / (7 * DAY_MS)) + 1;
    if (weeks.weeks) return weeks.weeks.includes(n);
    return (n - 1) % (weeks.weekInterval ?? 1) === 0;
  }

  if (d.kind !== 'instructional' || d.week === null) return false;
  if (term && (d.acadYear !== term.acadYear || d.semester !== term.semester)) return false;
  return weeks ? weeks.includes(d.week) : true;
}
