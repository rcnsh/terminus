import type { Answer, Env, ScoredOption, StopArrivals } from '../types.ts';
import { collectingMemo } from './collect.ts';
import { analyticsEnabled, writeRow } from '../analytics-rows.ts';
import type { RowFields } from '../analytics-rows.ts';

export { analyticsEnabled };

const MAX_ARRIVAL_ROWS = 8;

export interface LogInput {
  answer: Answer;
  best: ScoredOption | null;
  dest: string | null;
  hadCoords: boolean;
  walkAllS: number | null;
}

export function logAnswer(env: Env, input: LogInput): void {
  if (!analyticsEnabled(env)) return;
  const { answer, best } = input;
  const stop = answer.stop.code || 'none';
  const hadCoords = input.hadCoords ? 1 : 0;

  writeRow(env, 'answer', {
    stop,
    svc: best?.svc ?? '',
    dest: input.dest ?? '',
    quality: answer.quality,
    crowd: best?.arrival?.crowd ?? '',
    berth: best?.arrival?.berth ?? '',
    via: best?.change?.stop.code ?? '',
    svc2: best?.change?.svc ?? '',
    boardS: best?.boardS ?? -1,
    rideS: best?.rideS ?? -1,
    totalS: best?.totalS ?? -1,
    hops: best?.hops ?? -1,
    walkS: best?.walkS ?? -1,
    confidence: answer.stop.confidence,
    ambiguousBerth: best?.ambiguousBerth ? 1 : 0,
    hadCoords,
    walkAllS: input.walkAllS ?? -1,
    changeWaitS: best?.change ? best.change.boardS - best.change.reachS - best.change.crossS : -1,
  });

  for (const a of answer.arrivals.slice(0, MAX_ARRIVAL_ROWS)) {
    if (a.etaS == null) continue;
    writeRow(env, 'arrival', {
      stop,
      svc: a.svc,
      dest: input.dest ?? '',
      quality: answer.quality,
      plate: a.plate ?? '',
      crowd: a.crowd ?? '',
      berth: a.berth ?? '',
      etaS: a.etaS,
      boardS: -1,
      rideS: -1,
      totalS: -1,
      hops: -1,
      walkS: -1,
      confidence: answer.stop.confidence,
      ambiguousBerth: 0,
      hadCoords,
      walkAllS: -1,
    });
  }
}

const MAX_BOARD_ROWS = 16;

export async function logBoard(env: Env, sa: StopArrivals): Promise<void> {
  if (!analyticsEnabled(env) || !(await collectingMemo(env, 'eta'))) return;
  const lagS = Math.max(0, (Date.now() - sa.fetchedAt) / 1000);
  let n = 0;
  for (const a of sa.arrivals) {
    if (a.etaS == null || !a.plate || a.scheduled) continue;
    if (++n > MAX_BOARD_ROWS) break;
    writeRow(env, 'board', {
      stop: sa.code,
      svc: a.svc,
      dest: '',
      quality: 'live',
      plate: a.plate,
      crowd: a.crowd ?? '',
      berth: a.berth ?? '',
      etaS: Math.max(0, a.etaS - lagS),
    });
  }
}

export function logNextTook(env: Env, tookMs: number): void {
  writeRow(env, 'next', { tookMs: Math.max(0, Math.round(tookMs)) });
}

export function logError(env: Env, path: string): void {
  const parts = path.split('/');
  const route = parts.slice(0, parts[1] === 'api' ? 4 : 3).join('/') || '/';
  writeRow(env, 'error', { route });
}

export function logCronError(env: Env, step: string): void {
  writeRow(env, 'error', { route: `cron ${step}` });
}

export type PollOutcome = 'upstream' | 'error' | 'hit' | 'stale' | 'failed' | 'skipped' | 'retry';

export function logPoll(env: Env, outcome: PollOutcome, svc: string, buses: number): void {
  writeRow(env, 'timelapse', { outcome, svc, buses });
}

export interface WakeRow {
  changed: boolean;
  phase: string;
  quality: string;
  first: boolean;
  gapS: number;
  feedAgeS: number;
  leaveShiftS: number;
  lateS: number;
}

export function logTripWake(env: Env, r: WakeRow): void {
  writeRow(env, 'tripwake', {
    changed: r.changed ? 'pushed' : 'same',
    phase: r.phase,
    quality: r.quality,
    first: r.first ? 'first' : 'again',
    gapS: r.gapS,
    feedAgeS: r.feedAgeS,
    leaveShiftS: r.leaveShiftS,
    lateS: r.lateS,
  });
}

export type ActiveRow = RowFields<'active'> & { scope: 'all' | 'app' | 'version' };

export function logActive(env: Env, row: ActiveRow): void {
  writeRow(env, 'active', row);
}

export interface LegacyRow {
  what: 'address' | 'path' | 'outdated';
  client: string;
  route: string;
}

export function logLegacy(env: Env, r: LegacyRow): void {
  writeRow(env, 'legacy', { what: r.what, client: r.client, route: r.route, n: 1 });
}

export type SettingRow = RowFields<'settings'>;

export function logSetting(env: Env, r: SettingRow): void {
  writeRow(env, 'settings', r);
}

export interface KeyUseRow {
  keyId: string;
  route: string;
  outcome: 'ok' | 'limited';
}

export function logKeyUse(env: Env, r: KeyUseRow): void {
  writeRow(env, 'apikey', { keyId: r.keyId, route: r.route, outcome: r.outcome, n: 1 });
}

export interface AppErrorRow {
  platform: string;
  version: string;
  fingerprint: string;
  type: string;
  message: string;
  stack: string;
  os: string;
  fatal: boolean;
}

export function logAppError(env: Env, r: AppErrorRow): void {
  writeRow(env, 'apperror', { ...r, n: 1, fatal: r.fatal ? 1 : 0 });
}

export function logSignal(env: Env, signal: string): void {
  writeRow(env, 'signal', { signal, n: 1 });
}

export function logStep(env: Env, dir: 'earlier' | 'later' | 'best', trip: string): void {
  const kind = /^(gap-)?home:/.test(trip) ? 'home' : /^(place|to):/.test(trip) ? 'place' : 'class';
  writeRow(env, 'step', { dir, trip: kind, n: 1 });
}

export async function aeSql(env: Env, q: string, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>[]> {
  const res = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.ANALYTICS_TOKEN}` },
    body: q,
  });
  if (!res.ok) throw new Error(`Analytics Engine answered ${res.status}`);
  return ((await res.json()) as { data: Record<string, unknown>[] }).data;
}
