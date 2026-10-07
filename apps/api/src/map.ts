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
 * so each piece is kept in the edge cache (edgePart) and R2 is read once
 * per piece per data centre, not once per person. Reads from R2 are
 * limited per IP (RL_MAP); pieces already in the cache are not, so a lecture
 * hall on one Wi-Fi address can all open the map at once.
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
  // Asked at most once per request, and only when R2 is about to be read.
  let allowed: Promise<boolean> | null = null;
  const mayRead = () => (allowed ??= env.RL_MAP ? env.RL_MAP.limit({ key: `map:${clientKey(req)}` }).then((r) => r.success, () => true) : Promise.resolve(true));
  const part = (key: string, type: string, maxAgeS: number) => edgePart(req, env.DOWNLOADS!, key, type, maxAgeS, mayRead, ctx);

  if (path === `/map/${TILES}`) return part(PREFIX + TILES, 'application/vnd.pmtiles', 86400);

  // A malformed escape ("%E0") is a bad path: not found, not an error.
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return json({ error: 'not found' }, 404);
  }
  const font = FONT.exec(decoded);
  if (font && glyphRange(font[2])) return part(`${PREFIX}fonts/${font[1]}/${font[2]}.pbf`, 'application/x-protobuf', 30 * 86400);

  const sprite = SPRITE.exec(path);
  if (sprite) {
    const type = sprite[3] === 'png' ? 'image/png' : 'application/json';
    return part(`${PREFIX}sprites/${SPRITES}/${sprite[1]}${sprite[2] ?? ''}.${sprite[3]}`, type, 30 * 86400);
  }
  return json({ error: 'not found' }, 404);
}

/** A range of 256 glyphs, as MapLibre asks for them ("512-767"): anything else is no file, so not worth an R2 read. */
export function glyphRange(range: string): boolean {
  const [start, end] = range.split('-').map(Number);
  return start % 256 === 0 && end === start + 255 && end <= 65_535;
}

const slowDown = () => json({ error: 'too many requests, slow down' }, 429, { 'retry-after': '60' });

/** How long an isolate trusts what it last learnt of a file (its ETag and size). */
const HEAD_TTL_MS = 5 * 60_000;
/** Pieces bigger than this go straight from R2, uncached. The whole map file is about 4 MB. */
const MAX_CACHED_BYTES = 32 * 1024 * 1024;
const heads = new Map<string, { etag: string; httpEtag: string; size: number; atMs: number }>();

/** What this isolate knows of the file, while it still trusts it. */
const known = (key: string, nowMs: number) => {
  const head = heads.get(key);
  return head && nowMs - head.atMs < HEAD_TTL_MS ? head : undefined;
};

async function headOf(bucket: R2Bucket, key: string, nowMs: number) {
  const fresh = known(key, nowMs);
  if (fresh) return fresh;
  const obj = await bucket.head(key);
  if (!obj) {
    heads.delete(key);
    return null;
  }
  const head = { etag: obj.etag, httpEtag: obj.httpEtag, size: obj.size, atMs: nowMs };
  heads.set(key, head);
  return head;
}

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
 * time, so the pieces are shared by everyone.
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
  const nowMs = Date.now();
  if (!known(key, nowMs) && !(await mayRead())) return slowDown();
  const head = await headOf(bucket, key, nowMs);
  if (!head) return json({ error: 'not found' }, 404);
  const headers = partHeaders(type, maxAgeS, head.httpEtag);
  // The client's copy is current: nothing to read.
  if (matchesEtag(req, head.httpEtag)) return new Response(null, { status: 304, headers });
  // Anything conditional beyond that, R2 decides.
  if (req.headers.has('if-match') || req.headers.has('if-modified-since') || req.headers.has('if-unmodified-since') || req.headers.has('if-range')) return fromR2();

  const range = rangeOf(req.headers.get('range'), head.size);
  if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { 'content-range': `bytes */${head.size}` } });
  if (range === 'other') return fromR2();
  const { offset, length } = range ?? { offset: 0, length: head.size };
  if (length > MAX_CACHED_BYTES) return fromR2();

  const id = new Request(`https://terminus.internal/map/${encodeURIComponent(key)}?etag=${encodeURIComponent(head.etag)}&bytes=${offset}-${length}`);
  let body: ArrayBuffer | null = null;
  const hit = await cache.match(id).catch(() => undefined);
  if (hit) body = await hit.arrayBuffer();
  else {
    if (!(await mayRead())) return slowDown();
    const obj = await bucket.get(key, { range: { offset, length }, onlyIf: { etagMatches: head.etag } }).catch(() => null);
    // Replaced since we last looked (or gone): forget it and let R2 answer.
    if (!obj || !('body' in obj)) {
      heads.delete(key);
      return fromR2();
    }
    body = await obj.arrayBuffer();
    const put = cache.put(id, new Response(body.slice(0), { headers: { 'content-type': type, 'cache-control': `public, max-age=${maxAgeS}` } })).catch(() => {});
    if (ctx) ctx.waitUntil(put);
    else await put;
  }
  headers.set('content-length', String(body.byteLength));
  if (!range) return new Response(body, { headers });
  headers.set('content-range', `bytes ${offset}-${offset + body.byteLength - 1}/${head.size}`);
  return new Response(body, { status: 206, headers });
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
  } catch {
    // A range R2 can't satisfy (past the end).
    return new Response(null, { status: 416 });
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
