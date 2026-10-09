/**
 * The trip engine: what state today's trip is in, the same on every device.
 *
 *   idle → due → heading → waiting → riding → arrived
 *                 └──────────┴──→ missed → (replanned) → due
 *            └──→ skipped
 *
 * The phase is worked out on each request from the answer (its leave-by
 * time, whether you're at the stop or already there) and what the day's
 * signals say: "On the D2", "Missed it", "Not going", "I'm there", a
 * location. The signals live in a Durable Object per user (`Trip`, keyed by
 * user id), so a tap on the phone changes the Mac's menu bar too. It holds
 * only today's signals, never a location, and deletes them at the end of the
 * day with an alarm. An idle object costs nothing.
 */

import type { Env, Leave, MeAnswer } from './types.ts';
import { haversineM } from './geo.ts';
import { MAX_FIX_ACC_M, WALK, sgt } from './config.ts';
import { sgtDate } from './calendar.ts';
import { GRAPH } from './graph.ts';
import { headwayFor, indexGraph, rideSpan, rideStops } from './resolve.ts';
import { shapeFor } from './campus.ts';
import { alongNear } from './buses.ts';
import { isoSeconds, shortStop } from './format.ts';

export type Phase = 'idle' | 'due' | 'heading' | 'waiting' | 'riding' | 'missed' | 'arrived';

/** What a client can send to /me/signal. */
export const SIGNALS = ['boarded', 'missed', 'skipped', 'left', 'arrived', 'location', 'reset', 'away', 'back'] as const;
export type SignalKind = (typeof SIGNALS)[number];

/** The bus you said you're on, as the answer had it when you said so. */
export interface Boarded {
  svc: string;
  stop: string;
  /** ISO: when it left, and when it gets you there. */
  board: string | null;
  /** ISO: the leave-by time that went with it. From then on the trip is
   *  about this bus, whatever later answers suggest (see next.ts). */
  leave?: string;
  /** Planned from the device's location, not from where the timetable puts
   *  you. A plan without one never replaces a plan with one. */
  located?: boolean;
  arrive: string | null;
  /** The leave-by's own reason and whether it's a timetable estimate, so a
   *  plan shown again (see `leaveOf`) reads as it did when it was made. */
  note?: string;
  estimated?: boolean;
  off?: string;
  /** Seconds on foot to the stop and on the bus, for the card's journey. */
  walkS?: number;
  rideS?: number;
  /** Stop codes, and the bus's plate when the feed had one at the tap: its
   *  arrival at `alightCode` is then read from the feed while you ride. */
  stopCode?: string;
  alightCode?: string;
  plate?: string;
  /** A public bus, with a fare, and the graph's route for it when its number
   *  can't name it (`151/1`). */
  paid?: true;
  route?: string;
  /** Seen riding it: a location on its road, further on than you could have
   *  walked since it left (seenOnBus). Devices without a location then take
   *  you to be on it too. */
  seen?: true;
  /**
   * A trip that changes buses: the second bus, its `stopCode` where it goes
   * from (`alightCode` above, or the stop across the road from it, `crossS`
   * further) and its `arrive` the end of the trip. The fields above are then
   * the first bus alone, `arrive` and `alightCode` at the change.
   */
  change?: Boarded;
  /** On a trip's second bus: seconds across the road to its stop from where the first drops you. */
  crossS?: number;
}

/** A trip home (after the last class, or in a long gap), by its key: it has no name of its own. */
export function isHomeKey(key: string): boolean {
  return key.startsWith('home:') || key.startsWith('gap-home:');
}

/**
 * A plan as a leave-by again: what every device shows once one device's plan
 * is the trip's (see next.ts), instead of each working out its own bus.
 */
