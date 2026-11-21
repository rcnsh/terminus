import type { ArriveBy, BusChange, Candidate, Graph, Leave, ScoredOption, StopArrivals } from '../types.ts';
import { PUBLIC, TRANSFER, WALK } from '../config.ts';
import { legRideS, readyS } from './resolve.ts';
import { type Departure, type ServiceBoard, departuresFrom, headwayMs, nextDeparture, serviceBoard } from './departures.ts';
import { serviceResumesAt } from './hours.ts';
import { isPublic, svcName } from './public.ts';
import { ON_TIME_SLACK_S } from '../timetable/profile.ts';
import { busChange, isoSeconds, shortStop } from './format.ts';
import { type CrowdRisk, OFTEN_PACKED } from './crowd.ts';
import { m } from '../i18n.ts';

export interface LeaveInput {
  options: ScoredOption[];
  candidates: Candidate[];
  byStop: Map<string, StopArrivals>;
  graph: Graph;
  arriveBy: ArriveBy | null | undefined;
  walkAllS: number | null;
  walkEndS?: number;
  endWalk?: (o: ScoredOption) => number;
  walkWeight?: number;
  nowMs: number;
  crowdRisk?: CrowdRisk;
}

const NOW_S = 60;
const BUFFER_MS = WALK.boardBufferS * 1000;
const walkMs = (leg: { walkS: number; here?: true }) => (leg.here ? 0 : leg.walkS * 1000 + BUFFER_MS);

interface Leg {
  svc: string;
  stop: { code: string; name: string };
  walkS: number;
  here?: true;
  rideS: number;
  off?: { code: string; name: string };
  to?: { code: string; name: string };
  paid?: true;
  change?: {
    svc: string;
    at: { code: string; name: string };
    stop: { code: string; name: string };
    crossS: number;
    rideS: number;
    to?: { code: string; name: string };
  };
}

const changeLeg = (o: ScoredOption): Leg['change'] =>
  o.change
    ? {
        svc: o.change.svc,
        at: o.change.at,
        stop: o.change.stop,
        crossS: o.change.crossS,
        rideS: o.change.rideS,
        ...(o.to ? { to: o.to } : {}),
      }
    : undefined;

const legOf = (o: ScoredOption): Leg => ({
  svc: o.svc,
  stop: o.stop,
  walkS: o.walkS,
  ...(o.here ? { here: true as const } : {}),
  rideS: o.rideS,
  off: o.off,
  to: o.to,
  ...paidOf(o),
  ...(o.change ? { change: changeLeg(o) } : {}),
});

const fareMs = (leg: { paid?: true }) => (leg.paid ? PUBLIC.fareWorthS * 1000 : 0);
const paidOf = (leg: { svc: string; paid?: true }) =>
  leg.paid ? { paid: true as const, ...(leg.svc !== svcName(leg.svc) ? { route: leg.svc } : {}) } : {};

const venueWalkOf = (arriveBy: ArriveBy, leg: Leg) => arriveBy.walkByStopS?.[(leg.change?.to ?? leg.to)?.code ?? ''] ?? arriveBy.venueWalkS;

type Ranked = Leave & { ms: number; worth: number; opens: boolean };
const unranked = ({ ms: _ms, worth: _worth, opens: _opens, ...leave }: Ranked): Leave => leave;

const offOf = (leg: { off?: { code: string; name: string }; to?: { code: string; name: string } }) => ({
  ...(leg.off ? { off: shortStop(leg.off.name), offCode: leg.off.code } : {}),
  ...(leg.to ? { toStop: shortStop(leg.to.name), toCode: leg.to.code } : {}),
});

