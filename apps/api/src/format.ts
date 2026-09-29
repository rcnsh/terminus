/**
 * The server returns a pre-rendered string and clients render it without
 * computing anything. An Android QS tile, a push notification, a web page and
 * (later) an MCP tool all consume the same `label` and `detail`. The moment a
 * client starts formatting for itself, four interfaces begin to drift apart
 * and there are four places to fix every bug.
 *
 * So: user-visible strings are produced on the server, never in a client.
 * The answer's `label`, `detail` and `alt` are built here; the class card and
 * the other per-client lines in card.ts; clock times and lateness in
 * clock.ts; rest and timing text in profile.ts.
 */

import type { Answer, Arrival, Quality, ScoredOption, Stop } from './types.ts';
import { LABEL_MAX, WALK, isMeasured } from './config.ts';

/**
 * The contract caps `label` at 40 chars, but a Quick Settings tile truncates
 * far shorter than that -- roughly 12-16 glyphs are actually visible on most
 * launchers. 40 is the hard limit; this is the one that matters.
 */
export const LABEL_TARGET = 16;

/** Does this label survive a real tile, not just the contract? */
export function fitsTile(label: string): boolean {
  return label.length <= LABEL_TARGET;
}

export function mins(seconds: number): string {
  if (seconds < 45) return 'now';
  if (seconds < 90) return '1 min';
  return `${Math.round(seconds / 60)} min`;
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

function crowdWord(c: Arrival['crowd']): string | null {
  return c === 'low' ? 'quiet' : c === 'medium' ? 'filling' : c === 'high' ? 'packed' : null;
}

function ageMin(nowMs: number, fetchedAt: number): number {
  return Math.max(0, Math.round((nowMs - fetchedAt) / 60_000));
}

/**
 * How long until you can board, in words.
 *
 * An 'unknown' option carries a boardS, but it is a sort key derived from a
 * default headway, not a prediction. It never becomes a number on screen.
 */
export function etaPhrase(o: ScoredOption): string {
  if (o.quality === 'unknown') return 'no times';
  return o.quality === 'scheduled' ? `~${mins(o.boardS)}` : mins(o.boardS);
}

export interface FormatInput {
  options: ScoredOption[];
  alt: ScoredOption | null;
  /** Stop we would report when there is nothing to board (ended case). */
  fallbackStop: Stop | null;
  /** Nearest stop of any kind, or null when we have no coordinates. */
  nearestStop: Stop | null;
  /** Short destination name, e.g. "UTown". Null for a bare /next. */
  destLabel: string | null;
  /** Seconds to walk the entire way, when known. */
  walkAllS: number | null;
  confidence: number;
  arrivals: Arrival[];
  nowMs: number;
}

export type WalkVerdict = 'win' | 'close' | 'lose';

/**
 * Several trips on this campus are beaten outright on foot. Say so.
 *
 * No safety margin is required to beat a guess: if the best we have is a
 * headway estimate or no data at all, a known walking time is the better
 * answer the moment it is shorter.
 */
export function walkVerdict(walkAllS: number | null, best: ScoredOption | undefined): WalkVerdict {
  if (walkAllS == null || !best) return 'lose';
  const margin = isMeasured(best.quality) ? WALK.beatsBusByS : 0;
  if (walkAllS + margin < best.totalS) return 'win';
  if (walkAllS < best.totalS + WALK.mentionWithinS) return 'close';
  return 'lose';
}

/** One option rendered standalone, for the `alt` field. */
export function renderAlt(o: ScoredOption): string {
  return `${o.svc} · ${etaPhrase(o)} · ${shortStop(o.stop.name)}`;
}

function buildLabel(best: ScoredOption, nowMs: number): string {
  const svc = best.svc.length > 6 ? best.svc.slice(0, 6) : best.svc;
  if (best.quality === 'stale') {
    return clampLabel(`${svc} · ${mins(best.boardS)} (${ageMin(nowMs, best.fetchedAt)}m)`);
  }
  return clampLabel(`${svc} · ${etaPhrase(best)}`);
}

function buildDetail(f: FormatInput, best: ScoredOption, verdict: WalkVerdict): string {
  const parts: string[] = [shortStop(best.stop.name)];

  // Being sent to the stop you are NOT standing at is the answer that saves
  // the bus, and it is also the one that looks wrong. Say it out loud.
  const elsewhere = Boolean(f.nearestStop && f.nearestStop.code !== best.stop.code);
  if (elsewhere && f.nearestStop?.opposite === best.stop.code) parts.push('cross the road');
  else if (best.walkS >= 60) parts.push(`${mins(best.walkS)} walk`);
  else if (elsewhere) parts.push('short walk');
  // No nearestStop means no coordinates, so we cannot claim you are anywhere.
  else if (f.nearestStop) parts.push('right here');

  if (f.destLabel && best.hops > 0) {
    parts.push(
      best.quality === 'unknown'
        ? `${f.destLabel}, ${best.hops} stop${best.hops === 1 ? '' : 's'}`
        : `${f.destLabel} ~${mins(best.totalS)}`,
    );
  } else if (f.destLabel) {
    parts.push(`at ${f.destLabel}`);
  }

  if (verdict === 'close' && f.walkAllS != null) parts.push(`walk ${mins(f.walkAllS)}`);

  const crowd = crowdWord(best.arrival?.crowd ?? null);
  if (crowd) parts.push(crowd);

  // Degrade in public: an unresolvable direction is worse than a stale time,
  // because it is the failure that walks you onto the wrong bus.
  if (best.ambiguousBerth) parts.push('direction unconfirmed');

  if (best.quality === 'stale') parts.push(`${ageMin(f.nowMs, best.fetchedAt)} min old`);
  else if (best.quality === 'scheduled') parts.push('estimated');
  else if (best.quality === 'unknown') parts.push('live times unavailable');

  if (f.alt) {
    // Same service off a different stop: naming the service alone reads as
    // "another D2 is coming here", which is not what it means.
    const eta = etaPhrase(f.alt);
    parts.push(
      f.alt.svc === best.svc ? `or ${shortStop(f.alt.stop.name)} ${eta}` : `or ${f.alt.svc} ${eta}`,
    );
  }

  return parts.join(' · ');
}

/**
 * The degrade ladder: live -> scheduled -> unknown -> stale -> ended.
 *
 * A three-minute-old answer honestly labelled beats a spinner, and beats an
 * empty tile that reads as "no buses".
 */
/**
 * Whole-second ISO, "2026-09-28T01:14:02Z". Clients parse these, and a
 * default Swift ISO8601DateFormatter rejects the ".000" toISOString adds.
 */
export const isoSeconds = (ms: number) => new Date(Math.round(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
const iso = isoSeconds;

export function buildAnswer(f: FormatInput): Answer {
  const best = f.options[0];

  if (!best) {
    const stop = f.fallbackStop;
    const walk = f.walkAllS;
    // A short walk with nothing to board is not an outage, it is an answer.
    const trivial = walk != null && walk <= WALK.mentionWithinS;
    const label = clampLabel(
      walk == null ? 'No buses running' : trivial ? `Walk · ${mins(walk)}` : `No bus · walk ${mins(walk)}`,
    );
    const detail =
      walk == null
        ? 'Services ended for the night'
        : trivial
          ? `${f.destLabel ?? 'It'} is a ${mins(walk)} walk`
          : `Services ended · ${mins(walk)} walk to ${f.destLabel ?? 'there'}`;
    return {
      label,
      detail,
      // The label already says to walk; repeating it as the alternative is noise.
      alt: null,
      stop: { code: stop?.code ?? '', name: stop?.name ?? '', confidence: f.confidence },
      quality: 'ended' as Quality,
      asOf: new Date(f.nowMs).toISOString(),
      arrivals: f.arrivals,
      departsAt: null,
      arriveAt: walk != null ? iso(f.nowMs + walk * 1000) : null,
    };
  }

  const verdict = walkVerdict(f.walkAllS, best);

  // `quality` still describes the bus data, because `asOf` and `arrivals`
  // still describe the feed. When it is 'unknown', that is precisely why
  // walking won.
  const common = {
    stop: { code: best.stop.code, name: best.stop.name, confidence: f.confidence },
    quality: best.quality,
    // A stale answer keeps its ORIGINAL fetch time. Lying about this is worse
    // than being stale.
    asOf: new Date(best.quality === 'stale' ? best.fetchedAt : f.nowMs).toISOString(),
    arrivals: f.arrivals,
  };

  // Board and ride times count from when the arrivals were fetched. An
  // 'unknown' option's times are sort keys, never clock times.
  const timed = best.quality !== 'unknown';
  const departsAt = timed ? iso(best.fetchedAt + best.boardS * 1000) : null;
  const arriveAt = timed ? iso(best.fetchedAt + best.totalS * 1000) : null;

  if (verdict === 'win' && f.walkAllS != null) {
    const busPhrase =
      best.quality === 'unknown'
        ? `${best.svc} has no live times`
        : `${best.svc} would be ${mins(best.totalS)}`;
    return {
      ...common,
      label: clampLabel(`Walk · ${mins(f.walkAllS)}`),
      detail: [
        f.destLabel ? `On foot to ${f.destLabel}` : 'Faster on foot',
        busPhrase,
        `from ${shortStop(best.stop.name)}`,
      ].join(' · '),
      alt: renderAlt(best),
      departsAt: null,
      arriveAt: iso(f.nowMs + f.walkAllS * 1000),
    };
  }

  return {
    ...common,
    label: buildLabel(best, f.nowMs),
    detail: buildDetail(f, best, verdict),
    alt: f.alt ? renderAlt(f.alt) : null,
    departsAt,
    arriveAt,
  };
}
