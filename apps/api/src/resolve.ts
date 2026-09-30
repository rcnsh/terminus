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
import { DEFAULT_HEADWAY_S, RIDE, WALK, isMeasured, sgt } from './config.ts';
import { haversineM } from './geo.ts';
import { footM, stopFootM } from './walk.ts';
import { residenceStops } from './residences.ts';

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
  return leg.hops * RIDE.secondsPerHop + (leg.crossS ?? 0);
}

export function reach(idx: GraphIndex, svc: string, from: string, to: string): { hops: number } | null {
  if (from === to) return { hops: 0 };
  const r = idx.routes.get(svc);
  if (!r) return null;
  const fromAt = r.pos.get(from);
  const toAt = r.pos.get(to);
  if (!fromAt || !toAt) return null;

  let best = Infinity;
  const n = r.seq.length;
  for (const i of fromAt) {
    for (const j of toAt) {
      if (j > i) best = Math.min(best, j - i);
      else if (r.loop) best = Math.min(best, j - i + n);
    }
  }
  return best === Infinity ? null : { hops: best };
}

/**
 * Stops worth fetching arrivals for. Bounded by WALK.maxCandidates so one
 * request never fans out into a dozen upstream calls.
 */
export function candidateStops(graph: Graph, input: ResolveInput): Candidate[] {
  const idx = indexGraph(graph);
  const { to } = input;

  let base: Array<{ stop: Stop; distM: number; footM: number }>;
  const home = input.lat != null && input.lon != null ? residenceStops(input.lat, input.lon, idx.byCode) : null;
  if (home) {
    base = home;
  } else if (input.lat != null && input.lon != null) {
    // Range is the straight line; the walk itself follows the paths.
    const all = graph.stops
      .map((stop) => ({ stop, distM: haversineM(input.lat!, input.lon!, stop.lat, stop.lon) }))
      .sort((a, b) => a.distM - b.distM)
      .map((c) => ({ ...c, footM: footM(input.lat!, input.lon!, c.stop) }));
    const near = all.filter((c) => c.distM <= WALK.maxRadiusM).slice(0, WALK.maxCandidates);
    // A user's usual stops (near home) join the set when in range, so a dense
    // cluster of closer stops cannot push out the one they actually use.
    for (const code of input.preferStops ?? []) {
      const c = all.find((x) => x.stop.code === code);
      if (c && c.distM <= WALK.maxRadiusM && !near.includes(c)) near.push(c);
    }
    // Never answer "no stop nearby" -- degrade to the nearest one, however far.
    base = near.length ? near : all.slice(0, 1);
  } else {
    const stop = input.originCode ? idx.byCode.get(input.originCode) : undefined;
    if (!stop) return [];
    // Starting from home: the walk to the stop decides which bus is catchable.
    base = [{ stop, distM: 0, footM: 0 }];
  }

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
      let best: { hops: number; crossS: number; code: string } | null = null;
      const cost = (b: { hops: number; crossS: number }) => b.hops * RIDE.secondsPerHop + b.crossS;
      for (const t of targets) {
        const r = reach(idx, svc, stop.code, t.code);
        if (r && (!best || cost({ hops: r.hops, crossS: t.crossS }) < cost(best))) best = { hops: r.hops, crossS: t.crossS, code: t.code };
      }
      if (best) legs.push({ svc, hops: best.hops, ...(best.crossS ? { crossS: best.crossS, off: idx.byCode.get(best.code)! } : {}) });
    }
    // Starting from home or a room without coordinates: that walk comes first.
    const walkS = input.lat != null ? Math.round(foot / speed) : (input.originWalkS ?? 0);
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
  const out: Record<string, ServiceHours> = { ...(base ?? {}) };
  for (const [svc, value] of Object.entries(hand ?? {})) {
    if (svc.startsWith('_') || !value || typeof value !== 'object') continue;
    const src = value as Record<string, unknown>;
    const merged: ServiceHours = { ...out[svc] };
    let touched = false;
    for (const day of ['weekday', 'saturday', 'sunday'] as const) {
      if (!(day in src)) continue;
      const win = src[day];
      if (win === null) {
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

/** Is `svc` inside its published operating window right now (SGT)? */
export function inService(graph: Graph, svc: string, nowMs: number): boolean {
  const hours: ServiceHours | undefined = graph.serviceHours?.[svc];
  if (!hours) return true; // unknown hours: assume running, let the feed decide
  const { day, minutes } = sgt(nowMs);
  // NUS runs the Sunday timetable on public holidays. Without this a holiday
  // morning gets a headway guess for services that are not running.
  const sunday = day === 0 || termDay(nowMs).holiday !== null;
  const win = sunday ? hours.sunday : day === 6 ? hours.saturday : hours.weekday;
  if (win === null) return false; // explicitly does not run today
  if (!win) return true; // hours unknown: assume running, let the feed decide
  const open = hhmmToMin(win[0]);
  const close = hhmmToMin(win[1]);
  // An unparseable window is unknown, NOT "ended all day". Getting this
  // backwards would turn a half-filled template into a Worker that reports no
  // buses ever, which is a far worse failure than reporting them at 3am.
  if (open === null || close === null) return true;
  // Windows that cross midnight (e.g. 07:00 -> 01:00).
  return close >= open ? minutes >= open && minutes < close : minutes >= open || minutes < close;
}

/**
 * When `svc` stops running today (SGT), epoch ms: the close of its published
 * window. Null when the hours are unknown or it isn't running now. A window
 * that crosses midnight closes tomorrow.
 */
export function serviceEndsAt(graph: Graph, svc: string, nowMs: number): number | null {
  if (!inService(graph, svc, nowMs)) return null;
  const hours: ServiceHours | undefined = graph.serviceHours?.[svc];
  if (!hours) return null;
  const { day, minutes } = sgt(nowMs);
  const sunday = day === 0 || termDay(nowMs).holiday !== null;
  const win = sunday ? hours.sunday : day === 6 ? hours.saturday : hours.weekday;
  if (!win) return null;
  const open = hhmmToMin(win[0]);
  const close = hhmmToMin(win[1]);
  if (open === null || close === null) return null;
  const midnight = nowMs - (minutes * 60_000 + (nowMs % 60_000));
  // Past midnight in a window that crosses it: it closes later today.
  const closeDay = close >= open || minutes >= open ? (close >= open ? 0 : 1) : 0;
  return midnight + (closeDay * 1440 + close) * 60_000;
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
  const notEnding = rows.filter((a) => a.berth == null || !/-E$/.test(a.berth));

  // Every run terminates here and none departs. Show them, but do not pretend
  // to be confident about a bus that ends its journey as you reach it.
  if (!notEnding.length) return { usable: rows, ambiguousBerth: rows.length > 0 };

  const distinct = new Set(notEnding.map((a) => a.berth).filter((b) => b != null));
  return { usable: notEnding, ambiguousBerth: distinct.size > 1 };
}

export function headwayFor(graph: Graph, svc: string): number {
  return graph.headwayS?.[svc] ?? DEFAULT_HEADWAY_S;
}

export interface BoardRow {
  svc: string;
  /** Seconds until arrival. null means "no live time to show", never 0. */
  etaS: number | null;
  quality: Quality;
  ambiguousBerth: boolean;
}

/**
 * What is coming at a single stop, for every service that stops there --
 * the map's tap-a-stop popover. Deliberately destination-less: no walk time,
 * no hops, no "can I reach it" cutoff, because the visitor is already
 * standing there (or checking before they leave), not racing to catch one.
 * Shares its quality ladder and berth handling with scoreOptions() so a stop
 * never disagrees with itself between the Now answer and the map.
 */
export function boardAt(graph: Graph, idx: GraphIndex, stopCode: string, sa: StopArrivals | undefined, nowMs: number): BoardRow[] {
  const services = idx.servingStop.get(stopCode) ?? [];
  const available = sa !== undefined && sa.available !== false;
  const out: BoardRow[] = [];

  for (const svc of services) {
    const forSvc = (sa?.arrivals ?? []).filter((a) => a.svc === svc);
    const { usable, ambiguousBerth } = resolveBerths(forSvc);
    const etas = usable
      .filter((a) => a.etaS != null)
      .sort((a, b) => (a.etaS as number) - (b.etaS as number));

    let quality: Quality;
    let etaS: number | null = null;
    if (etas.length) {
      quality = 'live';
      etaS = etas[0].etaS;
    } else if (!inService(graph, svc, nowMs)) {
      continue; // ended: do not list a service that is not running
    } else if (!available) {
      quality = 'unknown';
    } else {
      quality = 'scheduled';
    }
    if (sa?.stale && quality !== 'unknown') quality = 'stale';

    out.push({ svc, etaS, quality, ambiguousBerth });
  }

  out.sort(
    (a, b) =>
      Number(isMeasured(b.quality)) - Number(isMeasured(a.quality)) ||
      (a.etaS ?? Infinity) - (b.etaS ?? Infinity) ||
      a.svc.localeCompare(b.svc),
  );
  return out;
}

/**
 * Convert candidates plus live arrivals into ranked options, all in seconds
 * from now. Options whose service has ended are dropped entirely.
 */
export function scoreOptions(
  graph: Graph,
  candidates: Candidate[],
  arrivalsByStop: Map<string, StopArrivals>,
  nowMs: number,
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

      const earliest = c.walkS + WALK.boardBufferS;
      // A missing entry means we never reached the feed -- not that no bus is
      // coming. Those are different answers and must not collapse into one.
      const available = sa !== undefined && sa.available !== false;
      let boardS: number;
      let quality: ScoredOption['quality'];
      let arrival = null;

      // The first bus you can physically reach, not the first bus listed.
      const catchable = etas.find((a) => (a.etaS as number) >= earliest);
      if (catchable) {
        boardS = catchable.etaS as number;
        quality = 'live';
        arrival = catchable;
      } else if (etas.length) {
        // Every listed bus leaves before you can get there.
        boardS = (etas[etas.length - 1].etaS as number) + headwayFor(graph, leg.svc);
        quality = 'scheduled';
      } else if (!inService(graph, leg.svc, nowMs)) {
        // The published hours are ours, not the feed's, so this holds even
        // when we have no data at all.
        continue; // ended
      } else if (!available) {
        // Keep the option -- the graph still says this service goes where you
        // are going -- but boardS here is only an ordering key. The formatter
        // must never print a time for an 'unknown' option.
        boardS = earliest + headwayFor(graph, leg.svc) / 2;
        quality = 'unknown';
      } else {
        // The feed answered and had nothing: a headway is the honest guess.
        boardS = earliest + headwayFor(graph, leg.svc) / 2;
        quality = 'scheduled';
      }

      if (sa?.stale && quality !== 'unknown') quality = 'stale';

      const rideS = legRideS(leg);
      out.push({
        stop: c.stop,
        svc: leg.svc,
        distM: c.distM,
        walkS: c.walkS,
        hops: leg.hops,
        boardS: Math.round(boardS),
        rideS,
        totalS: Math.round(boardS) + rideS,
        quality,
        arrival,
        fetchedAt: sa?.fetchedAt ?? nowMs,
        ambiguousBerth,
        ...(leg.off ? { off: leg.off } : {}),
      });
    }
  }

  // Measurements beat estimates outright; within a tier, time decides.
  out.sort(
    (a, b) =>
      Number(isMeasured(b.quality)) - Number(isMeasured(a.quality)) ||
      a.totalS - b.totalS ||
      a.walkS - b.walkS ||
      a.svc.localeCompare(b.svc),
  );
  return out;
}

/**
 * The second option. Must differ in its first leg -- two variants of the same
 * service off the same stop is not a choice, it is noise.
 */
export function pickAlt(options: ScoredOption[]): ScoredOption | null {
  const best = options[0];
  if (!best) return null;
  return (
    options.find((o) => o.svc !== best.svc) ??
    options.find((o) => o.stop.code !== best.stop.code) ??
    null
  );
}

/**
 * How sure we are this is the right stop, from the margin over the best
 * option at a *different* stop. A tight margin means the hop-count guess in
 * RIDE.secondsPerHop is doing the deciding, which it is not good enough for.
 */
export function confidence(options: ScoredOption[], hasCoords: boolean): number {
  if (!options.length) return 0;
  const best = options[0];
  // Two passes of the same service through this stop and no way to tell which
  // one the ETA belongs to. No amount of margin elsewhere earns that back.
  const ceiling = best.ambiguousBerth ? 0.5 : 0.97;
  if (!hasCoords) return Math.min(0.75, ceiling); // exact stop, but only an assumption about where you are
  const other = options.find((o) => o.stop.code !== best.stop.code);
  if (!other) return Math.min(0.9, ceiling);
  const marginS = other.totalS - best.totalS;
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

/** Seconds to walk the whole way, for the "service ended" answer. */
export function walkAllTheWayS(
  graph: Graph,
  input: ResolveInput,
  fallbackFrom: Stop | null,
): number | null {
  const idx = indexGraph(graph);
  const dest = input.to ? idx.byCode.get(input.to) : null;
  if (!dest) return null;
  const speed = input.walkSpeedMs ?? WALK.speedMs;
  if (input.lat != null && input.lon != null) {
    // In a residence, walk out by its own stops: the straight line can cross
    // a hill the path goes round.
    const home = residenceStops(input.lat, input.lon, idx.byCode);
    if (home) {
      const via = Math.min(...home.map((h) => (h.stop.code === dest.code ? h.footM : h.footM + stopFootM(h.stop, dest))));
      return Math.round(Math.max(via, footM(input.lat, input.lon, dest)) / speed);
    }
    return Math.round(footM(input.lat, input.lon, dest) / speed);
  }
  if (!fallbackFrom) return null;
  // From the origin stop, the walk to it (from home) comes first, same as for the bus.
  return Math.round(stopFootM(fallbackFrom, dest) / speed) + (input.originWalkS ?? 0);
}
