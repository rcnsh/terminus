// When Now fetches its card again, and what it says while the card isn't
// live (app/app.js): worked out here, apart from the page, so the tests can
// run it (web-timing.test.js).

import { t } from '/account/dom.js';

/** The answer refreshes this often while the app is on screen (the API caches 15 s). */
export const REFRESH_MS = 30_000;
/** Sooner than that at the card's own marks (nextChangeAt, refreshAt), but never sooner than this from now. */
export const MARK_MIN_MS = 5_000;
/** Nor sooner than this after the last refresh a mark brought: a leave-by
 *  that keeps sliding (a late bus) would otherwise ask every 5 s. The Mac
 *  app and the server's own trip engine wait 30 s too. */
export const MARK_GAP_MS = 30_000;

/**
 * The banner over a card the service worker kept, fetched at `at` (a time
 * to show). Online, the network was slow, or with `failed` the request
 * itself failed (the server answering an error, say).
 */
export function staleText(at, { online, failed = false }) {
  if (!online) return t("You're offline. Showing the update from {0}.", at);
  return failed ? t("Couldn't update. Showing the update from {0}.", at) : t('Slow connection. Showing the update from {0}.', at);
}

/**
 * How long to wait before trying again after the kept copy came instead,
 * the `tries`-th time in a row (from 0): 8 s, then 16 s, doubling. Null once
 * that's as long as the timed refresh, which is then soon enough: a
 * struggling server isn't helped by more.
 */
export function slowRetryMs(tries) {
  const wait = 8_000 * 2 ** tries;
  return wait < REFRESH_MS ? wait : null;
}

/**
 * How long until answer `a` is fetched again at its marks (card.nextChangeAt:
 * the bus leaving, time to go; refreshAt: the plan moving on): at the sooner,
 * never sooner than MARK_MIN_MS from now nor MARK_GAP_MS after the last
 * refresh a mark brought (`markAt`, on this device's clock). Null with no
 * mark before the next timed refresh. A mark the answer already got past
 * isn't one: the server had it in hand, and waiting on it would ask every 5 s.
 * `now` is this device's clock, `serverNow` the server's (dom.js).
 */
export function markWaitMs(a, { now, serverNow, markAt }) {
  const asOf = Date.parse(a?.asOf ?? '');
  const marks = [a?.card?.nextChangeAt, a?.refreshAt].map((x) => Date.parse(x ?? '')).filter((m) => Number.isFinite(m) && !(m <= asOf));
  if (!marks.length) return null;
  const wait = Math.max(MARK_MIN_MS, markAt + MARK_GAP_MS - now, Math.min(...marks) - serverNow);
  return wait >= REFRESH_MS ? null : wait;
}
