import type { Arrival, FeedState, Graph, StopArrivals } from '../types.ts';
import { headwayFor, inService, serviceClosedAt, serviceEndsAt, serviceResumesAt } from './hours.ts';
import { isPublic } from './public.ts';

const PROJECT_MS = 86_400_000;

export const headwayMs = (graph: Graph, svc: string, ms: number): number => Math.max(60, headwayFor(graph, svc, ms)) * 1000;

const nextHour = (ms: number) => (Math.floor(ms / 3_600_000) + 1) * 3_600_000;

export interface Departure {
  id: string;
  kind: 'live' | 'stale' | 'estimate';
  earliest: number;
  latest: number;
  arrival?: Arrival;
  opens?: true;
  partial?: true;
}

export interface DepartureWindow {
  now: number;
  from: number;
  until?: number;
  around?: number;
  max?: number;
}

export const FIRST_BUS_LEAD_S = 30 * 60;

export function beforeOpening(graph: Graph, svc: string, rows: Arrival[], fetchedAt: number, nowMs: number): Arrival[] {
  if (!rows.length || inService(graph, svc, nowMs)) return rows;
  const opens = serviceResumesAt(graph, svc, nowMs);
  if (opens === null) return rows;
  const out: Arrival[] = [];
  for (const a of rows) {
    const at = a.etaS == null ? null : fetchedAt + a.etaS * 1000;
    if (at === null || at < opens) out.push(a);
    else if (at - nowMs <= FIRST_BUS_LEAD_S * 1000) out.push({ ...a, scheduled: true });
  }
  return out;
}

export function resolveBerths(rows: Arrival[]): { usable: Arrival[]; ambiguousBerth: boolean } {
  const notEnding = rows.filter((a) => !a.ends);

  if (!notEnding.length) return { usable: rows, ambiguousBerth: rows.length > 0 };

  const distinct = new Set(notEnding.map((a) => a.berth).filter((b) => b != null));
  return { usable: notEnding, ambiguousBerth: distinct.size > 1 };
}

export function feedFor(sa: StopArrivals | undefined, pub: boolean): FeedState | undefined {
  if (!sa) return undefined;
  return sa.feeds?.[pub ? 'public' : 'shuttle'] ?? sa;
}

interface LiveBus {
  id: string;
  at: number;
  kind: Departure['kind'];
  arrival: Arrival;
}

export interface ServiceBoard {
  svc: string;
  fetchedAt?: number;
  available: boolean;
  stale: boolean;
  ambiguousBerth: boolean;
  paid: boolean;
  live: LiveBus[];
}

export function serviceBoard(graph: Graph, sa: StopArrivals | undefined, svc: string, nowMs: number): ServiceBoard {
  const paid = isPublic(graph, svc);
  const feed = feedFor(sa, paid);
  const { usable, ambiguousBerth } = resolveBerths((sa?.arrivals ?? []).filter((a) => a.svc === svc));
  const answered = sa !== undefined && feed !== undefined && feed.available !== false;
  const live =
    answered && feed
      ? beforeOpening(graph, svc, usable, feed.fetchedAt, nowMs)
          .filter((a) => a.etaS != null)
          .map((a) => ({
            at: feed.fetchedAt + (a.etaS as number) * 1000,
            kind: (a.scheduled ? 'estimate' : feed.stale ? 'stale' : 'live') as Departure['kind'],
            arrival: a,
          }))
          .sort((a, b) => a.at - b.at)
          .map(passId)
      : [];
  return {
    svc,
    ...(feed ? { fetchedAt: feed.fetchedAt } : {}),
    available: answered && !sa?.unread?.includes(svc),
    stale: feed?.stale === true,
    ambiguousBerth,
    paid,
    live,
  };
}

function passId<B extends { arrival: Arrival }>(b: B, i: number, all: B[]): B & { id: string } {
  const plate = b.arrival.plate;
  if (plate == null) return { ...b, id: `#${i}` };
  const pass = all.slice(0, i).filter((o) => o.arrival.plate === plate).length + 1;
  return { ...b, id: pass === 1 ? plate : `${plate}@${pass}` };
}

const boardOf = (graph: Graph, board: StopArrivals | ServiceBoard | undefined, svc: string, nowMs: number): ServiceBoard =>
  board && 'live' in board ? board : serviceBoard(graph, board, svc, nowMs);

