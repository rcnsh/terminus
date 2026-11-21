import type { Answer, Arrival, BusLeg, BusChange, Quality, ScoredOption, Stop } from '../types.ts';
import { LABEL_MAX, PUBLIC, WALK, isMeasured } from '../config.ts';
import { svcName } from './public.ts';
import { m } from '../i18n.ts';

export const LABEL_TARGET = 16;

export function fitsTile(label: string): boolean {
  return label.length <= LABEL_TARGET;
}

export function mins(seconds: number): string {
  if (seconds < 45) return m().now;
  if (seconds < 90) return m().oneMin;
  return m().nMin(Math.round(seconds / 60));
}

const ABBREV: Array<[RegExp, string]> = [
  [/\bKent Ridge\b/gi, 'KR'],
  [/\bOpposite\b/gi, 'Opp'],
  [/\bUniversity Town\b/gi, 'UTown'],
  [/\bPrince George'?s Park\b/gi, 'PGP'],
  [/\bTerminal\b/gi, 'Term'],
  [/\bResidences?\b/gi, 'Res'],
  [/\bCentral Library\b/gi, 'CLB'],
  [/\bBukit Timah Campus\b/gi, 'BTC'],
];

export function shortStop(name: string, max = 20): string {
  let s = name;
  for (const [re, to] of ABBREV) s = s.replace(re, to);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}

export function clampLabel(s: string): string {
  return s.length <= LABEL_MAX ? s : s.slice(0, LABEL_MAX - 1).trimEnd() + '…';
}

export const isoSeconds = (ms: number) => new Date(Math.round(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
const iso = isoSeconds;

function crowdWord(c: Arrival['crowd']): string | null {
  return c === 'low' ? m().crowdLow : c === 'medium' ? m().crowdMedium : c === 'high' ? m().crowdHigh : null;
}

function ageMin(nowMs: number, fetchedAt: number): number {
  return Math.max(0, Math.round((nowMs - fetchedAt) / 60_000));
}

export function etaPhrase(o: ScoredOption): string {
  if (o.quality === 'unknown') return m().noTimes;
  return o.quality === 'scheduled' || o.quality === 'stale' ? m().approx(mins(o.boardS)) : mins(o.boardS);
}

export interface FormatInput {
  options: ScoredOption[];
  alt: ScoredOption | null;
  fallbackStop: Stop | null;
  nearestStop: Stop | null;
  origin?: Stop | null;
  destLabel: string | null;
  walkAllS: number | null;
  endWalk?: (o: ScoredOption) => number;
  walkEndS?: number;
  walkWeight?: number;
  confidence: number;
  arrivals: Arrival[];
  nowMs: number;
}

export type WalkVerdict = 'win' | 'close' | 'lose';

export function footS(o: ScoredOption, endS = 0): number {
  return o.walkS + (o.change?.crossS ?? 0) + endS;
}

export function walkVerdict(
  walkAllS: number | null,
  best: ScoredOption | undefined,
  bestEndS = 0,
  walkWeight: number = WALK.sunWeight,
): WalkVerdict {
  if (walkAllS == null || !best) return 'lose';
  const margin = isMeasured(best.quality) ? WALK.beatsBusByS : 0;
  const busS = best.totalS - (best.opensInS ?? 0) + bestEndS + (best.paid ? PUBLIC.fareWorthS : 0);
  if (walkAllS * walkWeight + margin < busS + (walkWeight - 1) * footS(best, bestEndS)) return 'win';
  if (walkAllS < busS + WALK.mentionWithinS) return 'close';
  return 'lose';
}

export function legOf(o: ScoredOption, endWalkS = 0): BusLeg {
  const timed = o.quality !== 'unknown';
  return {
    svc: svcName(o.svc),
    stop: shortStop(o.stop.name),
    stopCode: o.stop.code,
    walkS: o.walkS,
    rideS: o.rideS,
    board: timed ? iso(o.fromMs + o.boardS * 1000) : null,
    arrive: timed ? iso(o.fromMs + o.totalS * 1000) : null,
    estimated: o.quality === 'scheduled' || o.quality === 'stale',
    ...(o.off ? { off: shortStop(o.off.name) } : {}),
    ...(o.to ? { toStop: shortStop(o.to.name) } : {}),
    ...(endWalkS > 0 ? { endWalkS } : {}),
    ...(o.paid ? { paid: true as const } : {}),
    ...(o.change ? { change: busChange(o) } : {}),
  };
}

export function busChange(o: ScoredOption): BusChange | undefined {
  const t = o.change;
  if (!t) return undefined;
  const timed = o.quality !== 'unknown';
  return {
    svc: svcName(t.svc),
    from: shortStop(t.at.name),
    fromCode: t.at.code,
    stop: shortStop(t.stop.name),
    stopCode: t.stop.code,
    ...(t.crossS > 0 ? { crossS: t.crossS } : {}),
    reach: timed ? iso(o.fromMs + t.reachS * 1000) : null,
    board: timed ? iso(o.fromMs + t.boardS * 1000) : null,
    rideS: t.rideS,
    estimated: t.quality === 'scheduled' || t.quality === 'stale',
  };
}

export function changeWords(o: ScoredOption): string | null {
  const t = o.change;
  if (!t) return null;
  const at = shortStop(t.at.name);
  return t.crossS > 0 ? m().changeAcross(at, named(t)) : m().changeTo(at, named(t));
}

export const named = (o: { svc: string; paid?: true }): string => (o.paid ? `${svcName(o.svc)} ($)` : svcName(o.svc));

export function renderAlt(o: ScoredOption): string {
  return `${named(o)}${o.change ? ` → ${named(o.change)}` : ''} · ${etaPhrase(o)} · ${shortStop(o.stop.name)}`;
}

function buildLabel(best: ScoredOption, nowMs: number): string {
  const name = svcName(best.svc);
  const svc = name.length > 6 ? name.slice(0, 6) : name;
  if (best.quality === 'stale') {
    return clampLabel(m().staleLabel(svc, mins(best.boardS), ageMin(nowMs, best.fetchedAt)));
  }
  return clampLabel(`${svc} · ${etaPhrase(best)}`);
}

function buildDetail(f: FormatInput, best: ScoredOption, verdict: WalkVerdict): string {
  const parts: string[] = [shortStop(best.stop.name)];

  const elsewhere = Boolean(f.nearestStop && f.nearestStop.code !== best.stop.code);
  if (elsewhere && f.nearestStop?.opposite === best.stop.code) parts.push(m().crossRoad);
  else if (!f.nearestStop && f.origin && f.origin.opposite === best.stop.code) parts.push(m().crossRoad);
  else if (best.walkS >= 60) parts.push(m().walkToStop(mins(best.walkS)));
  else if (elsewhere) parts.push(m().shortWalk);
  else if (f.nearestStop) parts.push(m().rightHere);

  const change = changeWords(best);
  if (change) parts.push(change);

  if (best.off && best.hops > 0) parts.push(m().offAt(shortStop(best.off.name)));

  if (f.destLabel && best.hops > 0) {
    parts.push(
      best.quality === 'unknown'
        ? m().destStops(f.destLabel, best.hops)
        : m().destIn(f.destLabel, mins(best.totalS + (f.endWalk?.(best) ?? 0))),
    );
  } else if (f.destLabel) {
    parts.push(m().atDest(f.destLabel));
  }

  if (verdict === 'close' && f.walkAllS != null) parts.push(m().walkingAll(mins(f.walkAllS + (f.walkEndS ?? 0))));

  const crowd = crowdWord(best.arrival?.crowd ?? null);
  if (crowd) parts.push(crowd);

  if (best.paid) parts.push(m().publicBus);

  if (best.ambiguousBerth) parts.push(m().directionUnconfirmed);

  if (best.quality === 'stale') parts.push(m().minOld(ageMin(f.nowMs, best.fetchedAt)));
  else if (best.quality === 'scheduled') parts.push(m().estimated);
  else if (best.quality === 'unknown') parts.push(m().liveUnavailable);

  if (f.alt) {
    const raw = etaPhrase(f.alt);
    const plain = raw === m().now || raw === m().noTimes;
    const altName = f.alt.change ? `${named(f.alt)} → ${named(f.alt.change)}` : named(f.alt);
    const sameSvc = svcName(f.alt.svc) === svcName(best.svc) && !f.alt.change && !best.change;
    parts.push(m().orAlt(sameSvc ? shortStop(f.alt.stop.name) : altName, raw, plain));
  }

  return parts.join(' · ');
}

export function buildAnswer(f: FormatInput): Answer {
  const best = f.options[0];

  if (!best) {
    const stop = f.fallbackStop;
    const walk = f.walkAllS;
    const said = walk != null ? walk + (f.walkEndS ?? 0) : null;
    const trivial = said != null && said <= WALK.mentionWithinS;
    const label = clampLabel(said == null ? m().noBuses : trivial ? m().walkLabel(mins(said)) : m().noBusWalk(mins(said)));
    const detail =
      said == null ? m().servicesEnded : trivial ? m().isAWalk(f.destLabel, mins(said)) : m().endedWalkTo(mins(said), f.destLabel);
    return {
      label,
      detail,
      alt: null,
      stop: { code: stop?.code ?? '', name: stop?.name ?? '', confidence: f.confidence },
      quality: 'ended' as Quality,
      asOf: new Date(f.nowMs).toISOString(),
      arrivals: f.arrivals,
      departsAt: null,
      arriveAt: walk != null ? iso(f.nowMs + walk * 1000) : null,
      ...(said != null ? { foot: { s: said, why: trivial ? null : m().servicesEnded } } : {}),
    };
  }

  const bestEndS = f.endWalk?.(best) ?? 0;
  const walkThereS = f.walkAllS != null ? f.walkAllS + (f.walkEndS ?? 0) : null;
  const verdict = walkVerdict(walkThereS, best, bestEndS, f.walkWeight);

  const common = {
    stop: { code: best.stop.code, name: best.stop.name, confidence: f.confidence },
    quality: best.quality,
    asOf: new Date(best.quality === 'stale' ? best.fetchedAt : f.nowMs).toISOString(),
    arrivals: f.arrivals,
  };

  const timed = best.quality !== 'unknown';
  const departsAt = timed ? iso(best.fromMs + best.boardS * 1000) : null;
  const arriveAt = timed ? iso(best.fromMs + best.totalS * 1000) : null;

  if (verdict === 'win' && f.walkAllS != null) {
    const busPhrase =
      best.quality === 'unknown'
        ? m().busNoLive(svcName(best.svc))
        : m().busWouldBe(svcName(best.svc), mins(best.totalS - (best.opensInS ?? 0) + bestEndS));
    return {
      ...common,
      label: clampLabel(m().walkLabel(mins(walkThereS ?? f.walkAllS))),
      detail: [f.destLabel ? m().onFootTo(f.destLabel) : m().fasterOnFoot, busPhrase, m().fromStop(shortStop(best.stop.name))].join(' · '),
      alt: renderAlt(best),
      departsAt: null,
      arriveAt: iso(f.nowMs + f.walkAllS * 1000),
      foot: { s: walkThereS ?? f.walkAllS, why: busPhrase },
    };
  }

  return {
    ...common,
    label: buildLabel(best, f.nowMs),
    detail: buildDetail(f, best, verdict),
    alt: f.alt ? renderAlt(f.alt) : null,
    departsAt,
    arriveAt,
    bus: legOf(best, bestEndS),
    altBus: f.alt ? legOf(f.alt, f.endWalk?.(f.alt) ?? 0) : null,
  };
}
