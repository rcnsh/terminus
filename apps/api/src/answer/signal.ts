/**
 * A signal about one of today's trips ("On it", "Missed it", "Not going",
 * "I'm there", undo) applied to the day, as one pure function: the route in
 * me.ts parses it and saves what this returns. Apart from trip.ts, which
 * keeps the day's records and stays free of the answer and the profile.
 */

import type { Graph } from '../types.ts';
import type { Planned } from './next.ts';
import type { Outcome } from '../accounts/outcomes.ts';
import { type Profile, classKey, classesOn } from '../timetable/profile.ts';
import { GRAPH, GRAPH_PUBLIC } from './graph.ts';
import { isoSeconds } from './format.ts';
import { type DayRecord, type SignalKind, type TripRecord, isHomeKey, laterChange, leaveOf, secondBusOf } from './trip.ts';

/** The plate of the `svc` bus at a stop now, and when it's due there (ISO); empty when the feed can't say. */
export type PlateLookup = (stopCode: string | undefined, svc: string, graph: Graph) => Promise<{ plate?: string; at?: string }>;

/** The outcome a signal records; the others ("waiting", a location) say nothing about it. */
const OUTCOME_OF: Partial<Record<TripRecord['kind'], Exclude<Outcome, 'none'>>> = {
  boarded: 'boarded',
  left: 'boarded',
  missed: 'missed',
  skipped: 'skipped',
  arrived: 'arrived',
};

/** What a signal does to the day: the trip's new record (null: forgotten), and its outcome ('clear': forgotten too). */
export interface SignalApplied {
  rec: TripRecord | null;
  outcome: Exclude<Outcome, 'none'> | 'clear' | null;
}

/**
 * A signal about trip `key` ("On it", "Missed it", "Not going", "I'm
 * there", undo) applied to the day, against `now`, the answer planned before
 * it. Saves nothing: the caller saves the record, then the outcome. `plateAt`
 * is asked only for "On it", for the bus pulling in.
 */
export async function applySignal(
  kind: Exclude<SignalKind, 'location' | 'away' | 'back'>,
  key: string,
  now: Planned,
  day: DayRecord | null,
  profile: Profile,
  nowMs: number,
  plateAt: PlateLookup,
): Promise<SignalApplied> {
  const current = key === now.trip.key;
  // After the planned bus has left, "On it" and "Missed it" are about that
  // bus (the plan), not the next one the answer has moved on to.
  const p = current ? now.trip.plan : null;
  const gone = p?.board ? Date.parse(p.board) <= nowMs + 60_000 : false;
  const l = current
    ? gone && p
      ? p.change
        ? { ...now.answer.leave, ...leaveOf(p) }
        : {
            ...now.answer.leave,
            svc: p.svc,
            stop: p.stop,
            board: p.board,
            arrive: p.arrive,
            off: p.off,
            stopCode: p.stopCode,
            offCode: p.alightCode,
          }
      : now.answer.leave
    : null;
  const label = current ? (now.answer.dest?.label ?? undefined) : classesOn(profile, nowMs).find((c) => classKey(c) === key)?.label;
  let rec: TripRecord | null;
  switch (kind) {
    case 'reset':
      rec = null;
      break;
    case 'boarded': {
      // Already on the first bus of a trip that changes buses: that's
      // still the bus you're on, not a new one.
      const was = day?.trips[key];
      if (current && was?.kind === 'boarded' && was.boarded?.change && now.trip.phase === 'riding' && now.trip.rec?.boarded?.change) {
        rec = was;
        break;
      }
      // No bus to be on (a walk, or an old card): you've set off.
      if (!l?.svc) {
        rec = { kind: 'left', at: nowMs, label };
        break;
      }
      // The bus pulling in now, which may be one before or after the
      // plan's: its times are the plan's moved to when it's due here.
      const graph = l.paid ? GRAPH_PUBLIC : GRAPH;
      const { plate, at: boardAt } = await plateAt(l.stopCode, l.route ?? l.svc, graph);
      const shift = boardAt && l.board ? Date.parse(boardAt) - Date.parse(l.board) : 0;
      // A public bus is followed on its own route and feed (trip.ts, next.ts).
      const paid = l.paid ? { paid: true as const, ...(l.route ? { route: l.route } : {}) } : {};
      rec = {
        kind,
        at: nowMs,
        label,
        boarded: l.change
          ? {
              // A trip that changes buses: this bus to the change, its
              // time there moved with it; the second bus as planned.
              svc: l.svc,
              stop: l.stop ?? '',
              board: boardAt ?? l.board,
              arrive: l.change.reach && shift ? isoSeconds(Date.parse(l.change.reach) + shift) : l.change.reach,
              ...(l.stopCode ? { stopCode: l.stopCode } : {}),
              alightCode: l.change.fromCode,
              ...(plate ? { plate } : {}),
              ...paid,
              ...(now.answer.dest?.to ? { change: laterChange(secondBusOf(l, now.answer.dest.to), l.change.reach, shift) } : {}),
            }
          : {
              svc: l.svc,
              stop: l.stop ?? '',
              board: boardAt ?? l.board,
              arrive: l.arrive && shift ? isoSeconds(Date.parse(l.arrive) + shift) : l.arrive,
              ...(l.off ? { off: l.off } : {}),
              ...(l.stopCode ? { stopCode: l.stopCode } : {}),
              ...(now.answer.dest?.to ? { alightCode: l.offCode ?? l.toCode ?? now.answer.dest.to } : {}),
              ...(plate ? { plate } : {}),
              ...paid,
            },
      };
      break;
    }
    case 'missed':
      rec = { kind, at: nowMs, label, missed: l?.board ?? null };
      break;
    default:
      rec = { kind, at: nowMs, label };
  }
  // A trip home isn't a class: nothing to learn from skipping it.
  const outcome = rec === null ? 'clear' : isHomeKey(key) ? null : (OUTCOME_OF[rec.kind] ?? null);
  return { rec, outcome };
}
