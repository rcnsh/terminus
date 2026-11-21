import { MAX_FIX_ACC_M, TTL } from './config.ts';
import { errorText } from './i18n.ts';

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization, x-api-key, if-match, x-terminus-client',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-expose-headers': 'etag, retry-after',
};

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
    body = { ...body, error: errorText((body as { error: string }).error) };
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...CORS,
      ...extra,
    },
  });
}

export function jsonCached(body: unknown, maxAge: number, scope: 'public' | 'private' = 'public'): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `${scope}, max-age=${maxAge}`, ...CORS },
  });
}

export function numParam(url: URL, key: string): number | null {
  const raw = url.searchParams.get(key);
  if (raw === null) return null;
  const s = raw.trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export const roundCoord = (x: number): number => Math.round(x * 10_000) / 10_000;

export function coordsFrom(url: URL): Coords {
  return coords(numParam(url, 'lat'), numParam(url, 'lon'), numParam(url, 'acc'));
}

export type Coords = { lat: number; lon: number } | { lat: null; lon: null };

export function coords(lat: number | null, lon: number | null, acc: number | null = null): Coords {
  if (lat === null || lon === null) return { lat: null, lon: null };
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return { lat: null, lon: null };
  if (acc !== null && acc > MAX_FIX_ACC_M) return { lat: null, lon: null };
  return { lat: roundCoord(lat), lon: roundCoord(lon) };
}

export function clientKey(req: Request): string {
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  if (!ip.includes(':')) return ip;
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v4) return v4[1];
  const [head, tail] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const groups = tail !== undefined ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  const prefix = groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''));
  return `${prefix.join(':')}::/64`;
}

export class UpstreamUnreachable extends Error {
  readonly timedOut: boolean;
  constructor(message: string, timedOut: boolean) {
    super(message);
    this.timedOut = timedOut;
  }
}

const NO_BODY = new Set([204, 205, 304]);

export async function timedFetch(what: string, url: string, init: RequestInit, ms = TTL.upstreamTimeoutMs): Promise<Response> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
    const body = NO_BODY.has(res.status) ? null : await res.arrayBuffer();
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  } catch (err) {
    if ((err as Error)?.name === 'TimeoutError') throw new UpstreamUnreachable(`${what} timeout after ${ms}ms`, true);
    throw new UpstreamUnreachable(`${what} unreachable: ${(err as Error)?.message ?? String(err)}`, false);
  }
}

export const QR_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
export const ELEMENTS = 'https://unpkg.com/@stoplight/elements@9.0.25';
const CSP_BASE = [
  "default-src 'self'",
  `script-src 'self' ${QR_LIB} https://challenges.cloudflare.com https://static.cloudflareinsights.com`,
  'frame-src https://challenges.cloudflare.com',
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://cloudflareinsights.com",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
];
const CSP_SITE = CSP_BASE.join('; ');
const DOCS_EXTRA: Record<string, string> = {
  'script-src': `${ELEMENTS}/`,
  'style-src': `${ELEMENTS}/`,
  'img-src': 'https:',
  'font-src': `data: ${ELEMENTS}/`,
};
const TIMELAPSE_EXTRA: Record<string, string> = {
  'worker-src': 'blob:',
};
const widen = (extra: Record<string, string>): string =>
  CSP_BASE.map((d) => {
    const more = extra[d.split(' ')[0]];
    return more ? `${d} ${more}` : d;
  }).join('; ');
const CSP_DOCS = widen(DOCS_EXTRA);
const CSP_TIMELAPSE = widen(TIMELAPSE_EXTRA);

export function cspFor(path: string): string {
  if (path === '/docs') return CSP_DOCS;
  if (path === '/admin/') return CSP_TIMELAPSE;
  return CSP_SITE;
}

export function withSecurityHeaders(res: Response, path: string): Response {
  const out = new Response(res.body, res);
  const h = out.headers;
  h.set('x-content-type-options', 'nosniff');
  h.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  h.set('referrer-policy', path.startsWith('/auth/') || path.startsWith('/pair') ? 'no-referrer' : 'strict-origin-when-cross-origin');
  if ((h.get('content-type') ?? '').includes('text/html')) {
    h.set('content-security-policy', cspFor(path));
    h.set('x-frame-options', 'DENY');
    h.set('permissions-policy', 'geolocation=(self), camera=(), microphone=()');
  }
  return out;
}
