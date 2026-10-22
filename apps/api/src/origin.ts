/**
 * Which terminus this Worker is: the stable site, or the beta at
 * beta.terminus.run, which sets PUBLIC_ORIGIN (cloudflare.config.ts,
 * `--mode beta`). Links in email and messages point at this origin, so a beta
 * account is never sent to the stable site, where it doesn't exist.
 */

import type { Env } from './types.ts';

export const STABLE_ORIGIN = 'https://terminus.run';

export const siteOrigin = (env: Env): string => env.PUBLIC_ORIGIN || STABLE_ORIGIN;

export const isBeta = (env: Env): boolean => siteOrigin(env) !== STABLE_ORIGIN;

/**
 * Where links handed to people point: sign-in links, the new-device email,
 * an error's "create a key at". LINK_ORIGIN when set, for if a network
 * refuses terminus.run, so a link tapped there still opens; else the site's
 * own.
 */
export const linkOrigin = (env: Env): string => env.LINK_ORIGIN || siteOrigin(env);
