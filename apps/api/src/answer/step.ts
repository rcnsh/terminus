/**
 * "Earlier bus" and "Later bus": the user steps from the bus the server
 * picked to the one before or after it, and the card follows. The server
 * still works out every bus; the client only sends back the one the card
 * offered (`Steps.earlier` or `later`). The choice is kept per trip for the
 * day in the Trip object (`DayRecord.steps`), so the leave reminder, the
 * widgets and every device follow it. See docs/adr/0013-step-between-buses.md.
 *
 * Buses are ordered by when you'd leave for them, and a step keeps the
 * arrival moving the same way: a later bus never gets you there sooner than
 * the one you're on, an earlier one never later. "Later" stops at
 * STEP.lateMaxS late for a class, or STEP.laterMaxS after the server's bus
 * on any other trip; "Earlier" at the first bus you can still catch.
 */

import type { Leave } from '../types.ts';
import { SAME_BUS_MS } from './plan.ts';
import { STEP } from '../config.ts';

/** A bus chosen for a trip: the service as the graph names it (`151/1`), its stop's code, and when it leaves it. */
export interface StepTarget {
  svc: string;
  stop: string;
  board: string;
}

/** The steps the card offers from the bus it shows. */
export interface Steps {
  /** The trip to send with a step (/api/me/step). */
  trip: string;
  /** The bus one step earlier or later, to send back as it is; null at the limit. */
  earlier: StepTarget | null;
  later: StepTarget | null;
  /** The bus is the user's choice, not the server's: "Best bus" puts it back. */
  moved: boolean;
}

/** A leave-by's bus as a step target; null when it's a walk. */
export function targetOf(l: Leave | null | undefined): StepTarget | null {
  return l?.svc && l.stopCode && l.board ? { svc: l.route ?? l.svc, stop: l.stopCode, board: l.board } : null;
}

/** A step target as the client sent it, checked; null when it isn't one. */
export function parseTarget(v: unknown): StepTarget | null {
  if (!v || typeof v !== 'object') return null;
  const { svc, stop, board } = v as Record<string, unknown>;
  const ok = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 40;
  if (!ok(svc) || !ok(stop) || !ok(board) || Number.isNaN(Date.parse(board))) return null;
  return { svc, stop, board: new Date(Date.parse(board)).toISOString().replace(/\.\d{3}Z$/, 'Z') };
}

const boardMs = (l: Leave) => Date.parse(l.board!);
const atMs = (l: Leave) => Date.parse(l.at);
const arriveMs = (l: Leave) => Date.parse(l.arrive!);
const isService = (l: Leave, t: StepTarget) => (l.route ?? l.svc) === t.svc && l.stopCode === t.stop;

/** The same service from the same stop within SAME_BUS_MS: the feed moved its time a little. */
export const sameAs = (l: Leave, t: StepTarget) => isService(l, t) && Math.abs(boardMs(l) - Date.parse(t.board)) <= SAME_BUS_MS;

/**
 * The bus a target stands for now: the same bus, its time as the feed has
 * it now; when the feed no longer lists it, the next of that service from
 * that stop, never an earlier one. Null when it leaves before any bus of
 * that service you can still catch: you didn't set off for it, and the
 * choice lapses rather than sliding on to ever later buses.
 */
export function findTarget(all: Leave[], t: StepTarget): Leave | null {
  const at = Date.parse(t.board);
  const mine = all.filter((l) => l.board && isService(l, t)).sort((a, b) => boardMs(a) - boardMs(b));
  const same = mine.filter((l) => sameAs(l, t)).sort((a, b) => Math.abs(boardMs(a) - at) - Math.abs(boardMs(b) - at))[0];
  if (same) return same;
  if (!mine.length || at < boardMs(mine[0]) - SAME_BUS_MS) return null;
  return mine.find((l) => boardMs(l) >= at) ?? null;
}

export interface StepInput {
  /** The trip's key, for the card's steps. */
  trip: string;
  /** The server's own bus for the trip; null when it's a walk or nothing runs. */
  own: Leave | null;
  /** Every bus that gets you there (leave.ts `departures`). */
  all: Leave[];
  /** The bus the user chose for this trip, if any. */
  target: StepTarget | null;
  /** A class: the latest arrival "Later" may offer. Null for any other trip. */
  lastArriveMs: number | null;
  nowMs: number;
}

/**
 * The bus to show, and the steps from it: the user's chosen bus while it's
 * still to come, else the server's own. Null without a bus to step from.
 */
export function stepFrom(f: StepInput): { leave: Leave; steps: Steps } | null {
  // A chosen bus that has left is no longer a choice: the trip follows its plan from there.
  const target = f.target && Date.parse(f.target.board) > f.nowMs ? f.target : null;
  const found = target ? findTarget(f.all, target) : null;
  // The server's own answer, or a walk that has since come to beat the chosen bus: still that bus.
  const own = targetOf(f.own) ? f.own! : found;
  if (!own) return null;
  const moved = found !== null && !sameAs(found, targetOf(own)!);
  const pick = moved ? found! : own;
  const lastLeaveMs = f.lastArriveMs === null ? atMs(own) + STEP.laterMaxS * 1000 : null;
  const fits = (l: Leave) =>
    Boolean(l.board && l.arrive) &&
    (f.lastArriveMs === null || arriveMs(l) <= f.lastArriveMs) &&
    (lastLeaveMs === null || atMs(l) <= lastLeaveMs);
  const later =
    f.all
      .filter((l) => fits(l) && atMs(l) > atMs(pick) && arriveMs(l) >= arriveMs(pick))
      .sort((a, b) => arriveMs(a) - arriveMs(b) || atMs(b) - atMs(a))[0] ?? null;
  const earlier =
    f.all
      .filter((l) => l.board && l.arrive && atMs(l) < atMs(pick) && atMs(l) >= f.nowMs && arriveMs(l) <= arriveMs(pick))
      .sort((a, b) => atMs(b) - atMs(a) || arriveMs(a) - arriveMs(b))[0] ?? null;
  return { leave: pick, steps: { trip: f.trip, earlier: targetOf(earlier), later: targetOf(later), moved: moved || own !== f.own } };
}
