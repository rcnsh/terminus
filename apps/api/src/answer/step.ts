import type { Leave } from '../types.ts';
import type { Departing } from './leave.ts';
import { type Plan, tripEnd } from './trip.ts';
import { SAME_BUS_MS } from './plan.ts';
import { STEP } from '../config.ts';

export interface StepTarget {
  svc: string;
  stop: string;
  board: string;
}

export interface Steps {
  trip: string;
  earlier: StepTarget | null;
  later: StepTarget | null;
  moved: boolean;
}

export function stepsPastLeave(plan: Plan, l: Leave | null | undefined, moved: boolean, trip: string, nowMs: number): Steps | null {
  const later = targetOf(l);
  if (!later || !l!.arrive || !plan.leave || !plan.board) return null;
  const end = tripEnd(plan);
  if (nowMs < Date.parse(plan.leave) || Date.parse(plan.board) <= nowMs) return null;
  if (boardMs(l!) <= Date.parse(plan.board) || (end && arriveMs(l!) < Date.parse(end))) return null;
  return { trip, earlier: null, later, moved };
}

export function targetOf(l: Leave | null | undefined): StepTarget | null {
  return l?.svc && l.stopCode && l.board ? { svc: l.route ?? l.svc, stop: l.stopCode, board: l.board } : null;
}

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
const busOf = (l: Leave): string | undefined => (l as Partial<Departing>).bus;
const isService = (l: Leave, t: StepTarget) => (l.route ?? l.svc) === t.svc && l.stopCode === t.stop;

export const sameAs = (l: Leave, t: StepTarget) => isService(l, t) && Math.abs(boardMs(l) - Date.parse(t.board)) <= SAME_BUS_MS;

function closestSame<L extends Leave>(all: L[], t: StepTarget): L | undefined {
  const at = Date.parse(t.board);
  return all.filter((l) => sameAs(l, t)).sort((a, b) => Math.abs(boardMs(a) - at) - Math.abs(boardMs(b) - at))[0];
}

export function findTarget(all: Leave[], t: StepTarget): Leave | null {
  const at = Date.parse(t.board);
  const mine = all.filter((l) => l.board && isService(l, t)).sort((a, b) => boardMs(a) - boardMs(b));
  const same = closestSame(mine, t);
  if (same) return same;
  if (!mine.length || at < boardMs(mine[0]) - SAME_BUS_MS) return null;
  return mine.find((l) => boardMs(l) >= at) ?? null;
}

export interface StepInput {
  trip: string;
  own: Leave | null;
  all: Departing[];
  target: StepTarget | null;
  lastArriveMs: number | null;
  nowMs: number;
}

export function stepFrom(f: StepInput): { leave: Leave; steps: Steps } | null {
  const target = f.target && Date.parse(f.target.board) > f.nowMs ? f.target : null;
  const found = target ? findTarget(f.all, target) : null;
  const own = targetOf(f.own) ? f.own! : found;
  if (!own) return null;
  const same = (a: Leave, b: Leave) => (busOf(a) && busOf(b) ? busOf(a) === busOf(b) : sameAs(a, targetOf(b)!));
  const moved = found !== null && !same(found, own);
  const pick = moved ? found! : own;
  const lastLeaveMs = f.lastArriveMs === null ? atMs(own) + STEP.laterMaxS * 1000 : null;
  const fits = (l: Leave) =>
    Boolean(l.board && l.arrive) &&
    (f.lastArriveMs === null || arriveMs(l) <= f.lastArriveMs) &&
    (lastLeaveMs === null || atMs(l) <= lastLeaveMs);
  const self = busOf(pick) ?? closestSame(f.all, targetOf(pick)!)?.bus;
  const other = (l: Departing) => l.bus !== self;
  const later =
    f.all
      .filter((l) => fits(l) && other(l) && atMs(l) > atMs(pick) && arriveMs(l) >= arriveMs(pick))
      .sort((a, b) => arriveMs(a) - arriveMs(b) || atMs(b) - atMs(a))[0] ?? null;
  const earlier =
    f.all
      .filter((l) => l.board && l.arrive && other(l) && atMs(l) < atMs(pick) && atMs(l) >= f.nowMs && arriveMs(l) <= arriveMs(pick))
      .sort((a, b) => atMs(b) - atMs(a) || arriveMs(a) - arriveMs(b))[0] ?? null;
  return { leave: pick, steps: { trip: f.trip, earlier: targetOf(earlier), later: targetOf(later), moved: moved || own !== f.own } };
}
