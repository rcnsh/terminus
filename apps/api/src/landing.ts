/**
 * The landing page, with the two things it would otherwise fetch once open
 * written in before it's sent: the current release's version beside the
 * download buttons, and Account in place of Sign in for someone signed in.
 * Fetched by the page's script, both changed in front of the reader. And
 * once the app is on Google Play (PLAY_URL), its Android buttons become
 * Play's badge.
 *
 * A string fill rather than HTMLRewriter, so the tests and the dev stub
 * (Node, which has none) serve the same page. landing.test.js fails if
 * index.html loses the markup filled here.
 */

import type { Env } from './types.ts';
import { PLAY_URL, RELEASE_VERSION, latestRelease } from './downloads.ts';
import { authenticate } from './accounts.ts';
import { matchesEtag } from './map.ts';
import { isBeta } from './site.ts';

/** Only a version as release.sh writes it goes into the page. */
const VERSION = new RegExp(`^${RELEASE_VERSION}$`);

/** The current release's version, from latest.json as it is now, or null. */
export async function latestVersion(env: Env): Promise<string | null> {
  if (!env.DOWNLOADS) return null;
  try {
    const v = (await latestRelease(env.DOWNLOADS))?.version;
    return typeof v === 'string' && VERSION.test(v) ? v : null;
  } catch {
    // No version is the page as written: its script asks for it.
    return null;
  }
}

/** Only a Google Play app page goes into the page. */
const PLAY = /^https:\/\/play\.google\.com\/store\/apps\/details\?id=[\w.]+$/;

/** index.html's Android button, as written: the APK. */
export const APK_BUTTON = '<a class="btn accent get-android" href="/download/android">Get it for Android</a>';

/** index.html's install step for the APK, which Google Play makes needless. */
const APK_STEP = /\s*<li><strong>Android:<\/strong>[^]*?<\/li>/;

/**
 * Google Play's badge, in English and Chinese: the page's language shows one
 * (index.html's CSS). Lazy, so the hidden one is never fetched.
 */
function playBadge(url: string): string {
  const img = (file: string) => `<img src="/assets/badges/${file}" alt="Get it on Google Play" width="168" height="50" loading="lazy">`;
  return `<a class="play" href="${url}">${img('google-play.png')}${img('google-play-zh.png')}</a>`;
}

/**
 * index.html with the version and the account link filled in, and with a
 * Google Play page, every Android link going there. The version carries its
 * English for i18n.js (data-t), which words it in Chinese.
 */
export function fillLanding(html: string, opts: { version: string | null; signedIn: boolean; play?: string | null }): string {
  let out = html;
  if (opts.play && PLAY.test(opts.play)) {
    out = out.replaceAll(APK_BUTTON, playBadge(opts.play));
    out = out.replaceAll('href="/download/android"', `href="${opts.play}"`);
    // The structured data's download link too, which names the site in full.
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

/**
 * The page's ETag: weak, from everything that goes into it (the file's own
 * ETag, the version, signed in or not, the beta's mark and the Play page), so a browser
 * revalidating gets a 304 only while what it has is what it would get.
 */
export async function landingEtag(assetEtag: string, version: string | null, signedIn: boolean, beta: boolean, play: string | null = PLAY_URL): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([assetEtag, version, signedIn, beta, play]))));
  return `W/"${Array.from(digest.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('')}"`;
}

/**
 * The landing page as served: private, as it depends on who asks, and
 * checked every time (no-cache). Never the file's own 304, as the browser's
 * copy may say Sign in or name an older version; a 304 only for the page's
 * own ETag (landingEtag).
 */
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
  // Without the file's ETag there's nothing to tell one copy from the next: always the page.
  if (assetEtag) {
    const etag = await landingEtag(assetEtag, version, signedIn, isBeta(env));
    headers.set('etag', etag);
    if (matchesEtag(req, etag.slice(2))) {
      await res.body?.cancel();
      // No content-type: nothing for the beta's mark (markBeta) to rewrite.
      headers.delete('content-type');
      return new Response(null, { status: 304, headers });
    }
  }
  const body = req.method === 'HEAD' ? null : fillLanding(await res.text(), { version, signedIn, play: PLAY_URL });
  return new Response(body, { status: res.status, headers });
}
