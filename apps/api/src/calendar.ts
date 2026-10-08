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
import { m } from './i18n.ts';
import { SGT_MS } from './config.ts';

export interface CalendarData {
  /** When it was built (ISO); the newer of two copies wins where they differ. */
  generated?: string;
  semesters: Array<{ acadYear: string; semester: number; start: string }>;
  holidays: Array<{ date: string; name: string }>;
}

/** The copy bundled at deploy time. */
export const BUNDLED = calendarJson as CalendarData;
/** What's answered from: the bundled copy, or a newer one the Worker
 *  fetched itself (calendarsync.ts) merged over it. */
let DATA: CalendarData = BUNDLED;

/** The calendar answered from now. */
export const currentCalendar = (): CalendarData => DATA;

/** Answer from [data] from now on; null goes back to the bundled copy. */
export function useCalendar(data: CalendarData | null): void {
  DATA = data ?? BUNDLED;
}

/**
 * [a] and [b] together, [b] the newer: every semester either has, with
 * [b]'s where both have one, and every holiday [b] has. [a]'s other holidays
 * stay when they're past (after [nowMs]) or outside the dates [b] covers, so
 * a source that drops an old year never loses it here. A holiday to come
 * that [b] covers and no longer lists was taken back upstream, and goes.
 */
export function mergeCalendars(a: CalendarData, b: CalendarData, nowMs: number = Date.now()): CalendarData {
  const sems = new Map(a.semesters.map((s) => [`${s.acadYear} ${s.semester}`, s]));
  for (const s of b.semesters) sems.set(`${s.acadYear} ${s.semester}`, s);
  const today = sgtDate(nowMs);
  const covered = holidaySpan(b);
  const kept = a.holidays.filter((h) => h.date <= today || !covered || h.date < covered[0] || h.date > covered[1]);
  const days = new Map(kept.map((h) => [h.date, h]));
  for (const h of b.holidays) days.set(h.date, h);
  const generated = [a.generated, b.generated].filter(Boolean).sort().at(-1);
  return {
    ...(generated ? { generated } : {}),
    semesters: [...sems.values()].sort((x, y) => x.start.localeCompare(y.start) || x.semester - y.semester),
    holidays: [...days.values()].sort((x, y) => x.date.localeCompare(y.date)),
  };
}

/** The first and last holiday dates a calendar lists, or null with none. */
export function holidaySpan(c: CalendarData): [string, string] | null {
  if (!c.holidays.length) return null;
  const dates = c.holidays.map((h) => h.date).sort();
  return [dates[0], dates[dates.length - 1]];
}

const DAY_MS = 86_400_000;

/**
 * 'unknown' means today is past the end of the calendar data. Imported
 * classes then run every week (fail open): a guessed class beats a timetable
 * that silently goes blank because nobody redeployed calendar.json.
 */
export type WeekKind = 'instructional' | 'recess' | 'reading' | 'exam' | 'vacation' | 'unknown';

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
export function sgtMidnight(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) - SGT_MS;
}

/** Weeks from a semester's first day to the end of its exams. */
const semWeeks = (semester: number) => (semester >= 3 ? 6 : 17);
/** How long after the last known semester ends before the data counts as run out. */
const COVERAGE_GRACE_DAYS = 21;

function semEndMs(s: { semester: number; start: string }): number {
  return sgtMidnight(s.start) + semWeeks(s.semester) * 7 * DAY_MS;
}

/** Semester 1 starts on the same Monday each year, give or take: 52 weeks after the last. */
const YEAR_MS = 52 * 7 * DAY_MS;

/**
 * The last day the calendar data can answer for, as YYYY-MM-DD: a few weeks
 * past the last semester's end, but never into the week the next academic
 * year's first semester would start when the data doesn't have it. Special
 * Term II ends a week before semester 1 begins, so the grace alone would
 * call its first teaching weeks vacation and hide every class.
 */
export function calendarThrough(data: CalendarData = DATA): string {
  const last = Math.max(...data.semesters.map(semEndMs));
  let through = last + COVERAGE_GRACE_DAYS * DAY_MS;
  const sem1 = data.semesters.filter((s) => s.semester === 1).map((s) => sgtMidnight(s.start));
  if (sem1.length) {
    const next = Math.max(...sem1) + YEAR_MS;
    if (next > last) through = Math.min(through, next - DAY_MS);
  }
  return sgtDate(through);
}

