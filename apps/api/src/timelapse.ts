/**
 * A day of NUS shuttles, recorded for a timelapse (the operator's page at
 * /admin/timelapse/ replays it and exports a video).
 *
 * This is the one place terminus polls the NUS feed on a schedule rather
 * than because someone asked (CLAUDE.md rule 2 has the exception). It is
 * bounded on every side:
 *
 * - one Durable Object per Singapore day (timelapsedo.ts), driven by its own
 *   alarm, asks for each service's buses once per TIMELAPSE.pollMs (never
 *   below MIN_POLL_MS, and never more than TIMELAPSE.maxPollsPerDay polls a
 *   day: pollInterval()), the services spread across that time, never in a
 *   burst;
 * - only inside TIMELAPSE.hours, and only for services inside their own
 *   operating hours;
 * - through getBuses(), the map's own path: the 5 s edge cache, failMemoS
 *   and the breaker all apply, so a poll the map already paid for costs NUS
 *   nothing, and an open breaker skips the poll altogether;
 * - only while the kill switch is on (timelapseEnabled()).
 *
 * The day is kept in the object's SQLite storage as it's recorded, then
 * written to R2 as one gzipped JSON file (DayFile) when the window closes,
 * and the object is emptied.
 */

import type { Env } from './types.ts';
import { MIN_POLL_MS, SGT_MS, TIMELAPSE } from './config.ts';
import { canReadTimelapse } from './admin.ts';
import { json } from './http.ts';
import { buildCampusMap } from './campus.ts';
import { GRAPH } from './graph.ts';
import { sgtDate, sgtMidnight as midnightOf } from './calendar.ts';

/* ------------------------------------------------------------------ */
/* When it records                                                     */
/* ------------------------------------------------------------------ */

export interface Hours {
  start: string;
  end: string;
}

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

const DAY_MS = 86_400_000;

/** How long a recording window lasts, ms: 18 hours at 06:30 to 00:30. */
export function windowLength(hours: Hours = TIMELAPSE.hours): number {
  const start = minutesOf(hours.start);
  const end = minutesOf(hours.end);
  return ((end <= start ? 1440 : 0) + end - start) * 60_000;
}

/**
 * The poll interval actually used: [ms], but never below MIN_POLL_MS, and
 * long enough that [services] services can't be polled more than
 * TIMELAPSE.maxPollsPerDay times in a window. No service is asked twice
 * within it, so each is asked at most ceil(window / interval) times a day.
 * The weekly scrape can add a route to stops.json without anyone looking:
 * the day then polls each service a little less often, never NUS more.
 */
export function pollInterval(ms: number = TIMELAPSE.pollMs, services: number = Object.keys(GRAPH.routes ?? {}).length): number {
  const asked = Number.isFinite(ms) ? Math.max(MIN_POLL_MS, ms) : TIMELAPSE.pollMs;
  const perService = Math.max(1, Math.floor(TIMELAPSE.maxPollsPerDay / Math.max(1, services)));
  return Math.max(asked, Math.ceil(windowLength() / perService));
}

/** When day [date]'s window opens and closes, epoch ms. One that crosses
 *  midnight (06:30 to 00:30) closes the next morning. */
export function windowOf(date: string, hours: Hours = TIMELAPSE.hours): { open: number; close: number } {
  const start = minutesOf(hours.start);
  const end = minutesOf(hours.end);
  const midnight = midnightOf(date);
  return { open: midnight + start * 60_000, close: midnight + (end <= start ? DAY_MS : 0) + end * 60_000 };
}

/**
 * The day [ms] belongs to: the date its window opened on. 00:10 on the 8th
 * is still the 7th's day while a 06:30 to 00:30 window runs, and so is 03:00
 * (closed, waiting for the 8th's window to open).
 */
export function serviceDate(ms: number, hours: Hours = TIMELAPSE.hours): string {
  return sgtDate(ms - minutesOf(hours.start) * 60_000);
}