export function leaveOf(b: Boarded): Leave {
  const c = b.change;
  if (c) {
    // The first bus to catch, the trip's end where the second gets you.
    const end = leaveOf(c);
    return {
      ...leaveOf({ ...b, change: undefined }),
      arrive: c.arrive,
      ...(end.off ? { off: end.off } : {}),
      ...(end.offCode ? { offCode: end.offCode } : {}),
      ...(end.toStop ? { toStop: end.toStop } : {}),
      change: {
        svc: c.svc,
        from: offStop(b) ?? b.stop,
        fromCode: b.alightCode ?? '',
        stop: c.stop,
        stopCode: c.stopCode ?? '',
        ...(c.crossS ? { crossS: c.crossS } : {}),
        reach: b.arrive,
        board: c.board,
        rideS: c.rideS ?? 0,
        estimated: c.estimated === true,
      },
    };
  }
  return {
    at: b.leave ?? b.board ?? new Date(0).toISOString(),
    estimated: b.estimated === true,
    svc: b.svc,
    stop: b.stop,
    board: b.board,
    arrive: b.arrive,
    note: b.note ?? null,
    ...(b.off ? { off: b.off } : {}),
    ...(b.stopCode ? { stopCode: b.stopCode } : {}),
    ...(b.alightCode ? { offCode: b.alightCode } : {}),
    ...(b.walkS != null ? { walkS: b.walkS } : {}),
    ...(b.rideS != null ? { rideS: b.rideS } : {}),
    ...(offStop(b) ? { toStop: offStop(b)! } : {}),
    ...(b.paid ? { paid: true as const } : {}),
    ...(b.route ? { route: b.route } : {}),
  };
}

/**
 * Where you get off the bus you're on: across the road when the plan said so,
 * else the stop it drops you at ("UTown"), never the class ("GEA1000 @ UTown").
 */
export function offStop(b: Boarded): string | null {
  if (b.off) return b.off;
  const s = b.alightCode ? indexGraph(GRAPH).byCode.get(b.alightCode) : undefined;
  return s ? shortStop(s.name) : null;
}

/** When the trip ends, the second bus's arrival on a trip that changes buses. */
export const tripEnd = (b: Boarded): string | null => (b.change ? b.change.arrive : b.arrive);

/**
 * The bus a leave-by's change of buses goes on to, as a plan's second bus
 * (Boarded.change): to `alightCode`, the trip's end, unless the leave-by
 * names where it gets you off.
 */
export function secondBusOf(l: Pick<Leave, 'change' | 'arrive' | 'off' | 'offCode' | 'toCode'>, alightCode: string): Boarded | undefined {
  const c = l.change;
  if (!c) return undefined;
  return {
    svc: c.svc,
    stop: c.stop,
    board: c.board,
    arrive: l.arrive,
    ...(c.estimated ? { estimated: true } : {}),
    ...(l.off ? { off: l.off } : {}),
    stopCode: c.stopCode,
    rideS: c.rideS,
    alightCode: l.offCode ?? l.toCode ?? alightCode,
    ...(c.crossS ? { crossS: c.crossS } : {}),
  };
}

/**
 * The second bus when you board a later first bus than planned (`shiftMs`
 * after it): if that gets you to the change (`reach`, as planned) after the
 * planned second bus, that one has gone, so a guess from when you get there,
 * a bus within a headway, and the trip's end moved with it.
 */
export function laterChange(c: Boarded | undefined, reach: string | null | undefined, shiftMs: number): Boarded | undefined {
  if (!c?.board || !reach || shiftMs <= 0) return c;
  const there = Date.parse(reach) + shiftMs;
  const by = there - Date.parse(c.board);
  if (by <= 0) return c;
  return { ...c, board: isoSeconds(there), ...(c.arrive ? { arrive: isoSeconds(Date.parse(c.arrive) + by) } : {}), estimated: true };
}

/** How long after the second bus's time it's taken to have left with you on it. */
export const CHANGE_GRACE_MS = 30_000;

/**
 * The latest the second bus of a trip that changes buses can leave: its
 * time, or a headway after it when that time is only a guess (there by
 * then, and a bus within a headway).
 */
export function secondLeavesMs(c: Boarded): number | null {
  if (!c.board) return null;
  const at = Date.parse(c.board);
  return c.estimated ? at + Math.max(60, headwayFor(GRAPH, c.svc)) * 1000 : at;
}

/**
 * Where a trip that changes buses is: on the first bus until it gets to the
 * change (`first`), at the change stop until the second bus has left
 * (`change`), then on the second. A trip on one bus is always `first`.
 * `firstLate`: the feed still has the first bus on its way to the change.
 * The second bus's time should be the feed's where it has one (secondBus in
 * next.ts), so a bus still due there keeps you at the change.
 */
export function rideStage(b: Boarded, nowMs: number, firstLate = false): 'first' | 'change' | 'second' {
  if (!b.change) return 'first';
  if (firstLate || !b.arrive || nowMs < Date.parse(b.arrive)) return 'first';
  const leaves = secondLeavesMs(b.change);
  if (leaves === null || nowMs < leaves + CHANGE_GRACE_MS) return 'change';
  return 'second';
}

