/**
 * Which bus a trip is about: one plan for every device.
 *
 * Each request works out a fresh answer, and with it a bus (`made`). The day's
 * record keeps the bus the trip is for (`DayRecord.plans`). This decides which
 * of the two the trip is about now, and whether the record should change:
 *
 * - **Frozen** from the plan's leave-by (or its departure, if earlier): that
 *   bus until it has left, whatever the answer says now. Past the leave time
 *   the answer moves on to later buses, and from a moving bus to other stops.
 * - **Kept** for a device without a location (the widget, the background
 *   refresh, the Mac, the web) when the plan was made from the phone's
 *   location: it would otherwise plan from where the timetable puts you.
 * - **Told:** from when you'd be at the stop for it (and so from the
 *   heads-up), the bus you were told stays the plan while it still gets you
 *   there in time. Answers a minute apart can prefer another (the feed lists
 *   a later one, a crowd guess changes); only one that would make you late
 *   gives way.
 * - Otherwise the fresh answer's bus, saved when it's another bus, or the
 *   same one now on live times.
 *
 * Live times move a little from one answer to the next, so the same service
 * from the same stop within a few minutes is the same bus (`sameBus`).
 * Saved again each time, its leave-by would stay just ahead of the clock (at
 * the stop it's seconds before the bus) and the plan would never freeze.
 */

import type { Leave } from './types.ts';
import { type Boarded, WAIT_EARLY_MS } from './trip.ts';

/** Live times move this much from one answer to the next, and it's still the same bus. */
export const SAME_BUS_MS = 3 * 60_000;

/** The bus a leave-by is for, as a plan; null when it's a walk. */
export function planOfLeave(l: Leave | null | undefined, located: boolean, alightCode: string): Boarded | null {
  if (!l?.svc || !l.board) return null;
  return {
    svc: l.svc,
    stop: l.stop ?? '',
    board: l.board,
    ...(l.at ? { leave: l.at } : {}),
    ...(located ? { located: true } : {}),
    arrive: l.arrive,
    ...(l.note ? { note: l.note } : {}),
    ...(l.estimated ? { estimated: true } : {}),
    ...(l.off ? { off: l.off } : {}),
    ...(l.stopCode ? { stopCode: l.stopCode } : {}),
    ...(l.walkS != null ? { walkS: l.walkS } : {}),
    ...(l.rideS != null ? { rideS: l.rideS } : {}),
    alightCode: l.offCode ?? alightCode,
    ...(l.paid ? { paid: true as const } : {}),
    ...(l.route ? { route: l.route } : {}),
  };
}

/** The same service from the same stop, its time moved a little by the feed. */
export function sameBus(a: Boarded | null | undefined, b: Boarded | null | undefined): boolean {
  if (!a?.board || !b?.board || a.svc !== b.svc || (a.stopCode ?? a.stop) !== (b.stopCode ?? b.stop)) return false;
  return Math.abs(Date.parse(a.board) - Date.parse(b.board)) <= SAME_BUS_MS;
}

export interface PlanInput {
  /** The plan in the day's record, if any. */
  stored: Boarded | undefined;
  /** The bus this request's answer says. */
  made: Boarded | null;
  /** This request has a location. */
  located: boolean;
  /** When the class starts, for a class; null for a trip home. */
  classAtMs: number | null;
  nowMs: number;
}

export interface PlanChoice {
  /** The bus the trip is about: what every device shows and detection watches. */
  bus: Boarded | null;
  /** The answer's own bus, to be saved as the plan. */
  save: boolean;
}

export function choosePlan({ stored, made, located, classAtMs, nowMs }: PlanInput): PlanChoice {
  const at = (iso: string | undefined) => (iso ? Date.parse(iso) : Infinity);
  const ahead = stored?.board ? at(stored.board) > nowMs : false;

  const frozen = stored?.board && nowMs >= Math.min(at(stored.board), at(stored.leave)) ? stored : null;
  if (frozen) return { bus: frozen, save: false };
  if (!located && stored?.located && ahead) return { bus: stored, save: false };

  const told =
    located && stored?.located && ahead && stored.leave && stored.arrive && classAtMs !== null &&
    nowMs >= at(stored.leave) - WAIT_EARLY_MS && at(stored.arrive) <= classAtMs;
  // The same bus with newer times is still that bus: shown as the answer has it.
  if (told && !sameBus(stored, made)) return { bus: stored, save: false };

  const save = made !== null && (!sameBus(stored, made) || (stored?.estimated === true && !made.estimated)) && (located || !stored?.located);
  return { bus: made, save };
}
