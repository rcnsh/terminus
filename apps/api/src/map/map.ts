import { layers, namedFlavor } from '@protomaps/basemaps';
import type { Env } from '../types.ts';
import { CORS, clientKey, json } from '../http.ts';
import { cacheBase } from '../feeds/edgecache.ts';

const PREFIX = 'map/';
const TILES = 'campus.pmtiles';
const SPRITES = 'v4';
const GLYPHS = '2';
export const MAP_BOUNDS = [103.755, 1.28, 103.83, 1.332] as const;
const ATTRIBUTION = '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>';

const FONT = /^\/map\/fonts\/(Noto Sans (?:Regular|Medium|Italic))\/(\d{1,5}-\d{1,5})\.pbf$/;
const SPRITE = /^\/map\/sprites\/v4\/(light|dark)(@2x)?\.(json|png)$/;

const HIDDEN_LAYERS = new Set(['pois']);

export type Theme = 'light' | 'dark';

export function mapStyle(origin: string, theme: Theme, lang: 'en' | 'zh'): Record<string, unknown> {
  const flavor = namedFlavor(theme);
  const base = layers('protomaps', flavor, { lang: lang === 'zh' ? 'zh-Hans' : 'en' }).filter((layer) => !HIDDEN_LAYERS.has(layer.id));
  return {
    version: 8,
    name: `terminus ${theme}`,
    glyphs: `${origin}/map/fonts/{fontstack}/{range}.pbf?v=${GLYPHS}`,
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

const styles = new Map<string, string>();

export async function handleMap(req: Request, url: URL, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
  const path = url.pathname;
  if (!path.startsWith('/map/')) return null;

  if (path === '/map/style.json') {
    const theme: Theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
    const lang = url.searchParams.get('lang') === 'zh' ? 'zh' : 'en';
    const id = `${url.origin} ${theme} ${lang}`;
    let style = styles.get(id);
    if (!style) styles.set(id, (style = JSON.stringify(mapStyle(url.origin, theme, lang))));
    return new Response(style, {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=3600', ...CORS },
    });
  }

  if (!env.FILES) return json({ error: 'not found' }, 404);
  let allowed: Promise<boolean> | null = null;
  const mayRead = () =>
    (allowed ??= env.RL_MAP
      ? env.RL_MAP.limit({ key: `map:${clientKey(req)}` }).then(
          (r) => r.success,
          () => true,
        )
      : Promise.resolve(true));

  if (path === `/map/${TILES}`) return edgePart(req, env.FILES, PREFIX + TILES, 'application/vnd.pmtiles', 86400, mayRead, ctx);

  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return json({ error: 'not found' }, 404);
  }
  const file = (key: string, type: string, cacheAs = key) => edgeFile(req, env.FILES!, key, cacheAs, type, 30 * 86400, mayRead, ctx);
  const font = FONT.exec(decoded);
  if (font && glyphRange(font[2])) {
    const key = `${PREFIX}fonts/${font[1]}/${font[2]}.pbf`;
    return file(key, 'application/x-protobuf', url.searchParams.get('v') === GLYPHS ? `${key}?v=${GLYPHS}` : key);
  }

  const sprite = SPRITE.exec(path);
  if (sprite)
    return file(
      `${PREFIX}sprites/${SPRITES}/${sprite[1]}${sprite[2] ?? ''}.${sprite[3]}`,
      sprite[3] === 'png' ? 'image/png' : 'application/json',
    );
  return json({ error: 'not found' }, 404);
}

export function glyphRange(range: string): boolean {
  if (!/^(?:0|[1-9]\d*)-[1-9]\d*$/.test(range)) return false;
  const [start, end] = range.split('-').map(Number);
  return start % 256 === 0 && end === start + 255 && end <= 65_535;
}

const slowDown = () => json({ error: 'too many requests, slow down' }, 429, { 'retry-after': '60' });
const unavailable = () => json({ error: 'terminus is busy, try again in a minute' }, 503, { 'retry-after': '60' });

const HEAD_TTL_MS = 5 * 60_000;
const HEAD_RETRY_MS = 30_000;
const MAX_CACHED_BYTES = 32 * 1024 * 1024;
type Head = { etag: string; httpEtag: string; size: number; atMs: number };
const heads = new Map<string, Head>();

export const forgetHeads = () => heads.clear();

const headId = (key: string) => new Request(`${cacheBase()}/map-head/${encodeURIComponent(key)}`);
const HEAD_KEPT_S = 30 * 86_400;

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
  const put = cache
    .put(headId(key), Response.json(head, { headers: { 'cache-control': `public, max-age=${HEAD_KEPT_S}` } }))
    .catch(() => {});
  if (ctx) ctx.waitUntil(put);
  else await put;
  return head;
}

async function cachedHead(cache: Cache, key: string): Promise<Head | undefined> {
  try {
    const hit = await cache.match(headId(key));
    const head = hit ? ((await hit.json()) as Head) : undefined;
    return head &&
      typeof head.etag === 'string' &&
      typeof head.httpEtag === 'string' &&
      Number.isFinite(head.size) &&
      Number.isFinite(head.atMs)
      ? head
      : undefined;
  } catch {
    return undefined;
  }
}

async function forgetHead(cache: Cache, key: string): Promise<void> {
  heads.delete(key);
  await cache.delete(headId(key)).catch(() => false);
}

const otherConditions = (req: Request) =>
  ['if-match', 'if-modified-since', 'if-unmodified-since', 'if-range'].some((h) => req.headers.has(h));