/** The ride for a progress bar: the stops from boarding to getting off, and the times. */
export interface Ride {
  svc: string;
  stops: Array<{ code: string; name: string }>;
  board: string;
  arrive: string;
  /** On the first bus of a trip that changes buses: the bus to change to,
   *  and "Then P at 9:15 from Kent Vale". The stops above end at the change. */
  change?: { svc: string; color: string; stop: string; board: string | null; text: string };
}

/** The ride on the bus you're on, when its stops are known. */
export function rideOf(b: Boarded): Ride | null {
  if (!b.stopCode || !b.alightCode || !b.board || !b.arrive) return null;
  const idx = indexGraph(GRAPH);
  const codes = rideStops(idx, b.svc, b.stopCode, b.alightCode);
  if (!codes || codes.length < 2) return null;
  return {
    svc: b.svc,
    stops: codes.map((code) => ({ code, name: shortStop(idx.byCode.get(code)?.name ?? code) })),
    board: b.board,
    arrive: b.arrive,
  };
}

/**
 * Whether a location shows you on the bus `b`: on its road between where
 * you board and where you get off, and further from the stop than you could
 * have walked since it left (with a rough fix's error to spare), by road or
 * straight there. Anywhere short of that says nothing: you may have missed
 * it and set off on foot. Where the road runs both ways (or the line passes
 * the same place twice), no place on the line the fix could be may be
 * within that walk. Shuttles only: public buses have no road line here.
 */
export function seenOnBus(b: Boarded, lat: number, lon: number, nowMs: number): boolean {
  if (!b.board || !b.stopCode || !b.alightCode || b.paid) return false;
  const idx = indexGraph(GRAPH);
  const r = idx.routes.get(b.svc);
  const stop = idx.byCode.get(b.stopCode);
  const span = rideSpan(idx, b.svc, b.stopCode, b.alightCode);
  const shape = shapeFor(b.svc, GRAPH.routes?.[b.svc] ?? []);
  if (!r || !stop || !span || span.hops === 0 || !shape) return false;
  const walked = (WALK_MAX_MS * Math.max(0, nowMs - Date.parse(b.board))) / 1000 + MAX_FIX_ACC_M;
  if (haversineM(lat, lon, stop.lat, stop.lon) <= walked) return false;
  const start = shape.at[span.i];
  // A loop's line closes at its first stop, so it can be measured round past it.
  const lap = r.loop ? shape.at[r.seq.length] : undefined;
  const end = span.i + span.hops;
  const rideM = end < shape.at.length ? shape.at[end] - start : lap !== undefined ? lap - start + shape.at[end - r.seq.length] : null;
  if (rideM === null) return false;
  // Metres on from the stop, and back before it, to `m` along the line.
  const ahead = (m: number) => (m >= start ? m - start : lap !== undefined ? lap - start + m : Infinity);
  const behind = (m: number) => (m <= start ? start - m : lap !== undefined ? start + lap - m : Infinity);
  const near = alongNear(shape, lat, lon, ON_RIDE_M);
  if (near.some((m) => ahead(m) <= walked || behind(m) <= walked)) return false;
  return near.some((m) => ahead(m) <= rideM);
}

/** The latest signal about one trip today. */
export interface TripRecord {
  kind: Exclude<SignalKind, 'location' | 'reset' | 'away' | 'back'>;
  at: number;
  /** Skipped by "Not on campus today" (phase 8.3); "Back on campus" undoes all of them. */
  away?: boolean;
  /** The trip's name, for "Undo: going to CS2030". */
  label?: string;
  boarded?: Boarded;
  /** The departure you missed, ISO. */
  missed?: string | null;
}

/** Today's signals, by trip key (classKey, or home:<minutes>). */
export interface DayRecord {
  date: string;
  trips: Record<string, TripRecord>;
  /** The bus each trip's plan said to catch, kept from when the trip was due
   *  and frozen once it left, so a trip taken to be on that bus ("On the
   *  D2") stays about it after the answer has moved on to the next one. */
  plans?: Record<string, Boarded>;
  /** When the object next wakes to push (epoch ms), or absent when it
   *  won't: the Worker asks again only when that would be sooner
   *  (needsWatch). Push only. */
  watch?: number;
}