/** Whether [ms] is inside a recording window. */
export function inWindow(ms: number, hours: Hours = TIMELAPSE.hours): boolean {
  const w = windowOf(serviceDate(ms, hours), hours);
  return ms >= w.open && ms < w.close;
}

/** [ms] when it's inside a window, else when the next one opens. */
export function nextOpen(ms: number, hours: Hours = TIMELAPSE.hours): number {
  if (inWindow(ms, hours)) return ms;
  const next = sgtDate(midnightOf(serviceDate(ms, hours)) + DAY_MS + SGT_MS);
  return windowOf(next, hours).open;
}

/**
 * The kill switch. KV `config:timelapse` ("on" or "off") wins, so the
 * recorder can be stopped at once without a deploy; without it, the
 * TIMELAPSE_ENABLED var. Unset everywhere is off: nothing polls NUS unless
 * someone turned it on. KV failing to answer is off too: it may hold an
 * "off" that the var would otherwise override.
 */
export async function timelapseEnabled(env: Env): Promise<boolean> {
  let kv: string | null;
  try {
    kv = await env.KV.get('config:timelapse');
  } catch {
    return false;
  }
  const v = (kv ?? env.TIMELAPSE_ENABLED ?? '').trim().toLowerCase();
  return v === 'on' || v === 'true' || v === '1';
}

/* ------------------------------------------------------------------ */
/* What it keeps                                                       */
/* ------------------------------------------------------------------ */

/** Coordinates are kept as whole steps of 1/Q degree (about 1.1 m) from ORIGIN. */
export const Q = 100_000;
export const ORIGIN = { lat: 1.29, lon: 103.77 };

/** One bus in one reading. */
export interface SampleBus {
  plate: string;
  lat: number;
  lon: number;
  /** Metres along its route line (the track buses.ts placed it on); null off it. */
  along: number | null;
}

/** A bus as four whole numbers: its plate's index, latitude and longitude
 *  in steps from ORIGIN, and metres along its line (-1 off it). */
export function encodeBus(b: SampleBus, plateIndex: number): [number, number, number, number] {
  return [plateIndex, Math.round((b.lat - ORIGIN.lat) * Q), Math.round((b.lon - ORIGIN.lon) * Q), b.along == null ? -1 : Math.round(b.along)];
}

/**
 * The day as one file. Each sample is `[dt, service, ...buses]`: ms since
 * the sample before it (the first counts from t0), the index of its service
 * in `services`, then four numbers per bus (encodeBus). A service polled
 * with no bus out is a sample with no buses; a poll that failed is no
 * sample. The route lines are the ones the `along`s were measured on.
 * apps/web/public/admin/timelapse/replay.js reads it.
 */
export interface DayFile {
  v: 1;
  date: string;
  /** Epoch ms the first sample's dt counts from. */
  t0: number;
  q: number;
  origin: [number, number];
  pollMs: number;
  services: string[];
  plates: string[];
  routes: Record<string, { color: string; loop: boolean; line: [number, number][] }>;
  /** `core`: on campus proper, not out along P's route (the page frames these). */
  stops: { code: string; name: string; lat: number; lon: number; core: boolean }[];
  samples: number[][];
}

/** The routes and stops a day is drawn with: the map's, as /campus has them now. */
export function mapSnapshot(): Pick<DayFile, 'routes' | 'stops'> {
  const campus = buildCampusMap(GRAPH);
  return {
    routes: Object.fromEntries(Object.entries(campus.routes).map(([svc, r]) => [svc, { color: r.color, loop: r.loop, line: r.line }])),
    stops: campus.stops.map((s) => ({ code: s.code, name: s.name, lat: s.lat, lon: s.lon, core: s.core })),
  };
}

/** A fingerprint of a line: equal for the same points, different otherwise. */
function fingerprint(line: [number, number][]): string {
  const text = JSON.stringify(line);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return `${line.length}:${h.toString(16)}`;
}

