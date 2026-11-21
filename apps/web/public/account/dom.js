export const t = (en, ...args) => (window.i18n ? window.i18n.t(en, ...args) : en.replace(/\{(\d+)\}/g, (_, i) => String(args[i] ?? '')));
export const locale = () => window.i18n?.locale;

export const sentences = (parts) => parts.filter(Boolean).join(window.i18n?.lang === 'zh' ? '。' : '. ');

export function locationError(err) {
  if (err?.code === 1) return t('Location is off for this site. Choose your stop instead.');
  if (err?.code === 3) return t('Finding your location took too long. Choose your stop instead.');
  return t("Couldn't find your location. Choose your stop instead.");
}

const quietUntil = { app: 0, auth: 0 };
const scopeOf = (path) => (/^\/api\/(auth|pair)(\/|$|\?)/.test(path) ? 'auth' : 'app');

export const quietMs = (path) => Math.max(0, quietUntil[scopeOf(String(path))] - Date.now());

const SEND_TIMEOUT_MS = 20_000;

const WRITE_TIMEOUT_MS = 60_000;

export function timeout(ms) {
  if (AbortSignal.timeout) return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

const unreachable = () => new Error(t("Couldn't reach terminus. Check your connection."));

export async function send(path, { timeoutMs = SEND_TIMEOUT_MS, ...init } = {}) {
  const scope = scopeOf(String(path));
  if (Date.now() < quietUntil[scope]) throw Object.assign(new Error(t('terminus is busy. Try again in a minute.')), { status: 429 });
  const signal = init.signal && AbortSignal.any ? AbortSignal.any([init.signal, timeout(timeoutMs)]) : (init.signal ?? timeout(timeoutMs));
  const res = await fetch(path, { ...init, signal }).catch((err) => {
    throw ['TimeoutError', 'AbortError', 'TypeError'].includes(err?.name) ? unreachable() : err;
  });
  noteServerDate(res);
  if (res.status === 429 || (res.status === 503 && res.headers.has('retry-after'))) {
    const s = Number(res.headers.get('retry-after'));
    quietUntil[scope] = Date.now() + Math.min(Number.isFinite(s) && s > 0 ? s : 60, 300) * 1000;
  }
  return res;
}

export const ADDED_PLACES_KEY = 'added-places';
export const PIN_COUNT_KEY = 'pinned-count';
const LANG_APPLIED_KEY = 'terminus-lang-applied';

export async function forgetAccountHere() {
  try {
    for (const k of [ADDED_PLACES_KEY, PIN_COUNT_KEY, LANG_APPLIED_KEY]) globalThis.localStorage?.removeItem(k);
  } catch {}
  const unsubscribe = (async () => {
    const reg = await navigator.serviceWorker?.getRegistration('/app/');
    await (await reg?.pushManager?.getSubscription())?.unsubscribe();
  })().catch(() => {});
  await Promise.race([unsubscribe, new Promise((r) => setTimeout(r, 2000))]);
}

export async function signedOut() {
  await forgetAccountHere();
  globalThis.location?.replace('/account/?next=/app/');
  throw new Error('signed out');
}

export async function api(path, opts) {
  return (await apiTagged(path, opts)).data;
}

export async function apiTagged(
  path,
  { method = 'GET', body, ifMatch, timeoutMs = method === 'GET' ? SEND_TIMEOUT_MS : WRITE_TIMEOUT_MS } = {},
) {
  const res = await send(path, {
    method,
    timeoutMs,
    headers: {
      'accept-language': window.i18n?.header ?? 'en',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(ifMatch ? { 'if-match': ifMatch } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    credentials: 'same-origin',
  });
  const text = await res.text().catch(() => {
    if (res.ok) throw unreachable();
    return null;
  });
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {}
  if (!res.ok)
    throw Object.assign(new Error(sentence(data?.error) || t("Couldn't reach terminus. Try again in a moment.")), { status: res.status });
  if (data === null || typeof data !== 'object') throw unreachable();
  return { data, etag: res.headers?.get('etag') ?? null };
}

function sentence(text) {
  if (typeof text !== 'string' || !text) return '';
  const s = text[0].toUpperCase() + text.slice(1);
  if (/[.!?。！？]$/.test(s)) return s;
  return /[\u4e00-\u9fff]/.test(s) ? `${s}。` : `${s}.`;
}

const CLOCK_KEY = 'terminus.clock';
let clockPref = 'auto';
try {
  clockPref = globalThis.localStorage?.getItem(CLOCK_KEY) ?? 'auto';
} catch {}

export function setClockPref(v) {
  clockPref = v === '12' || v === '24' ? v : 'auto';
  try {
    globalThis.localStorage?.setItem(CLOCK_KEY, clockPref);
  } catch {}
}

export const browserHour12 = () => new Intl.DateTimeFormat(locale() ?? [], { hour: 'numeric' }).resolvedOptions().hour12 === true;
export const hour12 = () => (clockPref === '12' ? true : clockPref === '24' ? false : browserHour12());

export const clockOpts = () =>
  hour12() ? { hour: 'numeric', minute: '2-digit', hour12: true } : { hour: '2-digit', minute: '2-digit', hour12: false };

export const spaced = (s) => s.replace(/([上下]午)(\d)/, '$1 $2');

export const clock = (iso) => spaced(new Date(iso).toLocaleTimeString(locale() ?? [], { ...clockOpts(), timeZone: 'Asia/Singapore' }));

const SKEW_MIN_MS = 3_000;
const SKEW_SAMPLES = 5;
let skewSamples = [];
let skewMs = 0;

export function skewSample(date, localMs) {
  const server = date ? Date.parse(date) : NaN;
  return Number.isFinite(server) ? server - localMs : null;
}

export function skewOf(samples) {
  if (!samples.length) return 0;
  const most = Math.max(...samples);
  return Math.abs(most) < SKEW_MIN_MS ? 0 : most;
}

export function noteServerDate(res, localMs = Date.now()) {
  if (!res?.headers || res.headers.get('x-terminus-cached')) return;
  const s = skewSample(res.headers.get('date'), localMs);
  if (s === null) return;
  skewSamples = [...skewSamples, s].slice(-SKEW_SAMPLES);
  skewMs = skewOf(skewSamples);
}

export const serverNow = () => Date.now() + skewMs;

export function inkOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return '#fff';
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const n = parseInt(m[1], 16);
  const lum = 0.2126 * lin(((n >> 16) & 255) / 255) + 0.7152 * lin(((n >> 8) & 255) / 255) + 0.0722 * lin((n & 255) / 255);
  return 1.05 / (lum + 0.05) >= (lum + 0.05) / 0.061 ? '#fff' : '#1c1917';
}
