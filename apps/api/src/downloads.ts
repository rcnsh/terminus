/**
 * App downloads, served from R2 so the repo can stay private.
 *
 * scripts/release.sh uploads the APK and the release workflow the Mac DMG,
 * each under its version, and each rewrites latest.json, which names the
 * current files. /download/android and /download/mac always serve whatever
 * latest.json points at, zip (up to 1.3.7) or DMG.
 *
 * The Mac app updates itself with Sparkle from /download/appcast.xml, which
 * the release workflow writes alongside latest.json and which points at the
 * DMG by its versioned path, /download/releases/<version>/<file>.
 */

import type { Env } from './types.ts';
import { json } from './http.ts';

export interface Latest {
  version: string;
  released: string;
  android: { file: string; sha256: string; size: number };
  mac: { file: string; sha256: string; size: number };
}

const LATEST = 'latest.json';
const APPCAST = 'appcast.xml';
/** A versioned release file, as /download/releases/<version>/<file>. A
 *  version may carry a pre-release tag: 2.0.0-beta, 2.0.0-beta.2. */
const VERSION = String.raw`\d+\.\d+\.\d+(?:-[a-z]+(?:\.\d+)?)?`;
const RELEASE_FILE = new RegExp(String.raw`^\/download\/(releases\/${VERSION}\/terminus-${VERSION}\.(?:apk|dmg|zip))$`);

const TYPES: Record<string, string> = {
  apk: 'application/vnd.android.package-archive',
  dmg: 'application/x-apple-diskimage',
  zip: 'application/zip',
};

export async function handleDownload(path: string, env: Env): Promise<Response | null> {
  if (!path.startsWith('/download/')) return null;
  if (!env.DOWNLOADS) return json({ error: 'downloads are not configured' }, 503);

  if (path === '/download/appcast.xml') {
    const feed = await env.DOWNLOADS.get(APPCAST);
    if (!feed) return json({ error: 'no release yet' }, 404);
    return new Response(feed.body, {
      headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=300' },
    });
  }

  const release = RELEASE_FILE.exec(path);
  if (release) return serveFile(env.DOWNLOADS, release[1]);

  const latestObj = await env.DOWNLOADS.get(LATEST);
  if (!latestObj) return json({ error: 'no release yet' }, 404);
  const latest = (await latestObj.json()) as Latest;

  if (path === '/download/latest.json') {
    return json(latest, 200, { 'cache-control': 'public, max-age=300' });
  }

  const which = path === '/download/android' ? latest.android : path === '/download/mac' ? latest.mac : null;
  if (!which) return json({ error: 'not found' }, 404);
  return serveFile(env.DOWNLOADS, which.file, which.sha256);
}

async function serveFile(bucket: R2Bucket, key: string, sha256?: string): Promise<Response> {
  const obj = await bucket.get(key);
  if (!obj) return json({ error: 'release file missing' }, 404);
  const name = key.split('/').pop()!;
  const headers: Record<string, string> = {
    'content-type': TYPES[name.split('.').pop() ?? ''] ?? 'application/octet-stream',
    'content-disposition': `attachment; filename="${name}"`,
    'content-length': String(obj.size),
    'cache-control': 'public, max-age=300',
  };
  if (sha256) headers['x-sha256'] = sha256;
  return new Response(obj.body, { headers });
}
