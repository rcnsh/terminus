import { TTL } from './config.ts';
/** Response helpers and query parsing shared by every route. */

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
};

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // The answer is coordinate-specific and cheap to recompute. The caching
      // that matters happens per stop code inside getArrivals().
      'cache-control': 'no-store',
      ...CORS,
      ...extra,
    },
  });
}

export function jsonCached(body: unknown, maxAge: number): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${maxAge}`, ...CORS },
  });
}

/**
 * LANDMINE: Number(null) === 0 and Number('') === 0, not NaN. A missing lat
 * silently resolves to the Gulf of Guinea and reports "no stop nearby"
 * instead of falling back to the configured origin.
 */
export function numParam(url: URL, key: string): number | null {
  const raw = url.searchParams.get(key);
  if (raw === null) return null;
  const s = raw.trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function coordsFrom(url: URL): { lat: number | null; lon: number | null } {
  const lat = numParam(url, 'lat');
  const lon = numParam(url, 'lon');
  if (lat === null || lon === null) return { lat: null, lon: null };
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return { lat: null, lon: null };
  return { lat, lon };
}

/**
 * Rate-limit key for the caller. One IPv6 host usually owns a whole /64, so
 * keying on the full address gives it 2^64 buckets.
 */
export function clientKey(req: Request): string {
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  if (!ip.includes(':')) return ip;
  const groups = ip.split('::')[0].split(':');
  return `${groups.slice(0, 4).join(':')}::/64`;
}

/** fetch with a timeout whose error says what timed out. */
export async function timedFetch(what: string, url: string, init: RequestInit, ms = TTL.upstreamTimeoutMs): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (err) {
    if ((err as Error)?.name === 'TimeoutError') throw new Error(`${what} timeout after ${ms}ms`);
    throw err;
  }
}


/**
 * Browser-facing hardening on every response. The CSP lists exactly what
 * the site loads: Turnstile, the QR library from cdnjs, Google Fonts. /docs
 * additionally loads Stoplight Elements from unpkg (pinned with SRI there).
 */
const CSP_BASE = [
  "default-src 'self'",
  "script-src 'self' https://cdnjs.cloudflare.com https://challenges.cloudflare.com",
  'frame-src https://challenges.cloudflare.com',
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
];
const CSP_SITE = CSP_BASE.join('; ');
const CSP_DOCS = CSP_BASE.map((d) =>
  d.startsWith('script-src') || d.startsWith('style-src') ? `${d} https://unpkg.com` : d.startsWith('img-src') ? `${d} https:` : d.startsWith('font-src') ? `${d} data: https://unpkg.com` : d,
).join('; ');

export function withSecurityHeaders(res: Response, path: string): Response {
  const out = new Response(res.body, res);
  const h = out.headers;
  h.set('x-content-type-options', 'nosniff');
  h.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  // Sign-in and pairing URLs carry a token or a code: never send them on.
  h.set('referrer-policy', path.startsWith('/auth/') || path.startsWith('/pair') ? 'no-referrer' : 'strict-origin-when-cross-origin');
  if ((h.get('content-type') ?? '').includes('text/html')) {
    h.set('content-security-policy', path === '/docs' ? CSP_DOCS : CSP_SITE);
    h.set('x-frame-options', 'DENY');
    h.set('permissions-policy', 'geolocation=(self), camera=(), microphone=()');
  }
  return out;
}
