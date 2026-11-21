import type { Env } from '../types.ts';
import { json } from '../http.ts';

export const PLAY_URL: string | null = null;

interface ReleaseFile {
  file: string;
  sha256: string;
  size: number;
}

export interface Latest {
  version: string;
  released: string;
  android: ReleaseFile;
  androidAbis?: Record<string, ReleaseFile>;
  mac: ReleaseFile;
}

const LATEST = 'latest.json';
const APPCAST = 'appcast.xml';
export const RELEASE_VERSION = String.raw`\d+\.\d+\.\d+(?:-[a-z]+(?:\.\d+)?)?`;
const RELEASE_FILE = new RegExp(
  String.raw`^\/download\/(releases\/${RELEASE_VERSION}\/terminus-${RELEASE_VERSION}(?:-armv7|-x86_64)?\.(?:apk|dmg|zip))$`,
);

const TYPES: Record<string, string> = {
  apk: 'application/vnd.android.package-archive',
  dmg: 'application/x-apple-diskimage',
  zip: 'application/zip',
};

async function releaseText(bucket: R2Bucket, key: string): Promise<string | null> {
  const obj = await bucket.get(key);
  return obj ? obj.text() : null;
}

export async function latestRelease(bucket: R2Bucket): Promise<Latest | null> {
  const text = await releaseText(bucket, LATEST);
  return text === null ? null : (JSON.parse(text) as Latest);
}

export async function handleDownload(path: string, env: Env, url: URL): Promise<Response | null> {
  if (!path.startsWith('/download/')) return null;
  if (!env.FILES) return json({ error: 'downloads are not configured' }, 503);

  if (path === '/download/appcast.xml') {
    const feed = await releaseText(env.FILES, APPCAST);
    if (feed === null) return json({ error: 'no release yet' }, 404);
    return new Response(feed, {
      headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=300' },
    });
  }

  const release = RELEASE_FILE.exec(path);
  if (release) return serveFile(env.FILES, release[1]);

  const latest = await latestRelease(env.FILES);
  if (!latest) return json({ error: 'no release yet' }, 404);

  if (path === '/download/latest.json') {
    return json(latest, 200, { 'cache-control': 'public, max-age=300' });
  }

  const abi = url?.searchParams.get('abi') ?? '';
  const abis = latest.androidAbis ?? {};
  const android = Object.hasOwn(abis, abi) ? abis[abi] : latest.android;
  const which = path === '/download/android' ? android : path === '/download/mac' ? latest.mac : null;
  if (!which) return json({ error: 'not found' }, 404);
  return serveFile(env.FILES, which.file, which.sha256);
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
