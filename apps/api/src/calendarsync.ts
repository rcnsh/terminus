/**
 * The academic calendar, kept up to date by the Worker itself, so it doesn't
 * run out when nobody redeploys.
 *
 * data/calendar.json is bundled at deploy time (scripts/fetch_calendar.py,
 * refreshed weekly by the scrape workflow). Bundled data only changes with a
 * deploy, so the cron also fetches the same two public sources once a week
 * (refreshCalendar): NUSMods' semester start dates and MOM's public holidays
 * on data.gov.sg. A copy that passes the checks is merged over what's known
 * and kept in KV; every instance reads it from there (loadCalendar), merged
 * with the bundled copy, so a source that drops a year loses nothing and a
 * broken one changes nothing. A holiday to come that the source takes back
 * goes (a few at a time); a semester already known never moves this way.
 */

import { BUNDLED, type CalendarData, currentCalendar, holidaySpan, mergeCalendars, sgtDate, useCalendar } from './calendar.ts';
import type { Env } from './types.ts';

export const NUSMODS_CALENDAR =
  'https://raw.githubusercontent.com/nusmodifications/nusmods/master/packages/nusmods-academic-calendar/academic-calendar.json';
export const SG_HOLIDAYS = 'https://data.gov.sg/api/action/datastore_search?resource_id=d_8ef23381f9417e4d4254ee8b4dcdb176&limit=1000';

/** The fetched calendar, merged over what was known, in KV. */
export const CALENDAR_DATA_KEY = 'calendar:data';
/** When the next fetch is due (epoch ms). */
export const CALENDAR_NEXT_KEY = 'calendar:next';
/** Fetched once a week; after a failure, again the next day. */
const EVERY_MS = 7 * 86_400_000;
const RETRY_MS = 86_400_000;
/** How long an instance answers from its copy before reading KV again. */
const RELOAD_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
/**
 * How far a semester known already may move in one fetch. Semesters start on
 * a Monday, so a real move is a week or more and none gets past this: a
 * human checks it and deploys the corrected calendar.json, which then wins.
 */
const MAX_SHIFT_DAYS = 3;
/** Holidays to come one fetch may take back (a corrected mistake); a year has about a dozen. */
const MAX_TAKEN_BACK = 3;

let loadedAt = -Infinity;

/** The bundled calendar with [kept] merged in: the newer one wins where they differ. */
export function withBundled(kept: CalendarData | null, nowMs: number = Date.now()): CalendarData {
  if (!kept) return BUNDLED;
  return (kept.generated ?? '') >= (BUNDLED.generated ?? '') ? mergeCalendars(BUNDLED, kept, nowMs) : mergeCalendars(kept, BUNDLED, nowMs);
}

/**
 * Answers from the calendar in KV, read at most every RELOAD_MS per
 * instance. Without one, or when KV can't be read, the bundled copy (or the
 * copy already loaded) stands.
 */
export async function loadCalendar(env: Pick<Env, 'KV'> | null, nowMs: number = Date.now()): Promise<void> {
  if (!env?.KV || nowMs - loadedAt < RELOAD_MS) return;
  loadedAt = nowMs;
  try {
    const kept = (await env.KV.get(CALENDAR_DATA_KEY, 'json')) as CalendarData | null;
    if (kept && valid(kept)) useCalendar(withBundled(kept, nowMs));
  } catch {
    // Keep answering from what's loaded.
  }
}

