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
 */
interface RowSpec {
  index: string;
  blobs: readonly (string | null)[];
  doubles: readonly (string | null)[];
}

/** The blobs of an 'arrival' row, which 'board' rows share so one query reads both (eta.ts predictionsFor). */
const ARRIVAL_BLOBS = ['stop', 'svc', 'dest', 'quality', 'plate', 'crowd', null, 'berth'] as const;

/**
 * Every kind of row, its columns in the order they are written. The layout
 * is frozen: never move, rename into another meaning, or remove a column,
 * or every query written before the change starts lying; a new field takes
 * a position no kind reading the same query uses. Each kind has a section
 * in docs/analytics.md (analytics-rows.test.js checks).
 */
export const ROWS = {
  /** The answer someone asked for (logAnswer). blob6 and blob8 are kept '': plate and trip, which answers never had. */
  answer: {
    index: 'stop',
    blobs: ['stop', 'svc', 'dest', 'quality', null, 'crowd', null, 'berth', 'via', 'svc2'],
    doubles: [null, 'boardS', 'rideS', 'totalS', 'hops', 'walkS', 'confidence', 'ambiguousBerth', 'hadCoords', 'walkAllS', 'changeWaitS'],
  },
  /** A timed bus at an answer's stop (logAnswer), at most MAX_ARRIVAL_ROWS per answer; its doubles are the answer's, but etaS. */
  arrival: {
    index: 'stop',
    blobs: ARRIVAL_BLOBS,
    doubles: ['etaS', 'boardS', 'rideS', 'totalS', 'hops', 'walkS', 'confidence', 'ambiguousBerth', 'hadCoords', 'walkAllS'],
  },
  /** A bus on a board just fetched from NUS (logBoard): an 'arrival' row with etaS its only double. */
  board: { index: 'stop', blobs: ARRIVAL_BLOBS, doubles: ['etaS'] },
  /** One /api/me/next answered (logNextTook): tookMs is double12, past every answer column. */
  next: { index: 'kind', blobs: [], doubles: [null, null, null, null, null, null, null, null, null, null, null, 'tookMs'] },
  /** An unhandled error's route, a cron step's 'cron <step>' or the feed's 'feed arrivals' | 'feed buses' with why. */
  error: { index: 'kind', blobs: ['route', 'reason'], doubles: [] },
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
/** A row's fields by name. One left out is written as an empty column, and trailing ones aren't written. */
export type RowFields<K extends RowKind> = { [F in BlobField<K>]?: string } & { [F in DoubleField<K>]?: number };

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

/** [fields] as the kind's columns, padding what's left out and dropping what trails. */
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
