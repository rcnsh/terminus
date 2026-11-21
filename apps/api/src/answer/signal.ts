import type { Graph } from '../types.ts';
import type { Planned } from './next.ts';
import type { Outcome } from '../accounts/outcomes.ts';
import { type Profile, classKey, classesOn } from '../timetable/profile.ts';
import { GRAPH, GRAPH_PUBLIC } from './graph.ts';
import { isoSeconds } from './format.ts';
import { type DayRecord, type SignalKind, type TripRecord, isHomeKey, laterChange, leaveOf, secondBusOf } from './trip.ts';

export type PlateLookup = (stopCode: string | undefined, svc: string, graph: Graph) => Promise<{ plate?: string; at?: string }>;

const OUTCOME_OF: Partial<Record<TripRecord['kind'], Exclude<Outcome, 'none'>>> = {
  boarded: 'boarded',
  left: 'boarded',
  missed: 'missed',
  skipped: 'skipped',
  arrived: 'arrived',
};

export interface SignalApplied {
  rec: TripRecord | null;
  outcome: Exclude<Outcome, 'none'> | 'clear' | null;
}

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
      const was = day?.trips[key];
      if (current && was?.kind === 'boarded' && was.boarded?.change && now.trip.phase === 'riding' && now.trip.rec?.boarded?.change) {
        rec = was;
        break;
      }
      if (!l?.svc) {
        rec = { kind: 'left', at: nowMs, label };
        break;
      }
      const graph = l.paid ? GRAPH_PUBLIC : GRAPH;
      const { plate, at: boardAt } = await plateAt(l.stopCode, l.route ?? l.svc, graph);
      const shift = boardAt && l.board ? Date.parse(boardAt) - Date.parse(l.board) : 0;
      const paid = l.paid ? { paid: true as const, ...(l.route ? { route: l.route } : {}) } : {};
      rec = {
        kind,
        at: nowMs,
        label,
        boarded: l.change
          ? {
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
  const outcome = rec === null ? 'clear' : isHomeKey(key) ? null : (OUTCOME_OF[rec.kind] ?? null);
  return { rec, outcome };
}