let current: Record<string, string> | null = null;

/** Each route line's fingerprint in [map], or (null) in this deploy's map. */
export function lineKeys(map: Pick<DayFile, 'routes'> | null): Record<string, string> {
  if (!map) return (current ??= lineKeys(mapSnapshot()));
  return Object.fromEntries(Object.entries(map.routes).map(([svc, r]) => [svc, fingerprint(r.line)]));
}

/** One stored row: ms since the row before, the service, its encoded buses. */
export interface Row {
  dt: number;
  svc: string;
  buses: number[];
}

export function buildDayFile(o: {
  date: string;
  t0: number;
  pollMs: number;
  plates: string[];
  rows: Row[];
  map: Pick<DayFile, 'routes' | 'stops'>;
}): DayFile {
  const services = [...new Set(o.rows.map((r) => r.svc))].sort();
  const index = new Map(services.map((s, i) => [s, i]));
  return {
    v: 1,
    date: o.date,
    t0: o.t0,
    q: Q,
    origin: [ORIGIN.lon, ORIGIN.lat],
    pollMs: o.pollMs,
    services,
    plates: o.plates,
    ...o.map,
    samples: o.rows.map((r) => [r.dt, index.get(r.svc)!, ...r.buses]),
  };
}

export async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export const dayKey = (date: string) => `timelapse/${date}.json.gz`;

/* ------------------------------------------------------------------ */
/* The recorder, from the Worker                                        */
/* ------------------------------------------------------------------ */

/** How long a recorder keeps a closed day that R2 refused, trying again,
 *  and how many days back /timelapse/days looks for one. A week is plenty
 *  to notice. */
export const HELD_DAYS = 7;

/** The cron runs every 15 minutes. */
const CRON_MS = 15 * 60_000;

/** How long the Worker waits for a recorder to answer: one that's stuck
 *  mustn't hold up the cron's other steps or an operator's request. */
const RECORDER_WAIT_MS = 10_000;

/** [path] from a recorder, or a rejection after RECORDER_WAIT_MS. */
function askRecorder(stub: DurableObjectStub, path: string, init?: RequestInit): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('the timelapse recorder did not answer')), RECORDER_WAIT_MS);
  });
  return Promise.race([stub.fetch(`https://timelapse.internal${path}`, init), late]).finally(() => clearTimeout(timer));
}

/** The recorder for day [date]. In Asia, near the feed and most of its users,
 *  so the edge cache it reads is likely the one the map fills. */
export function recorderFor(env: Env, date: string): DurableObjectStub | null {
  if (!env.TIMELAPSE) return null;
  return env.TIMELAPSE.get(env.TIMELAPSE.idFromName(date), { locationHint: 'apac' });
}

/**
 * From the 15-minute cron: inside a window with the switch on, makes sure
 * today's recorder is running (it does nothing when it already is). The
 * recorder keeps itself going with its alarm from then on; this only starts
 * it each morning, and again after the switch comes back on.
 *
 * Once a day, at the first run after the window opens, the past week's
 * recorders are asked too, switch or not: one still holding a day whose
 * alarm is gone (its retries ran out) is woken to write it and empty
 * itself. One holding nothing does nothing, and stores nothing.
 */
export async function ensureRecorder(env: Env, nowMs: number): Promise<void> {
  if (!env.TIMELAPSE || !inWindow(nowMs)) return;
  const date = serviceDate(nowMs);
  const start = (d: string) => askRecorder(recorderFor(env, d)!, `/start?date=${d}`, { method: 'POST' });
  if (nowMs - windowOf(date).open < CRON_MS) {
    await Promise.allSettled(Array.from({ length: HELD_DAYS }, (_, i) => start(serviceDate(nowMs - (i + 1) * DAY_MS))));
  }
  if (!(await timelapseEnabled(env))) return;
  await start(date);
}

