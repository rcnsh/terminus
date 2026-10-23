/**
 * Which bus a trip is about: one plan for every device. Frozen from its
 * leave-by (but a plan made without a location gives way to a located
 * answer until its bus leaves), kept for a device without a location, held
 * once you were told it unless it would make you late (answers a minute apart can prefer another:
 * the feed lists a later one, a crowd guess changes), else the fresh answer's
 * bus. See internals.md, *One plan, and push*.
 *
 * The same service from the same stop within SAME_BUS_MS is the same bus
 * (`sameBus`): saved again each time, its leave-by would stay just ahead of
 * the clock and the plan would never freeze.
 */

import type { Leave } from '../types.ts';
import { type Plan, WAIT_EARLY_MS, secondBusOf, tripEnd } from './trip.ts';

/** Live times move this much from one answer to the next, and it's still the same bus. */
export const SAME_BUS_MS = 3 * 60_000;

/** The bus a leave-by is for, as a plan; null when it's a walk. */
export function planOfLeave(l: Leave | null | undefined, located: boolean, alightCode: string): Plan | null {
  if (!l?.svc || !l.board) return null;
  const change = secondBusOf(l, alightCode);
  if (change) {
    // The first bus to the change; the second (and the trip's end) after it.
    const first = planOfLeave(
      { ...l, change: undefined, arrive: l.change!.reach, off: undefined, offCode: l.change!.fromCode },
      located,
      l.change!.fromCode,
    )!;
    return { ...first, change };
  }
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
    alightCode: l.offCode ?? l.toCode ?? alightCode,
    ...(l.paid ? { paid: true as const } : {}),
    ...(l.route ? { route: l.route } : {}),
  };
}

/** The same service from the same stop, its time moved a little by the feed. */
export function sameBus(a: Plan | null | undefined, b: Plan | null | undefined): boolean {
  if (!a?.board || !b?.board || a.svc !== b.svc || (a.stopCode ?? a.stop) !== (b.stopCode ?? b.stop)) return false;
  // A trip that changes buses is the same only with the same change.
  if (a.change?.svc !== b.change?.svc || a.change?.stopCode !== b.change?.stopCode) return false;
  return Math.abs(Date.parse(a.board) - Date.parse(b.board)) <= SAME_BUS_MS;
}

export interface PlanInput {
  /** The plan in the day's record, if any. */
  stored: Plan | undefined;
  /** The bus this request's answer says. */
  made: Plan | null;
  /** This request has a location. */
  located: boolean;
  /** This request's location is at the stored plan's boarding stop: waiting for that bus. */
  atItsStop?: boolean;
  /** When the class starts, for a class; null for a trip home. */
  classAtMs: number | null;
  nowMs: number;
}

export interface PlanChoice {
  /** The bus the trip is about: what every device shows and detection watches. */
  bus: Plan | null;
  /** Save the answer's own bus (`made`) as the plan. */
  save: boolean;
  /** Delete the stored plan: a guess the phone's location has replaced with a walk. */
  drop?: true;
}

export function choosePlan({ stored, made, located, atItsStop = false, classAtMs, nowMs }: PlanInput): PlanChoice {
  const at = (iso: string | undefined) => (iso ? Date.parse(iso) : Infinity);
  const ahead = stored?.board ? at(stored.board) > nowMs : false;

  // A plan made without a location starts where the timetable puts you; the
  // phone knows better, past its leave-by too. Not while you wait at its
  // stop, and not once its bus has left: then only that plan can tell
  // whether you're on it (next.ts).
  const guessed = located && !atItsStop && stored !== undefined && !stored.located && ahead;
  const frozen = !guessed && stored?.board && nowMs >= Math.min(at(stored.board), at(stored.leave)) ? stored : null;
  if (frozen) return { bus: frozen, save: false };
  // Kept, but when this answer has that same bus its times are the newer:
  // the plan's are from when the phone made it, minutes ago.
  if (!located && stored?.located && ahead) return { bus: sameBus(stored, made) ? made : stored, save: false };

  const told =
    located &&
    stored?.located &&
    ahead &&
    stored.leave &&
    tripEnd(stored) &&
    classAtMs !== null &&
    nowMs >= at(stored.leave) - WAIT_EARLY_MS &&
    at(tripEnd(stored) ?? undefined) <= classAtMs;
  // The same bus with newer times is still that bus: shown as the answer has it.
  if (told && !sameBus(stored, made)) return { bus: stored, save: false };

  const save =
    made !== null && (!sameBus(stored, made) || (stored?.estimated === true && !made.estimated)) && (located || !stored?.located);
  return guessed && !made ? { bus: null, save: false, drop: true } : { bus: made, save };
}
