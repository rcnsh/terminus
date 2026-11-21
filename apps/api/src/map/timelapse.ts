import type { Env } from '../types.ts';
import { MIN_POLL_MS, SGT_MS, TIMELAPSE } from '../config.ts';
import { canReadTimelapse } from '../ops/admin.ts';
import { json } from '../http.ts';
import { buildCampusMap } from './campus.ts';
import { GRAPH } from '../answer/graph.ts';
import { sgtDate, sgtMidnight as midnightOf } from '../timetable/calendar.ts';

export interface Hours {
  start: string;
  end: string;
}

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

const DAY_MS = 86_400_000;

export function windowLength(hours: Hours = TIMELAPSE.hours): number {
  const start = minutesOf(hours.start);
  const end = minutesOf(hours.end);
  return ((end <= start ? 1440 : 0) + end - start) * 60_000;
}

export function pollInterval(ms: number = TIMELAPSE.pollMs, services: number = Object.keys(GRAPH.routes ?? {}).length): number {
  const asked = Number.isFinite(ms) ? Math.max(MIN_POLL_MS, ms) : TIMELAPSE.pollMs;
  const perService = Math.max(1, Math.floor(TIMELAPSE.maxPollsPerDay / Math.max(1, services)));
  return Math.max(asked, Math.ceil(windowLength() / perService));
}

export function windowOf(date: string, hours: Hours = TIMELAPSE.hours): { open: number; close: number } {
  const start = minutesOf(hours.start);
  const end = minutesOf(hours.end);
  const midnight = midnightOf(date);
  return { open: midnight + start * 60_000, close: midnight + (end <= start ? DAY_MS : 0) + end * 60_000 };
}

export function serviceDate(ms: number, hours: Hours = TIMELAPSE.hours): string {
  return sgtDate(ms - minutesOf(hours.start) * 60_000);
}

export function inWindow(ms: number, hours: Hours = TIMELAPSE.hours): boolean {
  const w = windowOf(serviceDate(ms, hours), hours);
  return ms >= w.open && ms < w.close;
}

export function nextOpen(ms: number, hours: Hours = TIMELAPSE.hours): number {
  if (inWindow(ms, hours)) return ms;
  const next = sgtDate(midnightOf(serviceDate(ms, hours)) + DAY_MS + SGT_MS);
  return windowOf(next, hours).open;
}

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

export const Q = 100_000;
export const ORIGIN = { lat: 1.29, lon: 103.77 };

export interface SampleBus {
  plate: string;
  lat: number;
  lon: number;
  along: number | null;
}

export function encodeBus(b: SampleBus, plateIndex: number): [number, number, number, number] {
  return [
    plateIndex,
    Math.round((b.lat - ORIGIN.lat) * Q),
    Math.round((b.lon - ORIGIN.lon) * Q),
    b.along == null ? -1 : Math.round(b.along),
  ];
}

export interface DayFile {
  v: 1;
  date: string;
  t0: number;
  q: number;
  origin: [number, number];
  pollMs: number;
  services: string[];
  plates: string[];
  routes: Record<string, { color: string; loop: boolean; line: [number, number][] }>;
  stops: { code: string; name: string; lat: number; lon: number; core: boolean }[];
  samples: number[][];
}

export function mapSnapshot(): Pick<DayFile, 'routes' | 'stops'> {
  const campus = buildCampusMap(GRAPH);
  return {
    routes: Object.fromEntries(Object.entries(campus.routes).map(([svc, r]) => [svc, { color: r.color, loop: r.loop, line: r.line }])),
    stops: campus.stops.map((s) => ({ code: s.code, name: s.name, lat: s.lat, lon: s.lon, core: s.core })),
  };
}

function fingerprint(line: [number, number][]): string {
  const text = JSON.stringify(line);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return `${line.length}:${h.toString(16)}`;
}

let current: Record<string, string> | null = null;

