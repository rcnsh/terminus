import type { Env } from './types.ts';
import { onceEvery, perScope } from './memo.ts';

export function analyticsEnabled(env: Pick<Env, 'AE'>): boolean {
  return typeof env.AE?.writeDataPoint === 'function';
}

interface RowSpec {
  index: string;
  blobs: readonly (string | null)[];
  doubles: readonly (string | null)[];
  optional?: readonly string[];
}

const ARRIVAL_BLOBS = ['stop', 'svc', 'dest', 'quality', 'plate', 'crowd', null, 'berth'] as const;

export const ROWS = {
  answer: {
    index: 'stop',
    blobs: ['stop', 'svc', 'dest', 'quality', null, 'crowd', null, 'berth', 'via', 'svc2'],
    doubles: [null, 'boardS', 'rideS', 'totalS', 'hops', 'walkS', 'confidence', 'ambiguousBerth', 'hadCoords', 'walkAllS', 'changeWaitS'],
  },
  arrival: {
    index: 'stop',
    blobs: ARRIVAL_BLOBS,
    doubles: ['etaS', 'boardS', 'rideS', 'totalS', 'hops', 'walkS', 'confidence', 'ambiguousBerth', 'hadCoords', 'walkAllS'],
  },
  board: { index: 'stop', blobs: ARRIVAL_BLOBS, doubles: ['etaS'] },
  next: { index: 'kind', blobs: [], doubles: [null, null, null, null, null, null, null, null, null, null, null, 'tookMs'] },
  error: { index: 'kind', blobs: ['route', 'reason'], doubles: [], optional: ['reason'] },
  timelapse: { index: 'kind', blobs: ['outcome', 'svc'], doubles: ['buses'] },
  tripwake: { index: 'kind', blobs: ['changed', 'phase', 'quality', 'first'], doubles: ['gapS', 'feedAgeS', 'leaveShiftS', 'lateS'] },
  active: { index: 'kind', blobs: ['scope', 'name', 'day'], doubles: ['d1', 'd7', 'd30'] },
  legacy: { index: 'kind', blobs: ['what', 'client', 'route'], doubles: ['n'] },
  settings: { index: 'kind', blobs: ['setting', 'value', 'day'], doubles: ['n', 'of'] },
  apikey: { index: 'keyId', blobs: ['keyId', 'route', 'outcome'], doubles: ['n'] },
  apperror: {
    index: 'kind',
    blobs: ['platform', 'version', 'fingerprint', 'type', 'message', 'stack', 'os'],
    doubles: ['n', 'fatal'],
  },
  signal: { index: 'kind', blobs: ['signal'], doubles: ['n'] },
  step: { index: 'kind', blobs: ['dir', 'trip'], doubles: ['n'] },
} as const satisfies Record<string, RowSpec>;

export type RowKind = keyof typeof ROWS;
type Named<A> = Exclude<A extends readonly (infer T)[] ? T : never, null>;
type BlobField<K extends RowKind> = Named<(typeof ROWS)[K]['blobs']>;
type DoubleField<K extends RowKind> = Named<(typeof ROWS)[K]['doubles']>;
type Optional<K extends RowKind> = (typeof ROWS)[K] extends { optional: readonly (infer O)[] } ? O : never;
export type RowFields<K extends RowKind> = { [F in Exclude<BlobField<K>, Optional<K>>]: string } & {
  [F in Exclude<DoubleField<K>, Optional<K>>]: number;
} & { [F in BlobField<K> & Optional<K>]?: string } & { [F in DoubleField<K> & Optional<K>]?: number };

export type Columns<K extends RowKind> = { readonly [F in BlobField<K> | DoubleField<K> | 'kind']: string };

type ColumnsOf<K> = K extends RowKind ? Columns<K> : never;

function columnsOf(spec: RowSpec): Record<string, string> {
  const out: Record<string, string> = { kind: 'blob1' };
  spec.blobs.forEach((f, i) => f && (out[f] = `blob${i + 2}`));
  spec.doubles.forEach((f, i) => f && (out[f] = `double${i + 1}`));
  return out;
}

export const COL = Object.fromEntries(Object.entries(ROWS).map(([k, spec]) => [k, columnsOf(spec)])) as unknown as {
  readonly [K in RowKind]: Columns<K>;
};

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

function layout(names: readonly (string | null)[], fields: Record<string, unknown>, empty: string | number): (string | number)[] {
  let last = -1;
  names.forEach((f, i) => f && fields[f] !== undefined && (last = i));
  return names.slice(0, last + 1).map((f) => (f && fields[f] !== undefined ? (fields[f] as string | number) : empty));
}

export function rowPoint<K extends RowKind>(kind: K, fields: RowFields<K>): AnalyticsEngineDataPoint {
  const spec: RowSpec = ROWS[kind];
  const f = fields as Record<string, unknown>;
  return {
    blobs: [kind, ...(layout(spec.blobs, f, '') as string[])],
    doubles: layout(spec.doubles, f, 0) as number[],
    indexes: [spec.index === 'kind' ? kind : String(f[spec.index] ?? '')],
  };
}

const lostRows = perScope(() => onceEvery(10 * 60_000, 50));

export function writeRow<K extends RowKind>(env: Pick<Env, 'AE'>, kind: K, fields: RowFields<K>, nowMs: number = Date.now()): void {
  if (!analyticsEnabled(env)) return;
  try {
    env.AE!.writeDataPoint(rowPoint(kind, fields));
  } catch (err) {
    if (lostRows(env.AE).due(kind, nowMs))
      console.error(`analytics row ${kind} lost: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  }
}
