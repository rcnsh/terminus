import { BUNDLED, type CalendarData, currentCalendar, holidaySpan, mergeCalendars, sgtDate, useCalendar } from './calendar.ts';
import type { Env } from '../types.ts';
import { kvMemo } from '../memo.ts';

export const NUSMODS_CALENDAR =
  'https://raw.githubusercontent.com/nusmodifications/nusmods/master/packages/nusmods-academic-calendar/academic-calendar.json';
export const SG_HOLIDAYS = 'https://data.gov.sg/api/action/datastore_search?resource_id=d_8ef23381f9417e4d4254ee8b4dcdb176&limit=1000';

export const CALENDAR_DATA_KEY = 'calendar:data';
export const CALENDAR_NEXT_KEY = 'calendar:next';
const EVERY_MS = 7 * 86_400_000;
const RETRY_MS = 86_400_000;
const RELOAD_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_SHIFT_DAYS = 3;
const MAX_TAKEN_BACK = 3;

const calendarLoads = kvMemo(RELOAD_MS, async (env: Pick<Env, 'KV'>, nowMs: number) => {
  try {
    const kept = (await env.KV.get(CALENDAR_DATA_KEY, 'json')) as CalendarData | null;
    if (kept && valid(kept)) useCalendar(withBundled(kept, nowMs));
  } catch {}
});

export function withBundled(kept: CalendarData | null, nowMs: number = Date.now()): CalendarData {
  if (!kept) return BUNDLED;
  return (kept.generated ?? '') >= (BUNDLED.generated ?? '') ? mergeCalendars(BUNDLED, kept, nowMs) : mergeCalendars(kept, BUNDLED, nowMs);
}

export async function loadCalendar(env: Pick<Env, 'KV'> | null, nowMs: number = Date.now()): Promise<void> {
  if (env?.KV) await calendarLoads.get(env, nowMs);
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
export function isDate(s: unknown): s is string {
  const m = typeof s === 'string' ? DATE.exec(s) : null;
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() + 1 === Number(m[2]) && d.getUTCDate() === Number(m[3]);
}

const NAME = /^[\p{L}\p{M}\p{N} '’&().,/+-]+$/u;
const DOMAIN = /www\.|[a-z0-9]\.[a-z]{2,}/i;
export const plainName = (s: unknown): s is string =>
  typeof s === 'string' && s.trim().length > 0 && s.length < 80 && NAME.test(s) && !DOMAIN.test(s);

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

export function movedSemesters(old: CalendarData, fetched: CalendarData): string[] {
  const was = new Map(old.semesters.map((s) => [`${s.acadYear} ${s.semester}`, s.start]));
  const out: string[] = [];
  for (const s of fetched.semesters) {
    const before = was.get(`${s.acadYear} ${s.semester}`);
    if (before && Math.abs(Date.parse(`${s.start}T00:00:00Z`) - Date.parse(`${before}T00:00:00Z`)) > MAX_SHIFT_DAYS * 86_400_000)
      out.push(`${s.acadYear} ${s.semester}: ${before} to ${s.start}`);
  }
  return out;
}

export function takenBack(old: CalendarData, fetched: CalendarData, nowMs: number): string[] {
  const span = holidaySpan(fetched);
  if (!span) return [];
  const today = sgtDate(nowMs);
  const listed = new Set(fetched.holidays.map((h) => h.date));
  return old.holidays.filter((h) => h.date > today && h.date >= span[0] && h.date <= span[1] && !listed.has(h.date)).map((h) => h.date);
}

export function fromSources(nusmods: unknown, holidays: unknown, nowMs: number): CalendarData {
  const since = new Date(nowMs).getUTCFullYear() - 1;
  if (!nusmods || typeof nusmods !== 'object') throw new Error('NUSMods calendar: not an object');
  const semesters: CalendarData['semesters'] = [];
  for (const [acadYear, sems] of Object.entries(nusmods as Record<string, unknown>)) {
    if (Number(acadYear.split('/')[1]) < since || !sems || typeof sems !== 'object') continue;
    for (const [sem, cfg] of Object.entries(sems as Record<string, { start?: unknown }>)) {
      const start = cfg?.start;
      if (!Array.isArray(start) || start.length !== 3 || !start.every(Number.isInteger))
        throw new Error(`NUSMods calendar: ${acadYear} ${sem} has no start date`);
      const [y, mo, d] = start as number[];
      semesters.push({
        acadYear,
        semester: Number(sem),
        start: `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      });
    }
  }
  const records = (holidays as { result?: { records?: unknown } } | null)?.result?.records;
  if (!Array.isArray(records)) throw new Error('data.gov.sg holidays: no records');
  const days = records
    .map((r) => r as { date?: unknown; holiday?: unknown })
    .filter((r) => typeof r.date === 'string' && Number(r.date.slice(0, 4)) >= since)
    .map((r) => ({
      date: String(r.date),
      name: String(r.holiday ?? '')
        .replace(/’/g, "'")
        .trim(),
    }));
  semesters.sort((a, b) => a.start.localeCompare(b.start) || a.semester - b.semester);
  days.sort((a, b) => a.date.localeCompare(b.date));
  return { generated: new Date(nowMs).toISOString().replace(/\.\d+Z$/, 'Z'), semesters, holidays: days };
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { 'user-agent': 'terminus-calendar/1.0' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

export async function refreshCalendar(env: Pick<Env, 'KV'>, nowMs: number): Promise<'not due' | 'unchanged' | 'updated'> {
  const due = Number(await env.KV.get(CALENDAR_NEXT_KEY)) || 0;
  if (nowMs < due) return 'not due';
  try {
    const [nusmods, holidays] = await Promise.all([getJson(NUSMODS_CALENDAR), getJson(SG_HOLIDAYS)]);
    const fetched = fromSources(nusmods, holidays, nowMs);
    if (!valid(fetched)) throw new Error('fetched calendar failed its checks');
    const raw = await env.KV.get(CALENDAR_DATA_KEY);
    let kept: CalendarData | null = null;
    try {
      kept = raw ? (JSON.parse(raw) as CalendarData) : null;
    } catch {}
    const before = kept && valid(kept) ? kept : null;
    const current = withBundled(before, nowMs);
    const moved = movedSemesters(current, fetched);
    if (moved.length) throw new Error(`fetched calendar moves semesters (${moved.join('; ')}); kept the old one`);
    const gone = takenBack(current, fetched, nowMs);
    if (gone.length > MAX_TAKEN_BACK)
      throw new Error(`fetched calendar drops ${gone.length} holidays to come (${gone.join(', ')}); kept the old one`);
    const next = mergeCalendars(before ?? { semesters: [], holidays: [] }, fetched, nowMs);
    await env.KV.put(CALENDAR_NEXT_KEY, String(nowMs + EVERY_MS));
    const same =
      before &&
      JSON.stringify(before.semesters) === JSON.stringify(next.semesters) &&
      JSON.stringify(before.holidays) === JSON.stringify(next.holidays);
    if (same) return 'unchanged';
    await env.KV.put(CALENDAR_DATA_KEY, JSON.stringify(next));
    useCalendar(withBundled(next, nowMs));
    return 'updated';
  } catch (err) {
    await env.KV.put(CALENDAR_NEXT_KEY, String(nowMs + RETRY_MS)).catch(() => {});
    throw err;
  }
}

export const calendarSource = (): 'bundled' | 'fetched' => (currentCalendar() === BUNDLED ? 'bundled' : 'fetched');
