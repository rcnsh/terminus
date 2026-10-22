/**
 * The places a bus passes on its way, by names a student new to NUS knows:
 * the MRT, UTown, PGP, the library, the faculties. A board row's `towards`
 * (the next stop and the end of the line) tells a regular which way a bus
 * goes; someone in their first weeks wants to know whether it goes past the
 * MRT. Hand-kept, and short on purpose: a stop is here only when its name
 * means something on its own, so a bus's list stays a few words long.
 */

import type { GraphIndex } from '../types.ts';
import { lang, listOf, m } from '../i18n.ts';

/**
 * Stop code → the place it stands for. Two stops can be one place (the
 * MRT's two sides of the road; PGP and its foyer). Place names stay English
 * in Chinese too (i18n.ts); a faculty, which is a description, has its
 * Chinese.
 */
export const VIA_PLACES: Record<string, { en: string; zh?: string }> = {
  'KR-MRT': { en: 'Kent Ridge MRT' },
  'KR-MRT-OPP': { en: 'Kent Ridge MRT' },
  'BG-MRT': { en: 'Botanic Gardens MRT' },
  UTOWN: { en: 'UTown' },
  PGP: { en: 'PGP' },
  PGPR: { en: 'PGP' },
  KV: { en: 'Kent Vale' },
  CLB: { en: 'Central Library' },
  COM3: { en: 'COM 3' },
  BIZ2: { en: 'BIZ' },
  AS5: { en: 'Arts', zh: '人文社科' },
  S17: { en: 'Science', zh: '理学院' },
  'SDE3-OPP': { en: 'Engineering', zh: '工程' },
};

/** How many places a bus's list names: past three, it no longer fits a line. */
export const VIA_MAX = 3;

const placeOf = (code: string): string | null => {
  const p = VIA_PLACES[code];
  return p ? (lang() === 'zh' ? (p.zh ?? p.en) : p.en) : null;
};

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
  const out: string[] = [];
  for (const code of ahead) {
    const p = placeOf(code);
    if (p && p !== here && !out.includes(p)) out.push(p);
    if (out.length >= max) break;
  }
  return out;
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
