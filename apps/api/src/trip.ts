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
import { sgt } from './config.ts';
import { sgtDate } from './calendar.ts';
import { GRAPH } from './graph.ts';
import { indexGraph, rideStops } from './resolve.ts';
import { shortStop } from './format.ts';

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
  /** ISO: when the bus left, estimated from the fix that noticed you on it
   *  (detect.ts). Only for measuring the ride (ridetimes.ts). */
  departed?: string;
  /** A public bus, with a fare, and the graph's route for it when its number
   *  can't name it (`151/1`); detection follows it in the public graph. */
  paid?: true;
  route?: string;
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

/** The ride for a progress bar: the stops from boarding to getting off, and the times. */
export interface Ride {
  svc: string;
  stops: Array<{ code: string; name: string }>;
  board: string;
  arrive: string;
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

/** The latest signal about one trip today. */
export interface TripRecord {
  kind: Exclude<SignalKind, 'location' | 'reset' | 'away' | 'back'> | 'waiting';
  at: number;
  /** Worked out from the phone's location, not tapped (phase 8.1). */
  detected?: boolean;
  /** A detected miss at the boarding stop, rather than at home. */
  atStop?: boolean;
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
   *  and frozen once it left, so "On the 9:41 D2?" is still about that bus
   *  after the answer has moved on to the next one. */
  plans?: Record<string, Boarded>;
  /** When the phone last sent a location during a trip (epoch ms, kept to the
   *  minute): while it's recent, the trip is being followed and nobody is
   *  asked what happened (card.ts). Never where. */
  followed?: number;
  /** When the object was last asked to wake (the card's nextChangeAt, epoch
   *  ms), so the Worker only asks again when that changes. Push only. */
  watch?: number;
}

/** A trip is being followed by location while its last fix is this recent (fixes come every 20 s). */
export const FOLLOWED_MS = 90_000;

/** Whether the phone is following today's trip by location right now. */
export function isFollowed(day: DayRecord | null, nowMs: number): boolean {
  return day?.followed !== undefined && nowMs - day.followed < FOLLOWED_MS && nowMs >= day.followed - 60_000;
}

/** Heads-up window: the trip is "due" this long before its leave-by. */
export const DUE_MS = 5 * 60_000;
/** At the stop this long before the leave-by counts as waiting for the bus. */
export const WAIT_EARLY_MS = 15 * 60_000;
/** Close enough to the boarding stop to be waiting at it. */
export const AT_STOP_M = 80;
/** After the bus you're on should have got you there, you're taken to be there. */
export const RIDE_GRACE_MS = 10 * 60_000;
/** Nobody said otherwise this long after the bus left: you're taken to be on it. */
export const ASSUME_MS = 3 * 60_000;
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
  if (rec?.kind === 'waiting') return 'waiting';
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
  return env.TRIPS.get(env.TRIPS.idFromName(userId));
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
    return day && (Object.keys(day.trips).length || Object.keys(day.plans ?? {}).length || day.watch || day.followed) ? day : null;
  } catch (err) {
    // The answer works without trip state; a failure only loses the phase.
    console.error('trip state unavailable', err instanceof Error ? err.name : typeof err);
    return null;
  }
}

/** Remembers the bus a trip's plan says to catch (see DayRecord.plans). */
export async function savePlan(env: Env, userId: string, key: string, plan: Boarded, nowMs: number): Promise<void> {
  const s = stub(env, userId);
  if (!s) return;
  try {
    const res = await post(s, 'plan', { date: sgtDate(nowMs), key, plan, deleteAt: endOfDayMs(nowMs) });
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (err) {
    // Only the question at departure depends on it.
    console.error('trip plan not saved', err instanceof Error ? err.message : typeof err);
  }
}

/** Records a signal for one trip today; `null` clears that trip ("reset"). */
export async function saveSignal(env: Env, userId: string, key: string, rec: TripRecord | null, nowMs: number): Promise<DayRecord | null> {
  return saveSignals(env, userId, [{ key, rec }], nowMs);
}

/** Several trips' records in one call to the Trip object (null deletes one). */
export async function saveSignals(env: Env, userId: string, items: { key: string; rec: TripRecord | null }[], nowMs: number): Promise<DayRecord | null> {
  const s = stub(env, userId);
  if (!s) return null;
  const res = await post(s, 'signal', { date: sgtDate(nowMs), items, deleteAt: endOfDayMs(nowMs) });
  if (!res.ok) throw new Error(`trip signal failed: ${res.status}`);
  return (await res.json()) as DayRecord;
}

/** Notes that a location just came in for today's trip (see DayRecord.followed). */
export async function markFollowed(env: Env, userId: string, nowMs: number): Promise<DayRecord | null> {
  const s = stub(env, userId);
  if (!s) return null;
  const res = await post(s, 'followed', { date: sgtDate(nowMs), at: nowMs, deleteAt: endOfDayMs(nowMs) });
  if (!res.ok) throw new Error(`trip followed failed: ${res.status}`);
  return (await res.json()) as DayRecord;
}

/**
 * Empties a user's trip state at once, for an account that's being deleted
 * (it would otherwise go at midnight). A failure is logged, not thrown: the
 * account still goes, and the state still expires with the day.
 */
export async function clearTrip(env: Env, userId: string): Promise<void> {
  const s = stub(env, userId);
  if (!s) return;
  try {
    const res = await ask(s, 'clear', { method: 'POST' });
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (err) {
    console.error('trip state not cleared', err instanceof Error ? err.message : typeof err);
  }
}

/**
 * Asks the user's Trip object to wake at `atMs` (the card's nextChangeAt),
 * work out the card again and push it if it changed. Push only. Never
 * throws; false (logged) when the object didn't take it, so the cron can
 * ask again.
 */
export async function watchTrip(env: Env, userId: string, atMs: number, nowMs: number): Promise<boolean> {
  const s = stub(env, userId);
  if (!s) return true;
  try {
    const res = await post(s, 'watch', { userId, date: sgtDate(nowMs), at: atMs, deleteAt: endOfDayMs(nowMs) });
    if (!res.ok) throw new Error(`status ${res.status}`);
    return true;
  } catch (err) {
    console.error('trip watch failed', err instanceof Error ? err.message : typeof err);
    return false;
  }
}
