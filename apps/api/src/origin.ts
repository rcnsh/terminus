import type { Env } from './types.ts';

export const STABLE_ORIGIN = 'https://terminus.run';

export const siteOrigin = (env: Env): string => env.PUBLIC_ORIGIN || STABLE_ORIGIN;

export const isBeta = (env: Env): boolean => siteOrigin(env) !== STABLE_ORIGIN;

export const linkOrigin = (env: Env): string => env.LINK_ORIGIN || siteOrigin(env);