/* ------------------------------------------------------------------ */
/* /timelapse/days                                                     */
/* ------------------------------------------------------------------ */

const DAY_PATH = /^\/timelapse\/days\/(\d{4}-\d{2}-\d{2})$/;

/** What the recorder says about the day it holds (timelapsedo.ts /status). */
export interface RecorderStatus {
  date: string | null;
  samples: number;
  state: string;
}


/**
 * GET /timelapse/days and /timelapse/days/:date, for the operator or a
 * holder of TIMELAPSE_TOKEN only (anything else is a 404, as /admin/stats).
 * A closed day is its file from R2, unchanged from then on, so it's cached
 * for a year; today's is built from what the recorder holds so far, and not
 * cached.
 */
export async function handleTimelapse(req: Request, url: URL, env: Env, nowMs: number): Promise<Response | null> {
  if (!url.pathname.startsWith('/timelapse/')) return null;
  if (!canReadTimelapse(env, req) || req.method !== 'GET') return json({ error: 'not found' }, 404);
  if (!env.DOWNLOADS) return json({ error: 'timelapse storage is not configured' }, 503);

  if (url.pathname === '/timelapse/days') {
    const days: { date: string; closed: boolean; bytes: number | null; samples: number | null }[] = [];
    let cursor: string | undefined;
    do {
      const page = await env.DOWNLOADS.list({ prefix: 'timelapse/', cursor });
      for (const o of page.objects) {
        const date = /^timelapse\/(\d{4}-\d{2}-\d{2})\.json\.gz$/.exec(o.key)?.[1];
        if (date) days.push({ date, closed: true, bytes: o.size, samples: null });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    const today = serviceDate(nowMs);
    const status = await recorderStatus(env, today);
    if (status && status.samples > 0 && !days.some((d) => d.date === today)) days.push({ date: today, closed: false, bytes: null, samples: status.samples });
    // Earlier days whose recorders are still trying to write them to R2.
    const held = await Promise.all(
      Array.from({ length: HELD_DAYS }, (_, i) => serviceDate(nowMs - (i + 1) * DAY_MS))
        .filter((date) => !days.some((d) => d.date === date))
        .map(async (date) => ({ date, status: await recorderStatus(env, date) })),
    );
    for (const { date, status: s } of held) if (s && s.samples > 0) days.push({ date, closed: false, bytes: null, samples: s.samples });
    days.sort((a, b) => b.date.localeCompare(a.date));
    return json({ days, recording: { date: today, enabled: await timelapseEnabled(env), state: status?.state ?? 'idle', samples: status?.samples ?? 0 } });
  }

  const date = DAY_PATH.exec(url.pathname)?.[1];
  if (!date) return json({ error: 'not found' }, 404);
  const stored = await env.DOWNLOADS.get(dayKey(date));
  if (stored) {
    return new Response(stored.body, {
      headers: { 'content-type': 'application/gzip', 'cache-control': 'private, max-age=31536000, immutable', etag: stored.httpEtag },
    });
  }
  // Not closed yet: the recorder's day so far.
  const open = recorderFor(env, date);
  let res: Response | null = null;
  try {
    res = open ? await askRecorder(open, `/day?date=${date}`) : null;
  } catch {
    return json({ error: 'terminus is busy, try again in a minute' }, 503, { 'retry-after': '60' });
  }
  if (!res || !res.ok) return json({ error: 'no timelapse for that day' }, 404);
  return new Response(res.body, { headers: { 'content-type': 'application/gzip', 'cache-control': 'no-store' } });
}

async function recorderStatus(env: Env, date: string): Promise<RecorderStatus | null> {
  const stub = recorderFor(env, date);
  if (!stub) return null;
  try {
    const res = await askRecorder(stub, `/status?date=${date}`);
    return res.ok ? ((await res.json()) as RecorderStatus) : null;
  } catch {
    return null;
  }
}
