/**
 * Direction resolution.
 *
 * NUS stops come in directional pairs metres apart ("Kent Ridge MRT" / "Opp
 * Kent Ridge MRT"). That gap is inside GPS error near dense buildings, so
 * picking the nearer stop is wrong roughly half the time -- and it is the
 * specific wrong answer that makes you miss a bus you can see.
 *
 * So: never rank by distance. Rank by whether the destination is genuinely
 * downstream in the scraped route sequence, and score walking and riding in
 * the same unit (seconds) so the trade-off is legible.
 */

import { termDay } from './calendar.ts';
import type {
  Arrival,
  Candidate,
  Crowd,
  FeedState,
  Graph,
  GraphIndex,
  Leg,
  Quality,
  ResolveInput,
  RouteIndex,
  ScoredOption,
  ServiceHours,
  Stop,
  StopArrivals,
} from './types.ts';
import { DEFAULT_HEADWAY_S, PUBLIC, RIDE, WALK, isMeasured, sgt } from './config.ts';
import { ROUTE_COLORS } from './campus.ts';
import { haversineM } from './geo.ts';
import { isPublic, publicRideS, rideMetres, svcName } from './public.ts';
import { footM, stopFootM } from './walk.ts';
import { mins } from './format.ts';
import { listOf, m } from './i18n.ts';
import { type HomeWalk, residenceStops } from './residences.ts';

export { haversineM };

const indexCache = new WeakMap<Graph, GraphIndex>();

export function indexGraph(graph: Graph): GraphIndex {
  const hit = indexCache.get(graph);
  if (hit) return hit;

  const byCode = new Map<string, Stop>();
  for (const s of graph.stops) byCode.set(s.code, s);

  const routes = new Map<string, RouteIndex>();
  for (const [svc, raw] of Object.entries(graph.routes ?? {})) {
    let seq = raw.slice();
    const closes = seq.length > 2 && seq[0] === seq[seq.length - 1];
    const loop = graph.loops?.[svc] ?? closes;
    if (closes) seq = seq.slice(0, -1);
    const pos = new Map<string, number[]>();
    seq.forEach((code, i) => {
      const at = pos.get(code);
      if (at) at.push(i);
      else pos.set(code, [i]);
    });
    routes.set(svc, { seq, loop, pos });
  }

  const servingStop = new Map<string, string[]>();
  for (const [svc, r] of routes) {
    for (const code of new Set(r.seq)) {
      const at = servingStop.get(code);
      if (at) at.push(svc);
      else servingStop.set(code, [svc]);
    }
  }

  const idx: GraphIndex = { graph, byCode, routes, servingStop };
  indexCache.set(graph, idx);
  return idx;
}

/**
 * Is `to` genuinely downstream of `from` on `svc`?
 *
 * Linear route: only if it comes later in the sequence. Loop route: always,
 * by wrapping -- but the hop count blows up, and the scorer converts hops to
 * seconds, so riding the wrong way round loses on cost rather than on a
 * special case. Returns null when unreachable.
 */
/** Riding, plus the walk back across the road when the bus stops on the far side. */
export function legRideS(leg: Leg): number {
  return (leg.rideS ?? leg.hops * RIDE.secondsPerHop) + (leg.crossS ?? 0);
}

/**
 * `through` when the ride goes on past the loop's terminal: the run ends
 * there (the feed lists a shuttle's under an -E berth, and a public loop
 * ends at its interchange), so it's the next run on from there, not the
 * same bus. A shuttle loop starts at its terminal; a public one's
 * interchange can be off campus, between its last campus stop and its first.
 */
export function reach(idx: GraphIndex, svc: string, from: string, to: string): { hops: number; through?: true } | null {
  if (from === to) return { hops: 0 };
  const r = idx.routes.get(svc);
  if (!r) return null;
  const fromAt = r.pos.get(from);
  const toAt = r.pos.get(to);
  if (!fromAt || !toAt) return null;

  const origin = idx.graph.public?.[svc]?.origin;
  const endsAtFirst = origin === undefined || origin === r.seq[0];
  let best = Infinity;
  let through = false;
  const n = r.seq.length;
  for (const i of fromAt) {
    for (const j of toAt) {
      const hops = j > i ? j - i : r.loop ? j - i + n : Infinity;
      if (hops < best) {
        best = hops;
        // Wrapping round to the terminal itself is getting off there; to any stop after it, riding on.
        through = j < i && (j > 0 || !endsAtFirst);
      }
    }
  }
  if (best === Infinity) return null;
  return through ? { hops: best, through: true } : { hops: best };
}

/**
 * Seconds riding `svc` along `stops`: `perHop` a stop, but no faster than
 * RIDE.longHopMs over a long one. Route P's stops are kilometres apart
 * (Kent Vale to the Bukit Timah campus), where a count of stops says
 * minutes for a ride of a quarter of an hour.
 */
export function shuttleRideS(idx: GraphIndex, stops: string[], perHop: number): number {
  let s = 0;
  for (let k = 1; k < stops.length; k++) {
    const a = idx.byCode.get(stops[k - 1]);
    const b = idx.byCode.get(stops[k]);
    const m = a && b ? haversineM(a.lat, a.lon, b.lat, b.lon) : 0;
    s += Math.max(perHop, m / RIDE.longHopMs);
  }
  return Math.round(s);
}

