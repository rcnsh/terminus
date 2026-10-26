/**
 * Keeping up with uNivUS releases without a person in the loop.
 *
 * When NUS refuses our version string (10009), the new versionName is public
 * on Google Play; its versionCode isn't, so the next few codes are guessed in
 * order. This reads the name (or the refusal itself, if it names a version),
 * tries the likeliest strings with NUS, and on success writes the winner to
 * config:appVersion, which every isolate picks up within a minute.
 *
 * It runs only while NUS is refusing us, reads the page at most hourly, and
 * tries each candidate at most once, so a stuck release costs NUS at most
 * CODE_GUESSES requests in total, not one per check.
 */

import type { Env } from '../types.ts';
import { KV_APP_VERSION, appVersion, forgetAppVersion } from './auth.ts';
import { tryVersion } from './fms.ts';
import { timedFetch } from '../http.ts';

export const PLAY_URL = 'https://play.google.com/store/apps/details?id=sg.edu.nus.univus&hl=en&gl=SG';
const USER_AGENT = 'terminus (+https://terminus.run)';
const KV_AUTO = 'monitor:autoversion';
/** Candidates tried with NUS per lookup (each costs a mint and one call). */
const MAX_TRIES = 3;
/** While NUS keeps refusing, read the pages at most this often. */
export const LOOKUP_EVERY_MS = 3_600_000;
/** The versionCodes worth guessing after ours. A code goes up by one per
 *  build, and builds that never reach Play use some up: 2.59.2 was 140 and
 *  2.60.3, the next on Play, 144. */
export const CODE_GUESSES = 10;

export interface Version {
  name: string;
  code: number;
}

export function parseVersion(s: string | null | undefined): Version | null {
  const m = /^univus_android_(\d+(?:\.\d+)+)_(\d+)$/.exec(s?.trim() ?? '');
  return m ? { name: m[1], code: Number(m[2]) } : null;
}

export function versionString(v: Version): string {
  return `univus_android_${v.name}_${v.code}`;
}

/** Compare versionNames numerically, part by part: 2.10.0 is after 2.9.9. */
export function compareNames(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const newer = (v: Version, than: Version) => compareNames(v.name, than.name) > 0 || (v.name === than.name && v.code > than.code);

/**
 * The versionName on the Play page. The page is one large script blob; the
 * app's own version sits just before its target and minimum SDK levels, as
 * `[[["2.59.2"]],[[[35]],[[[23,"6.0"]]]]]`. Version strings elsewhere on the
 * page belong to reviews.
 */
export function versionFromPlay(html: string): string | null {
  return /\[\[\["(\d+(?:\.\d+)+)"\]\],\[\[\[\d+\]\],\[\[\[\d+,"/.exec(html)?.[1] ?? null;
}

/** Version strings in NUS's refusal, in case it names the one it wants. */
export function versionsFromRefusal(detail: string | null | undefined): Version[] {
  return [...(detail ?? '').matchAll(/univus_android_(\d+(?:\.\d+)+)_(\d+)/g)].map((m) => ({ name: m[1], code: Number(m[2]) }));
}

export interface Findings {
  refusal: Version[];
  play: string | null;
  errors: string[];
}

/** Read the Play page. A page that fails or has changed shape adds an error. */
export async function lookUp(): Promise<Pick<Findings, 'play' | 'errors'>> {
  try {
    const res = await timedFetch('Google Play', PLAY_URL, { headers: { 'user-agent': USER_AGENT, accept: 'text/html' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const play = versionFromPlay(await res.text());
    return { play, errors: play ? [] : ['Google Play: no version found on the page'] };
  } catch (err) {
    return { play: null, errors: [`Google Play: ${(err as Error)?.message ?? err}`] };
  }
}

/**
 * The strings worth trying, likeliest first, all newer than `current`:
 * whatever the refusal names, then Play's name with the next CODE_GUESSES
 * versionCodes, lowest first.
 */
export function candidates(current: Version, f: Pick<Findings, 'refusal' | 'play'>): Version[] {
  const out: Version[] = [...f.refusal];
  // Guessed codes only under a newer name: a page still showing our name has
  // not caught up yet, and guessing would spend NUS calls on nothing.
  if (f.play && compareNames(f.play, current.name) > 0) {
    for (let i = 1; i <= CODE_GUESSES; i++) out.push({ name: f.play, code: current.code + i });
  }
  const seen = new Set<string>();
  return out.filter((v) => newer(v, current) && !seen.has(versionString(v)) && seen.add(versionString(v)));
}

interface AutoState {
  tried: string[];
  lookedAt: number;
  /** What Play showed at lookedAt, guessed from until it is read again. */
  play?: string | null;
}

export type AutoResult = { status: 'switched'; from: string; to: string } | { status: 'failed'; note: string };

/**
 * Called with NUS's refusal while it is refusing our version. Finds, tries
 * and (if one works) switches to the new version string.
 */
export async function autoUpdateVersion(env: Env, nowMs: number, detail: string | null, probeStop: string): Promise<AutoResult> {
  const currentString = await appVersion(env, nowMs);
  const current = parseVersion(currentString);
  if (!current)
    return { status: 'failed', note: `the current version string (${currentString || 'unset'}) is not univus_android_<name>_<code>` };

  const state: AutoState = { tried: [], lookedAt: 0, ...(await env.KV.get<AutoState>(KV_AUTO, 'json').catch(() => null)) };
  const f: Findings = { refusal: versionsFromRefusal(detail), play: state.play ?? null, errors: [] };
  const lookedUp = nowMs - state.lookedAt >= LOOKUP_EVERY_MS;
  if (lookedUp) {
    Object.assign(f, await lookUp());
    state.lookedAt = nowMs;
    state.play = f.play;
  }

  const fresh = candidates(current, f)
    .map(versionString)
    .filter((s) => !state.tried.includes(s))
    .slice(0, MAX_TRIES);
  const refused: string[] = [];
  let note = '';
  for (const s of fresh) {
    state.tried = [...state.tried, s].slice(-20);
    let ok: boolean;
    try {
      ok = await tryVersion(env, s, probeStop, nowMs);
    } catch (err) {
      // Not a verdict on the version: stop, and let the next check try again.
      state.tried = state.tried.filter((t) => t !== s);
      note = `trying ${s} failed for another reason: ${(err as Error)?.message ?? err}`;
      break;
    }
    if (ok) {
      await env.KV.put(KV_APP_VERSION, s);
      forgetAppVersion(env);
      await env.KV.put(KV_AUTO, JSON.stringify(state)).catch(() => {});
      return { status: 'switched', from: currentString, to: s };
    }
    refused.push(s);
  }
  await env.KV.put(KV_AUTO, JSON.stringify(state)).catch(() => {});

  const seen = [
    f.refusal.length ? `the refusal names ${f.refusal.map(versionString).join(', ')}` : '',
    lookedUp ? `Google Play shows ${f.play ?? 'nothing readable'}` : 'Google Play was read less than an hour ago',
    ...f.errors,
  ].filter(Boolean);
  const outcome = refused.length ? `NUS refused ${refused.join(', ')}` : fresh.length ? '' : 'nothing new to try';
  return { status: 'failed', note: [outcome, note, ...seen].filter(Boolean).join('; ') };
}
