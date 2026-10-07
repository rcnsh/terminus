/**
 * The `TimelapseRecorder` Durable Object: one per Singapore day (named by
 * its date), recording where every shuttle is while the day's window is
 * open (timelapse.ts has the rules it keeps to).
 *
 * Its alarm is its clock. Each round asks every service that's running for
 * its buses once, spread evenly across TIMELAPSE.pollMs: with eight
 * services and 30 s, one service every 3.75 s, never all at once. A round
 * with no bus anywhere counts towards idleness; after idleRounds of them it
 * stops for the day if it has seen buses and no service is still inside its
 * hours (service is over), or rests for idleSleepMs otherwise: before the
 * first bus of the morning, or a gap in the middle of the day (the feed
 * listing no buses for a few minutes), after which it asks again.
 *
 * When the window closes it writes the day to R2 and deletes everything,
 * its alarm included, so a finished day costs nothing.
 *
 * States: `polling`; `resting` (idle, asks again after idleSleepMs); `off`
 * (the kill switch, until the cron finds it on again); `done` (idle after
 * service, waiting to write the day at the close).
 */

import type { Env } from './types.ts';
import { TIMELAPSE } from './config.ts';
import { scopeCache } from './edgecache.ts';
import { GRAPH } from './graph.ts';
import { breakerOpen, getBuses } from './fms.ts';
import { trackedPlacement } from './buses.ts';
import { inService } from './resolve.ts';
import { logPoll } from './analytics.ts';
import { loadCalendar } from './calendarsync.ts';
import { buildDayFile, dayKey, encodeBus, gzip, lineKeys, mapSnapshot, pollInterval, timelapseEnabled, windowOf } from './timelapse.ts';
import type { DayFile, RecorderStatus, Row } from './timelapse.ts';

type State = 'polling' | 'resting' | 'off' | 'done';

interface Meta {
  date: string;
  /** Epoch ms the first sample's dt counts from. */
  t0: number;
  /** The time of the last stored sample, which the next one's dt counts from. */
  lastT: number;
  state: State;
  /** The round in progress: the services to ask, when it began, the next
   *  one, the buses seen, how many services answered, and how many closed
   *  for the day before their turn (not asked, and not expected to answer). */
  round: { list: string[]; start: number; i: number; buses: number; answered: number; closed?: number } | null;
  /** Rounds in a row with no bus on any service. */
  idle: number;
  /** Whether any bus has been seen today. */
  seen: boolean;
  /** Each service's last recorded reading (fetchedAt), so one is never kept twice. */
  last: Record<string, number>;
  plates: string[];
  pollMs: number;
  /** When each service was last asked for, whatever came of it: never again
   *  within pollMs, across rounds too (a round with fewer services in it has
   *  shorter slots). */
  asked?: Record<string, number>;
  /** Rounds in a row in which no service answered: the feed failing. */
  failing?: number;
  /** Each route line's fingerprint when the day began (lineKeys): a deploy
   *  that changes a line mid-day would measure `along` on a line the day
   *  doesn't have. */
  lines?: Record<string, string>;
}

/**
 * How many pollMs to wait for the next round after [failing] failed rounds
 * in a row: 1, 2, 4, then 8 (four minutes). The failure memo (failMemoS) is
 * shorter than a round, so it never quiets the recorder; without this, a
 * feed down all day would be asked at the full rate all day.
 */
export const backoffOf = (failing: number): number => 2 ** Math.min(Math.max(0, failing), 3);

/** After the day failed to reach R2, try again this much later. */
const RETRY_MS = 10 * 60_000;

