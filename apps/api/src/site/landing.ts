import type { Env } from '../types.ts';
import { PLAY_URL, RELEASE_VERSION, latestRelease } from './downloads.ts';
import { authenticate } from '../accounts/accounts.ts';
import { matchesEtag } from '../map/map.ts';
import { isBeta } from '../origin.ts';

const VERSION = new RegExp(`^${RELEASE_VERSION}$`);

export async function latestVersion(env: Env): Promise<string | null> {
  if (!env.FILES) return null;
  try {
    const v = (await latestRelease(env.FILES))?.version;
    return typeof v === 'string' && VERSION.test(v) ? v : null;
  } catch {
    return null;
  }
}

const PLAY = /^https:\/\/play\.google\.com\/store\/apps\/details\?id=[\w.]+$/;

export const APK_BUTTON = '<a class="btn accent get-android" href="/download/android">Get it for Android</a>';

const APK_STEP = /\s*<li><strong>Android:<\/strong>[^]*?<\/li>/;

function playBadge(url: string): string {
  const img = (file: string) => `<img src="/assets/badges/${file}" alt="Get it on Google Play" width="168" height="50" loading="lazy">`;
  return `<a class="play" href="${url}">${img('google-play.png')}${img('google-play-zh.png')}</a>`;
}

export function fillLanding(html: string, opts: { version: string | null; signedIn: boolean; play?: string | null }): string {
  let out = html;
  if (opts.play && PLAY.test(opts.play)) {
    out = out.replaceAll(APK_BUTTON, playBadge(opts.play));
    out = out.replaceAll('href="/download/android"', `href="${opts.play}"`);
    out = out.replaceAll('"https://terminus.run/download/android"', `"${opts.play}"`);
    out = out.replace(APK_STEP, '');
  }
  if (opts.version && VERSION.test(opts.version)) {
    const v = ` <span data-t="Version {0}." data-t-args='["${opts.version}"]'>Version ${opts.version}.</span>`;
    out = out.replace('<span id="version"></span>', `<span id="version">${v}</span>`);
    out = out.replace('<span id="dl-version"></span>', `<span id="dl-version">${v}</span>`);
  }
  if (opts.signedIn) out = out.replace('id="account-link">Sign in</a>', 'id="account-link">Account</a>');
  return out;
}

export async function landingEtag(
  assetEtag: string,
  version: string | null,
  signedIn: boolean,
  beta: boolean,
  play: string | null = PLAY_URL,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([assetEtag, version, signedIn, beta, play]))),
  );
  return `W/"${Array.from(digest.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('')}"`;
}

export async function landingPage(req: Request, assets: Fetcher, env: Env, nowMs: number, ctx?: ExecutionContext): Promise<Response> {
  const [res, version, session] = await Promise.all([
    assets.fetch(new Request(req.url, { method: req.method, headers: { accept: req.headers.get('accept') ?? 'text/html' } })),
    latestVersion(env),
    env.DB ? authenticate(env.DB, req, nowMs, ctx).catch(() => null) : null,
  ]);
  if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('text/html')) return res;
  const signedIn = session !== null;
  const headers = new Headers(res.headers);
  const assetEtag = res.headers.get('etag');
  for (const h of ['etag', 'last-modified', 'content-length']) headers.delete(h);
  headers.set('cache-control', 'private, no-cache');
  if (assetEtag) {
    const etag = await landingEtag(assetEtag, version, signedIn, isBeta(env));
    headers.set('etag', etag);
    if (matchesEtag(req, etag.slice(2))) {
      await res.body?.cancel();
      headers.delete('content-type');
      return new Response(null, { status: 304, headers });
    }
  }
  const body = req.method === 'HEAD' ? null : fillLanding(await res.text(), { version, signedIn, play: PLAY_URL });
  return new Response(body, { status: res.status, headers });
}
