/**
 * The layout of every Analytics Engine row terminus writes, declared once.
 *
 * Analytics Engine SQL addresses columns only as blob1..blob20 and
 * double1..double20, and a row can't be rewritten once written (they are
 * kept about three months), so each kind's positions are the query
 * contract. ROWS names them: writeRow writes a row by name, and COL gives
 * readers the column each name is in. The loggers are in ops/analytics.ts;
 * what each kind means is in docs/analytics.md.
 *
 * At the top of src, not in ops/, so the feed code (which imports nothing
 * from src's folders) writes its failures through the same table.
 */

import type { Env } from './types.ts';

export function analyticsEnabled(env: Env): boolean {
  return typeof env.AE?.writeDataPoint === 'function';
}

/**
 * One kind of row: blob1 is always the kind, so `blobs` names blob2 on and
 * `doubles` double1 on, by position. null is a column the kind keeps empty
 * ('' or 0) so the ones after it stay where queries already read them.
 * `index` is the field that is index1 (the sampling key), or 'kind'.
 * Every field is required when writing, so a logger that drops one fails
 * tsc rather than writing a believable '' or 0; `optional` names the
 * fields a kind may leave out, which then aren't written at all.
 */
interface RowSpec {
  index: string;
  blobs: readonly (string | null)[];
  doubles: readonly (string | null)[];
  optional?: readonly string[];
}

/** The blobs of an 'arrival' row, which 'board' rows share so one query reads both (eta.ts predictionsFor). */
const ARRIVAL_BLOBS = [
  'stop', // the answer's stop code; a board's own
  'svc', // service
  'dest', // the answer's destination stop code; '' on a board
  'quality', // the answer's: live | scheduled | unknown | stale | ended; 'live' on a board
  'plate',
  'crowd', // low | medium | high | ''
  null, // blob8: always ''
  'berth', // raw busStopCode, so a route's first stop ends -S
] as const;

/**
 * Every kind of row, its columns in the order they are written. Kinds
 * already give blob2 on and double1 on their own meanings, so a column's
 * meaning is per kind. Existing positions never move, get renamed into
 * another meaning or go, or every query written before the change starts
 * lying. A new field takes a position unused within its own kind and by
 * any kind read in the same query (arrival and board, answer and arrival).
 * Each kind has a section in docs/analytics.md (analytics-rows.test.js
 * checks).
 */
export const ROWS = {
  /** The answer someone asked for (logAnswer). With no bus, svc is '' and boardS..walkS are -1. */
  answer: {
    index: 'stop',
    blobs: [
      'stop', // boarding stop code, 'none' when there is none
      'svc', // service, '' on an ended answer
      'dest', // destination stop code, '' for a bare /next
      'quality', // live | scheduled | unknown | stale | ended
      null, // blob6: always '' (the plate, on an arrival row)
      'crowd', // low | medium | high | ''
      null, // blob8: always '', kept so the columns after it don't shift
      'berth', // raw busStopCode
      'via', // the stop a trip changes buses at, '' on one bus
      'svc2', // the bus after the change, '' on one bus
    ],
    doubles: [
      null, // double1: always 0 (etaS, on an arrival row)
      'boardS', // seconds until you can board, -1 with no bus
      'rideS', // -1 with no bus
      'totalS', // -1 with no bus
      'hops', // -1 with no bus
      'walkS', // the walk to the boarding stop, -1 with no bus
      'confidence', // in the stop chosen, 0..1
      'ambiguousBerth', // 0 | 1
      'hadCoords', // 0 | 1: a location was sent
      'walkAllS', // the whole-way walk, -1 when unknown
      'changeWaitS', // seconds waiting for the bus after a change, -1 on one bus
    ],
  },
  /**
   * A timed bus at an answer's stop (logAnswer), at most MAX_ARRIVAL_ROWS per answer. Its doubles are
   * the answer's, but etaS, with boardS..walkS and walkAllS always -1 and ambiguousBerth always 0.
   */
  arrival: {
    index: 'stop',
    blobs: ARRIVAL_BLOBS,
    doubles: [
      'etaS', // seconds to arrival
      'boardS',
      'rideS',
      'totalS',
      'hops',
      'walkS',
      'confidence',
      'ambiguousBerth',
      'hadCoords',
      'walkAllS',
    ],
  },
  /** A bus on a board just fetched from NUS (logBoard): an 'arrival' row with etaS its only double. */
  board: { index: 'stop', blobs: ARRIVAL_BLOBS, doubles: ['etaS'] },
  /** One /api/me/next answered (logNextTook): tookMs is double12, past every answer column. */
  next: { index: 'kind', blobs: [], doubles: [null, null, null, null, null, null, null, null, null, null, null, 'tookMs'] },
  /** An unhandled error's route, a cron step's 'cron <step>' or the feed's 'feed arrivals' | 'feed buses' with why. */
  error: { index: 'kind', blobs: ['route', 'reason'], doubles: [], optional: ['reason'] },
  /** One poll of the timelapse recorder and what it cost NUS (logPoll). */
  timelapse: { index: 'kind', blobs: ['outcome', 'svc'], doubles: ['buses'] },
  /** One Trip object wake (logTripWake). */
  tripwake: { index: 'kind', blobs: ['changed', 'phase', 'quality', 'first'], doubles: ['gapS', 'feedAgeS', 'leaveShiftS', 'lateS'] },
  /** A day's active counts (logActive). */
  active: { index: 'kind', blobs: ['scope', 'name', 'day'], doubles: ['d1', 'd7', 'd30'] },
  /** One request that used something on its way out (logLegacy). */
  legacy: { index: 'kind', blobs: ['what', 'client', 'route'], doubles: ['n'] },
  /** A day's count of one setting's value (logSetting). */
  settings: { index: 'kind', blobs: ['setting', 'value', 'day'], doubles: ['n', 'of'] },
  /** One request made with an API key (logKeyUse), indexed by the key. */
  apikey: { index: 'keyId', blobs: ['keyId', 'route', 'outcome'], doubles: ['n'] },
  /** One error report from an app or the website (logAppError). */
  apperror: {
    index: 'kind',
    blobs: ['platform', 'version', 'fingerprint', 'type', 'message', 'stack', 'os'],
    doubles: ['n', 'fatal'],
  },
  /** One trip signal (logSignal). */
  signal: { index: 'kind', blobs: ['signal'], doubles: ['n'] },
  /** One step between buses (logStep). */
  step: { index: 'kind', blobs: ['dir', 'trip'], doubles: ['n'] },
} as const satisfies Record<string, RowSpec>;

