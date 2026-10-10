/**
 * Crash and error reports from the apps and the website: POST /api/errors.
 *
 * A report says what broke, never who it broke for: the platform, the app
 * version, the OS or browser and its version, the error's type, its message
 * and stack. No account, session, device or install id is asked for or
 * kept, and the address it came from is only used for the rate limit, as on
 * every open route. The message and stack are scrubbed first (scrub), since
 * an exception can quote a URL with coordinates in it or a path with
 * someone's name. Each app has a switch to stop sending them.
 *
 * Reports go to Analytics Engine (analytics.ts logAppError), which keeps
 * them three months, and the dashboard groups them by fingerprint. Off
 * unless the operator turns `errors` on (collect.ts); while it's off a
 * report is answered the same and dropped.
 */

import type { Env } from './types.ts';
import { collecting } from './collect.ts';
import { json } from './http.ts';
import { logAppError } from './analytics.ts';
import { readJson } from './me.ts';
import { API_VERSION } from './openapi.ts';

export const ERROR_PLATFORMS = ['android', 'mac', 'ios', 'web'] as const;
const MESSAGE_MAX = 300;
const STACK_MAX = 3000;
const STACK_LINES = 40;
/** Frames the fingerprint is made of: the top of the stack, where crashes differ. */
const FINGERPRINT_FRAMES = 5;

/**
 * [text] without what could say who or where: a URL's query and fragment
 * (they can hold coordinates or a code), email addresses, a home folder's
 * name, coordinates and other long numbers, and token-like strings.
 */
export function scrub(text: string): string {
  return (
    text
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi, '$1')
      .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>')
      .replace(/(\/(?:Users|home)\/|\\Users\\)[^/\\\s]+/gi, '$1<user>')
      .replace(/-?\b\d{1,3}\.\d{4,}\b/g, '<number>')
      .replace(/\b\d{6,}\b/g, '<number>')
      // A long run of letters and digits mixed is a token or an id, not a name.
      .replace(/\b[A-Za-z0-9_-]{20,}\b/g, (w) => (/\d/.test(w) && /[A-Za-z]/.test(w) ? '<token>' : w))
  );
}

/** The same crash, the same fingerprint: its platform, type and top frames, without line numbers. */
export async function fingerprintOf(platform: string, type: string, message: string, stack: string): Promise<string> {
  const frames = stack
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, FINGERPRINT_FRAMES)
    .map((l) => l.replace(/:\d+(:\d+)?/g, '').replace(/\b0x[0-9a-f]+\b/gi, '').replace(/\+ ?\d+\b/g, ''));
  // With no stack, the message with its numbers blanked, so "index 3" and "index 4" are one.
  const basis = [platform, type, ...(frames.length ? frames : [message.replace(/\d+/g, '#')])].join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(basis));
  return [...new Uint8Array(digest).slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** POST /api/errors: 204 whether kept or not, 400 for a body that isn't a report. */
export async function handleAppError(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, { allow: 'POST' });
  const b = await readJson(req);
  const platform = ERROR_PLATFORMS.find((p) => p === b?.platform);
  // The website is whatever this Worker serves: its version is the release's.
  const version = platform === 'web' ? API_VERSION : str(b?.version, 32);
  const os = str(b?.os, 40);
  const type = scrub(str(b?.type, 120)).trim();
  if (!b || !platform || !/^[\w.+-]{1,32}$/.test(version) || !/^[\w .()/-]{0,40}$/.test(os) || !type) {
    return json({ error: 'a report needs platform, version and type' }, 400);
  }
  if (!(await collecting(env, 'errors'))) return new Response(null, { status: 204 });
  const message = scrub(str(b.message, 2000)).slice(0, MESSAGE_MAX);
  const stack = scrub(str(b.stack, 20_000)).split('\n').slice(0, STACK_LINES).join('\n').slice(0, STACK_MAX);
  logAppError(env, {
    platform,
    version,
    os,
    type,
    message,
    stack,
    fatal: b.fatal === true,
    fingerprint: await fingerprintOf(platform, type, message, stack),
  });
  return new Response(null, { status: 204 });
}
