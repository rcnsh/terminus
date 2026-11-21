import type { Env } from '../types.ts';
import { collecting } from './collect.ts';
import { json } from '../http.ts';
import { logAppError } from './analytics.ts';
import { readJson } from '../accounts/me.ts';
import { API_VERSION } from '../openapi.ts';

export const ERROR_PLATFORMS = ['android', 'mac', 'ios', 'web'] as const;
const MESSAGE_MAX = 300;
const STACK_MAX = 3000;
const STACK_LINES = 40;
const FINGERPRINT_FRAMES = 5;

export function scrub(text: string): string {
  return text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi, '$1')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>')
    .replace(/(\/(?:Users|home)\/|\\Users\\)[^/\\\s]+/gi, '$1<user>')
    .replace(/-?\b\d{1,3}\.\d{4,}\b/g, '<number>')
    .replace(/\b\d{6,}\b/g, '<number>')
    .replace(/\b[A-Za-z0-9_-]{20,}\b/g, (w) => (/\d/.test(w) && /[A-Za-z]/.test(w) ? '<token>' : w));
}

export function scrubStack(stack: string): string {
  return stack
    .split('\n')
    .map((line) => {
      const frame = /^(\d+\s+\S+\s+0x[0-9a-f]+ .* \+ )(\d+)$/i.exec(line);
      return frame ? scrub(frame[1]) + frame[2] : scrub(line);
    })
    .join('\n');
}

const BARE_FRAME = /^(\S+ \+0x[0-9a-f]+ |\?\?\? )\(0x[0-9a-f]+\)$|^--$/i;

export async function fingerprintOf(platform: string, type: string, message: string, stack: string): Promise<string> {
  const top = stack
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, FINGERPRINT_FRAMES);
  const frames = top.map((l) =>
    l
      .replace(/:\d+(:\d+)?/g, '')
      .replace(/\b0x[0-9a-f]+\b/gi, '')
      .replace(/\+ ?\d+\b/g, ''),
  );
  const bare = top.length > 0 && top.every((f) => BARE_FRAME.test(f));
  const said = bare ? message.replace(/0x[0-9a-f]+/gi, '#').replace(/\d+/g, '#') : message.replace(/\d+/g, '#');
  const basis = [platform, type, ...frames, ...(frames.length && !bare ? [] : [said])].join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(basis));
  return [...new Uint8Array(digest).slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

export async function handleAppError(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, { allow: 'POST' });
  const b = await readJson(req);
  const platform = ERROR_PLATFORMS.find((p) => p === b?.platform);
  const version = platform === 'web' ? API_VERSION : str(b?.version, 32);
  const os = str(b?.os, 40);
  const type = scrub(str(b?.type, 120)).trim();
  if (!b || !platform || !/^[\w.+-]{1,32}$/.test(version) || !/^[\w .()/-]{0,40}$/.test(os) || !type) {
    return json({ error: 'a report needs platform, version and type' }, 400);
  }
  if (!(await collecting(env, 'errors'))) return new Response(null, { status: 204 });
  const message = scrub(str(b.message, 2000)).slice(0, MESSAGE_MAX);
  const stack = scrubStack(str(b.stack, 20_000)).split('\n').slice(0, STACK_LINES).join('\n').slice(0, STACK_MAX);
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