export function departuresFrom(graph: Graph, board: StopArrivals | ServiceBoard | undefined, svc: string, w: DepartureWindow): Departure[] {
  const until = w.until ?? w.now + PROJECT_MS;
  const max = w.max ?? Infinity;
  const hourly = new Map<number, number>();
  const headwayAt = (ms: number) => {
    const hour = Math.floor(ms / 3_600_000);
    let h = hourly.get(hour);
    if (h === undefined) hourly.set(hour, (h = headwayMs(graph, svc, ms)));
    return h;
  };
  const runs = (ms: number) => inService(graph, svc, ms);
  const live = boardOf(graph, board, svc, w.now).live;
  const out: Departure[] = [];
  for (const b of live) {
    if (out.length >= max) return out;
    if (b.at >= w.from && b.at <= until) out.push({ id: b.id, kind: b.kind, earliest: b.at, latest: b.at, arrival: b.arrival });
  }

  const last = live.at(-1);
  let t = last ? last.at + headwayAt(last.at) : w.from;
  for (let n = 1; last && out.length < max && t <= until && runs(t); n++) {
    if (t < w.from) {
      const h = headwayAt(t);
      const k = Math.ceil((Math.min(w.from, nextHour(t), serviceEndsAt(graph, svc, t) ?? Infinity) - t) / h);
      [t, n] = [t + k * h, n + k - 1];
      continue;
    }
    out.push({ id: `${last.id}+${n}`, kind: 'estimate', earliest: t, latest: t });
    t += headwayAt(t);
  }

  let chain: number[] = [];
  if (w.around !== undefined && w.around >= w.now - PROJECT_MS && w.around <= until) {
    let b = w.around;
    const closed = runs(b) ? null : serviceClosedAt(graph, svc, b);
    if (closed !== null && closed > w.from) b = closed;
    if (b >= w.from) {
      chain = [b];
      for (let p = b; p > w.from;) {
        p -= headwayAt(p - headwayAt(p));
        chain.push(p);
        if (!runs(p)) break;
      }
      chain.reverse();
    } else {
      let before = b;
      while (b < w.from) [before, b] = [b, b + headwayAt(b)];
      chain = b > w.from ? [before, b] : [b];
    }
  }
  const aligned = !last && chain.length > 0 && chain[0] <= w.from;
  let fixed = aligned ? chain : [];
  let partial = aligned && chain[0] < w.from;
  if (aligned) t = Math.max(chain[0], w.from);
  let anchor = 'reach';
  let opens = false;
  let closes: number | null = null;
  const startAt = (s: number) => {
    const h = headwayAt(s);
    closes = serviceEndsAt(graph, svc, s);
    const by = closes ?? Infinity;
    [t, fixed, anchor, opens, partial] = [s, [s, ...chain.filter((f) => f >= s + h && f <= by)], `opens@${s}`, true, false];
  };
  const starts = last || runs(w.now) ? null : serviceResumesAt(graph, svc, w.now);
  if (starts !== null && starts <= t && t < (serviceEndsAt(graph, svc, starts) ?? Infinity)) startAt(starts);
  for (let n = 1, i = 0; out.length < max && t < until; n++, i++) {
    if (closes === null ? !runs(t) : t >= closes) {
      const s = serviceResumesAt(graph, svc, t);
      if (s === null || s >= until) break;
      startAt(s);
      [n, i] = [1, 0];
    } else if (closes === null) closes = serviceEndsAt(graph, svc, t);
    if (closes !== null && closes < w.from) {
      t = closes;
      continue;
    }
    const cut = partial;
    partial = false;
    const end = Math.min(i + 1 < fixed.length ? fixed[i + 1] : t + headwayAt(t), closes ?? Infinity);
    if (end > until) break;
    if (end >= w.from) {
      out.push({
        id: `${anchor}+${n}`,
        kind: 'estimate',
        earliest: Math.max(t, w.from),
        latest: end,
        ...(opens ? { opens: true as const } : {}),
        ...(cut ? { partial: true as const } : {}),
      });
      opens = false;
    }
    t = end;
  }
  return out;
}

export function nextDeparture(
  graph: Graph,
  board: StopArrivals | ServiceBoard | undefined,
  svc: string,
  fromMs: number,
  nowMs: number,
): Departure | null {
  return departuresFrom(graph, board, svc, { now: nowMs, from: fromMs, until: Math.max(nowMs, fromMs) + PROJECT_MS, max: 1 })[0] ?? null;
}
