// Helpers every page uses: words in the page's language, calls to the API,
// times in campus time, and readable text on a service's colour. (Drawing is
// Preact's: assets/ui.js.)

/** The page's language (assets/i18n.js): t('Updated {0}', time). */
// Outside a browser (the API's tests import search.js) it's English.
export const t = (en, ...args) => (globalThis.window?.i18n ? window.i18n.t(en, ...args) : en.replace(/\{(\d+)\}/g, (_, i) => String(args[i] ?? '')));
export const locale = () => globalThis.window?.i18n?.locale;

/**
 * Lines read by a screen reader as sentences, each stopped as the page's
 * language writes it: ". " in English, "。" in Chinese.
 */
export const sentences = (parts) => parts.filter(Boolean).join(globalThis.window?.i18n?.lang === 'zh' ? '。' : '. ');

/** Why the browser gave no location (a GeolocationPositionError), in the page's language: its own message is English. */
export function locationError(err) {
  if (err?.code === 1) return t('Location is off for this site. Choose your stop instead.');
  if (err?.code === 3) return t('Finding your location took too long. Choose your stop instead.');
  return t("Couldn't find your location. Choose your stop instead.");
}

// After a 429, nothing is sent until the server's Retry-After has passed:
// a page that keeps polling at full speed only keeps the limit tripped.
let quietUntil = 0;

/**
 * How long a call may take, unless its caller says otherwise. Wi-Fi that
 * drops everything (a lecture theatre's, a captive portal before sign-in)
 * would otherwise leave "Checking…" up for minutes, with the next timed
 * refresh piling another hung call on top.
 */
const SEND_TIMEOUT_MS = 20_000;

/**
 * How long a write may take. A timetable import or a profile save can be
 * slow on a phone's connection, and the server may finish it after the page
 * has given up, so a write waits longer before saying it failed.
 */
const WRITE_TIMEOUT_MS = 60_000;

/** A signal that aborts after `ms` (AbortSignal.timeout, where the browser has it). */
export function timeout(ms) {
  if (AbortSignal.timeout) return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

/** The error for a call that got no usable answer: nothing back in time, or a page that isn't terminus's. */
const unreachable = () => new Error(t("Couldn't reach terminus. Check your connection."));

/**
 * fetch(), unless the server asked this page to slow down: then it throws
 * at once, with status 429, until Retry-After (at most 5 minutes) is up.
 * Gives up after `timeoutMs` (SEND_TIMEOUT_MS), reading the body included.
 */
export async function send(path, { timeoutMs = SEND_TIMEOUT_MS, ...init } = {}) {
  if (Date.now() < quietUntil) throw Object.assign(new Error(t('terminus is busy. Try again in a minute.')), { status: 429 });
  // No answer in time, or none at all (offline: the browser's own "Failed
  // to fetch" or "Load failed", in English whatever the page's language).
  const res = await fetch(path, { signal: timeout(timeoutMs), ...init }).catch((err) => {
    throw ['TimeoutError', 'AbortError', 'TypeError'].includes(err?.name) ? unreachable() : err;
  });
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
 * The account language this browser last applied or saved (assets/i18n.js's
 * followAccount): the account's, not the browser's. The browser's own
 * choice is `terminus-lang`, which stays.
 */
const LANG_APPLIED_KEY = 'terminus-lang-applied';

/**
 * Signing out, or the account deleted or signed out elsewhere: what this
 * browser kept of the account goes, so the next person to sign in here
 * doesn't see it. That's the places searched for, the account's language
 * as last applied here, and the push subscription (the server has already
 * dropped its address). The look (language, theme, clock, card style) is
 * the browser's and stays.
 */
export async function forgetAccountHere() {
  try {
    for (const k of [ADDED_PLACES_KEY, LANG_APPLIED_KEY]) globalThis.localStorage?.removeItem(k);
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

/**
 * A 401 in the web app: it was signed out, or deleted, elsewhere. What this
 * browser kept of it goes, then it's off to sign in on the account page and
 * back to the app. In the installed app on iOS this is its own sign-in: its
 * storage is separate from Safari's. Throws, so the caller stops there.
 */
export async function signedOut() {
  await forgetAccountHere();
  globalThis.location?.replace('/account/?next=/app/');
  throw new Error('signed out');
}

/**
 * A same-origin JSON call; throws with the server's error message and status.
 * Reads give up after SEND_TIMEOUT_MS, writes after WRITE_TIMEOUT_MS.
 */
export async function api(path, { method = 'GET', body, timeoutMs = method === 'GET' ? SEND_TIMEOUT_MS : WRITE_TIMEOUT_MS } = {}) {
  const res = await send(path, {
    method,
    timeoutMs,
    // The API writes answers and errors in the page's language.
    headers: { 'accept-language': window.i18n?.header ?? 'en', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    credentials: 'same-origin',
  });
  // A body cut off part way (the time ran out, the connection dropped) is
  // no answer; only an empty one (a 204) stands for {}. An error keeps its
  // status either way.
  const text = await res.text().catch(() => {
    if (res.ok) throw unreachable();
    return null;
  });
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // Not JSON: a captive portal's sign-in page, or a proxy's error page.
  }
  if (!res.ok) throw Object.assign(new Error(sentence(data?.error) || `HTTP ${res.status}`), { status: res.status });
  // A 200 that isn't the API's answer must not pass for one.
  if (data === null || typeof data !== 'object') throw unreachable();
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