/** For the tests: forget what's loaded. */
export function resetCalendar(): void {
  loadedAt = -Infinity;
  useCalendar(null);
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A real YYYY-MM-DD date: Date.parse takes 2026-02-30 as 2 March, so the parts must come back the same. */
export function isDate(s: unknown): s is string {
  const m = typeof s === 'string' ? DATE.exec(s) : null;
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() + 1 === Number(m[2]) && d.getUTCDate() === Number(m[3]);
}

/**
 * A holiday's name, shown as it is: letters (Chinese too), digits, spaces
 * and everyday punctuation, under 80 characters. No '<', no control
 * characters, no ':' and no web address. check_scraped.py has the same rule.
 */
const NAME = /^[\p{L}\p{M}\p{N} '’&().,/+-]+$/u;
const DOMAIN = /www\.|[a-z0-9]\.[a-z]{2,}/i;
export const plainName = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0 && s.length < 80 && NAME.test(s) && !DOMAIN.test(s);

/**
 * Whether a calendar holds what the app relies on: real dates, terms 1-4
 * each starting on a Monday inside its own academic year (1 July of its
 * first year to 31 July of its second), and enough of both.
 * check_scraped.py checks calendar.json by the same rules.
 */
export function valid(c: CalendarData): boolean {
  if (!c || !Array.isArray(c.semesters) || !Array.isArray(c.holidays)) return false;
  if (c.semesters.length < 4 || c.holidays.length < 5) return false;
  const semOk = c.semesters.every((s) => {
    const ay = typeof s?.acadYear === 'string' ? /^(\d{4})\/(\d{4})$/.exec(s.acadYear) : null;
    if (!ay || Number(ay[2]) !== Number(ay[1]) + 1 || ![1, 2, 3, 4].includes(s.semester) || !isDate(s.start)) return false;
    return new Date(`${s.start}T00:00:00Z`).getUTCDay() === 1 && s.start >= `${ay[1]}-07-01` && s.start <= `${ay[2]}-07-31`;
  });
  const dayOk = c.holidays.every((h) => isDate(h?.date) && plainName(h.name));
  return semOk && dayOk;
}

/** Semesters [old] has that [fetched] starts more than MAX_SHIFT_DAYS away, as "2026/2027 1: 2026-08-10 to 2026-08-24". */
export function movedSemesters(old: CalendarData, fetched: CalendarData): string[] {
  const was = new Map(old.semesters.map((s) => [`${s.acadYear} ${s.semester}`, s.start]));
  const out: string[] = [];
  for (const s of fetched.semesters) {
    const before = was.get(`${s.acadYear} ${s.semester}`);
    if (before && Math.abs(Date.parse(`${s.start}T00:00:00Z`) - Date.parse(`${before}T00:00:00Z`)) > MAX_SHIFT_DAYS * 86_400_000) out.push(`${s.acadYear} ${s.semester}: ${before} to ${s.start}`);
  }
  return out;
}

/** Holidays to come in [old], inside the dates [fetched] covers, that [fetched] no longer lists. */
export function takenBack(old: CalendarData, fetched: CalendarData, nowMs: number): string[] {
  const span = holidaySpan(fetched);
  if (!span) return [];
  const today = sgtDate(nowMs);
  const listed = new Set(fetched.holidays.map((h) => h.date));
  return old.holidays.filter((h) => h.date > today && h.date >= span[0] && h.date <= span[1] && !listed.has(h.date)).map((h) => h.date);
}

/**
 * The calendar from the two sources' replies, as fetch_calendar.py builds
 * it: semesters and holidays from last year on. Throws on a reply it can't
 * read.
 */
export function fromSources(nusmods: unknown, holidays: unknown, nowMs: number): CalendarData {
  const since = new Date(nowMs).getUTCFullYear() - 1;
  if (!nusmods || typeof nusmods !== 'object') throw new Error('NUSMods calendar: not an object');
  const semesters: CalendarData['semesters'] = [];
  for (const [acadYear, sems] of Object.entries(nusmods as Record<string, unknown>)) {
    if (Number(acadYear.split('/')[1]) < since || !sems || typeof sems !== 'object') continue;
    for (const [sem, cfg] of Object.entries(sems as Record<string, { start?: unknown }>)) {
      const start = cfg?.start;
      if (!Array.isArray(start) || start.length !== 3 || !start.every(Number.isInteger)) throw new Error(`NUSMods calendar: ${acadYear} ${sem} has no start date`);
      const [y, mo, d] = start as number[];
      semesters.push({ acadYear, semester: Number(sem), start: `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` });
    }
  }
  const records = (holidays as { result?: { records?: unknown } } | null)?.result?.records;
  if (!Array.isArray(records)) throw new Error('data.gov.sg holidays: no records');
  const days = records
    .map((r) => r as { date?: unknown; holiday?: unknown })
    .filter((r) => typeof r.date === 'string' && Number(r.date.slice(0, 4)) >= since)
    .map((r) => ({ date: String(r.date), name: String(r.holiday ?? '').replace(/’/g, "'").trim() }));
  semesters.sort((a, b) => a.start.localeCompare(b.start) || a.semester - b.semester);
  days.sort((a, b) => a.date.localeCompare(b.date));
  return { generated: new Date(nowMs).toISOString().replace(/\.\d+Z$/, 'Z'), semesters, holidays: days };
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { 'user-agent': 'terminus-calendar/1.0' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

/**
 * Fetches the calendar once a week (from the cron) and keeps it in KV,
 * merged over what was known, when it passes the checks. Returns what it
 * did, for the logs; a failure is thrown after setting the retry.
 */
export async function refreshCalendar(env: Pick<Env, 'KV'>, nowMs: number): Promise<'not due' | 'unchanged' | 'updated'> {
  const due = Number(await env.KV.get(CALENDAR_NEXT_KEY)) || 0;
  if (nowMs < due) return 'not due';
  try {
    const [nusmods, holidays] = await Promise.all([getJson(NUSMODS_CALENDAR), getJson(SG_HOLIDAYS)]);
    const fetched = fromSources(nusmods, holidays, nowMs);
    if (!valid(fetched)) throw new Error('fetched calendar failed its checks');
    // A failed read throws (and the fetch is tried again tomorrow): taken as
    // "nothing kept", the write below would drop the years merged before.
    // Only a copy that isn't JSON at all is written over.
    const raw = await env.KV.get(CALENDAR_DATA_KEY);
    let kept: CalendarData | null = null;
    try {
      kept = raw ? (JSON.parse(raw) as CalendarData) : null;
    } catch {
      // Unreadable: nothing worth keeping.
    }
    const before = kept && valid(kept) ? kept : null;
    // Checked against what's answered from now, the bundled copy included:
    // a semester known already doesn't move, and few holidays to come go.
    // Either is thrown (for the cron's log), and the old calendar stays.
    const current = withBundled(before, nowMs);
    const moved = movedSemesters(current, fetched);
    if (moved.length) throw new Error(`fetched calendar moves semesters (${moved.join('; ')}); kept the old one`);
    const gone = takenBack(current, fetched, nowMs);
    if (gone.length > MAX_TAKEN_BACK) throw new Error(`fetched calendar drops ${gone.length} holidays to come (${gone.join(', ')}); kept the old one`);
    const next = mergeCalendars(before ?? { semesters: [], holidays: [] }, fetched, nowMs);
    await env.KV.put(CALENDAR_NEXT_KEY, String(nowMs + EVERY_MS));
    const same = before && JSON.stringify(before.semesters) === JSON.stringify(next.semesters) && JSON.stringify(before.holidays) === JSON.stringify(next.holidays);
    if (same) return 'unchanged';
    await env.KV.put(CALENDAR_DATA_KEY, JSON.stringify(next));
    useCalendar(withBundled(next, nowMs));
    return 'updated';
  } catch (err) {
    await env.KV.put(CALENDAR_NEXT_KEY, String(nowMs + RETRY_MS)).catch(() => {});
    throw err;
  }
}

/** For the logs and /health: how far the calendar answered from goes. */
export const calendarSource = (): 'bundled' | 'fetched' => (currentCalendar() === BUNDLED ? 'bundled' : 'fetched');
