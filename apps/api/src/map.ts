/**
 * The street map under the Map tab, served from our own domain so no third
 * party sees where anyone looks and there is no API key.
 *
 *   /map/campus.pmtiles          the campus's streets, buildings and paths:
 *                                one PMTiles file on R2, read in pieces
 *                                (HTTP range requests) by MapLibre
 *   /map/style.json?theme=&lang= a MapLibre style for it, light or dark,
 *                                English or Chinese labels
 *   /map/fonts/<font>/<range>.pbf  label glyphs
 *   /map/sprites/<file>          map icons
 *
 * scripts/map-tiles.sh cuts the file from the Protomaps build of
 * OpenStreetMap and uploads it, the fonts and the icons, under map/ in the
 * DOWNLOADS bucket. Map data (c) OpenStreetMap contributors, ODbL.
 *
 * Every map open asks for dozens of pieces, the same pieces for everyone,
 * so each piece is kept in the edge cache (edgePart, edgeFile) and R2 is
 * read once per piece per data centre, not once per person. Reads from R2
 * are limited per IP (RL_MAP); pieces already in the cache are not, so a
 * lecture hall on one Wi-Fi address can all open the map at once.
 */

import { layers, namedFlavor } from '@protomaps/basemaps';
import type { Env } from './types.ts';
import { CORS, clientKey, json } from './http.ts';

const PREFIX = 'map/';
const TILES = 'campus.pmtiles';
const SPRITES = 'v4';
/** The file covers this, and the map doesn't pan past it. [west, south, east, north] */
export const MAP_BOUNDS = [103.755, 1.28, 103.83, 1.332] as const;
const ATTRIBUTION = '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>';

const FONT = /^\/map\/fonts\/(Noto Sans (?:Regular|Medium|Italic))\/(\d{1,5}-\d{1,5})\.pbf$/;
const SPRITE = /^\/map\/sprites\/v4\/(light|dark)(@2x)?\.(json|png)$/;

/**
 * The base map's points of interest (libraries, parks, cafés, its own bus
 * stops): left out, so the routes and stops on top are what stands out.
 * Street, area and place names stay.
 */
const HIDDEN_LAYERS = new Set(['pois']);

export type Theme = 'light' | 'dark';

/**
 * The style: Protomaps' light or dark map without its points of interest,
 * so the bus routes and stops on top stand out, with every URL absolute
 * (MapLibre Native needs that).
 */
export function mapStyle(origin: string, theme: Theme, lang: 'en' | 'zh'): Record<string, unknown> {
  const flavor = namedFlavor(theme);
  const base = layers('protomaps', flavor, { lang: lang === 'zh' ? 'zh-Hans' : 'en' }).filter((layer) => !HIDDEN_LAYERS.has(layer.id));
  return {
    version: 8,
    name: `terminus ${theme}`,
    glyphs: `${origin}/map/fonts/{fontstack}/{range}.pbf`,
    sprite: `${origin}/map/sprites/${SPRITES}/${theme}`,
    sources: {
      protomaps: {
        type: 'vector',
        url: `pmtiles://${origin}/map/${TILES}`,
        attribution: ATTRIBUTION,
      },
    },
    layers: base,
  };
}

/** Each style, built once per isolate: it's the same every time. */
const styles = new Map<string, string>();

/** Serves /map/*; null for any other path. */
export async function handleMap(req: Request, url: URL, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
  const path = url.pathname;
  if (!path.startsWith('/map/')) return null;

  if (path === '/map/style.json') {
    const theme: Theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
    const lang = url.searchParams.get('lang') === 'zh' ? 'zh' : 'en';
    const id = `${url.origin} ${theme} ${lang}`;
    let style = styles.get(id);
    if (!style) styles.set(id, (style = JSON.stringify(mapStyle(url.origin, theme, lang))));
    return new Response(style, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=3600', ...CORS } });
  }

  if (!env.DOWNLOADS) return json({ error: 'not found' }, 404);
  // Asked at most once per request, and only when R2 is about to be read:
  // never for what the edge cache already has.
  let allowed: Promise<boolean> | null = null;
  const mayRead = () => (allowed ??= env.RL_MAP ? env.RL_MAP.limit({ key: `map:${clientKey(req)}` }).then((r) => r.success, () => true) : Promise.resolve(true));

  if (path === `/map/${TILES}`) return edgePart(req, env.DOWNLOADS, PREFIX + TILES, 'application/vnd.pmtiles', 86400, mayRead, ctx);

  // A malformed escape ("%E0") is a bad path: not found, not an error.
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return json({ error: 'not found' }, 404);
  }
  // Fonts and icons never change at their path (a new set of icons gets a
  // new folder, as v4 is), so they're kept by path alone.
  const file = (key: string, type: string) => edgeFile(req, env.DOWNLOADS!, key, type, 30 * 86400, mayRead, ctx);
  const font = FONT.exec(decoded);
  if (font && glyphRange(font[2])) return file(`${PREFIX}fonts/${font[1]}/${font[2]}.pbf`, 'application/x-protobuf');

  const sprite = SPRITE.exec(path);
  if (sprite) return file(`${PREFIX}sprites/${SPRITES}/${sprite[1]}${sprite[2] ?? ''}.${sprite[3]}`, sprite[3] === 'png' ? 'image/png' : 'application/json');
  return json({ error: 'not found' }, 404);
}

