/**
 * Detection (phase 8.1): what a location says about the trip, so most trips
 * need no taps.
 *
 * During a trip the Android app sends a fix every 20 seconds or so, as a
 * `location` signal with the speed it measured. Each one is judged here and
 * then dropped: only what it means is kept (the trip record), never where
 * you were.
 *
 * - **On the bus:** moving at bus speed along the planned service's route,
 *   having been at the boarding stop (a `waiting` record) around when it left.
 * - **Missed:** a few minutes after the planned bus left, still at the stop,
 *   or still at home, and not moving.
 * - **There:** at the stop you get off at, on the bus; or at the destination.
 *
 * Nothing asks what happened, so a wrong guess has to put itself right: taken
 * to be on a bus (detected, or nobody said) but standing still off its road
 * is a miss, and the plan moves on to the next way there. A tap from an older
 * app always wins.
 */

import type { Graph, Stop } from './types.ts';
import { haversineM } from './geo.ts';
import { roundCoord } from './http.ts';
import { indexGraph, rideStops } from './resolve.ts';
import { atHome } from './residences.ts';
import { ASSUME_MS, AT_STOP_M, type Boarded, type Phase, type TripRecord } from './trip.ts';

/** A location as the app sends it: speed in m/s and accuracy in metres when it has them. */
export interface Fix {
  lat: number;
  lon: number;
  speedMs: number | null;
  accM: number | null;
}

/** Faster than anyone walks or runs for long, slower than a bus between stops. */
export const BUS_SPEED_MS = 4;
/** Below this you're standing (or strolling) rather than riding. */
export const STILL_MS = 1.5;
/** How far off the straight line between two stops a bus on that road can be. */
export const CORRIDOR_M = 60;
/** At the stop you get off at, allowing for where along it the bus stops. */
export const OFF_M = 100;
/** A fix's own error counts up to this much on top of the distances above. */
const MAX_ACC_M = 60;
/** Waiting at the stop this recently counts as having been there for the bus. */
export const WAITED_MS = 30 * 60_000;
/** The bus can leave a little before the time it was given. */
const EARLY_MS = 2 * 60_000;

export type Detected = 'boarded' | 'missed' | 'arrived';

/** A fix from a request body, rounded like any location (roundCoord), or null when it isn't one. */
export function fixOf(body: Record<string, unknown> | null): Fix | null {
  const lat = body?.lat;
  const lon = body?.lon;
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  return { lat: roundCoord(lat), lon: roundCoord(lon), speedMs: num(body?.speed), accM: num(body?.acc) };
}

/** Whether detection may still act on this trip. */
export function mayDetect(rec: TripRecord | undefined): boolean {
  if (!rec) return true;
  // Its own conclusions it can move on from; a tap it only follows to the end of the ride.
  return rec.detected === true || rec.kind === 'waiting' || rec.kind === 'left' || rec.kind === 'boarded';
}

export interface DetectInput {
  phase: Phase;
  /** Today's record for this trip, if any. */
  rec: TripRecord | undefined;
  /** The bus the trip is about: the plan, or the one you're on. */
  bus: Boarded | null;
  /** The answer, planned from this fix, says you're at the destination. */
  arrivedHere: boolean;
  fix: Fix;
  homeStops: string[];
  graph: Graph;
  nowMs: number;
}