export function leaveBy(f: LeaveInput): Leave | null {
  if (f.walkAllS != null) {
    if (!f.arriveBy) return null;
    const walkS = f.walkAllS + (f.walkEndS ?? f.arriveBy.venueWalkS);
    const at = f.arriveBy.atMs - (ON_TIME_SLACK_S + walkS) * 1000;
    const from = Math.max(at, f.nowMs);
    return {
      at: isoSeconds(from),
      estimated: false,
      svc: null,
      stop: null,
      board: null,
      arrive: isoSeconds(from + walkS * 1000),
      note: null,
    };
  }

  if (!f.arriveBy) {
    const b = f.options[0];
    if (!b || b.quality === 'unknown') return null;
    const at = b.fromMs + b.boardS * 1000 - walkMs(b);
    if (at - f.nowMs < NOW_S * 1000) return null;
    const endWalkS = f.endWalk?.(b) ?? 0;
    return {
      at: isoSeconds(at),
      estimated: b.quality === 'scheduled',
      ...(b.quality === 'stale' ? { stale: true as const } : {}),
      svc: svcName(b.svc),
      stop: shortStop(b.stop.name),
      stopCode: b.stop.code,
      board: isoSeconds(b.fromMs + b.boardS * 1000),
      arrive: isoSeconds(b.fromMs + b.totalS * 1000),
      note: null,
      walkS: b.walkS,
      rideS: b.rideS,
      ...offOf(b),
      ...(endWalkS > 0 ? { endWalkS } : {}),
      ...paidOf(b),
      ...(b.change ? { change: busChange(b) } : {}),
    };
  }

  const legs: Leg[] = f.options.length ? f.options.map(legOf) : fallbackLegs(f.candidates, f.graph);
  let onTime: Ranked | null = null;
  let late: (Ranked & { reach: number }) | null = null;
  for (const leg of legs) {
    const r = leg.change
      ? forTransfer(leg, f.byStop.get(leg.stop.code), f.byStop.get(leg.change.stop.code), f.graph, f.arriveBy, f.nowMs)
      : forLeg(leg, f.byStop.get(leg.stop.code), f.graph, f.arriveBy, f.nowMs, f.crowdRisk);
    if (!r) continue;
    const extraFootMs =
      ((f.walkWeight ?? WALK.sunWeight) - 1) * (leg.walkS + (leg.change?.crossS ?? 0) + venueWalkOf(f.arriveBy, leg)) * 1000;
    const worth = r.ms - fareMs(leg) - (leg.change ? TRANSFER.worthS * 1000 : 0) - extraFootMs;
    const out: Ranked = {
      at: isoSeconds(r.ms),
      estimated: r.estimated,
      ...(r.stale ? { stale: true as const } : {}),
      svc: svcName(leg.svc),
      stop: shortStop(leg.stop.name),
      stopCode: leg.stop.code,
      board: isoSeconds(r.board),
      arrive: isoSeconds(r.arrive),
      note: r.note,
      walkS: leg.walkS,
      rideS: leg.rideS,
      ...offOf(leg),
      ...paidOf(leg),
      ...(r.change ? { change: r.change } : {}),
      ms: r.ms,
      worth,
      opens: r.opens === true,
    };
    if (!r.late && (!onTime || worth > onTime.worth || (worth === onTime.worth && onTime.estimated && !r.estimated))) onTime = out;
    const reach = r.arrive + fareMs(leg) + (leg.change ? TRANSFER.worthS * 1000 : 0);
    if (r.late && (!late || reach < late.reach || (reach === late.reach && r.ms < late.ms))) late = { ...out, reach };
  }
  if (onTime) return unranked(onTime);
  if (!late) return null;
  const { reach: _reach, ...first } = late;
  return { ...unranked(first), at: isoSeconds(first.opens ? first.ms : Math.min(first.ms, f.nowMs)) };
}

interface LegLeave {
  ms: number;
  board: number;
  arrive: number;
  estimated: boolean;
  stale: boolean;
  late: boolean;
  note: string | null;
  opens?: true;
  change?: BusChange;
}

const LOOKBACK_MS = 2 * 86_400_000;

function leavingBy(graph: Graph, sb: ServiceBoard, svc: string, fromMs: number, byMs: number, nowMs: number): Departure[] {
  const ask = (from: number) => departuresFrom(graph, sb, svc, { now: nowMs, from, until: byMs, around: byMs }).filter((d) => !d.partial);
  const near = byMs - LOOKBACK_MS;
  if (near <= fromMs) return ask(fromMs);
  const fits = ask(near);
  const begins = serviceResumesAt(graph, svc, near);
  return fits.length >= 2 && (begins === null || fits[fits.length - 2].earliest >= begins) ? fits : ask(fromMs);
}

interface Bus {
  atStop: number;
  board: number;
  latest: number;
  estimated: boolean;
  stale: boolean;
  opens?: true;
}

const busOf = (d: Departure): Bus => ({
  atStop: d.earliest,
  board: d.earliest,
  latest: d.latest,
  estimated: d.kind === 'estimate',
  stale: d.kind === 'stale',
  ...(d.opens ? { opens: true as const } : {}),
});