export function rangeOf(header: string | null, size: number): { offset: number; length: number } | null | 'unsatisfiable' | 'other' {
  if (header === null) return null;
  const r = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!r || (r[1] === '' && r[2] === '')) return 'other';
  if (r[1] === '') {
    const n = Math.min(Number(r[2]), size);
    return n > 0 ? { offset: size - n, length: n } : 'unsatisfiable';
  }
  const offset = Number(r[1]);
  if (offset >= size) return 'unsatisfiable';
  const end = r[2] === '' ? size - 1 : Math.min(Number(r[2]), size - 1);
  return end < offset ? 'other' : { offset, length: end - offset + 1 };
}

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
  if (matchesEtag(req, head.httpEtag)) return new Response(null, { status: 304, headers });
  if (otherConditions(req)) return fromR2();

  const range = rangeOf(req.headers.get('range'), head.size);
  if (range === 'unsatisfiable')
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${head.size}`, ...PART_CORS } });
  if (range === 'other') return fromR2();
  const { offset, length } = range ?? { offset: 0, length: head.size };
  if (length > MAX_CACHED_BYTES) return fromR2();

  const id = new Request(`${cacheBase()}/map/${encodeURIComponent(key)}?etag=${encodeURIComponent(head.etag)}&bytes=${offset}-${length}`);
  let body: ReadableStream | ArrayBuffer | null;
  const hit = await cache.match(id).catch(() => undefined);
  if (hit) body = hit.body;
  else {
    if (!(await mayRead())) return slowDown();
    let obj: R2Object | R2ObjectBody | null;
    try {
      obj = await bucket.get(key, { range: { offset, length }, onlyIf: { etagMatches: head.etag } });
    } catch {
      return unavailable();
    }
    if (!obj || !('body' in obj)) {
      await forgetHead(cache, key);
      return fromR2();
    }
    const bytes = await obj.arrayBuffer();
    const put = cache
      .put(id, new Response(bytes.slice(0), { headers: { 'content-type': type, 'cache-control': `public, max-age=${maxAgeS}` } }))
      .catch(() => {});
    if (ctx) ctx.waitUntil(put);
    else await put;
    body = bytes;
  }
  headers.set('content-length', String(length));
  if (!range) return new Response(body, { headers });
  headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${head.size}`);
  return new Response(body, { status: 206, headers });
}

async function edgeFile(
  req: Request,
  bucket: R2Bucket,
  key: string,
  cacheAs: string,
  type: string,
  maxAgeS: number,
  mayRead: () => Promise<boolean>,
  ctx?: ExecutionContext,
): Promise<Response> {
  const cache = typeof caches === 'undefined' ? null : caches.default;
  const fromR2 = async () => ((await mayRead()) ? servePart(req, bucket, key, type, maxAgeS) : slowDown());
  if (!cache || req.headers.has('range') || otherConditions(req)) return fromR2();
  const id = new Request(`${cacheBase()}/map/file/${encodeURIComponent(cacheAs)}`);
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
    return unavailable();
  }
  if (!obj) return json({ error: 'not found' }, 404);
  const headers = partHeaders(type, maxAgeS, obj.httpEtag);
  headers.set('content-length', String(obj.size));
  if (obj.size > MAX_CACHED_BYTES) {
    if (!matchesEtag(req, obj.httpEtag)) return new Response(obj.body, { headers });
    await obj.body.cancel();
    headers.delete('content-length');
    return new Response(null, { status: 304, headers });
  }
  const bytes = await obj.arrayBuffer();
  const kept = {
    'content-type': type,
    'cache-control': `public, max-age=${maxAgeS}`,
    etag: obj.httpEtag,
    'content-length': String(bytes.byteLength),
  };
  const put = cache.put(id, new Response(bytes.slice(0), { headers: kept })).catch(() => {});
  if (ctx) ctx.waitUntil(put);
  else await put;
  if (matchesEtag(req, obj.httpEtag)) {
    headers.delete('content-length');
    return new Response(null, { status: 304, headers });
  }
  return new Response(bytes, { headers });
}

export const matchesEtag = (req: Request, etag: string) =>
  req.headers
    .get('if-none-match')
    ?.split(',')
    .some((t) => t.trim().replace(/^W\//, '') === etag) ?? false;

const PART_CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'etag, content-range, content-length' };

function partHeaders(type: string, maxAgeS: number, httpEtag: string): Headers {
  return new Headers({
    'content-type': type,
    'cache-control': `public, max-age=${maxAgeS}`,
    etag: httpEtag,
    'accept-ranges': 'bytes',
    ...PART_CORS,
  });
}

function preconditionFailed(req: Request, obj: R2Object): boolean {
  const ifMatch = req.headers.get('if-match');
  if (ifMatch && !ifMatch.split(',').some((t) => t.trim() === '*' || t.trim() === obj.httpEtag)) return true;
  const since = Date.parse(req.headers.get('if-unmodified-since') ?? '');
  return !ifMatch && Number.isFinite(since) && obj.uploaded.getTime() > since + 999;
}

async function servePart(req: Request, bucket: R2Bucket, key: string, type: string, maxAgeS: number): Promise<Response> {
  const ranged = req.headers.has('range');
  let obj: R2Object | R2ObjectBody | null;
  try {
    obj = await bucket.get(key, { range: req.headers, onlyIf: req.headers });
  } catch (e) {
    if (ranged && /range|satisf/i.test(String((e as Error)?.message ?? e))) {
      const size = (await bucket.head(key).catch(() => null))?.size;
      return new Response(null, {
        status: 416,
        headers: { ...(size != null ? { 'content-range': `bytes */${size}` } : {}), ...PART_CORS },
      });
    }
    return unavailable();
  }
  if (!obj) return json({ error: 'not found' }, 404);
  const headers = partHeaders(type, maxAgeS, obj.httpEtag);
  if (!('body' in obj)) return new Response(null, { status: preconditionFailed(req, obj) ? 412 : 304, headers });
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
