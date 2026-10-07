// Helpers every page uses: words in the page's language, calls to the API,
// times in campus time, and readable text on a service's colour. (Drawing is
// Preact's: assets/ui.js.)

/** The page's language (assets/i18n.js): t('Updated {0}', time). */
// Outside a browser (the API's tests import search.js) it's English.
export const t = (en, ...args) => (globalThis.window?.i18n ? window.i18n.t(en, ...args) : en.replace(/\{(\d+)\}/g, (_, i) => String(args[i] ?? '')));
export const locale = () => globalThis.window?.i18n?.locale;

// After a 429, nothing is sent until the server's Retry-After has passed:
// a page that keeps polling at full speed only keeps the limit tripped.
let quietUntil = 0;

/**
 * fetch(), unless the server asked this page to slow down: then it throws
 * at once, with status 429, until Retry-After (at most 5 minutes) is up.
 */
export async function send(path, init) {
  if (Date.now() < quietUntil) throw Object.assign(new Error(t('terminus is busy. Try again in a minute.')), { status: 429 });
  const res = await fetch(path, init);
  noteServerDate(res);
  if (res.status === 429) {
    const s = Number(res.headers.get('retry-after'));
    quietUntil = Date.now() + Math.min(Number.isFinite(s) && s > 0 ? s : 60, 300) * 1000;
  }
  return res;
}

/** Where the web app keeps the places searched for (app/app.js). */
export const ADDED_PLACES_KEY = 'added-places';

/**
 * Signing out, or the account deleted or signed out elsewhere: what this
 * browser kept of the account goes, so the next person to sign in here
 * doesn't see it. That's the places searched for, and the push
 * subscription (the server has already dropped its address). The look
 * (language, theme, clock) is the browser's and stays.
 */
export async function forgetAccountHere() {
  try {
    globalThis.localStorage?.removeItem(ADDED_PLACES_KEY);
  } catch {
    // Storage blocked: nothing was kept.
  }
  // Unsubscribing asks the push service, which can be slow offline: signing
  // out waits two seconds at most.
  const unsubscribe = (async () => {
    const reg = await globalThis.navigator?.serviceWorker?.getRegistration('/app/');
    await (await reg?.pushManager?.getSubscription())?.unsubscribe();
  })().catch(() => {
    // No service worker, or push never set up.
  });
  await Promise.race([unsubscribe, new Promise((r) => setTimeout(r, 2000))]);
}

/** A same-origin JSON call; throws with the server's error message and status. */
export async function api(path, { method = 'GET', body } = {}) {
  const res = await send(path, {
    method,
    // The API writes answers and errors in the page's language.
    headers: { 'accept-language': window.i18n?.header ?? 'en', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(sentence(data.error) || `HTTP ${res.status}`), { status: res.status });
  return data;
}

// The API's errors are lowercase phrases ("not a valid NUSMods share link"),
// written for API users; on the page they're shown as sentences.
function sentence(text) {
  if (typeof text !== 'string' || !text) return '';
  const s = text[0].toUpperCase() + text.slice(1);
  if (/[.!?。！？]$/.test(s)) return s;
  return /[\u4e00-\u9fff]/.test(s) ? `${s}。` : `${s}.`;
}

// 12- or 24-hour times: the account's choice (its profile's `clock`), kept
// in this browser so the first paint has it; 'auto' follows the browser.
const CLOCK_KEY = 'terminus.clock';
let clockPref = 'auto';
try {
  clockPref = globalThis.localStorage?.getItem(CLOCK_KEY) ?? 'auto';
} catch {}

/** The account's clock choice, from each profile as it loads or saves. */
export function setClockPref(v) {
  clockPref = v === '12' || v === '24' ? v : 'auto';
  try {
    globalThis.localStorage?.setItem(CLOCK_KEY, clockPref);
  } catch {}
}

/** This browser's own style, before any choice. */
export const browserHour12 = () => new Intl.DateTimeFormat(locale() ?? [], { hour: 'numeric' }).resolvedOptions().hour12 === true;
export const hour12 = () => (clockPref === '12' ? true : clockPref === '24' ? false : browserHour12());

/** A time as the card writes it: "9:41 AM" or "09:41". */
export const clockOpts = () => (hour12() ? { hour: 'numeric', minute: '2-digit', hour12: true } : { hour: '2-digit', minute: '2-digit', hour12: false });

/** A formatted time with a space after 上午/下午, as the server writes it ("下午 6:36"). */
export const spaced = (s) => s.replace(/([上下]午)(\d)/, '$1 $2');

// Campus time, like the apps: class times from the server are Singapore time.
export const clock = (iso) => spaced(new Date(iso).toLocaleTimeString(locale() ?? [], { ...clockOpts(), timeZone: 'Asia/Singapore' }));

/*
 * The device's clock can be wrong by minutes, and every countdown compares
 * the server's times (leave by, departs, stale at) with it. Each API answer's
 * Date header says what the server's clock read when it answered, so the
 * error is that minus this clock at the answer. Date is whole seconds and
 * is read a moment after it was written, so one answer can only ever say
 * the error is at most that: the largest of the last few is the best guess,
 * and an answer the browser kept a few seconds (max-age) can't drag it down.
 * Under SKEW_MIN_MS it's noise, and ignored.
 */
const SKEW_MIN_MS = 3_000;
const SKEW_SAMPLES = 5;
let skewSamples = [];
let skewMs = 0;

/** One answer's reading: the server's `date` header minus `localMs`, or null without one. */
export function skewSample(date, localMs) {
  const server = date ? Date.parse(date) : NaN;
  return Number.isFinite(server) ? server - localMs : null;
}

/** The clock's error from the latest `samples`: their largest, or 0 under SKEW_MIN_MS. */
export function skewOf(samples) {
  if (!samples.length) return 0;
  const most = Math.max(...samples);
  return Math.abs(most) < SKEW_MIN_MS ? 0 : most;
}

/**
 * Takes response `res` into the clock's error. One the service worker
 * served from its cache (x-terminus-cached) says nothing about now.
 */
export function noteServerDate(res, localMs = Date.now()) {
  if (!res?.headers || res.headers.get('x-terminus-cached')) return;
  const s = skewSample(res.headers.get('date'), localMs);
  if (s === null) return;
  skewSamples = [...skewSamples, s].slice(-SKEW_SAMPLES);
  skewMs = skewOf(skewSamples);
}

/** Now on the server's clock: use it wherever a server time is compared with now. */
export const serverNow = () => Date.now() + skewMs;

/**
 * Text that reads on a service's colour: white or near-black, whichever
 * contrasts more (WCAG luminance). The yellow A2 or blue K need dark text.
 */
export function inkOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return '#fff';
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const n = parseInt(m[1], 16);
  const lum = 0.2126 * lin(((n >> 16) & 255) / 255) + 0.7152 * lin(((n >> 8) & 255) / 255) + 0.0722 * lin((n & 255) / 255);
  // Contrast with white (luminance 1) against with #1c1917 (about 0.011).
  return (1.05 / (lum + 0.05)) >= (lum + 0.05) / 0.061 ? '#fff' : '#1c1917';
}
