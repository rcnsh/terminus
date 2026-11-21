import type { Env } from '../types.ts';
import { TIMELAPSE } from '../config.ts';
import { scopeCache } from '../feeds/edgecache.ts';
import { GRAPH } from '../answer/graph.ts';
import { breakerOpen, getBuses } from '../feeds/fms.ts';
import { placeBuses, type Track } from './buses.ts';
import { inService } from '../answer/hours.ts';
import { logPoll } from '../ops/analytics.ts';
import { loadCalendar } from '../timetable/calendarsync.ts';
import {
  buildDayFile,
  dayKey,
  encodeBus,
  gzip,
  HELD_DAYS,
  lineKeys,
  mapSnapshot,
  pollInterval,
  timelapseEnabled,
  windowOf,
} from './timelapse.ts';
import type { DayFile, RecorderStatus, Row } from './timelapse.ts';

type State = 'polling' | 'resting' | 'off' | 'done';

interface Meta {
  date: string;
  t0: number;
  lastT: number;
  state: State;
  round: { list: string[]; start: number; i: number; buses: number; answered: number; closed?: number } | null;
  idle: number;
  seen: boolean;
  last: Record<string, number>;
  plates: string[];
  pollMs: number;
  asked?: Record<string, number>;
  failing?: number;
  lines: Record<string, string>;
  samples?: number;
}

export const backoffOf = (failing: number): number => 2 ** Math.min(Math.max(0, failing), 3);

const RETRY_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