function forLeg(
  leg: Leg,
  sa: StopArrivals | undefined,
  graph: Graph,
  arriveBy: ArriveBy,
  nowMs: number,
  risk?: CrowdRisk,
): LegLeave | null {
  const walk = walkMs(leg);
  const venueWalkS = venueWalkOf(arriveBy, leg);
  const latestBoard = arriveBy.atMs - (ON_TIME_SLACK_S + venueWalkS + leg.rideS) * 1000;
  const arriveAfter = (boardMs: number) => boardMs + (leg.rideS + venueWalkS) * 1000;
  const earliest = nowMs + readyS(leg) * 1000;
  const at = (d: Departure, late: boolean, note: string | null): LegLeave => {
    const { atStop, board, latest, estimated, stale, opens } = busOf(d);
    return {
      ms: atStop - walk,
      board,
      arrive: arriveAfter(latest),
      estimated,
      stale,
      late,
      note,
      ...(late && opens ? { opens } : {}),
    };
  };

  const sb = serviceBoard(graph, sa, leg.svc, nowMs);
  const fits = leavingBy(graph, sb, leg.svc, earliest, latestBoard, nowMs);
  if (fits.length) {
    let b = fits[fits.length - 1];
    const crowd = crowdCheck(leg, b.latest, arriveBy, risk);
    const earlier = (crowd.earlier || arriveBy.oneEarlier === true) && fits.length > 1;
    if (earlier) b = fits[fits.length - 2];
    const note = crowd.earlier && fits.length === 1 ? crowd.warnOnly : (crowd.note ?? (earlier ? m().oneEarlierNote : null));
    return at(b, false, note);
  }
  const first = nextDeparture(graph, sb, leg.svc, earliest, nowMs);
  return first ? at(first, true, null) : null;
}

function firstBus(graph: Graph, svc: string, sa: ServiceBoard, fromMs: number, nowMs: number): Bus | null {
  const d = nextDeparture(graph, sa, svc, fromMs, nowMs);
  return d ? busOf(d) : null;
}

function lastBus(graph: Graph, svc: string, sa: ServiceBoard, fromMs: number, byMs: number, nowMs: number): Bus | null {
  const b = leavingBy(graph, sa, svc, fromMs, byMs, nowMs).at(-1);
  return b ? busOf(b) : null;
}

const changeOf = (t: NonNullable<Leg['change']>, reachMs: number, b2: Bus): BusChange => ({
  svc: svcName(t.svc),
  from: shortStop(t.at.name),
  fromCode: t.at.code,
  stop: shortStop(t.stop.name),
  stopCode: t.stop.code,
  ...(t.crossS > 0 ? { crossS: t.crossS } : {}),
  reach: isoSeconds(reachMs),
  board: isoSeconds(b2.board),
  rideS: t.rideS,
  estimated: b2.estimated || b2.stale,
});

function forTransfer(
  leg: Leg,
  sa1: StopArrivals | undefined,
  sa2: StopArrivals | undefined,
  graph: Graph,
  arriveBy: ArriveBy,
  nowMs: number,
): LegLeave | null {
  const t = leg.change!;
  const venueWalkS = venueWalkOf(arriveBy, leg);
  const walk = walkMs(leg);
  const ride1 = leg.rideS * 1000;
  const change = (t.crossS + TRANSFER.changeBufferS) * 1000;
  const after = (b2: Bus) => b2.latest + (t.rideS + venueWalkS) * 1000;

  const done = (b1: Bus, b2: Bus, late: boolean): LegLeave => ({
    ms: b1.atStop - walk,
    board: b1.board,
    arrive: after(b2),
    estimated: b1.estimated || b2.estimated,
    stale: b1.stale || b2.stale,
    late,
    note: null,
    ...(b1.opens ? { opens: true as const } : {}),
    change: changeOf(t, b1.latest + ride1, b2),
  });

  const sb1 = serviceBoard(graph, sa1, leg.svc, nowMs);
  const sb2 = serviceBoard(graph, sa2, t.svc, nowMs);
  const earliest1 = nowMs + readyS(leg) * 1000;
  const by2 = arriveBy.atMs - (ON_TIME_SLACK_S + venueWalkS + t.rideS) * 1000;
  const last2 = lastBus(graph, t.svc, sb2, earliest1 + ride1 + change, by2, nowMs);
  const last1 = last2 && lastBus(graph, leg.svc, sb1, earliest1, last2.atStop - change - ride1, nowMs);
  if (last1) {
    const b2 = firstBus(graph, t.svc, sb2, last1.latest + ride1 + change, nowMs);
    if (b2) return done(last1, b2, false);
  }
  const b1 = firstBus(graph, leg.svc, sb1, earliest1, nowMs);
  const b2 = b1 && firstBus(graph, t.svc, sb2, b1.latest + ride1 + change, nowMs);
  if (!b1 || !b2) return null;
  return done(b1, b2, after(b2) > arriveBy.atMs - ON_TIME_SLACK_S * 1000);
}

export type Departing = Leave & { bus: string };
const busKey = (svc: string, stop: string, change: { svc: string; stop: { code: string } } | undefined, bus: string) =>
  [svc, stop, change?.svc ?? '', change?.stop.code ?? '', bus].join('|');

export const publicLeave = ({ bus: _bus, ...l }: Leave & { bus?: string }): Leave => l;

export function departureOf(all: Departing[], o: ScoredOption): Departing | null {
  if (o.bus === undefined) return null;
  const key = busKey(o.svc, o.stop.code, o.change, o.bus);
  return all.find((l) => l.bus === key) ?? null;
}

