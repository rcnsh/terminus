import calendarJson from '../../data/calendar.json' with { type: 'json' };
import nusDaysJson from '../../data/nus-days.json' with { type: 'json' };
import { m } from '../i18n.ts';
import { SGT_MS } from '../config.ts';

export interface CalendarData {
  generated?: string;
  semesters: Array<{ acadYear: string; semester: number; start: string }>;
  holidays: Array<{ date: string; name: string }>;
}

export const BUNDLED = calendarJson as CalendarData;
let DATA: CalendarData = BUNDLED;

export const currentCalendar = (): CalendarData => DATA;

export function useCalendar(data: CalendarData | null): void {
  DATA = data ?? BUNDLED;
}

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

export function holidaySpan(c: CalendarData): [string, string] | null {
  if (!c.holidays.length) return null;
  const dates = c.holidays.map((h) => h.date).sort();
  return [dates[0], dates[dates.length - 1]];
}

export const NUS_DAYS: CalendarData['holidays'] = nusDaysJson.days;

export function holidayOn(date: string, data: CalendarData = DATA): string | null {
  return (data.holidays.find((h) => h.date === date) ?? NUS_DAYS.find((h) => h.date === date))?.name ?? null;
}

const DAY_MS = 86_400_000;

export type WeekKind = 'instructional' | 'recess' | 'reading' | 'exam' | 'vacation' | 'unknown';

export interface TermDay {
  acadYear: string | null;
  semester: number | null;
  kind: WeekKind;
  week: number | null;
  holiday: string | null;
}

export type LessonWeeks = number[] | { start: string; end: string; weekInterval?: number; weeks?: number[] };

export function sgtDate(nowMs: number): string {
  return new Date(nowMs + SGT_MS).toISOString().slice(0, 10);
}

export function sgtMidnight(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) - SGT_MS;
}

const semWeeks = (semester: number) => (semester >= 3 ? 6 : 17);
const COVERAGE_GRACE_DAYS = 21;

function semEndMs(s: { semester: number; start: string }): number {
  return sgtMidnight(s.start) + semWeeks(s.semester) * 7 * DAY_MS;
}

const YEAR_MS = 52 * 7 * DAY_MS;

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
  const holiday = holidayOn(today, data);
  const dayStart = sgtMidnight(today);
  if (today > calendarThrough(data)) return { acadYear: null, semester: null, kind: 'unknown', week: null, holiday };

  const started = data.semesters
    .filter((s) => sgtMidnight(s.start) <= dayStart)
    .sort((a, b) => a.start.localeCompare(b.start))
    .at(-1);
  if (!started) return { acadYear: null, semester: null, kind: 'vacation', week: null, holiday };

  const k = Math.floor((dayStart - sgtMidnight(started.start)) / (7 * DAY_MS)) + 1;
  const base = { acadYear: started.acadYear, semester: started.semester, holiday };

  if (started.semester >= 3) {
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

export function importedClassRuns(weeks: LessonWeeks | undefined, term: Term | null, nowMs: number, data: CalendarData = DATA): boolean {
  const d = termDay(nowMs, data);
  if (d.holiday) return false;

  if (weeks && !Array.isArray(weeks)) {
    const day = sgtMidnight(sgtDate(nowMs));
    const start = sgtMidnight(weeks.start);
    if (day < start || day > sgtMidnight(weeks.end)) return false;
    const n = Math.floor((day - start) / (7 * DAY_MS)) + 1;
    if (weeks.weeks) return weeks.weeks.includes(n);
    return (n - 1) % (weeks.weekInterval ?? 1) === 0;
  }

  if (d.kind === 'unknown') return !(term && termEnded(term, nowMs, data));

  if (d.kind !== 'instructional' || d.week === null) return false;
  if (term && (d.acadYear !== term.acadYear || d.semester !== term.semester)) return false;
  return weeks ? weeks.includes(d.week) : true;
}

const semesterStart = (t: Term, data: CalendarData) => data.semesters.find((s) => s.acadYear === t.acadYear && s.semester === t.semester);

export function termsForImport(semester: number, nowMs: number, data: CalendarData = DATA): Term[] {
  const same = data.semesters.filter((s) => s.semester === semester).sort((a, b) => a.start.localeCompare(b.start));
  const live = same.filter((s) => semEndMs(s) >= sgtMidnight(sgtDate(nowMs)));
  const ended = same.filter((s) => !live.includes(s)).reverse();
  const out = [...live.slice(0, 1), ...ended.slice(0, 1)].map((s) => ({ acadYear: s.acadYear, semester: s.semester }));
  const d = new Date(nowMs + SGT_MS);
  const y = d.getUTCMonth() + 1 >= 8 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  const guess = { acadYear: `${y}/${y + 1}`, semester };
  if (!live.length && (!out.length || out[0].acadYear < guess.acadYear)) return [guess, ...out];
  return out;
}

export function semesterSoon(nowMs: number, days = 7, data: CalendarData = DATA): { term: Term; start: string } | null {
  const today = sgtMidnight(sgtDate(nowMs));
  const s = data.semesters.find((x) => x.semester <= 2 && sgtMidnight(x.start) > today && sgtMidnight(x.start) - today <= days * DAY_MS);
  return s ? { term: { acadYear: s.acadYear, semester: s.semester }, start: s.start } : null;
}

export function termFrom(term: Term | null | undefined, start: string, data: CalendarData = DATA): boolean {
  const s = term ? semesterStart(term, data) : undefined;
  return s !== undefined && s.start >= start;
}

export function termEnded(term: Term, nowMs: number, data: CalendarData = DATA): boolean {
  const s = semesterStart(term, data);
  return s ? semEndMs(s) < sgtMidnight(sgtDate(nowMs)) : false;
}

export function termName(t: Term): string {
  const ay = t.acadYear.replace(/^(\d{4})\/\d{2}(\d{2})$/, '$1/$2');
  return t.semester <= 2 ? m().termSem(t.semester, ay) : m().termSpecial(t.semester === 3 ? 'I' : 'II', ay);
}

export function dayOffReason(nowMs: number, data: CalendarData = DATA): string | null {
  const d = termDay(nowMs, data);
  if (d.holiday) return m().holiday(d.holiday);
  return d.kind === 'recess'
    ? m().recessWeek
    : d.kind === 'reading'
      ? m().readingWeek
      : d.kind === 'exam'
        ? m().exams
        : d.kind === 'vacation'
          ? m().vacation
          : null;
}