export class TimelapseRecorder {
  private readonly state: DurableObjectState;
  private readonly storage: DurableObjectStorage;
  private readonly env: Env;
  private ready = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
    scopeCache(env);
  }

  private schema(): SqlStorage {
    const sql = this.storage.sql;
    if (!this.ready) {
      sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
      sql.exec(
        'CREATE TABLE IF NOT EXISTS samples (n INTEGER PRIMARY KEY AUTOINCREMENT, dt INTEGER NOT NULL, svc TEXT NOT NULL, buses TEXT NOT NULL)',
      );
      this.ready = true;
    }
    return sql;
  }

  private tables(): SqlStorage | null {
    const sql = this.storage.sql;
    if (!this.ready)
      this.ready =
        sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('meta', 'samples')").one().n ===
        2;
    return this.ready ? sql : null;
  }

  private read<T>(k: string): T | null {
    const row = this.tables()?.exec<{ v: string }>('SELECT v FROM meta WHERE k = ?', k).toArray()[0];
    return row ? (JSON.parse(row.v) as T) : null;
  }

  private write(k: string, v: unknown): void {
    this.schema().exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', k, JSON.stringify(v));
  }

  private count(): number {
    return this.tables()?.exec<{ n: number }>('SELECT COUNT(*) AS n FROM samples').one().n ?? 0;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const date = url.searchParams.get('date') ?? '';
    const meta = this.read<Meta>('meta');

    if (req.method === 'POST' && url.pathname === '/start') {
      return this.state.blockConcurrencyWhile(() => this.start(date));
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      const status: RecorderStatus = {
        date: meta?.date ?? null,
        samples: meta ? (meta.samples ?? this.count()) : 0,
        state: meta?.state ?? 'idle',
      };
      return Response.json(status);
    }
    if (req.method === 'GET' && url.pathname === '/day') {
      if (!meta || meta.date !== date) return new Response('not found', { status: 404 });
      return new Response(await gzip(JSON.stringify(this.dayFile(meta))), { headers: { 'content-type': 'application/gzip' } });
    }
    return new Response('not found', { status: 404 });
  }

  private async start(date: string): Promise<Response> {
    const now = Date.now();
    const { open, close } = windowOf(date);
    let meta = this.read<Meta>('meta');
    if (!meta) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || now >= close) return Response.json({ state: 'closed' });
      const map = mapSnapshot();
      meta = {
        date,
        t0: now,
        lastT: now,
        state: 'polling',
        round: null,
        idle: 0,
        seen: false,
        last: {},
        plates: [],
        pollMs: pollInterval(),
        asked: {},
        lines: lineKeys(map),
        samples: 0,
      };
      this.write('map', map);
      this.write('meta', meta);
      await this.storage.setAlarm(Math.max(now, open));
    } else if (meta.state === 'off' && (await timelapseEnabled(this.env))) {
      meta.state = 'polling';
      meta.round = null;
      this.write('meta', meta);
      await this.storage.setAlarm(now);
    } else if ((await this.storage.getAlarm()) === null) {
      await this.storage.setAlarm(now);
    }
    return Response.json({ state: meta.state });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const meta = this.read<Meta>('meta');
    if (!meta) return;
    await loadCalendar(this.env, now);
    const { close } = windowOf(meta.date);
    if (now >= close) return this.close(meta);
    if (meta.state === 'off' || meta.state === 'done') return this.storage.setAlarm(close);

    let round = meta.round;
    if (!round || round.i >= round.list.length) {
      if (round && (await this.idleAfter(meta, round, now))) return;
      if (!(await timelapseEnabled(this.env))) {
        meta.state = 'off';
        meta.round = null;
        this.write('meta', meta);
        return this.storage.setAlarm(close);
      }
      meta.pollMs = Math.max(meta.pollMs, pollInterval());
      round = {
        list: Object.keys(GRAPH.routes ?? {})
          .filter((svc) => inService(GRAPH, svc, now))
          .sort(),
        start: now,
        i: 0,
        buses: 0,
        answered: 0,
      };
      meta.state = 'polling';
      meta.round = round;
    }

    if (round.i < round.list.length) {
      const svc = round.list[round.i];
      const since = now - (meta.asked?.[svc] ?? -Infinity);
      if (since < meta.pollMs) {
        this.write('meta', meta);
        return this.storage.setAlarm(Math.min(close, now + meta.pollMs - since));
      }
      if (!inService(GRAPH, svc, now)) {
        round.closed = (round.closed ?? 0) + 1;
      } else {
        (meta.asked ??= {})[svc] = now;
        this.write('meta', meta);
        let buses: number | null = null;
        try {
          buses = await this.poll(meta, svc, now);
        } catch (err) {
          console.error('timelapse', svc, err instanceof Error ? err.message : String(err));
        }
        if (buses !== null) {
          round.buses += buses;
          round.answered++;
        }
      }
      round.i++;
    }
    if (round.i >= round.list.length) {
      const asked = round.list.length - (round.closed ?? 0);
      meta.failing = asked > 0 && round.answered === 0 ? (meta.failing ?? 0) + 1 : 0;
    }
    this.write('meta', meta);
    const slot = meta.pollMs / Math.max(1, round.list.length);
    const next = round.i < round.list.length ? round.start + round.i * slot : round.start + meta.pollMs * backoffOf(meta.failing ?? 0);
    await this.storage.setAlarm(Math.min(close, Math.max(next, now + slot)));
  }

  private async idleAfter(meta: Meta, round: NonNullable<Meta['round']>, now: number): Promise<boolean> {
    const idle = round.buses === 0 && round.answered === round.list.length - (round.closed ?? 0);
    meta.seen ||= round.buses > 0;
    meta.idle = idle ? meta.idle + 1 : 0;
    if (meta.idle < TIMELAPSE.idleRounds) return false;
    meta.idle = 0;
    meta.round = null;
    const running = Object.keys(GRAPH.routes ?? {}).some((svc) => inService(GRAPH, svc, now));
    const done = meta.seen && !running;
    meta.state = done ? 'done' : 'resting';
    this.write('meta', meta);
    const { close } = windowOf(meta.date);
    await this.storage.setAlarm(done ? close : Math.min(close, now + TIMELAPSE.idleSleepMs));
    return true;
  }

  private async poll(meta: Meta, svc: string, now: number): Promise<number | null> {
    const env = this.env;
    if (await breakerOpen(this.env)) {
      logPoll(env, 'skipped', svc, 0);
      return null;
    }
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    try {
      let calls = 0;
      const live = await getBuses(env, ctx, svc, now, () => void calls++).catch(() => null);
      const upstream = calls > 0;
      for (let i = 1; i < calls; i++) logPoll(env, 'retry', svc, 0);
      if (!live) {
        logPoll(env, upstream ? 'error' : 'failed', svc, 0);
        return null;
      }
      if (live.stale || live.fetchedAt <= (meta.last[svc] ?? 0)) {
        logPoll(env, live.stale ? (upstream ? 'error' : 'stale') : 'hit', svc, 0);
        return live.stale ? null : live.buses.length;
      }
      logPoll(env, upstream ? 'upstream' : 'hit', svc, live.buses.length);
      const tracksKey = `tracks:${svc}`;
      const placed = await placeBuses(GRAPH, svc, live.buses, live.fetchedAt, this.read<Record<string, Track>>(tracksKey) ?? {});
      const sameLine = meta.lines[svc] === lineKeys(null)[svc];
      const along = new Map(sameLine ? placed.buses.map((b) => [b.plate, placed.tracks[b.id]?.along ?? null]) : []);
      const buses: number[] = [];
      for (const b of live.buses) {
        let p = meta.plates.indexOf(b.plate);
        if (p < 0) p = meta.plates.push(b.plate) - 1;
        buses.push(...encodeBus({ plate: b.plate, lat: b.lat, lon: b.lon, along: along.get(b.plate) ?? null }, p));
      }
      const dt = live.fetchedAt - meta.lastT;
      const samples = meta.samples === undefined ? this.count() + 1 : meta.samples + 1;
      const next: Meta = { ...meta, lastT: live.fetchedAt, last: { ...meta.last, [svc]: live.fetchedAt }, samples };
      this.storage.transactionSync(() => {
        this.schema().exec('INSERT INTO samples (dt, svc, buses) VALUES (?, ?, ?)', dt, svc, JSON.stringify(buses));
        this.write('meta', next);
        this.write(tracksKey, placed.tracks);
      });
      meta.lastT = next.lastT;
      meta.last = next.last;
      meta.samples = samples;
      return live.buses.length;
    } finally {
      await Promise.allSettled(pending);
    }
  }

  private dayFile(meta: Meta): DayFile {
    const rows = this.schema()
      .exec<{ dt: number; svc: string; buses: string }>('SELECT dt, svc, buses FROM samples ORDER BY n')
      .toArray()
      .map((r): Row => ({ dt: r.dt, svc: r.svc, buses: JSON.parse(r.buses) as number[] }));
    return buildDayFile({
      date: meta.date,
      t0: meta.t0,
      pollMs: meta.pollMs,
      plates: meta.plates,
      rows,
      map: this.read<DayFile>('map') ?? mapSnapshot(),
    });
  }

  private async close(meta: Meta): Promise<void> {
    try {
      const samples = this.count();
      if (samples > 0) {
        if (!this.env.FILES) throw new Error('no FILES bucket');
        const body = await gzip(JSON.stringify(this.dayFile(meta)));
        await this.env.FILES.put(dayKey(meta.date), body, {
          httpMetadata: { contentType: 'application/gzip' },
          customMetadata: { samples: String(samples) },
        });
      }
      await this.storage.deleteAlarm();
      await this.storage.deleteAll();
    } catch (err) {
      console.error('timelapse', meta.date, err instanceof Error ? err.message : String(err));
      const now = Date.now();
      if (now < windowOf(meta.date).close + HELD_DAYS * DAY_MS) return this.storage.setAlarm(now + RETRY_MS);
      console.error('timelapse', meta.date, 'given up: not written to R2');
      await this.storage.deleteAlarm();
      await this.storage.deleteAll();
    }
    this.ready = false;
  }
}
