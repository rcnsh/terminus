// When Now fetches its card again, which fix it goes with, and what it says
// while the card isn't live (app/app.js): worked out here, apart from the
// page, so the tests can run it (web-timing.test.js).

import { t } from '/account/dom.js';
import { haversineM } from '/account/profile.js';

/** The answer refreshes this often while the app is on screen (the API caches 15 s). */
export const REFRESH_MS = 30_000;
/**
 * Pulled down to refresh (pull.js), a tab whose times came less than this
 * long ago isn't fetched again: the API caches arrivals 15 s, so it would
 * only send the same ones back.
 */
export const PULL_FRESH_MS = 15_000;
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

/**
 * A fix this old or newer is taken as it is: getCurrentPosition with this
 * maximumAge hands back the browser's own at once.
 */
export const FIX_FRESH_MS = 60_000;
/** Without one, the card waits this long for a fresh fix before it asks without. */
export const FIX_GRACE_MS = 1_500;
/** Then it goes with the last fix this page got, if it's no older than this. */
export const FIX_LAST_MS = 600_000;
/** The API drops a fix whose `acc` is over this (MAX_FIX_ACC_M there). */
export const FIX_MAX_ACC_M = 200;
/** A fresh fix this far from the one sent brings the card again, for where you are. */
export const FIX_MOVED_M = 50;

/**
 * Which fix the card is asked with: the fresh one ({ lat, lon, accuracy, at },
 * `at` when it was taken), or null when the browser had none to give (no
 * permission, an error). Still waited for at the grace (`fresh` undefined),
 * the page's last fix while it's under FIX_LAST_MS old. Null for no location.
 */
export function fixToSend(fresh, last, now) {
  if (fresh !== undefined) return fresh;
  return last && now - last.at < FIX_LAST_MS ? last : null;
}

/**
 * Fix `f` as the API takes it, rounded to about 11 m like the apps. `acc` is
 * how far out it may be: its accuracy, plus a walk's worth of its age. The
 * API drops a fix too rough to say where you are.
 */
export function fixQuery(f, now) {
  const acc = Math.round((f.accuracy || 0) + (Math.max(0, now - f.at) / 1000) * 1.3);
  return { lat: f.lat.toFixed(4), lon: f.lon.toFixed(4), acc: String(acc) };
}

/**
 * Whether the fresh fix, come after the card was asked with `sent` (a fix or
 * null), brings the card once more: when it went without one (or with one the API
 * drops), or from over FIX_MOVED_M away. That refresh finds the fresh fix under FIX_FRESH_MS old,
 * so it doesn't bring another.
 */
export function refreshAgain(sent, fresh, sentAt = Date.now()) {
  // Nothing new, or a fix the API would drop too: asking again would only repeat the ask.
  if (!fresh || fresh === sent || (fresh.accuracy || 0) > FIX_MAX_ACC_M) return false;
  // A sent fix the API drops (too rough or too old, as it was when sent) is no location.
  if (sent && Number(fixQuery(sent, sentAt).acc) > FIX_MAX_ACC_M) return true;
  return !sent || haversineM(sent.lat, sent.lon, fresh.lat, fresh.lon) > FIX_MOVED_M;
}