const MAX_DEPARTURES = 150;
const CLASS_LOOKBACK_MS = 3 * 3_600_000;

export function departures(f: LeaveInput, untilMs: number, anchor?: { svc: string; stop: string; board: string } | null): Departing[] {
  const legs: Array<{ leg: Leg; endS: number }> = f.options.length
    ? f.options.map((o) => ({ leg: legOf(o), endS: f.endWalk?.(o) ?? 0 }))
    : f.arriveBy
      ? fallbackLegs(f.candidates, f.graph).map((leg) => ({ leg, endS: 0 }))
      : [];
  const out: Departing[] = [];
  for (const { leg, endS } of legs) {
    const sa = f.byStop.get(leg.stop.code);
    const t = leg.change;
    const sb = serviceBoard(f.graph, sa, leg.svc, f.nowMs);
    const sb2 = t ? serviceBoard(f.graph, f.byStop.get(t.stop.code), t.svc, f.nowMs) : null;
    const walk = walkMs(leg);
    const onS = f.arriveBy ? venueWalkOf(f.arriveBy, leg) : 0;
    const ready = f.nowMs + readyS(leg) * 1000;
    const latestBoard = f.arriveBy ? f.arriveBy.atMs - (ON_TIME_SLACK_S + onS + leg.rideS) * 1000 : null;
    const from = latestBoard === null ? ready : Math.max(ready, latestBoard - CLASS_LOOKBACK_MS);
    const chosenMs = anchor && anchor.svc === leg.svc && anchor.stop === leg.stop.code ? Date.parse(anchor.board) : undefined;
    const chosen = chosenMs !== undefined && chosenMs > f.nowMs ? chosenMs : undefined;
    const onTime =
      latestBoard !== null && latestBoard - headwayMs(f.graph, leg.svc, latestBoard - headwayMs(f.graph, leg.svc, latestBoard)) >= ready;
    const lined = chosen === undefined && onTime && !t;
    const around = chosen ?? (lined ? latestBoard! : undefined);
    const buses = departuresFrom(f.graph, sb, leg.svc, {
      now: f.nowMs,
      from,
      until: untilMs,
      max: MAX_DEPARTURES,
      ...(around !== undefined ? { around } : {}),
    });
    let prev: number | null = null;
    for (const d of buses) {
      if (d.earliest === prev) continue;
      prev = d.earliest;
      if (lined && d.partial) continue;
      const b = busOf(d);
      const b2 =
        t && sb2 ? firstBus(f.graph, t.svc, sb2, b.latest + leg.rideS * 1000 + (t.crossS + TRANSFER.changeBufferS) * 1000, f.nowMs) : null;
      if (t && !b2) break;
      out.push({
        at: isoSeconds(b.atStop - walk),
        estimated: b.estimated || Boolean(b2?.estimated),
        ...(b.stale || b2?.stale ? { stale: true as const } : {}),
        svc: svcName(leg.svc),
        stop: shortStop(leg.stop.name),
        stopCode: leg.stop.code,
        board: isoSeconds(b.board),
        arrive: isoSeconds(t && b2 ? b2.latest + (t.rideS + onS) * 1000 : b.latest + (leg.rideS + onS) * 1000),
        note: null,
        walkS: leg.walkS,
        rideS: leg.rideS,
        ...offOf(leg),
        ...(!f.arriveBy && endS > 0 ? { endWalkS: endS } : {}),
        ...paidOf(leg),
        ...(t && b2 ? { change: changeOf(t, b.latest + leg.rideS * 1000, b2) } : {}),
        bus: busKey(leg.svc, leg.stop.code, leg.change, d.id),
      });
    }
  }
  return out;
}

function crowdCheck(
  leg: Leg,
  atMs: number,
  arriveBy: ArriveBy,
  risk?: CrowdRisk,
): { earlier: boolean; note: string | null; warnOnly: string | null } {
  const r = risk?.(leg.svc, leg.stop.code, atMs);
  if (r == null || r < OFTEN_PACKED) return { earlier: false, note: null, warnOnly: null };
  const where = shortStop(leg.stop.name);
  const busy = m().oftenBusy(leg.svc, where);
  const warnOnly = m().mayBeFull(busy);
  if (arriveBy.fullBusMargin === false) return { earlier: false, note: warnOnly, warnOnly };
  return { earlier: true, note: m().soOneEarlier(busy), warnOnly };
}

function fallbackLegs(cands: Candidate[], graph: Graph): Leg[] {
  return cands.flatMap((c) =>
    c.legs.map((l) => ({
      svc: l.svc,
      stop: c.stop,
      walkS: c.walkS,
      ...(c.here ? { here: true as const } : {}),
      rideS: legRideS(l),
      off: l.off,
      to: l.to,
      ...(isPublic(graph, l.svc) ? { paid: true as const } : {}),
    })),
  );
}
