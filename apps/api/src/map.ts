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
 */

import { layers, namedFlavor } from '@protomaps/basemaps';
import type { Env } from './types.ts';
import { json } from './http.ts';

const PREFIX = 'map/';
const TILES = 'campus.pmtiles';
const SPRITES = 'v4';
/** The file covers this, and the map doesn't pan past it. [west, south, east, north] */
export const MAP_BOUNDS = [103.755, 1.28, 103.83, 1.332] as const;
const ATTRIBUTION = '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>';

const FONT = /^\/map\/fonts\/(Noto Sans (?:Regular|Medium|Italic))\/(\d{1,5}-\d{1,5})\.pbf$/;
const SPRITE = /^\/map\/sprites\/v4\/(light|dark)(@2x)?\.(json|png)$/;

/** Kinds of place the base map would mark that the app marks itself, or
 *  that only clutter a campus map. */
const HIDDEN_POIS = ['bus_stop'];

export type Theme = 'light' | 'dark';

/**
 * The style: Protomaps' light or dark map, quietened so the bus routes and
 * stops on top stand out, with every URL absolute (MapLibre Native needs
 * that).
 */
export function mapStyle(origin: string, theme: Theme, lang: 'en' | 'zh'): Record<string, unknown> {
  const flavor = namedFlavor(theme);
  const base = layers('protomaps', flavor, { lang: lang === 'zh' ? 'zh-Hans' : 'en' }).map((layer) => {
    if (layer.id !== 'pois' || layer.type !== 'symbol') return layer;
    const filter = layer.filter ? ['all', layer.filter, ['!', ['in', ['get', 'kind'], ['literal', HIDDEN_POIS]]]] : undefined;
    return { ...layer, filter } as typeof layer;
  });
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

/** Serves /map/*; null for any other path. */
export async function handleMap(req: Request, url: URL, env: Env): Promise<Response | null> {
  const path = url.pathname;
  if (!path.startsWith('/map/')) return null;

  if (path === '/map/style.json') {
    const theme: Theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
    const lang = url.searchParams.get('lang') === 'zh' ? 'zh' : 'en';
    return json(mapStyle(url.origin, theme, lang), 200, { 'cache-control': 'public, max-age=3600' });
  }

  if (!env.DOWNLOADS) return json({ error: 'not found' }, 404);

  if (path === `/map/${TILES}`) return servePart(req, env.DOWNLOADS, PREFIX + TILES, 'application/vnd.pmtiles', 86400);

  const font = FONT.exec(decodeURIComponent(path));
  if (font) return servePart(req, env.DOWNLOADS, `${PREFIX}fonts/${font[1]}/${font[2]}.pbf`, 'application/x-protobuf', 30 * 86400);

  const sprite = SPRITE.exec(path);
  if (sprite) {
    const type = sprite[3] === 'png' ? 'image/png' : 'application/json';
    return servePart(req, env.DOWNLOADS, `${PREFIX}sprites/${SPRITES}/${sprite[1]}${sprite[2] ?? ''}.${sprite[3]}`, type, 30 * 86400);
  }
  return json({ error: 'not found' }, 404);
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
  const headers = new Headers({
    'content-type': type,
    'cache-control': `public, max-age=${maxAgeS}`,
    etag: obj.httpEtag,
    'accept-ranges': 'bytes',
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'etag, content-range, content-length',
  });
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
