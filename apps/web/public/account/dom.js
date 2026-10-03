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
  if (res.status === 429) {
    const s = Number(res.headers.get('retry-after'));
    quietUntil = Date.now() + Math.min(Number.isFinite(s) && s > 0 ? s : 60, 300) * 1000;
  }
  return res;
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