export function lineKeys(map: Pick<DayFile, 'routes'> | null): Record<string, string> {
  if (!map) return (current ??= lineKeys(mapSnapshot()));
  return Object.fromEntries(Object.entries(map.routes).map(([svc, r]) => [svc, fingerprint(r.line)]));
}

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

export const HELD_DAYS = 7;

const CRON_MS = 15 * 60_000;

const RECORDER_WAIT_MS = 10_000;

function askRecorder(stub: DurableObjectStub, path: string, init?: RequestInit): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('the timelapse recorder did not answer')), RECORDER_WAIT_MS);
  });
  return Promise.race([stub.fetch(`https://timelapse.internal${path}`, init), late]).finally(() => clearTimeout(timer));
}

export function recorderFor(env: Env, date: string): DurableObjectStub | null {
  if (!env.TIMELAPSE) return null;
  return env.TIMELAPSE.get(env.TIMELAPSE.idFromName(date), { locationHint: 'apac' });
}

export async function ensureRecorder(env: Env, nowMs: number): Promise<void> {
  if (!env.TIMELAPSE || !inWindow(nowMs)) return;
  const date = serviceDate(nowMs);
  const start = (d: string) => askRecorder(recorderFor(env, d)!, `/start?date=${d}`, { method: 'POST' });
  if (nowMs - windowOf(date).open < CRON_MS) {
    await Promise.allSettled(Array.from({ length: HELD_DAYS + 1 }, (_, i) => start(serviceDate(nowMs - (i + 1) * DAY_MS))));
  }
  if (!(await timelapseEnabled(env))) return;
  await start(date);
}

const DAY_PATH = /^\/api\/timelapse\/days\/(\d{4}-\d{2}-\d{2})$/;

export interface RecorderStatus {
  date: string | null;
  samples: number;
  state: string;
}

export async function handleTimelapse(req: Request, url: URL, env: Env, nowMs: number): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/timelapse/')) return null;
  if (req.method !== 'GET' || !(await canReadTimelapse(env, req, nowMs))) return json({ error: 'not found' }, 404);
  if (!env.FILES) return json({ error: 'timelapse storage is not configured' }, 503);

  if (url.pathname === '/api/timelapse/days') {
    const days: { date: string; closed: boolean; bytes: number | null; samples: number | null }[] = [];
    let cursor: string | undefined;
    do {
      const page = await env.FILES.list({ prefix: 'timelapse/', cursor });
      for (const o of page.objects) {
        const date = /^timelapse\/(\d{4}-\d{2}-\d{2})\.json\.gz$/.exec(o.key)?.[1];
        if (date) days.push({ date, closed: true, bytes: o.size, samples: null });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    const today = serviceDate(nowMs);
    const status = await recorderStatus(env, today);
    if (status && status.samples > 0 && !days.some((d) => d.date === today))
      days.push({ date: today, closed: false, bytes: null, samples: status.samples });
    const held = await Promise.all(
      Array.from({ length: HELD_DAYS }, (_, i) => serviceDate(nowMs - (i + 1) * DAY_MS))
        .filter((date) => !days.some((d) => d.date === date))
        .map(async (date) => ({ date, status: await recorderStatus(env, date) })),
    );
    for (const { date, status: s } of held) if (s && s.samples > 0) days.push({ date, closed: false, bytes: null, samples: s.samples });
    days.sort((a, b) => b.date.localeCompare(a.date));
    return json({
      days,
      recording: { date: today, enabled: await timelapseEnabled(env), state: status?.state ?? 'idle', samples: status?.samples ?? 0 },
    });
  }

  const date = DAY_PATH.exec(url.pathname)?.[1];
  if (!date) return json({ error: 'not found' }, 404);
  const stored = await env.FILES.get(dayKey(date));
  if (stored) {
    return new Response(stored.body, {
      headers: { 'content-type': 'application/gzip', 'cache-control': 'private, max-age=31536000, immutable', etag: stored.httpEtag },
    });
  }
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