export class TimelapseRecorder {
  private readonly state: DurableObjectState;
  private readonly storage: DurableObjectStorage;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
    scopeCache(env);
  }

  /** The tables, again after deleteAll() at the end of a day. */
  private schema(): SqlStorage {
    const sql = this.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS samples (n INTEGER PRIMARY KEY AUTOINCREMENT, dt INTEGER NOT NULL, svc TEXT NOT NULL, buses TEXT NOT NULL)');
    return sql;
  }

  /** Whether there are tables at all: a read mustn't create them, or asking
   *  about a day nobody recorded (/timelapse/days asks about a week of them)
   *  would leave storage behind that nothing ever deletes. */
  private hasTables(): boolean {
    return this.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0;
  }

  private read<T>(k: string): T | null {
    if (!this.hasTables()) return null;
    const row = this.schema().exec<{ v: string }>('SELECT v FROM meta WHERE k = ?', k).toArray()[0];
    return row ? (JSON.parse(row.v) as T) : null;
  }

  private write(k: string, v: unknown): void {
    this.schema().exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', k, JSON.stringify(v));
  }

  private count(): number {
    if (!this.hasTables()) return 0;
    return this.schema().exec<{ n: number }>('SELECT COUNT(*) AS n FROM samples').one().n;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const date = url.searchParams.get('date') ?? '';
    const meta = this.read<Meta>('meta');

    if (req.method === 'POST' && url.pathname === '/start') {
      return this.state.blockConcurrencyWhile(() => this.start(date));
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      const status: RecorderStatus = { date: meta?.date ?? null, samples: meta ? this.count() : 0, state: meta?.state ?? 'idle' };
      return Response.json(status);
    }
    if (req.method === 'GET' && url.pathname === '/day') {
      if (!meta || meta.date !== date) return new Response('not found', { status: 404 });
      return new Response(await gzip(JSON.stringify(this.dayFile(meta))), { headers: { 'content-type': 'application/gzip' } });
    }
    return new Response('not found', { status: 404 });
  }

  /** Starts day [date] if it hasn't, or again after the kill switch. Nothing otherwise. */
  private async start(date: string): Promise<Response> {
    const now = Date.now();
    const { open, close } = windowOf(date);
    let meta = this.read<Meta>('meta');
    if (!meta) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || now >= close) return Response.json({ state: 'closed' });
      const map = mapSnapshot();
      meta = { date, t0: now, lastT: now, state: 'polling', round: null, idle: 0, seen: false, last: {}, plates: [], pollMs: pollInterval(), asked: {}, lines: lineKeys(map) };
      // The lines the day's `along`s are measured on, kept with it.
      this.write('map', map);
      this.write('meta', meta);
      await this.storage.setAlarm(Math.max(now, open));
    } else if (meta.state === 'off' && (await timelapseEnabled(this.env))) {
      meta.state = 'polling';
      meta.round = null;
      this.write('meta', meta);
      await this.storage.setAlarm(now);
    } else if (meta.state === 'polling' && (await this.storage.getAlarm()) === null) {
      // Never stranded: a polling day always has its next alarm.
      await this.storage.setAlarm(now);
    }
    return Response.json({ state: meta.state });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const meta = this.read<Meta>('meta');
    if (!meta) return;
    // The calendar the rest of the Worker answers from: a public holiday
    // known only from KV runs Sunday hours, and services that aren't
    // running then mustn't be asked.
    await loadCalendar(this.env, now);
    const { close } = windowOf(meta.date);
    if (now >= close) return this.close(meta);
    if (meta.state === 'off' || meta.state === 'done') return this.storage.setAlarm(close);

    let round = meta.round;
    if (!round || round.i >= round.list.length) {
      if (round && (await this.idleAfter(meta, round, now))) return;
      // The switch is read once a round: off within pollMs of being turned off.
      if (!(await timelapseEnabled(this.env))) {
        meta.state = 'off';
        meta.round = null;
        this.write('meta', meta);
        return this.storage.setAlarm(close);
      }
      // A deploy since the day began may have added routes: the interval
      // they need to stay under the day's ceiling, from this round on.
      meta.pollMs = Math.max(meta.pollMs, pollInterval());
      // Only the services running now; none running is a round with no bus.
      round = { list: Object.keys(GRAPH.routes ?? {}).filter((svc) => inService(GRAPH, svc, now)).sort(), start: now, i: 0, buses: 0, answered: 0 };
      meta.state = 'polling';
      meta.round = round;
    }

    if (round.i < round.list.length) {
      const svc = round.list[round.i];
      const since = now - (meta.asked?.[svc] ?? -Infinity);
      if (since < meta.pollMs) {
        // Asked too recently (at the end of the last round, when it had more
        // services in it): this one waits its turn, and the rest with it.
        this.write('meta', meta);
        return this.storage.setAlarm(Math.min(close, now + meta.pollMs - since));
      }
      if (!inService(GRAPH, svc, now)) {
        // Closed since the round began: not asked, and not expected to answer.
        round.closed = (round.closed ?? 0) + 1;
      } else {
        (meta.asked ??= {})[svc] = now;
        // Kept before asking: an alarm that throws after the request is run
        // again by the platform within seconds, and must find it asked.
        this.write('meta', meta);
        let buses: number | null = null;
        try {
          buses = await this.poll(meta, svc, now);
        } catch (err) {
          // Something after the request failed (placing the buses, storage):
          // a failed poll, and on to the next service. Thrown, the alarm's
          // retries would find this service asked too recently and wait, so
          // one service failing every time would stop the round for good.
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
      // A round in which no service it asked answered: the feed is failing.
      const asked = round.list.length - (round.closed ?? 0);
      meta.failing = asked > 0 && round.answered === 0 ? (meta.failing ?? 0) + 1 : 0;
    }
    this.write('meta', meta);
    // The next service a slot later; after the last, the next round a whole
    // pollMs after this one began, or longer while the feed fails
    // (backoffOf). Never less than a slot after this poll: an alarm that ran
    // late moves the rest later rather than bunching them up, so no service
    // is asked twice within a round's length.
    const slot = meta.pollMs / Math.max(1, round.list.length);
    const next = round.i < round.list.length ? round.start + round.i * slot : round.start + meta.pollMs * backoffOf(meta.failing ?? 0);
    await this.storage.setAlarm(Math.min(close, Math.max(next, now + slot)));
  }

  /**
   * After [round]: whether it now stops (and has set its alarm for when it
   * wakes). Idle long enough, it's done for the day once it has seen buses
   * and none of the services is still inside its hours; otherwise it rests
   * and tries again later. With a service still running, no bus for a few
   * minutes is a gap, not the end of the day: ending there would lose the
   * rest of it, since nothing starts a done day again. Only a round in which every
   * running service answered counts as idle: with any of them failing (the
   * feed down, the breaker open, one service's calls refused), its buses
   * could be out there, and an outage mustn't end the day. Such a round
   * also resets the count, so the rounds that stop it are in a row.
   */
  private async idleAfter(meta: Meta, round: NonNullable<Meta['round']>, now: number): Promise<boolean> {
    const idle = round.buses === 0 && round.answered === round.list.length - (round.closed ?? 0);
    meta.seen ||= round.buses > 0;
    // Only empty rounds in a row count: one that couldn't confirm it starts again.
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

  /** Asks for [svc]'s buses once, through the map's own path, and keeps the
   *  reading. How many buses the feed reported; null when it didn't answer. */
  private async poll(meta: Meta, svc: string, now: number): Promise<number | null> {
    const env = this.env;
    // The breaker is open: NUS refused us a moment ago. Don't ask at all.
    if (await breakerOpen()) {
      logPoll(env, 'skipped', svc, 0);
      return null;
    }
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    try {
      // Every request to NUS this poll made: usually one, more with a retry.
      let calls = 0;
      const live = await getBuses(env, ctx, svc, now, () => void calls++).catch(() => null);
      const upstream = calls > 0;
      // Each request past the first is counted too, so the dashboard's total
      // is what NUS saw, not the polls.
      for (let i = 1; i < calls; i++) logPoll(env, 'retry', svc, 0);
      // A failed request that reached NUS still counts as a request (`error`).
      if (!live) {
        logPoll(env, upstream ? 'error' : 'failed', svc, 0);
        return null;
      }
      // An old answer served because the feed is failing isn't a new reading.
      if (live.stale || live.fetchedAt <= (meta.last[svc] ?? 0)) {
        logPoll(env, live.stale ? (upstream ? 'error' : 'stale') : 'hit', svc, 0);
        return live.stale ? null : live.buses.length;
      }
      logPoll(env, upstream ? 'upstream' : 'hit', svc, live.buses.length);
      // Placed as the map places them, so `along` is the bus's own place on its line.
      const placed = await trackedPlacement(GRAPH, svc, live, ctx);
      // Measured on today's line only: after a deploy that changed it, the
      // positions are kept and the metres along aren't (the replay leaves
      // those buses out rather than draw them in the wrong place).
      // A day begun before the fingerprints were kept: they're its saved map's.
      meta.lines ??= lineKeys(this.read<DayFile>('map') ?? mapSnapshot());
      const sameLine = meta.lines[svc] === lineKeys(null)[svc];
      const along = new Map(sameLine ? placed.buses.map((b) => [b.plate, placed.tracks[b.id]?.along ?? null]) : []);
      const buses: number[] = [];
      for (const b of live.buses) {
        let p = meta.plates.indexOf(b.plate);
        if (p < 0) p = meta.plates.push(b.plate) - 1;
        buses.push(...encodeBus({ plate: b.plate, lat: b.lat, lon: b.lon, along: along.get(b.plate) ?? null }, p));
      }
      // The row and the times that date it, saved together: a reset between
      // the two would skew every later row's dt or keep this reading twice.
      const dt = live.fetchedAt - meta.lastT;
      const next: Meta = { ...meta, lastT: live.fetchedAt, last: { ...meta.last, [svc]: live.fetchedAt } };
      this.storage.transactionSync(() => {
        this.schema().exec('INSERT INTO samples (dt, svc, buses) VALUES (?, ?, ?)', dt, svc, JSON.stringify(buses));
        this.write('meta', next);
      });
      meta.lastT = next.lastT;
      meta.last = next.last;
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
    return buildDayFile({ date: meta.date, t0: meta.t0, pollMs: meta.pollMs, plates: meta.plates, rows, map: this.read<DayFile>('map') ?? mapSnapshot() });
  }

  /** The window has closed: the day to R2, then nothing left here. */
  private async close(meta: Meta): Promise<void> {
    if (this.count() > 0) {
      try {
        if (!this.env.DOWNLOADS) throw new Error('no DOWNLOADS bucket');
        const body = await gzip(JSON.stringify(this.dayFile(meta)));
        await this.env.DOWNLOADS.put(dayKey(meta.date), body, { httpMetadata: { contentType: 'application/gzip' }, customMetadata: { samples: String(this.count()) } });
      } catch (err) {
        // Kept, and tried again: losing a day to one failed write would be a waste.
        console.error('timelapse', meta.date, err instanceof Error ? err.message : String(err));
        return this.storage.setAlarm(Date.now() + RETRY_MS);
      }
    }
    await this.storage.deleteAll();
  }
}