/** What this fix says happened, or null when it says nothing new. */
export function detect(x: DetectInput): Detected | null {
  const { rec, bus, fix, nowMs } = x;
  if (rec?.kind === 'arrived' || rec?.kind === 'skipped') return null;
  const idx = indexGraph(x.graph);
  const slack = Math.min(fix.accM ?? 0, MAX_ACC_M);
  const near = (code: string | undefined, m: number) => {
    const s = code ? idx.byCode.get(code) : undefined;
    return s ? sides(s, idx.byCode).some((t) => haversineM(fix.lat, fix.lon, t.lat, t.lon) <= m + slack) : false;
  };

  // On the bus: there once it reaches the stop you get off at.
  if (x.phase === 'riding' || rec?.kind === 'boarded') {
    const b = rec?.boarded ?? bus;
    if (b?.alightCode && near(b.alightCode, OFF_M)) return 'arrived';
    // Taken to be on it (detected, or nobody said), but standing still away
    // from its road: you didn't take it. Nothing asks, so this is how a wrong
    // guess puts itself right; a tapped "On it" is left alone.
    const guessed = !rec || rec.detected === true;
    if (guessed && b?.svc && (fix.speedMs ?? 0) < STILL_MS && !onRoute(x.graph, b, fix, 2 * CORRIDOR_M + slack)) return 'missed';
    return null;
  }
  // At the destination, whatever anyone said about the bus.
  if (x.arrivedHere) return 'arrived';
  if (!mayDetect(rec)) return null;
  if (!bus?.svc || !bus.board || !bus.stopCode) return null;
  const board = Date.parse(bus.board);
  const speed = fix.speedMs;

  // Moving at bus speed along its route, having waited at its stop.
  const waited =
    (rec?.kind === 'waiting' && nowMs - rec.at <= WAITED_MS) ||
    // Missed one at the stop (detected there): still there for the next.
    (rec?.kind === 'missed' && rec.detected === true && rec.atStop === true);
  if (speed !== null && speed >= BUS_SPEED_MS && waited && nowMs >= board - EARLY_MS && onRoute(x.graph, bus, fix, CORRIDOR_M + slack)) {
    return 'boarded';
  }

  // Still where you were a few minutes after it left: missed.
  if (rec?.kind !== 'missed' && nowMs >= board + ASSUME_MS && (speed === null || speed < STILL_MS)) {
    if (near(bus.stopCode, AT_STOP_M) || atHome(fix.lat, fix.lon, x.homeStops)) return 'missed';
  }
  return null;
}

/** At the boarding stop rather than at home, for a detected miss (see `waited`). */
export function atStopOf(graph: Graph, bus: Boarded | null, fix: Fix): boolean {
  const s = bus?.stopCode ? indexGraph(graph).byCode.get(bus.stopCode) : undefined;
  return s ? haversineM(fix.lat, fix.lon, s.lat, s.lon) <= AT_STOP_M + Math.min(fix.accM ?? 0, MAX_ACC_M) : false;
}

/**
 * When the bus left the boarding stop, estimated from a fix on it: now, less
 * the time to cover the distance from the stop at the speed it's going.
 * For measured ride times (ridetimes.ts).
 */
export function departedAt(graph: Graph, bus: Boarded, fix: Fix, nowMs: number): number {
  const s = bus.stopCode ? indexGraph(graph).byCode.get(bus.stopCode) : undefined;
  if (!s || !fix.speedMs) return nowMs;
  const back = (haversineM(fix.lat, fix.lon, s.lat, s.lon) / fix.speedMs) * 1000;
  // A slow fix far from the stop would put the departure before you got there.
  return nowMs - Math.min(back, 3 * 60_000);
}

/** A stop and the one across the road: the bus may use either side's berth. */
function sides(s: Stop, byCode: Map<string, Stop>): Stop[] {
  const o = s.opposite ? byCode.get(s.opposite) : undefined;
  return o ? [s, o] : [s];
}

/**
 * Within `tolM` of the service's path from the boarding stop to where you get
 * off, drawn as straight lines between its stops. Campus stops are a few
 * hundred metres apart, so the roads between them are nearly straight.
 */
export function onRoute(graph: Graph, bus: Boarded, fix: Fix, tolM: number): boolean {
  const idx = indexGraph(graph);
  // A public two-way service is named by its number but routed by its key.
  const codes = (bus.stopCode && bus.alightCode ? rideStops(idx, bus.route ?? bus.svc, bus.stopCode, bus.alightCode) : null) ?? [bus.stopCode!];
  const pts = codes.map((c) => idx.byCode.get(c)).filter((s): s is Stop => Boolean(s));
  if (!pts.length) return false;
  if (pts.length === 1) return haversineM(fix.lat, fix.lon, pts[0].lat, pts[0].lon) <= tolM;
  for (let i = 1; i < pts.length; i++) {
    if (segmentM(fix, pts[i - 1], pts[i]) <= tolM) return true;
  }
  return false;
}

/** Metres from a point to the segment a–b, on a local flat projection (fine over a campus). */
export function segmentM(p: { lat: number; lon: number }, a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const k = Math.cos((p.lat * Math.PI) / 180);
  const M = 111_320;
  const ax = (a.lon - p.lon) * k * M, ay = (a.lat - p.lat) * M;
  const bx = (b.lon - p.lon) * k * M, by = (b.lat - p.lat) * M;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