/**
 * Whether a request should ask the Trip object to wake at `atMs`: when it
 * isn't going to wake at all, or would wake any later than `atMs`. Even a
 * few seconds count: the leave-by's push has only WALK.boardBufferS to
 * spare. A later or equal `atMs` needs nothing: the object works out the
 * card afresh when it wakes, and wakes again at that card's own next change.
 */
export function needsWatch(day: DayRecord | null, atMs: number, nowMs: number): boolean {
  const w = day?.watch;
  return w === undefined || w <= nowMs || atMs < w;
}

/** Changes to today's record, any of them in one request (see updateTrip). */
export interface TripUpdate {
  date: string;
  /** The next Singapore midnight, when everything goes. */
  deleteAt: number;
  /** Trip records; null deletes one. */
  items?: Array<{ key: string; rec: TripRecord | null }>;
  plans?: Record<string, Boarded>;
  /** Wake at `at` (no later than a wake already pending) to push the card. */
  watch?: { userId: string; at: number };
}

/** Heads-up window: the trip is "due" this long before its leave-by. */
export const DUE_MS = 5 * 60_000;
/** At the stop this long before the leave-by counts as waiting for the bus. */
export const WAIT_EARLY_MS = 15 * 60_000;
/** Close enough to the boarding stop to be waiting at it. */
export const AT_STOP_M = 80;
/** After the bus you're on should have got you there, you're taken to be there. */
export const RIDE_GRACE_MS = 10 * 60_000;
/** Nobody said otherwise this long after the bus left: where you are says
 *  whether you're on it (seenOnBus), or the answer is the next way there. */
export const ASSUME_MS = 3 * 60_000;
/** A location this close to the ride's road is on it: a phone's fix on a
 *  moving bus, plus the line's own error. */
export const ON_RIDE_M = 60;
/** Faster than anyone walks (WALK.speedMs is an average pace). */
const WALK_MAX_MS = WALK.speedMs * 1.5;
/** A plate is picked at the tap only from a bus due at the stop within this. */
export const PLATE_WINDOW_S = 5 * 60;

// The Singapore day a signal belongs to ("2026-09-30"), as calendar.ts has it.
export { sgtDate };

/** Next Singapore midnight, epoch ms: when the day's signals are deleted. */
export function endOfDayMs(nowMs: number): number {
  return nowMs - (sgt(nowMs).minutes * 60_000 + (nowMs % 60_000)) + 86_400_000;
}

/** The trip's record as the planner reads it. */
export function signalOf(day: DayRecord | null, key: string): TripRecord | undefined {
  return day?.trips[key];
}

/** Keys reached or skipped today, for the planner. */
export function dayState(day: DayRecord | null): { skipped: Set<string>; done: Set<string>; missed: Set<string>; away: boolean } {
  const skipped = new Set<string>();
  const done = new Set<string>();
  const missed = new Set<string>();
  let away = false;
  for (const [k, r] of Object.entries(day?.trips ?? {})) {
    if (r.kind === 'skipped') skipped.add(k);
    if (r.kind === 'arrived') done.add(k);
    if (r.kind === 'missed') missed.add(k);
    if (r.away) away = true;
  }
  return { skipped, done, missed, away };
}

/**
 * The phase of a planned trip, from its answer and the latest signal. A
 * signal wins over the clock: once you say you're on the bus, it doesn't
 * matter that the leave-by passed.
 */
export function phaseFor(a: MeAnswer, rec: TripRecord | undefined, nowMs: number, at: { lat: number | null; lon: number | null }): Phase {
  if (a.arrived) return 'arrived';
  if (rec?.kind === 'boarded') return 'riding';
  if (rec?.kind === 'missed') return 'missed';
  if (rec?.kind === 'arrived') return 'arrived';
  const leaveAt = a.leave?.at ? Date.parse(a.leave.at) : null;
  // At the plan's boarding stop from a little before the leave-by: waiting,
  // whatever the clock says. Not hours before it (you may live by that
  // stop), and not at any other stop (riding past one is not waiting at it).
  const code = a.leave?.stopCode ?? a.stop.code;
  if (at.lat !== null && at.lon !== null && code && a.leave?.svc && (leaveAt === null || nowMs >= leaveAt - WAIT_EARLY_MS)) {
    const s = indexGraph(GRAPH).byCode.get(code);
    if (s && haversineM(at.lat, at.lon, s.lat, s.lon) <= AT_STOP_M) return 'waiting';
  }
  if (rec?.kind === 'left') return 'heading';
  if (leaveAt === null) return 'idle';
  if (nowMs >= leaveAt) return 'heading';
  if (nowMs >= leaveAt - DUE_MS) return 'due';
  return 'idle';
}