/** A range of 256 glyphs, as MapLibre asks for them ("512-767"): anything else is no file, so not worth an R2 read. */
export function glyphRange(range: string): boolean {
  const [start, end] = range.split('-').map(Number);
  return start % 256 === 0 && end === start + 255 && end <= 65_535;
}

const slowDown = () => json({ error: 'too many requests, slow down' }, 429, { 'retry-after': '60' });
/** R2 didn't answer: the map should ask again soon, not take the file for broken (a PMTiles reader gives up on a 416). */
const unavailable = () => json({ error: 'terminus is busy, try again in a minute' }, 503, { 'retry-after': '60' });

/** How long what was learnt of the map file (its ETag and size) is trusted, in an isolate and at the edge. */
const HEAD_TTL_MS = 5 * 60_000;
/** While R2 fails, how long the last known ETag is trusted before R2 is asked again. */
const HEAD_RETRY_MS = 30_000;
/** Pieces bigger than this go straight from R2, uncached. The whole map file is about 4 MB. */
const MAX_CACHED_BYTES = 32 * 1024 * 1024;
type Head = { etag: string; httpEtag: string; size: number; atMs: number };
const heads = new Map<string, Head>();

/** Forgets what this isolate learnt of every file, as a new isolate would start. For tests. */
export const forgetHeads = () => heads.clear();

/** Where the data centre keeps the last head R2 gave. */
const headId = (key: string) => new Request(`https://terminus.internal/map-head/${encodeURIComponent(key)}`);
/**
 * The edge keeps what it learnt far longer than it trusts it: an older look
 * is still worth having when R2 may not be read, or fails.
 */
const HEAD_KEPT_S = 30 * 86_400;

/**
 * What is known of the file: this isolate's copy, else the data centre's
 * (the edge cache, so its isolates share one R2 look per HEAD_TTL_MS), else
 * R2's; null when there's no such file. Trusted for HEAD_TTL_MS from when
 * R2 was asked, wherever it was kept. Past that, when this request may not
 * read R2, the older look stands: its pieces are still the bytes of the
 * file its ETag names, and a piece already in the edge cache is never
 * refused. When R2 fails, the last look stands in too, trusted for
 * HEAD_RETRY_MS so cached pieces don't each cost an R2 call; with none,
 * 'unavailable'.
 */
async function headOf(
  cache: Cache,
  bucket: R2Bucket,
  key: string,
  nowMs: number,
  mayRead: () => Promise<boolean>,
  ctx?: ExecutionContext,
): Promise<Head | null | 'limited' | 'unavailable'> {
  const fresh = (h: Head | undefined) => (h && nowMs - h.atMs < HEAD_TTL_MS && nowMs >= h.atMs ? h : undefined);
  const local = heads.get(key);
  const mine = fresh(local);
  if (mine) return mine;
  const shared = await cachedHead(cache, key);
  const theirs = fresh(shared);
  if (theirs) {
    heads.set(key, theirs);
    return theirs;
  }
  if (!(await mayRead())) return local ?? shared ?? 'limited';
  let obj: R2Object | null;
  try {
    obj = await bucket.head(key);
  } catch {
    const last = local ?? shared;
    if (!last) return 'unavailable';
    const head = { ...last, atMs: nowMs - HEAD_TTL_MS + HEAD_RETRY_MS };
    heads.set(key, head);
    return head;
  }
  if (!obj) {
    await forgetHead(cache, key);
    return null;
  }
  const head = { etag: obj.etag, httpEtag: obj.httpEtag, size: obj.size, atMs: nowMs };
  heads.set(key, head);
  const put = cache.put(headId(key), Response.json(head, { headers: { 'cache-control': `public, max-age=${HEAD_KEPT_S}` } })).catch(() => {});
  if (ctx) ctx.waitUntil(put);
  else await put;
  return head;
}