/**
 * The stops ridden on `svc` from `from` to `to`, both included, the same way
 * round as `reach` counts them (the fewest hops, wrapping on a loop). Null
 * when `to` isn't downstream.
 */
export function rideStops(idx: GraphIndex, svc: string, from: string, to: string): string[] | null {
  const r = idx.routes.get(svc);
  const fromAt = r?.pos.get(from);
  const toAt = r?.pos.get(to);
  if (!r || !fromAt || !toAt) return from === to ? [from] : null;
  const n = r.seq.length;
  let best: { i: number; hops: number } | null = null;
  for (const i of fromAt) {
    for (const j of toAt) {
      const hops = j >= i ? j - i : r.loop ? j - i + n : Infinity;
      if (hops !== Infinity && (!best || hops < best.hops)) best = { i, hops };
    }
  }
  if (!best) return null;
  return Array.from({ length: best.hops + 1 }, (_, k) => r.seq[(best.i + k) % n]);
}

/** The user's walk from home to their home stops, in metres at their pace, when they've said it. */
function homeWalk(input: ResolveInput): HomeWalk | null {
  if (input.homeWalkS == null || !input.preferStops?.length) return null;
  return { stops: input.preferStops, m: input.homeWalkS * (input.walkSpeedMs ?? WALK.speedMs) };
}

/**
 * Stops worth fetching arrivals for. Bounded by WALK.maxCandidates so one
 * request never fans out into a dozen upstream calls.
 */
export function candidateStops(graph: Graph, input: ResolveInput): Candidate[] {
  const idx = indexGraph(graph);
  const { to } = input;

  // Either side of the road will do: arriving at "Opp UHC" gets you to UHC.
  // Without this, a route that only serves the far side never counts, and
  // the answer takes a longer bus to the exact stop. Getting off on the far
  // side costs the walk back across, which is part of the journey.
  // Every stop that serves the destination, and the far side of each road.
  const speed = input.walkSpeedMs ?? WALK.speedMs;
  const targets: Array<{ code: string; crossS: number }> = to
    ? [to, ...(input.toAlso ?? [])].flatMap((code) => {
        const s = idx.byCode.get(code);
        if (!s) return [];
        const twin = s.opposite ? idx.byCode.get(s.opposite) : undefined;
        return [{ code, crossS: 0 }, ...(twin ? [{ code: twin.code, crossS: Math.round(stopFootM(twin, s) / speed) }] : [])];
      })
    : [];
  const targetCodes = new Set(targets.map((t) => t.code));
  // A stop worth a fetch: some bus from it goes there (any stop, with no destination).
  const reaches = (stop: Stop) =>
    !to || (!targetCodes.has(stop.code) && (idx.servingStop.get(stop.code) ?? []).some((svc) => targets.some((t) => reach(idx, svc, stop.code, t.code))));

  let base: Array<{ stop: Stop; distM: number; footM: number }>;
  const home = input.lat != null && input.lon != null ? residenceStops(input.lat, input.lon, idx.byCode, homeWalk(input)) : null;
  if (home) {
    base = home;
  } else if (input.lat != null && input.lon != null) {
    // Range is the straight line; the walk itself follows the paths.
    const all = graph.stops
      .map((stop) => ({ stop, distM: haversineM(input.lat!, input.lon!, stop.lat, stop.lon) }))
      .sort((a, b) => a.distM - b.distM)
      .map((c) => ({ ...c, footM: footM(input.lat!, input.lon!, c.stop) }));
    const inRange = all.filter((c) => c.distM <= WALK.maxRadiusM);
    // The nearest few shuttle stops that go there, and the nearest stop only
    // public buses call at as one more: turning public buses on adds
    // options and never crowds a shuttle stop out of the answer. A closer
    // stop no bus to the destination calls at would only take a fetch and
    // push out one that does.
    const shuttle = inRange.filter((c) => !c.stop.public);
    const near = shuttle.filter((c) => reaches(c.stop)).slice(0, WALK.maxCandidates);
    const publicOnly = inRange.find((c) => c.stop.public && reaches(c.stop));
    if (publicOnly) near.push(publicOnly);
    // A user's usual stops (near home) join the set when in range, so a dense
    // cluster of closer stops cannot push out the one they actually use.
    for (const code of input.preferStops ?? []) {
      const c = all.find((x) => x.stop.code === code);
      if (c && c.distM <= WALK.maxRadiusM && !near.includes(c)) near.push(c);
    }
    // Never answer "no stop nearby" -- degrade to the nearest one, however far.
    base = near.length ? near : shuttle.length ? shuttle.slice(0, 1) : all.slice(0, 1);
  } else {
    const stop = input.originCode ? idx.byCode.get(input.originCode) : undefined;
    if (!stop) return [];
    // Starting from home: the walk to the stop decides which bus is catchable.
    base = [{ stop, distM: 0, footM: 0 }];
    // The far side of the road, a crossing further: the bus you want may
    // only call there, and nothing says which side you'll come out on.
    const twin = stop.opposite ? idx.byCode.get(stop.opposite) : undefined;
    if (twin) base.push({ stop: twin, distM: haversineM(stop.lat, stop.lon, twin.lat, twin.lon), footM: stopFootM(stop, twin) });
    // From home, every home stop: the walk from home (originWalkS) is to each.
    if (input.preferStops?.includes(stop.code)) {
      for (const code of input.preferStops) {
        const s = idx.byCode.get(code);
        if (s && !base.some((b) => b.stop.code === code)) base.push({ stop: s, distM: 0, footM: 0 });
      }
    }
  }

  const out: Candidate[] = base.map(({ stop, distM, footM: foot }) => {
    const legs = [];
    // Standing at the destination is not a boarding option. reach() returns
    // 0 hops for from === to, which would otherwise rank first every time.
    const services = to && targetCodes.has(stop.code) ? [] : (idx.servingStop.get(stop.code) ?? []);
    for (const svc of services) {
      if (!to) {
        legs.push({ svc, hops: 0 });
        continue;
      }
      // Where to get off: the stop that gets you there soonest, crossing included.
      let best: { hops: number; crossS: number; code: string; rideS?: number } | null = null;
      // Seconds a stop on this service: measured when there are enough rides (ridetimes.ts).
      const perHop = input.hopS?.(svc) ?? RIDE.secondsPerHop;
      // A public bus rides by the metres along its route (public.ts): its
      // campus stops can be a long way round the island apart.
      const pub = isPublic(graph, svc);
      const cost = (b: { hops: number; crossS: number; rideS?: number }) => (b.rideS ?? b.hops * RIDE.secondsPerHop) + b.crossS;
      for (const t of targets) {
        const r = reach(idx, svc, stop.code, t.code);
        if (!r) continue;
        const m = pub ? rideMetres(idx, svc, stop.code, t.code) : null;
        const stops = m === null ? rideStops(idx, svc, stop.code, t.code) : null;
        let rideS = m !== null ? publicRideS(m) : stops ? shuttleRideS(idx, stops, perHop) : r.hops * perHop;
        // Past the terminal it's the next run: about a headway's wait there.
        if (r.through) rideS += headwayFor(graph, svc);
        const cand = { hops: r.hops, crossS: t.crossS, code: t.code, ...(rideS !== r.hops * RIDE.secondsPerHop ? { rideS } : {}) };
        if (!best || cost(cand) < cost(best)) best = cand;
      }
      if (best) legs.push({ svc, hops: best.hops, ...(best.rideS !== undefined ? { rideS: best.rideS } : {}), ...(best.crossS ? { crossS: best.crossS, off: idx.byCode.get(best.code)! } : {}), to: idx.byCode.get(best.code)! });
    }
    // Starting from home or a room without coordinates: that walk comes
    // first, and a crossing to the far side's stop after it.
    const walkS = input.lat != null ? Math.round(foot / speed) : (input.originWalkS ?? 0) + Math.round(foot / speed);
    return { stop, distM, walkS, legs };
  });

  const useful = out.filter((c) => c.legs.length > 0);
  // If nothing here reaches the destination, keep the nearest stop so the
  // formatter can still offer a walk instead of a blank tile.
  return useful.length ? useful : out.slice(0, 1);
}

