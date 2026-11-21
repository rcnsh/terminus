import { t } from '/account/dom.js';
import { haversineM } from '/account/profile.js';

export const REFRESH_MS = 30_000;
export const PULL_FRESH_MS = 15_000;
export const MARK_MIN_MS = 5_000;
export const MARK_GAP_MS = 30_000;

export function staleText(at, { online, failed = false }) {
  if (!online) return t("You're offline. Showing the update from {0}.", at);
  return failed ? t("Couldn't update. Showing the update from {0}.", at) : t('Slow connection. Showing the update from {0}.', at);
}

export function slowRetryMs(tries) {
  const wait = 8_000 * 2 ** tries;
  return wait < REFRESH_MS ? wait : null;
}

export function markWaitMs(a, { now, serverNow, markAt }) {
  const asOf = Date.parse(a?.asOf ?? '');
  const marks = [a?.card?.nextChangeAt, a?.refreshAt].map((x) => Date.parse(x ?? '')).filter((m) => Number.isFinite(m) && !(m <= asOf));
  if (!marks.length) return null;
  const wait = Math.max(MARK_MIN_MS, markAt + MARK_GAP_MS - now, Math.min(...marks) - serverNow);
  return wait >= REFRESH_MS ? null : wait;
}

export const FIX_FRESH_MS = 60_000;
export const FIX_GRACE_MS = 1_500;
export const FIX_LAST_MS = 600_000;
export const FIX_MAX_ACC_M = 200;
export const FIX_MOVED_M = 50;

export function fixToSend(fresh, last, now) {
  if (fresh !== undefined) return fresh;
  return last && now - last.at < FIX_LAST_MS ? last : null;
}

export function fixQuery(f, now) {
  const acc = Math.round((f.accuracy || 0) + (Math.max(0, now - f.at) / 1000) * 1.3);
  return { lat: f.lat.toFixed(4), lon: f.lon.toFixed(4), acc: String(acc) };
}

export function refreshAgain(sent, fresh, sentAt = Date.now()) {
  if (!fresh || fresh === sent || (fresh.accuracy || 0) > FIX_MAX_ACC_M) return false;
  if (sent && Number(fixQuery(sent, sentAt).acc) > FIX_MAX_ACC_M) return true;
  return !sent || haversineM(sent.lat, sent.lon, fresh.lat, fresh.lon) > FIX_MOVED_M;
}
