// Helpers every part of the account page uses.

/** The page's language (assets/i18n.js): t('Updated {0}', time). */
// Outside a browser (the API's tests import search.js) it's English.
export const t = (en, ...args) => (globalThis.window?.i18n ? window.i18n.t(en, ...args) : en.replace(/\{(\d+)\}/g, (_, i) => String(args[i] ?? '')));
export const locale = () => globalThis.window?.i18n?.locale;

export const $ = (sel) => document.querySelector(sel);

/** A same-origin JSON call; throws with the server's error message and status. */
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    // The API writes answers and errors in the page's language.
    headers: { 'accept-language': window.i18n?.header ?? 'en', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
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

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k.startsWith('aria-')) node.setAttribute(k, v);
    else node[k] = v;
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

// Campus time, like the apps: class times from the server are Singapore time.
export const clock = (iso) => new Date(iso).toLocaleTimeString(locale() ?? [], { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Singapore' });