/** The data centre's copy of the head, if it has a readable one. */
async function cachedHead(cache: Cache, key: string): Promise<Head | undefined> {
  try {
    const hit = await cache.match(headId(key));
    const head = hit ? ((await hit.json()) as Head) : undefined;
    return head && typeof head.etag === 'string' && typeof head.httpEtag === 'string' && Number.isFinite(head.size) && Number.isFinite(head.atMs) ? head : undefined;
  } catch {
    return undefined;
  }
}

/** Forget what was known of the file: it was replaced or removed. */
async function forgetHead(cache: Cache, key: string): Promise<void> {
  heads.delete(key);
  await cache.delete(headId(key)).catch(() => false);
}

/** Conditions beyond If-None-Match, which R2 decides. */
const otherConditions = (req: Request) => ['if-match', 'if-modified-since', 'if-unmodified-since', 'if-range'].some((h) => req.headers.has(h));

/**
 * The byte range a Range header asks for, within a file this size: null for
 * the whole file, 'unsatisfiable' past its end, 'other' for what R2 should
 * work out itself (several ranges, nonsense).
 */
export function rangeOf(header: string | null, size: number): { offset: number; length: number } | null | 'unsatisfiable' | 'other' {
  if (header === null) return null;
  const r = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!r || (r[1] === '' && r[2] === '')) return 'other';
  if (r[1] === '') {
    // The last n bytes.
    const n = Math.min(Number(r[2]), size);
    return n > 0 ? { offset: size - n, length: n } : 'unsatisfiable';
  }
  const offset = Number(r[1]);
  if (offset >= size) return 'unsatisfiable';
  const end = r[2] === '' ? size - 1 : Math.min(Number(r[2]), size - 1);
  return end < offset ? 'other' : { offset, length: end - offset + 1 };
}

/**
 * servePart, through the edge cache. A piece is kept under the file's ETag
 * and its byte range, and read from R2 only when it's missing, with the
 * ETag as a condition, so a cached piece is always from the file its key
 * names. A newly uploaded file has a new ETag, so its pieces are new keys,
 * seen within HEAD_TTL_MS. PMTiles readers ask for the same ranges every
 * time, so the pieces are shared by everyone. A piece from the cache is
 * streamed as it comes.
 */
