/**
 * App downloads, served from R2 so the repo can stay private.
 *
 * scripts/release.sh uploads each build under its version and rewrites
 * latest.json, which names the current files. /download/android and
 * /download/mac always serve whatever latest.json points at.
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

export async function handleDownload(path: string, env: Env): Promise<Response | null> {
  if (!path.startsWith('/download/')) return null;
  if (!env.DOWNLOADS) return json({ error: 'downloads are not configured' }, 503);

  const latestObj = await env.DOWNLOADS.get(LATEST);
  if (!latestObj) return json({ error: 'no release yet' }, 404);
  const latest = (await latestObj.json()) as Latest;

  if (path === '/download/latest.json') {
    return json(latest, 200, { 'cache-control': 'public, max-age=300' });
  }

  const which = path === '/download/android' ? latest.android : path === '/download/mac' ? latest.mac : null;
  if (!which) return json({ error: 'not found' }, 404);
  const obj = await env.DOWNLOADS.get(which.file);
  if (!obj) return json({ error: 'release file missing' }, 404);

  const name = which.file.split('/').pop()!;
  return new Response(obj.body, {
    headers: {
      'content-type': name.endsWith('.apk') ? 'application/vnd.android.package-archive' : 'application/zip',
      'content-disposition': `attachment; filename="${name}"`,
      'content-length': String(obj.size),
      'x-sha256': which.sha256,
      'cache-control': 'public, max-age=300',
    },
  });
}