/* ------------------------------------------------------------------ */
/* Talking to the Durable Object                                      */
/* ------------------------------------------------------------------ */

function stub(env: Env, userId: string): DurableObjectStub | null {
  if (!env.TRIPS) return null;
  // Its users are in Singapore, like the timelapse recorder's.
  return env.TRIPS.get(env.TRIPS.idFromName(userId), { locationHint: 'apac' });
}

/**
 * How long a call to the Trip object may take. It answers in milliseconds;
 * one that's stuck (a busy or restarting object) mustn't hold up the card,
 * which works without it.
 */
export const TRIP_TIMEOUT_MS = 3_000;

/** The Trip object's answer, or a thrown error once it's taken too long. */
function ask(s: DurableObjectStub, path: string, init?: RequestInit): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('trip object timed out')), TRIP_TIMEOUT_MS);
  });
  return Promise.race([s.fetch(`https://trip/${path}`, init), late]).finally(() => timer && clearTimeout(timer));
}

/** A change sent to the Trip object (tripdo.ts), as JSON. */
function post(s: DurableObjectStub, path: string, body: unknown): Promise<Response> {
  return ask(s, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Today's signals, or null when there are none (or no Durable Object binding). */
export async function loadDay(env: Env, userId: string, nowMs: number): Promise<DayRecord | null> {
  const s = stub(env, userId);
  if (!s) return null;
  try {
    const res = await ask(s, `day?date=${sgtDate(nowMs)}`);
    if (!res.ok) return null;
    const day = (await res.json()) as DayRecord | null;
    return day && (Object.keys(day.trips).length || Object.keys(day.plans ?? {}).length || day.watch) ? day : null;
  } catch (err) {
    // The answer works without trip state; a failure only loses the phase.
    console.error('trip state unavailable', err instanceof Error ? err.name : typeof err);
    return null;
  }
}

/**
 * Sends any of today's changes to the Trip object in one request, and
 * answers with the day as it then stands (null without the binding).
 */
export async function updateTrip(env: Env, userId: string, u: Omit<TripUpdate, 'date' | 'deleteAt'>, nowMs: number): Promise<DayRecord | null> {
  const s = stub(env, userId);
  if (!s) return null;
  const res = await post(s, 'update', { ...u, date: sgtDate(nowMs), deleteAt: endOfDayMs(nowMs) } satisfies TripUpdate);
  if (!res.ok) throw new Error(`trip update failed: ${res.status}`);
  return (await res.json()) as DayRecord;
}

/** Several trips' records in one call to the Trip object (null deletes one). */
export async function saveSignals(env: Env, userId: string, items: { key: string; rec: TripRecord | null }[], nowMs: number): Promise<DayRecord | null> {
  return updateTrip(env, userId, { items }, nowMs);
}

/**
 * Empties a user's trip state at once, for an account that's being deleted
 * (it would otherwise go at midnight), and stops anything storing it again
 * today (tripdo.ts). Tried twice; a failure is then logged, not thrown: the
 * account still goes, and the state still expires with the day.
 */
export async function clearTrip(env: Env, userId: string): Promise<void> {
  const s = stub(env, userId);
  if (!s) return;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await ask(s, 'clear', { method: 'POST' });
      if (!res.ok) throw new Error(`status ${res.status}`);
      return;
    } catch (err) {
      if (attempt < 2) continue;
      console.error('trip state not cleared', err instanceof Error ? err.message : typeof err);
      return;
    }
  }
}

/**
 * Asks the user's Trip object to wake at `atMs` (the card's nextChangeAt),
 * work out the card again and push it if it changed. Push only. Never
 * throws; false (logged) when the object didn't take it, so the cron can
 * ask again.
 */
export async function watchTrip(env: Env, userId: string, atMs: number, nowMs: number): Promise<boolean> {
  try {
    await updateTrip(env, userId, { watch: { userId, at: atMs } }, nowMs);
    return true;
  } catch (err) {
    console.error('trip watch failed', err instanceof Error ? err.message : typeof err);
    return false;
  }
}