/** Minutes past midnight, or null if this is not an HH:MM string. */
export function hhmmToMin(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(v.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Merge hand-maintained hours over whatever the scraper produced.
 *
 * Only well-formed entries win, so a half-filled template cannot clobber real
 * data with `["", ""]`.
 */
export function mergeServiceHours(
  base: Record<string, ServiceHours> | undefined,
  hand: Record<string, unknown> | undefined,
): Record<string, ServiceHours> {
  const out: Record<string, ServiceHours> = { ...base };
  for (const [svc, value] of Object.entries(hand ?? {})) {
    if (svc.startsWith('_') || !value || typeof value !== 'object') continue;
    const src = value as Record<string, unknown>;
    const merged: ServiceHours = { ...out[svc] };
    let touched = false;
    for (const day of ['weekday', 'saturday', 'sunday'] as const) {
      if (!(day in src)) continue;
      const win = src[day];
      // [null, null] is how the file says it too: closed at both ends.
      if (win === null || (Array.isArray(win) && win.length === 2 && win[0] === null && win[1] === null)) {
        merged[day] = null; // an explicit "does not run"
        touched = true;
      } else if (
        Array.isArray(win) &&
        hhmmToMin(win[0]) !== null &&
        hhmmToMin(win[1]) !== null
      ) {
        merged[day] = [String(win[0]), String(win[1])];
        touched = true;
      }
      // Anything else -- ["", ""], a typo, a number -- is left unset, which
      // reads downstream as "hours unknown, assume running".
    }
    if (touched) out[svc] = merged;
  }
  return out;
}

/** The window `hours` gives the SGT day `ms` falls on: Sunday hours on public holidays. */
function windowOn(hours: ServiceHours, ms: number): ServiceHours['weekday'] | undefined {
  const { day } = sgt(ms);
  // NUS runs the Sunday timetable on public holidays. Without this a holiday
  // morning gets a headway guess for services that are not running.
  const sunday = day === 0 || termDay(ms).holiday !== null;
  return sunday ? hours.sunday : day === 6 ? hours.saturday : hours.weekday;
}

/** A window's open and close in minutes, or null when it isn't a usable window. */
function parseWindow(win: ServiceHours['weekday'] | undefined): { open: number; close: number } | null {
  if (!win) return null;
  const open = hhmmToMin(win[0]);
  const close = hhmmToMin(win[1]);
  return open === null || close === null ? null : { open, close };
}

/**
 * Minutes into today that yesterday's window still runs, when it crosses
 * midnight (Fri 07:00 -> 01:00 runs until 01:00 on Saturday). 0 otherwise.
 */
function yesterdayRunsUntil(hours: ServiceHours, nowMs: number): number {
  const y = parseWindow(windowOn(hours, nowMs - 86_400_000));
  return y && y.close < y.open ? y.close : 0;
}

/** Is `svc` inside its published operating window right now (SGT)? */
export function inService(graph: Graph, svc: string, nowMs: number): boolean {
  const hours: ServiceHours | undefined = graph.serviceHours?.[svc];
  if (!hours) return true; // unknown hours: assume running, let the feed decide
  const { minutes } = sgt(nowMs);
  // Just past midnight: still yesterday's service, by yesterday's hours.
  if (minutes < yesterdayRunsUntil(hours, nowMs)) return true;
  const win = windowOn(hours, nowMs);
  if (win === null) return false; // explicitly does not run today
  if (!win) return true; // hours unknown: assume running, let the feed decide
  const w = parseWindow(win);
  // An unparseable window is unknown, NOT "ended all day". Getting this
  // backwards would turn a half-filled template into a Worker that reports no
  // buses ever, which is a far worse failure than reporting them at 3am.
  if (!w) return true;
  // A window that crosses midnight runs from its open to the end of today;
  // the rest belongs to tomorrow (above).
  return w.close >= w.open ? minutes >= w.open && minutes < w.close : minutes >= w.open;
}

/**
 * When `svc` stops running (SGT), epoch ms: the close of the window it's in
 * now. Null when the hours are unknown or it isn't running now. A window
 * that crosses midnight closes tomorrow.
 */
export function serviceEndsAt(graph: Graph, svc: string, nowMs: number): number | null {
  if (!inService(graph, svc, nowMs)) return null;
  const hours: ServiceHours | undefined = graph.serviceHours?.[svc];
  if (!hours) return null;
  const { minutes } = sgt(nowMs);
  const midnight = nowMs - (minutes * 60_000 + (nowMs % 60_000));
  const tail = yesterdayRunsUntil(hours, nowMs);
  if (minutes < tail) return midnight + tail * 60_000;
  const w = parseWindow(windowOn(hours, nowMs));
  if (!w) return null;
  return midnight + ((w.close >= w.open ? 0 : 1440) + w.close) * 60_000;
}

/** Why a service isn't running now: it has finished for today, it starts
 *  later today, or it doesn't run today at all. */
export type StoppedReason = 'ended' | 'notYet' | 'noService';

/** How far ahead serviceResumesAt looks: past a week, so a service off for a weekend and a holiday still has a next start. */
const RESUME_DAYS = 8;

/**
 * Why `svc` isn't running now (SGT), or null when it is, by inService's
 * rules: unknown hours count as running, Sunday hours on public holidays.
 */
export function stoppedReason(graph: Graph, svc: string, nowMs: number): StoppedReason | null {
  if (inService(graph, svc, nowMs)) return null;
  const hours = graph.serviceHours?.[svc];
  const w = hours ? parseWindow(windowOn(hours, nowMs)) : null;
  if (!w) return 'noService';
  return sgt(nowMs).minutes < w.open ? 'notYet' : 'ended';
}

/**
 * When `svc` next starts running (SGT), epoch ms: the first opening after
 * now, today or up to RESUME_DAYS ahead, by each day's hours (Sunday's on a
 * public holiday). Null when the hours are unknown or none open in that time.
 */
export function serviceResumesAt(graph: Graph, svc: string, nowMs: number): number | null {
  const hours = graph.serviceHours?.[svc];
  if (!hours) return null;
  const { minutes } = sgt(nowMs);
  const midnight = nowMs - (minutes * 60_000 + (nowMs % 60_000));
  for (let d = 0; d <= RESUME_DAYS; d++) {
    const day = midnight + d * 86_400_000;
    const w = parseWindow(windowOn(hours, day));
    if (w && day + w.open * 60_000 > nowMs) return day + w.open * 60_000;
  }
  return null;
}

/**
 * Pick the boardable rows when one service reports under several berths.
 *
 * Returns everything unchanged for the ordinary single-berth stop. When the
 * suffix cannot tell the berths apart, says so instead of guessing: that is
 * the one case where the earliest ETA might be a bus going the wrong way.
 */
export function resolveBerths(rows: Arrival[]): { usable: Arrival[]; ambiguousBerth: boolean } {
  // Drop the run that TERMINATES here rather than preferring the one marked
  // -S: route P starts at a bare `KV` and ends at `KV-P-E`, so a start suffix
  // is not guaranteed but an end suffix is what makes a row unboardable.
  const notEnding = rows.filter((a) => !a.ends);

  // Every run terminates here and none departs. Show them, but do not pretend
  // to be confident about a bus that ends its journey as you reach it.
  if (!notEnding.length) return { usable: rows, ambiguousBerth: rows.length > 0 };

  const distinct = new Set(notEnding.map((a) => a.berth).filter((b) => b != null));
  return { usable: notEnding, ambiguousBerth: distinct.size > 1 };
}

export function headwayFor(graph: Graph, svc: string): number {
  return graph.headwayS?.[svc] ?? DEFAULT_HEADWAY_S;
}

/**
 * The state of the feed a service's arrivals came from. A shelter both the
 * shuttle and public buses call at was asked of two feeds, and one can be
 * down or stale while the other answers; a stop asked of one feed is that
 * feed's state. Undefined when the stop was never asked.
 */
export function feedFor(sa: StopArrivals | undefined, pub: boolean): FeedState | undefined {
  if (!sa) return undefined;
  return sa.feeds?.[pub ? 'public' : 'shuttle'] ?? sa;
}

export interface BoardRow {
  /** What's on the bus ("D2", "151"). */
  svc: string;
  /** Seconds until arrival. null means "no live time to show", never 0. */
  etaS: number | null;
  quality: Quality;
  ambiguousBerth: boolean;
  /** A public bus, with a fare. Absent for a shuttle. */
  paid?: true;
  /** The buses after that one, soonest first, as far as the feed knows them,
   *  each with its time in words (`eta`, as the row's). */
  later: { etaS: number; quality: Quality; eta: string }[];
  /** The service's colour (#rrggbb), as on the buses; null for one NUS hasn't painted. */
  color: string | null;
  /** Where it goes from here: the next stop's name, then the stop the route
   *  ends at. One name when they're the same; none at the end of the line. */
  towards: string[];
  /** How full the first bus is, from the feed; null when it doesn't say. */
  crowd: Crowd | null;
  /** When the service stops running today (ISO); null when its hours are unknown. */
  endsAt: string | null;
  /** False only on a row for a service outside its hours, listed when asked for (`stopped`). */
  running: boolean;
  /** Why it isn't running. Only on a row that isn't. */
  stopped?: StoppedReason;
  /** When it next starts (ISO), or null when no start is found. Only on a row that isn't running. */
  resumesAt?: string | null;
  /** `etaS` in words: "4 min", "now", "~6 min" for a timetable time. Null with no time. */
  eta: string | null;
  /** The next few buses after it: "then 12, ~20 min". Null when the feed gives none.
   *  Not called `then`, which would make a row look like a promise to `await`. */
  laterText: string | null;
  /** `towards` in words: "to Central Library, Kent Vale"; "Ends here" at the end of the line. */
  toText: string;
}

/** How many later buses a row's `then` names: more is noise on a phone. */
export const THEN_MAX = 3;

/** A time on a board, in words: a timetable time is marked as an estimate ("~6 min"), but not "now", which "~" can't make vaguer. */
export function etaText(etaS: number, quality: Quality): string {
  const t = mins(etaS);
  return quality === 'scheduled' && t !== m().now ? m().approx(t) : t;
}

/**
 * "then 12, ~20 min": the later buses as whole minutes (never under 1, as a
 * row's own time never says "0 min"), each timetable one marked. Null with none.
 */
export function thenText(later: { etaS: number; quality: Quality }[]): string | null {
  if (!later.length) return null;
  const n = (s: number) => String(Math.max(1, Math.round(s / 60)));
  return m().thenMin(listOf(later.slice(0, THEN_MAX).map((x) => (x.quality === 'scheduled' ? m().approx(n(x.etaS)) : n(x.etaS)))));
}

/** `towards` in words (see BoardRow.toText). */
export function towardsText(towards: string[]): string {
  if (!towards.length) return m().endsHere;
  return towards.length > 1 ? m().towardsTwo(towards[0], towards[1]) : m().towardsOne(towards[0]);
}

/** A stop's name as a sign would give it ("Central Library", not "CLB"). */
export const displayName = (stop: Stop | undefined, code: string): string => stop?.longName ?? stop?.name ?? code;

/**
 * Where `svc` goes from `stopCode`: [the next stop, the stop the route ends
 * at], by name. A loop runs on from its last stop to its first, and ends
 * where it started. At the end of a line there is nowhere on to go: [].
 * A stop the route calls at twice is taken at its first call.
 */
export function towardsFrom(idx: GraphIndex, svc: string, stopCode: string): string[] {
  const r = idx.routes.get(svc);
  const at = r?.pos.get(stopCode);
  if (!r || !at) return [];
  const nextOf = (i: number): number | null => (i + 1 < r.seq.length ? i + 1 : r.loop ? 0 : null);
  const n = nextOf(at[0]);
  if (n === null) return [];
  const next = r.seq[n];
  const end = r.loop ? r.seq[0] : r.seq[r.seq.length - 1];
  const codes = next === end ? [next] : [next, end];
  return codes.map((c) => displayName(idx.byCode.get(c), c));
}

/**
 * What is coming at a single stop, for every service that stops there --
 * the map's tap-a-stop popover. Deliberately destination-less: no walk time,
 * no hops, no "can I reach it" cutoff, because the visitor is already
 * standing there (or checking before they leave), not racing to catch one.
 * Shares its quality ladder and berth handling with scoreOptions() so a stop
 * never disagrees with itself between the Now answer and the map.
 *
 * A service outside its hours with no time from the feed is left out, or,
 * with `stopped`, listed after the others as not running, with why and when
 * it starts again. One the feed still gives a time for is running: the feed
 * is what's on the road, the hours only a guide.
 */
export function boardAt(
  graph: Graph,
  idx: GraphIndex,
  stopCode: string,
  sa: StopArrivals | undefined,
  nowMs: number,
  opts: { stopped?: boolean } = {},
): BoardRow[] {
  const services = idx.servingStop.get(stopCode) ?? [];
  const out: BoardRow[] = [];

  for (const svc of services) {
    const pub = isPublic(graph, svc);
    const feed = feedFor(sa, pub);
    const available = feed !== undefined && feed.available !== false;
    const forSvc = (sa?.arrivals ?? []).filter((a) => a.svc === svc);
    const { usable, ambiguousBerth } = resolveBerths(forSvc);
    const etas = usable
      .filter((a) => a.etaS != null)
      .sort((a, b) => (a.etaS as number) - (b.etaS as number));

    let quality: Quality;
    let etaS: number | null = null;
    if (etas.length) {
      // A time from the operator's timetable is an estimate, not a bus seen.
      quality = etas[0].scheduled ? 'scheduled' : 'live';
      etaS = etas[0].etaS;
    } else if (!inService(graph, svc, nowMs)) {
      if (!opts.stopped) continue; // not running: left out unless asked for
      const resumes = serviceResumesAt(graph, svc, nowMs);
      out.push({
        svc: svcName(svc),
        etaS: null,
        quality: 'ended',
        ambiguousBerth: false,
        ...(pub ? { paid: true as const } : {}),
        later: [],
        color: ROUTE_COLORS[svcName(svc)] ?? null,
        towards: towardsFrom(idx, svc, stopCode),
        crowd: null,
        endsAt: null,
        running: false,
        stopped: stoppedReason(graph, svc, nowMs) ?? 'ended',
        resumesAt: resumes === null ? null : new Date(resumes).toISOString(),
        eta: null,
        laterText: null,
        toText: towardsText(towardsFrom(idx, svc, stopCode)),
      });
      continue;
    } else if (!available) {
      quality = 'unknown';
    } else {
      quality = 'scheduled';
    }
    // Only a real arrival goes stale; a guess stays a guess.
    const aged = (q: Quality): Quality => (feed?.stale && q === 'live' ? 'stale' : q);
    quality = aged(quality);
    // Each later bus keeps its own quality: a timetabled one after a live one stays a guess.
    const later = etas.slice(1).map((a) => {
      const q = aged(a.scheduled ? 'scheduled' : 'live');
      return { etaS: a.etaS as number, quality: q, eta: etaText(a.etaS as number, q) };
    });
    const towards = towardsFrom(idx, svc, stopCode);

    const ends = serviceEndsAt(graph, svc, nowMs);
    out.push({
      svc: svcName(svc),
      etaS,
      quality,
      ambiguousBerth,
      ...(pub ? { paid: true as const } : {}),
      later,
      color: ROUTE_COLORS[svcName(svc)] ?? null,
      towards,
      crowd: etas[0]?.crowd ?? null,
      endsAt: ends === null ? null : new Date(ends).toISOString(),
      running: true,
      // Worded here, so every client says the same: the apps used to each
      // build these from the numbers, and drifted.
      eta: etaS === null ? null : etaText(etaS, quality),
      laterText: thenText(later),
      toText: towardsText(towards),
    });
  }

  out.sort(
    (a, b) =>
      // Not running: after every service that is, by name.
      Number(a.running === false) - Number(b.running === false) ||
      Number(isMeasured(b.quality)) - Number(isMeasured(a.quality)) ||
      (a.etaS ?? Infinity) - (b.etaS ?? Infinity) ||
      a.svc.localeCompare(b.svc),
  );
  return out;
}

/**
 * Convert candidates plus live arrivals into ranked options, all in seconds
 * from now. Options whose service has ended are dropped entirely, and so is
 * a guessed bus after the service stops for the day.
 */
export function scoreOptions(
  graph: Graph,
  candidates: Candidate[],
  arrivalsByStop: Map<string, StopArrivals>,
  nowMs: number,
  /** The walk on from where an option gets you off to the place itself: a
   *  food court's stops are different walks from it, so it counts in the ranking. */
  endWalk: (o: ScoredOption) => number = () => 0,
  /** `openBy`: a service not running yet that starts before this (epoch ms)
   *  is kept, its first bus guessed from its start. For a class: at 06:30 the
   *  08:00 class's bus is the D2 that starts at 07:15, not "Services ended". */
  opts: { openBy?: number } = {},
): ScoredOption[] {
  const out: ScoredOption[] = [];

  for (const c of candidates) {
    const sa = arrivalsByStop.get(c.stop.code);
    for (const leg of c.legs) {
      const forSvc = (sa?.arrivals ?? []).filter((a) => a.svc === leg.svc);

      // At a terminus the feed splits one service into two berths: COM3-D2-S
      // is the run STARTING here, COM3-D2-E is a run ENDING here. Only the
      // first is boardable. Nothing orders them: whenever no bus is waiting
      // to depart, the -E arrival is the sooner of the two, and the earliest
      // ETA hands you a bus that terminates on arrival. Prefer -S always.
      const { usable, ambiguousBerth } = resolveBerths(forSvc);

      const etas = usable
        .filter((a) => a.etaS != null)
        .sort((a, b) => (a.etaS as number) - (b.etaS as number));

      // The feed this service's arrivals came from: at a shelter the shuttle
      // and public buses share, each feed's own fetch time and state.
      const pub = isPublic(graph, leg.svc);
      const feed = feedFor(sa, pub);
      // Times here count from when the arrivals were fetched (departsAt is
      // fetchedAt + boardS), so the walk counts from then too: a bus that
      // left while a cached or stale answer aged can't be caught.
      const fetchedAt = feed?.fetchedAt ?? nowMs;
      const ageS = Math.max(0, (nowMs - fetchedAt) / 1000);
      const earliest = c.walkS + WALK.boardBufferS + ageS;
      // A missing entry means we never reached the feed -- not that no bus is
      // coming. Those are different answers and must not collapse into one.
      const available = feed !== undefined && feed.available !== false;
      let boardS: number;
      let quality: ScoredOption['quality'];
      let arrival = null;
      // Waiting for the service to start, which you can do wherever you are.
      let opensInS = 0;
      // When the service stops today, for the guesses below: a bus guessed
      // after it is no bus. Null when its hours are unknown or it isn't running.
      const running = inService(graph, leg.svc, nowMs);
      const endsAt = serviceEndsAt(graph, leg.svc, nowMs);
      const pastEnd = (s: number) => endsAt !== null && fetchedAt + s * 1000 > endsAt;

      // The first bus you can physically reach, not the first bus listed.
      const catchable = etas.find((a) => (a.etaS as number) >= earliest);
      if (catchable) {
        boardS = catchable.etaS as number;
        // A time from the operator's timetable (a public bus not yet on the
        // road) is an estimate, however exact it looks.
        quality = catchable.scheduled ? 'scheduled' : 'live';
        arrival = catchable;
      } else if (etas.length && running) {
        // Every listed bus leaves before you can get there: the first one
        // after the last listed, a headway apart, that you can reach. Not
        // once the service has closed: the feed still lists its last buses,
        // and there is no bus after them to guess (below).
        const headway = headwayFor(graph, leg.svc);
        boardS = (etas[etas.length - 1].etaS as number) + headway;
        if (headway > 0 && boardS < earliest) boardS += Math.ceil((earliest - boardS) / headway) * headway;
        if (pastEnd(boardS)) continue; // that was the last bus
        quality = 'scheduled';
      } else if (!running) {
        // The published hours are ours, not the feed's, so this holds even
        // when we have no data at all, or only buses you can't reach.
        const opens = opts.openBy !== undefined ? serviceResumesAt(graph, leg.svc, nowMs) : null;
        if (opens === null || opens > opts.openBy!) continue; // ended, or not started in time
        // It starts before you need it: a bus somewhere in the headway after
        // it does, or after you reach the stop, whichever is later.
        const startS = (opens - fetchedAt) / 1000;
        opensInS = Math.max(0, startS - earliest);
        boardS = Math.max(earliest, startS) + headwayFor(graph, leg.svc) / 2;
        quality = 'scheduled';
      } else {
        // You'd reach the stop after the last bus.
        if (pastEnd(earliest)) continue;
        // The feed answered and had nothing: a headway is the honest guess,
        // no later than the last bus. Unreached: keep the option -- the
        // graph still says this service goes where you are going -- but
        // boardS here is only an ordering key. The formatter must never
        // print a time for an 'unknown' option.
        boardS = earliest + headwayFor(graph, leg.svc) / 2;
        if (pastEnd(boardS)) boardS = (endsAt! - fetchedAt) / 1000;
        quality = available ? 'scheduled' : 'unknown';
      }

      // Only a real arrival goes stale; a headway guess stays a guess, never
      // ranked or worded as measured.
      if (feed?.stale && quality === 'live') quality = 'stale';

      // From now: the times above count from the fetch, and a cached or
      // stale answer is that much older. Comparing them with a walk that
      // starts now, or with another stop's fresher times, needs one clock.
      const fromNow = Math.round(boardS - ageS);
      const rideS = legRideS(leg);
      out.push({
        stop: c.stop,
        svc: leg.svc,
        distM: c.distM,
        walkS: c.walkS,
        hops: leg.hops,
        boardS: fromNow,
        rideS,
        totalS: fromNow + rideS,
        quality,
        arrival,
        fetchedAt,
        fromMs: nowMs,
        ...(opensInS > 0 ? { opensInS: Math.round(opensInS) } : {}),
        ambiguousBerth,
        ...(leg.off ? { off: leg.off } : {}),
        ...(leg.to ? { to: leg.to } : {}),
        ...(pub ? { paid: true as const } : {}),
      });
    }
  }

  // Measurements beat estimates outright; within a tier, time to the place
  // itself decides, a public bus's fare counting as PUBLIC.fareWorthS of it:
  // it wins only when it clearly saves time over the free shuttle.
  const costS = (o: ScoredOption) => o.totalS + endWalk(o) + (o.paid ? PUBLIC.fareWorthS : 0);
  out.sort(
    (a, b) =>
      Number(isMeasured(b.quality)) - Number(isMeasured(a.quality)) ||
      costS(a) - costS(b) ||
      a.walkS - b.walkS ||
      a.svc.localeCompare(b.svc),
  );
  // A live public bus outranks a free bus that only has a headway guess by
  // tier, but the fare still has to be worth it: unless it beats the best
  // free option's time by what the fare is worth, the free bus is the answer.
  // A free bus with no times at all has nothing to beat it with: its time is
  // only a sort key, and an estimate never goes over a measurement.
  if (out[0]?.paid) {
    const free = out.findIndex((o) => !o.paid);
    if (free > 0 && out[free].quality !== 'unknown' && costS(out[free]) <= costS(out[0])) out.unshift(...out.splice(free, 1));
  }
  return out;
}

/**
 * The second option. Must differ in its first leg -- two variants of the same
 * service off the same stop is not a choice, it is noise. The same service
 * from another stop is a choice only when it gets you there about as soon:
 * across the road it's usually the same bus the wrong way round the loop.
 */
export function pickAlt(options: ScoredOption[]): ScoredOption | null {
  const best = options[0];
  if (!best) return null;
  return (
    options.find((o) => o.svc !== best.svc) ??
    options.find((o) => o.stop.code !== best.stop.code && o.totalS - best.totalS <= WALK.mentionWithinS) ??
    null
  );
}

/**
 * How sure we are this is the right stop, from the margin over the best
 * option at a *different* stop. A tight margin means the hop-count guess in
 * RIDE.secondsPerHop is doing the deciding, which it is not good enough for.
 */
export function confidence(options: ScoredOption[], hasCoords: boolean, endWalk: (o: ScoredOption) => number = () => 0): number {
  if (!options.length) return 0;
  const best = options[0];
  // Two passes of the same service through this stop and no way to tell which
  // one the ETA belongs to. No amount of margin elsewhere earns that back.
  const ceiling = best.ambiguousBerth ? 0.5 : 0.97;
  if (!hasCoords) return Math.min(0.75, ceiling); // exact stop, but only an assumption about where you are
  const other = options.find((o) => o.stop.code !== best.stop.code);
  if (!other) return Math.min(0.9, ceiling);
  // The margin to the place itself, as the options are ranked (scoreOptions).
  const marginS = other.totalS + endWalk(other) - (best.totalS + endWalk(best));
  return Math.round(Math.max(0.5, Math.min(ceiling, 0.5 + marginS / 600)) * 100) / 100;
}

/**
 * The nearest stop, full stop -- including one that reaches nothing. The
 * formatter needs it to say "cross the road", which is the single most
 * valuable line in the product: you are standing at a stop, and without that
 * cue you will board the bus you can see.
 */
export function nearestStop(graph: Graph, lat: number | null, lon: number | null): Stop | null {
  if (lat == null || lon == null) return null;
  let best: Stop | null = null;
  let bestD = Infinity;
  for (const stop of graph.stops) {
    const d = haversineM(lat, lon, stop.lat, stop.lon);
    if (d < bestD) {
      bestD = d;
      best = stop;
    }
  }
  return best;
}

/**
 * Seconds on foot to the destination's stop `destCode` (input.to without
 * one), for the walk-or-bus comparison and the "service ended" answer.
 */
export function walkAllTheWayS(
  graph: Graph,
  input: ResolveInput,
  fallbackFrom: Stop | null,
  destCode: string | null = input.to,
): number | null {
  const idx = indexGraph(graph);
  const dest = destCode ? idx.byCode.get(destCode) : null;
  if (!dest) return null;
  const speed = input.walkSpeedMs ?? WALK.speedMs;
  if (input.lat != null && input.lon != null) {
    const { lat, lon } = input;
    // In a residence, walk out by its own stops: the straight line can cross
    // a hill the path goes round.
    const home = residenceStops(lat, lon, idx.byCode, homeWalk(input));
    if (home) {
      const via = Math.min(...home.map((h) => (h.stop.code === dest.code ? h.footM : h.footM + stopFootM(h.stop, dest))));
      return Math.round(Math.max(via, footM(lat, lon, dest)) / speed);
    }
    // Elsewhere, out by the stops near you and on along the paths between
    // stops (walks.json). The straight line with its detour is for a walk to
    // a stop nearby; across campus it can be half the real walk, or double it.
    const near = graph.stops
      .map((stop) => ({ stop, d: haversineM(lat, lon, stop.lat, stop.lon) }))
      .filter((c) => c.d <= WALK.maxRadiusM)
      .sort((a, b) => a.d - b.d)
      .slice(0, WALK.maxCandidates);
    const via = near.map((c) => footM(lat, lon, c.stop) + (c.stop.code === dest.code ? 0 : stopFootM(c.stop, dest)));
    const direct = haversineM(lat, lon, dest.lat, dest.lon) <= WALK.maxRadiusM || !via.length ? [footM(lat, lon, dest)] : [];
    return Math.round(Math.min(...via, ...direct) / speed);
  }
  if (!fallbackFrom) return null;
  // From the origin stop, the walk to it (from home) comes first, same as for the bus.
  return Math.round(stopFootM(fallbackFrom, dest) / speed) + (input.originWalkS ?? 0);
}

/**
 * The walk the whole way: `s` on foot to a stop of the destination and
 * `endS` on from it to the place itself (a room, a food court), by
 * whichever of its stops makes the walk shortest. Straight to the room
 * when it's near enough to walk to directly (`endS` 0): a room 120 m away
 * can be 400 m from the stop it's listed under, on the other side.
 */
export function wholeWalk(graph: Graph, input: ResolveInput, fallbackFrom: Stop | null): { s: number; endS: number } | null {
  if (!input.to) return null;
  const endOf = (code: string) => input.endWalkByStopS?.[code] ?? input.endWalkS ?? 0;
  let best: { s: number; endS: number } | null = null;
  for (const code of [input.to, ...(input.toAlso ?? [])]) {
    const s = walkAllTheWayS(graph, input, fallbackFrom, code);
    if (s !== null && (!best || s + endOf(code) < best.s + best.endS)) best = { s, endS: endOf(code) };
  }
  const { lat, lon, destAt } = input;
  if (lat != null && lon != null && destAt && haversineM(lat, lon, destAt.lat, destAt.lon) <= WALK.maxRadiusM) {
    // With the paths' detour of the room's own stop, the nearest one known.
    const room = { code: input.to, lat: destAt.lat, lon: destAt.lon } as Stop;
    const s = Math.round(footM(lat, lon, room) / (input.walkSpeedMs ?? WALK.speedMs));
    if (!best || s < best.s + best.endS) best = { s, endS: 0 };
  }
  return best;
}
