/**
 * The stops worth naming on a bus's way: the MRT, UTown, PGP, the library,
 * the faculties. A board row's `towards` (the next stop and the end of the
 * line) tells a regular which way a bus goes; someone in their first weeks
 * wants to know whether it goes past the MRT. Hand-kept, and short on
 * purpose, so a bus's list stays a few words long. Each is said by the name
 * on its own plate ("AS 5", "KR MRT"), the name the boards and the map use.
 */

import type { GraphIndex } from '../types.ts';
import { listOf, m } from '../i18n.ts';

/**
 * Stop code → the place it stands for, so two stops of one place (the MRT's
 * two sides of the road; PGP and its foyer) are named once. `rank` says
 * which to keep when a line passes more than a list holds: an MRT first,
 * then the places people live, then the rest.
 */
export const VIA_PLACES: Record<string, { place: string; rank: number }> = {
  'KR-MRT': { place: 'Kent Ridge MRT', rank: 0 },
  'KR-MRT-OPP': { place: 'Kent Ridge MRT', rank: 0 },
  'BG-MRT': { place: 'Botanic Gardens MRT', rank: 0 },
  UTOWN: { place: 'UTown', rank: 1 },
  PGP: { place: 'PGP', rank: 1 },
  PGPR: { place: 'PGP', rank: 1 },
  KV: { place: 'Kent Vale', rank: 1 },
  CLB: { place: 'Central Library', rank: 2 },
  COM3: { place: 'COM 3', rank: 2 },
  BIZ2: { place: 'BIZ', rank: 2 },
  AS5: { place: 'Arts', rank: 2 },
  S17: { place: 'Science', rank: 2 },
  'SDE3-OPP': { place: 'Engineering', rank: 2 },
};

/** How many places a bus's list names: past three, it no longer fits a line. */
export const VIA_MAX = 3;

const placeOf = (code: string): string | null => VIA_PLACES[code]?.place ?? null;
/** A stop by the name on its plate. */
const plateName = (idx: GraphIndex, code: string): string => idx.byCode.get(code)?.name ?? code;

/**
 * The places `svc` passes after `stopCode`, in order, up to `max`: the
 * stops it calls at from the next one to where it ends, as towardsFrom()
 * takes them (a loop runs on to its first stop). Each place once, and never
 * the place you're standing at. Empty when it passes none.
 */
export function viaFrom(idx: GraphIndex, svc: string, stopCode: string, max = VIA_MAX): string[] {
  const r = idx.routes.get(svc);
  const at = r?.pos.get(stopCode);
  if (!r || !at) return [];
  const ahead = r.seq.slice(at[0] + 1);
  // A loop that doesn't list its first stop again at the end still gets back there.
  if (r.loop && r.seq[r.seq.length - 1] !== r.seq[0]) ahead.push(r.seq[0]);
  const here = placeOf(stopCode);
  const seen: string[] = [];
  const out: string[] = [];
  for (const code of ahead) {
    const p = placeOf(code);
    if (!p || p === here || seen.includes(p)) continue;
    seen.push(p);
    out.push(plateName(idx, code));
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The stops a whole line passes, for its row in the list of lines: up to
 * `max`, in the order it reaches them, never its own ends (its name says
 * those). Past `max`, the higher-ranked places are kept.
 */
export function lineVia(idx: GraphIndex, svc: string, max = VIA_MAX): string[] {
  const r = idx.routes.get(svc);
  if (!r?.seq.length) return [];
  const first = placeOf(r.seq[0]);
  const last = r.loop ? first : placeOf(r.seq[r.seq.length - 1]);
  const passed: { code: string; place: string; rank: number; i: number }[] = [];
  r.seq.slice(1).forEach((code) => {
    const v = VIA_PLACES[code];
    if (v && v.place !== first && v.place !== last && !passed.some((x) => x.place === v.place))
      passed.push({ code, place: v.place, rank: v.rank, i: passed.length });
  });
  return [...passed]
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .slice(0, max)
    .sort((a, b) => a.i - b.i)
    .map((x) => plateName(idx, x.code));
}

/**
 * Where a stop's buses go, for a heading over its board: the places most of
 * them pass first (each row's first two), the most shared first, then the
 * soonest along. Up to `max`; empty when its buses pass none.
 */
export function stopVia(rows: { via: string[] }[], max = VIA_MAX): string[] {
  const score = new Map<string, { n: number; first: number }>();
  rows.forEach((row, i) =>
    row.via.slice(0, 2).forEach((p, j) => {
      const s = score.get(p);
      if (s) s.n++;
      else score.set(p, { n: 1, first: i * 2 + j });
    }),
  );
  return [...score.entries()]
    .sort(([, a], [, b]) => b.n - a.n || a.first - b.first)
    .slice(0, max)
    .map(([p]) => p);
}

/** `stopVia` in words: "to Central Library, Arts, BIZ"; null with no places. */
export function viaText(places: string[]): string | null {
  return places.length ? m().viaTo(listOf(places)) : null;
}