async function edgePart(
  req: Request,
  bucket: R2Bucket,
  key: string,
  type: string,
  maxAgeS: number,
  mayRead: () => Promise<boolean>,
  ctx?: ExecutionContext,
): Promise<Response> {
  const cache = typeof caches === 'undefined' ? null : caches.default;
  const fromR2 = async () => ((await mayRead()) ? servePart(req, bucket, key, type, maxAgeS) : slowDown());
  if (!cache) return fromR2();
  const head = await headOf(cache, bucket, key, Date.now(), mayRead, ctx);
  if (head === 'limited') return slowDown();
  if (head === 'unavailable') return unavailable();
  if (!head) return json({ error: 'not found' }, 404);
  const headers = partHeaders(type, maxAgeS, head.httpEtag);
  // The client's copy is current: nothing to read.
  if (matchesEtag(req, head.httpEtag)) return new Response(null, { status: 304, headers });
  // Anything conditional beyond that, R2 decides.
  if (otherConditions(req)) return fromR2();

  const range = rangeOf(req.headers.get('range'), head.size);
  if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { 'content-range': `bytes */${head.size}` } });
  if (range === 'other') return fromR2();
  const { offset, length } = range ?? { offset: 0, length: head.size };
  if (length > MAX_CACHED_BYTES) return fromR2();

  const id = new Request(`https://terminus.internal/map/${encodeURIComponent(key)}?etag=${encodeURIComponent(head.etag)}&bytes=${offset}-${length}`);
  let body: ReadableStream | ArrayBuffer | null;
  const hit = await cache.match(id).catch(() => undefined);
  // Kept under this ETag and range, so exactly `length` bytes.
  if (hit) body = hit.body;
  else {
    if (!(await mayRead())) return slowDown();
    let obj: R2Object | R2ObjectBody | null;
    try {
      obj = await bucket.get(key, { range: { offset, length }, onlyIf: { etagMatches: head.etag } });
    } catch {
      // R2 failed, which says nothing about the file: keep what we know of it.
      return unavailable();
    }
    // Replaced since we last looked (or gone): forget it and let R2 answer.
    if (!obj || !('body' in obj)) {
      await forgetHead(cache, key);
      return fromR2();
    }
    // Read whole once, for the cache and this answer: a miss is once per
    // piece per data centre.
    const bytes = await obj.arrayBuffer();
    const put = cache.put(id, new Response(bytes.slice(0), { headers: { 'content-type': type, 'cache-control': `public, max-age=${maxAgeS}` } })).catch(() => {});
    if (ctx) ctx.waitUntil(put);
    else await put;
    body = bytes;
  }
  headers.set('content-length', String(length));
  if (!range) return new Response(body, { headers });
  headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${head.size}`);
  return new Response(body, { status: 206, headers });
}

/**
 * A file that never changes at its path (a font range, an icon sheet),
 * through the edge cache by path alone, with its ETag kept beside it: no
 * look at R2 for what the cache has. A range, or a condition other than
 * If-None-Match (MapLibre sends neither for these), R2 answers.
 */
async function edgeFile(
  req: Request,
  bucket: R2Bucket,
  key: string,
  type: string,
  maxAgeS: number,
  mayRead: () => Promise<boolean>,
  ctx?: ExecutionContext,
): Promise<Response> {
  const cache = typeof caches === 'undefined' ? null : caches.default;
  const fromR2 = async () => ((await mayRead()) ? servePart(req, bucket, key, type, maxAgeS) : slowDown());
  if (!cache || req.headers.has('range') || otherConditions(req)) return fromR2();
  const id = new Request(`https://terminus.internal/map/file/${encodeURIComponent(key)}`);
  const hit = await cache.match(id).catch(() => undefined);
  const etag = hit?.headers.get('etag');
  const size = hit?.headers.get('content-length');
  if (hit && etag && size) {
    const headers = partHeaders(type, maxAgeS, etag);
    if (matchesEtag(req, etag)) {
      await hit.body?.cancel();
      return new Response(null, { status: 304, headers });
    }
    headers.set('content-length', size);
    return new Response(hit.body, { headers });
  }
  if (!(await mayRead())) return slowDown();
  let obj: R2ObjectBody | null;
  try {
    obj = await bucket.get(key);
  } catch {
    // R2 failed, which says nothing about the file.
    return unavailable();
  }
  if (!obj) return json({ error: 'not found' }, 404);
  const headers = partHeaders(type, maxAgeS, obj.httpEtag);
  headers.set('content-length', String(obj.size));
  if (obj.size > MAX_CACHED_BYTES) return matchesEtag(req, obj.httpEtag) ? new Response(null, { status: 304, headers }) : new Response(obj.body, { headers });
  const bytes = await obj.arrayBuffer();
  const kept = { 'content-type': type, 'cache-control': `public, max-age=${maxAgeS}`, etag: obj.httpEtag, 'content-length': String(bytes.byteLength) };
  const put = cache.put(id, new Response(bytes.slice(0), { headers: kept })).catch(() => {});
  if (ctx) ctx.waitUntil(put);
  else await put;
  if (matchesEtag(req, obj.httpEtag)) {
    headers.delete('content-length');
    return new Response(null, { status: 304, headers });
  }
  return new Response(bytes, { headers });
}

/** If-None-Match names this ETag. Cloudflare weakens an ETag when it compresses the body, so W/ counts too. */
export const matchesEtag = (req: Request, etag: string) =>
  req.headers.get('if-none-match')?.split(',').some((t) => t.trim().replace(/^W\//, '') === etag) ?? false;

function partHeaders(type: string, maxAgeS: number, httpEtag: string): Headers {
  return new Headers({
    'content-type': type,
    'cache-control': `public, max-age=${maxAgeS}`,
    etag: httpEtag,
    'accept-ranges': 'bytes',
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'etag, content-range, content-length',
  });
}

/**
 * One R2 object, whole or the byte range asked for. A changed file has a new
 * ETag, which PMTiles readers check between pieces.
 */
async function servePart(req: Request, bucket: R2Bucket, key: string, type: string, maxAgeS: number): Promise<Response> {
  const ranged = req.headers.has('range');
  let obj: R2Object | R2ObjectBody | null;
  try {
    obj = await bucket.get(key, { range: req.headers, onlyIf: req.headers });
  } catch (e) {
    // A range R2 can't satisfy (past the end) is the client's mistake;
    // anything else is R2 failing, and the file is fine.
    if (ranged && /range|satisf/i.test(String((e as Error)?.message ?? e))) return new Response(null, { status: 416 });
    return unavailable();
  }
  if (!obj) return json({ error: 'not found' }, 404);
  const headers = partHeaders(type, maxAgeS, obj.httpEtag);
  // onlyIf failed: the client's copy is current.
  if (!('body' in obj)) return new Response(null, { status: 304, headers });
  const range = obj.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (ranged && range) {
    const offset = range.suffix != null ? obj.size - range.suffix : (range.offset ?? 0);
    const length = range.suffix != null ? range.suffix : (range.length ?? obj.size - offset);
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set('content-length', String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('content-length', String(obj.size));
  return new Response(obj.body, { headers });
}
