/**
 * App downloads, served from R2 on our own domain, so a download link stays
 * the same from one release to the next.
 *
 * scripts/release.sh uploads the APKs and the Mac DMG, each under its
 * version, and then latest.json, which names the
 * current files. /download/android and /download/mac always serve whatever
 * latest.json points at, zip (up to 1.3.7) or DMG.
 *
 * Android comes as one APK per CPU type. `android` in latest.json is the
 * arm64 one, which suits nearly every phone (and is all an older app or link
 * knows about); `androidAbis` lists every type, and /download/android?abi=
 * serves the one asked for, as the app's update button does.
 *
 * The Mac app updates itself with Sparkle from /download/appcast.xml, which
 * scripts/release.sh writes alongside latest.json and which points at the
 * DMG by its versioned path, /download/releases/<version>/<file>.
 */

import type { Env } from './types.ts';
import { json } from './http.ts';

interface ReleaseFile {
  file: string;
  sha256: string;
  size: number;
}

export interface Latest {
  version: string;
  released: string;
  android: ReleaseFile;
  /** By Android ABI name (arm64-v8a, armeabi-v7a, x86_64). Absent before 2.1. */
  androidAbis?: Record<string, ReleaseFile>;
  mac: ReleaseFile;
}

const LATEST = 'latest.json';
const APPCAST = 'appcast.xml';
/** A release version as release.sh writes it. It may carry a pre-release
 *  tag: 2.0.0-beta, 2.0.0-beta.2. */
export const RELEASE_VERSION = String.raw`\d+\.\d+\.\d+(?:-[a-z]+(?:\.\d+)?)?`;
/** A versioned release file, as /download/releases/<version>/<file>. */
const RELEASE_FILE = new RegExp(String.raw`^\/download\/(releases\/${RELEASE_VERSION}\/terminus-${RELEASE_VERSION}(?:-armv7|-x86_64)?\.(?:apk|dmg|zip))$`);

const TYPES: Record<string, string> = {
  apk: 'application/vnd.android.package-archive',
  dmg: 'application/x-apple-diskimage',
  zip: 'application/zip',
};

export async function handleDownload(path: string, env: Env, url?: URL): Promise<Response | null> {
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

  const abi = url?.searchParams.get('abi') ?? '';
  const abis = latest.androidAbis ?? {};
  const android = Object.hasOwn(abis, abi) ? abis[abi] : latest.android;
  const which = path === '/download/android' ? android : path === '/download/mac' ? latest.mac : null;
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
