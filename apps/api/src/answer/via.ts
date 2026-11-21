import type { GraphIndex } from '../types.ts';
import { listOf, m } from '../i18n.ts';

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

export const VIA_MAX = 3;

const placeOf = (code: string): string | null => VIA_PLACES[code]?.place ?? null;
const plateName = (idx: GraphIndex, code: string): string => idx.byCode.get(code)?.name ?? code;

export function viaFrom(idx: GraphIndex, svc: string, stopCode: string, max = VIA_MAX): string[] {
  const r = idx.routes.get(svc);
  const at = r?.pos.get(stopCode);
  if (!r || !at) return [];
  const ahead = r.seq.slice(at[0] + 1);
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

export function viaText(places: string[]): string | null {
  return places.length ? m().viaTo(listOf(places)) : null;
}