export type RowKind = keyof typeof ROWS;
type Named<A> = Exclude<A extends readonly (infer T)[] ? T : never, null>;
type BlobField<K extends RowKind> = Named<(typeof ROWS)[K]['blobs']>;
type DoubleField<K extends RowKind> = Named<(typeof ROWS)[K]['doubles']>;
type Optional<K extends RowKind> = (typeof ROWS)[K] extends { optional: readonly (infer O)[] } ? O : never;
/** A row's fields by name, each required but those the kind declares optional. */
export type RowFields<K extends RowKind> = { [F in Exclude<BlobField<K>, Optional<K>>]: string } & {
  [F in Exclude<DoubleField<K>, Optional<K>>]: number;
} & { [F in BlobField<K> & Optional<K>]?: string } & { [F in DoubleField<K> & Optional<K>]?: number };

/** The column a kind writes each of its fields to ('blob5', 'double12'), and blob1 as `kind`. */
export type Columns<K extends RowKind> = { readonly [F in BlobField<K> | DoubleField<K> | 'kind']: string };

/** Columns<K> for each kind in a union apart, so keyof is the fields they all have. */
type ColumnsOf<K> = K extends RowKind ? Columns<K> : never;

function columnsOf(spec: RowSpec): Record<string, string> {
  const out: Record<string, string> = { kind: 'blob1' };
  spec.blobs.forEach((f, i) => f && (out[f] = `blob${i + 2}`));
  spec.doubles.forEach((f, i) => f && (out[f] = `double${i + 1}`));
  return out;
}

/** Each kind's columns by field name, for building a query: `${COL.answer.quality} AS quality`. */
export const COL = Object.fromEntries(Object.entries(ROWS).map(([k, spec]) => [k, columnsOf(spec)])) as unknown as {
  readonly [K in RowKind]: Columns<K>;
};

/**
 * The columns two or more kinds share, for a query that reads them together
 * (eta.ts reads 'arrival' and 'board' rows as one). Throws when a field they
 * both name sits in different columns, so the query can't mix two meanings.
 */
export function sharedColumns<K extends RowKind>(...kinds: K[]): { readonly [F in keyof ColumnsOf<K>]: string } {
  const [first, ...rest] = kinds.map((k) => COL[k] as Record<string, string>);
  const out: Record<string, string> = {};
  for (const [f, c] of Object.entries(first)) {
    if (!rest.every((r) => f in r)) continue;
    const other = rest.find((r) => r[f] !== c);
    if (other) throw new Error(`${kinds.join(' and ')} keep ${f} in different columns`);
    out[f] = c;
  }
  return out as unknown as { readonly [F in keyof ColumnsOf<K>]: string };
}

/** [fields] as the kind's columns, padding nulls and optional fields left out, and dropping what trails. */
function layout(names: readonly (string | null)[], fields: Record<string, unknown>, empty: string | number): (string | number)[] {
  let last = -1;
  names.forEach((f, i) => f && fields[f] !== undefined && (last = i));
  return names.slice(0, last + 1).map((f) => (f && fields[f] !== undefined ? (fields[f] as string | number) : empty));
}

/** The data point a row of [kind] is written as. */
export function rowPoint<K extends RowKind>(kind: K, fields: RowFields<K>): AnalyticsEngineDataPoint {
  const spec: RowSpec = ROWS[kind];
  const f = fields as Record<string, unknown>;
  return {
    blobs: [kind, ...(layout(spec.blobs, f, '') as string[])],
    doubles: layout(spec.doubles, f, 0) as number[],
    indexes: [spec.index === 'kind' ? kind : String(f[spec.index] ?? '')],
  };
}

/** Writes one row of [kind], by name. Never throws: a lost row never costs an answer. */
export function writeRow<K extends RowKind>(env: Env, kind: K, fields: RowFields<K>): void {
  if (!analyticsEnabled(env)) return;
  try {
    env.AE!.writeDataPoint(rowPoint(kind, fields));
  } catch {
    // Deliberately swallowed. Losing a metric is not worth losing an answer.
  }
}
