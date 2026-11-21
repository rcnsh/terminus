import type { Leave } from '../types.ts';
import { WALK } from '../config.ts';
import { type Plan, secondBusOf, tripEnd } from './trip.ts';
import { WAIT_EARLY_MS } from './phase.ts';

export const SAME_BUS_MS = 3 * 60_000;

export function planOfLeave(l: Leave | null | undefined, located: boolean, alightCode: string): Plan | null {
  if (!l?.svc || !l.board) return null;
  const change = secondBusOf(l, alightCode);
  if (change) {
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

export function sameBus(a: Plan | null | undefined, b: Plan | null | undefined): boolean {
  if (!a?.board || !b?.board || a.svc !== b.svc || (a.stopCode ?? a.stop) !== (b.stopCode ?? b.stop)) return false;
  if (a.change?.svc !== b.change?.svc || a.change?.stopCode !== b.change?.stopCode) return false;
  return Math.abs(Date.parse(a.board) - Date.parse(b.board)) <= SAME_BUS_MS;
}

export interface PlanInput {
  stored: Plan | undefined;
  made: Plan | null;
  located: boolean;
  atItsStop?: boolean;
  walkToItsStopS?: number | null;
  classAtMs: number | null;
  nowMs: number;
}

export interface PlanChoice {
  bus: Plan | null;
  save: boolean;
  drop?: true;
}

export function choosePlan({ stored, made, located, atItsStop = false, walkToItsStopS = null, classAtMs, nowMs }: PlanInput): PlanChoice {
  const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Infinity);
  const ahead = stored?.board ? at(stored.board) > nowMs : false;

  const guessed = located && !atItsStop && stored !== undefined && !stored.located && ahead;
  const frozen = !guessed && stored?.board && nowMs >= Math.min(at(stored.board), at(stored.leave)) ? stored : null;
  if (frozen) return { bus: frozen, save: false };
  if (!located && stored?.located && ahead) return { bus: sameBus(stored, made) ? made : stored, save: false };

  const outOfReach =
    located && !atItsStop && walkToItsStopS !== null && nowMs + walkToItsStopS * 1000 > at(stored?.board) + WALK.dwellS * 1000;
  const told =
    located &&
    !outOfReach &&
    stored?.located &&
    ahead &&
    stored.leave &&
    tripEnd(stored) &&
    classAtMs !== null &&
    nowMs >= at(stored.leave) - WAIT_EARLY_MS &&
    at(tripEnd(stored) ?? undefined) <= classAtMs;
  if (told && !sameBus(stored, made)) return { bus: stored, save: false };

  const save =
    made !== null && (!sameBus(stored, made) || (stored?.estimated === true && !made.estimated)) && (located || !stored?.located);
  return (guessed || outOfReach) && !made ? { bus: null, save: false, drop: true } : { bus: made, save };
}