export function termDay(nowMs: number, data: CalendarData = DATA): TermDay {
  const today = sgtDate(nowMs);
  const holiday = data.holidays.find((h) => h.date === today)?.name ?? null;
  const dayStart = sgtMidnight(today);
  if (today > calendarThrough(data)) return { acadYear: null, semester: null, kind: 'unknown', week: null, holiday };

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

  // A date-range lesson runs on its own dates, whatever the teaching week,
  // and whether or not the calendar still covers them.
  if (weeks && !Array.isArray(weeks)) {
    const day = sgtMidnight(sgtDate(nowMs));
    const start = sgtMidnight(weeks.start);
    if (day < start || day > sgtMidnight(weeks.end)) return false;
    const n = Math.floor((day - start) / (7 * DAY_MS)) + 1;
    if (weeks.weeks) return weeks.weeks.includes(n);
    return (n - 1) % (weeks.weekInterval ?? 1) === 0;
  }

  // Past the end of the data: every week (fail open), but not for a
  // semester the data says has finished.
  if (d.kind === 'unknown') return !(term && termEnded(term, nowMs, data));

  if (d.kind !== 'instructional' || d.week === null) return false;
  if (term && (d.acadYear !== term.acadYear || d.semester !== term.semester)) return false;
  return weeks ? weeks.includes(d.week) : true;
}

const semesterStart = (t: Term, data: CalendarData) =>
  data.semesters.find((s) => s.acadYear === t.acadYear && s.semester === t.semester);

/**
 * The semester a NUSMods "sem-N" link most likely means: the current one of
 * that number, else the next one to start. A sem-1 link pasted in July is for
 * August, not for the semester that ended in December. Candidates come back
 * best first; the caller can fall back when NUSMods has no data yet.
 */
export function termsForImport(semester: number, nowMs: number, data: CalendarData = DATA): Term[] {
  const same = data.semesters.filter((s) => s.semester === semester).sort((a, b) => a.start.localeCompare(b.start));
  const live = same.filter((s) => semEndMs(s) >= sgtMidnight(sgtDate(nowMs)));
  const ended = same.filter((s) => !live.includes(s)).reverse();
  const out = [...live.slice(0, 1), ...ended.slice(0, 1)].map((s) => ({ acadYear: s.acadYear, semester: s.semester }));
  // Not in the data: the academic year that starts in August.
  const d = new Date(nowMs + SGT_MS);
  const y = d.getUTCMonth() + 1 >= 8 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  const guess = { acadYear: `${y}/${y + 1}`, semester };
  // Only an ended one in the data, from a year before this one: the data
  // hasn't caught up with the new year yet, so the new year comes first.
  if (!live.length && (!out.length || out[0].acadYear < guess.acadYear)) return [guess, ...out];
  return out;
}

/**
 * Semester 1 or 2 when it starts within `days` days (after today), with its
 * start date: the week to remind people to import the new timetable. Special
 * terms are left out; few students take them.
 */
export function semesterSoon(nowMs: number, days = 7, data: CalendarData = DATA): { term: Term; start: string } | null {
  const today = sgtMidnight(sgtDate(nowMs));
  const s = data.semesters.find((x) => x.semester <= 2 && sgtMidnight(x.start) > today && sgtMidnight(x.start) - today <= days * DAY_MS);
  return s ? { term: { acadYear: s.acadYear, semester: s.semester }, start: s.start } : null;
}

/** Whether a timetable is for this semester or a later one (an unknown term is not). */
export function termFrom(term: Term | null | undefined, start: string, data: CalendarData = DATA): boolean {
  const s = term ? semesterStart(term, data) : undefined;
  return s !== undefined && s.start >= start;
}

/** Whether a timetable's semester has finished (exams included). Unknown terms count as current. */
export function termEnded(term: Term, nowMs: number, data: CalendarData = DATA): boolean {
  const s = semesterStart(term, data);
  return s ? semEndMs(s) < sgtMidnight(sgtDate(nowMs)) : false;
}

/** "Sem 1 2026/27", "Special Term I 2026/27". */
export function termName(t: Term): string {
  const ay = t.acadYear.replace(/^(\d{4})\/\d{2}(\d{2})$/, '$1/$2');
  return t.semester <= 2 ? m().termSem(t.semester, ay) : m().termSpecial(t.semester === 3 ? 'I' : 'II', ay);
}

/** Why there are no classes today, in a few words, or null on an ordinary day. */
export function dayOffReason(nowMs: number, data: CalendarData = DATA): string | null {
  const d = termDay(nowMs, data);
  if (d.holiday) return m().holiday(d.holiday);
  return d.kind === 'recess' ? m().recessWeek : d.kind === 'reading' ? m().readingWeek : d.kind === 'exam' ? m().exams : d.kind === 'vacation' ? m().vacation : null;
}
