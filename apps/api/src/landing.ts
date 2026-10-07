/**
 * The landing page, with the two things it would otherwise fetch once open
 * written in before it's sent: the current release's version beside the
 * download buttons, and Account in place of Sign in for someone signed in.
 * Fetched by the page's script, both changed in front of the reader.
 *
 * A string fill rather than HTMLRewriter, so the tests and the dev stub
 * (Node, which has none) serve the same page. landing.test.js fails if
 * index.html loses the markup filled here.
 */

import type { Env } from './types.ts';
import type { Latest } from './downloads.ts';
import { authenticate } from './accounts.ts';

/** latest.json changes only with a release; /download/latest.json is cached as long. */
const VERSION_MEMO_MS = 300_000;
let memo: { at: number; version: string | null } | null = null;

/** Only a version as release.sh writes it goes into the page. */
const VERSION = /^\d+\.\d+\.\d+(?:-[a-z]+(?:\.\d+)?)?$/;

/** The current release's version, from latest.json, or null. */
export async function latestVersion(env: Env, nowMs: number): Promise<string | null> {
  if (!env.DOWNLOADS) return null;
  if (memo && nowMs - memo.at < VERSION_MEMO_MS) return memo.version;
  let version: string | null = null;
  try {
    const obj = await env.DOWNLOADS.get('latest.json');
    const v = obj ? ((await obj.json()) as Partial<Latest>).version : null;
    version = typeof v === 'string' && VERSION.test(v) ? v : null;
  } catch {
    // No version is the page as written: its script asks for it.
  }
  memo = { at: nowMs, version };
  return version;
}

/**
 * index.html with the version and the account link filled in. The version
 * carries its English for i18n.js (data-t), which words it in Chinese.
 */
export function fillLanding(html: string, opts: { version: string | null; signedIn: boolean }): string {
  let out = html;
  if (opts.version && VERSION.test(opts.version)) {
    const v = ` <span data-t="Version {0}." data-t-args='["${opts.version}"]'>Version ${opts.version}.</span>`;
    out = out.replace('<span id="version"></span>', `<span id="version">${v}</span>`);
    out = out.replace('<span id="dl-version"></span>', `<span id="dl-version">${v}</span>`);
  }
  if (opts.signedIn) out = out.replace('id="account-link">Sign in</a>', 'id="account-link">Account</a>');
  return out;
}

/**
 * The landing page as served. Always the whole page, never a 304 from the
 * browser's copy, which may say Sign in or name an older version; private,
 * as it depends on who asks.
 */
export async function landingPage(req: Request, assets: Fetcher, env: Env, nowMs: number, ctx?: ExecutionContext): Promise<Response> {
  const [res, version, session] = await Promise.all([
    assets.fetch(new Request(req.url, { method: req.method, headers: { accept: req.headers.get('accept') ?? 'text/html' } })),
    latestVersion(env, nowMs),
    env.DB ? authenticate(env.DB, req, nowMs, ctx).catch(() => null) : null,
  ]);
  if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('text/html')) return res;
  const headers = new Headers(res.headers);
  for (const h of ['etag', 'last-modified', 'content-length']) headers.delete(h);
  headers.set('cache-control', 'private, no-cache');
  const body = req.method === 'HEAD' ? null : fillLanding(await res.text(), { version, signedIn: session !== null });
  return new Response(body, { status: res.status, headers });
}

/** For tests: forget the memoised version. */
export function resetLandingMemo(): void {
  memo = null;
}
