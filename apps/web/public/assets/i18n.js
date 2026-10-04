// The website in English or Simplified Chinese (phase 10).
//
// Loaded in <head>, before the page: it picks the language (the choice made
// on this browser, or the account's, or else the browser's own languages)
// and, for Chinese, hides the page until it's translated, so English never
// flashes. The translations are in zh.js, keyed by the English they replace,
// which only a Chinese page loads: English readers never download it.
// Pages need no markup for it: text is matched as it appears, and a sentence
// with a link or a name inside is matched as the whole element's HTML.
// Scripts word what they build with t('English {0}', value).
(() => {
  const KEY = 'terminus-lang';
  /** The translations, once zh.js has run (loaded below, for Chinese only). */
  const zh = () => window.TERMINUS_ZH || {};

  const read = (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  const write = (k, v) => {
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      // Storage blocked: the choice lasts this page only.
    }
  };

  /** The browser's first language we have: zh for any Chinese, else English. */
  function browserLang() {
    for (const l of navigator.languages?.length ? navigator.languages : [navigator.language || 'en']) {
      const t = (l || '').toLowerCase();
      if (t === 'zh' || t.startsWith('zh-')) return 'zh';
      if (t === 'en' || t.startsWith('en-')) return 'en';
    }
    return 'en';
  }

  /** auto, en or zh: what this browser was set to. */
  const pref = () => {
    const v = read(KEY);
    return v === 'en' || v === 'zh' ? v : 'auto';
  };
  const lang = pref() === 'auto' ? browserLang() : pref();
  // A page with its own translation (the privacy policy): go to it.
  const alt = document.documentElement.dataset[lang === 'zh' ? 'altZh' : 'altEn'];
  if (alt && !location.search.includes('original')) location.replace(alt);
  document.documentElement.lang = lang === 'zh' ? 'zh-Hans' : 'en';
  // Chinese: zh.js now, before the rest of the page. Written into the parser
  // so it runs before the page's own scripts, which word what they build
  // with t() as they load. Same-origin, so no browser holds it back.
  if (lang === 'zh' && !window.TERMINUS_ZH) document.write('<script src="/assets/zh.js"></script>');

  const fill = (s, args) => s.replace(/\{(\d+)\}/g, (_, i) => String(args[i] ?? ''));
  /** "Updated {0}" in this page's language, with the blanks filled. */
  const t = (en, ...args) => fill(lang === 'zh' && zh()[en] != null ? zh()[en] : en, args);

  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  let byHtml = null;
  /** The keys with markup, as this browser writes that markup, so they match the page's. */
  function htmlKeys() {
    if (byHtml) return byHtml;
    byHtml = new Map();
    const tpl = document.createElement('template');
    for (const [k, v] of Object.entries(zh())) {
      if (!k.includes('<')) continue;
      tpl.innerHTML = k;
      byHtml.set(norm(tpl.innerHTML), v);
    }
    return byHtml;
  }

  const ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
  const SKIP = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'svg']);

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const raw = node.nodeValue;
      const hit = zh()[norm(raw)];
      if (hit != null) node.nodeValue = raw.match(/^\s*/)[0] + hit + raw.match(/\s*$/)[0];
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || node.hasAttribute('data-no-t')) return;
    // A text box's placeholder, though not what's typed in it.
    for (const a of ATTRS) {
      const v = node.getAttribute(a);
      if (v && zh()[norm(v)] != null) node.setAttribute(a, zh()[norm(v)]);
    }
    if (SKIP.has(node.tagName)) return;
    if (node.children.length) {
      const hit = htmlKeys().get(norm(node.innerHTML));
      if (hit != null) {
        node.innerHTML = hit;
        return;
      }
    }
    // A copy: childNodes is live, and walk() replaces what it translates.
    for (const c of Array.from(node.childNodes)) walk(c);
  }

  /** Translates what's on the page (or under `root`). A no-op in English. */
  function translate(root = document.body) {
    if (lang !== 'zh' || !root) return;
    walk(root);
  }

  /** The choice as a cookie too, so pages the server makes (a sign-in link's) follow it. */
  function cookie(p) {
    document.cookie = p === 'auto' ? `${KEY}=; path=/; max-age=0; samesite=lax` : `${KEY}=${p}; path=/; max-age=31536000; samesite=lax`;
  }

  /** Sets this browser's language (auto, en or zh) and shows the page in it. */
  function setLang(p) {
    write(KEY, p === 'auto' ? null : p);
    cookie(p);
    location.reload();
  }

  /** The other language, at the end of the footer's links. */
  function addSwitch() {
    const nav = document.querySelector('footer nav');
    if (!nav || nav.querySelector('[data-lang-switch]')) return;
    const a = document.createElement('a');
    a.href = '#';
    a.dataset.langSwitch = '';
    a.dataset.noT = '';
    a.lang = lang === 'zh' ? 'en' : 'zh-Hans';
    a.textContent = lang === 'zh' ? 'English' : '中文';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      setLang(lang === 'zh' ? 'en' : 'zh');
    });
    nav.append(a);
  }

  if (!document.cookie.includes(`${KEY}=${pref()}`) && !(pref() === 'auto' && !document.cookie.includes(`${KEY}=`))) cookie(pref());

  // Hidden until translated (site.css), and translated before the page's own
  // scripts run: "interactive" comes before deferred and module scripts.
  if (lang === 'zh') {
    document.documentElement.classList.add('i18n-wait');
    // Never leave the page hidden, whatever happens below.
    setTimeout(() => document.documentElement.classList.remove('i18n-wait'), 2000);
  }
  const ready = () => {
    if (lang === 'zh') {
      document.title = t(norm(document.title));
      const desc = document.querySelector('meta[name="description"]');
      if (desc) desc.content = t(norm(desc.content));
      translate();
    }
    addSwitch();
    document.documentElement.classList.remove('i18n-wait');
  };
  if (document.readyState === 'loading') {
    document.addEventListener('readystatechange', function once() {
      if (document.readyState === 'loading') return;
      document.removeEventListener('readystatechange', once);
      ready();
    });
  } else {
    ready();
  }

  window.i18n = {
    lang,
    pref,
    t,
    translate,
    setLang,
    /** For toLocale…String: the page's language. */
    locale: lang === 'zh' ? 'zh-CN' : undefined,
    /** Accept-Language for the API, which writes answers and errors in it. */
    header: lang === 'zh' ? 'zh-Hans' : 'en',
    /**
     * The account's language (its profile's lang): applied here once when it
     * changed on another device; a choice made here before the account had
     * one is returned to be saved to it.
     */
    followAccount(accountLang) {
      const applied = read(`${KEY}-applied`);
      if (accountLang === 'auto' && pref() !== 'auto' && applied == null) {
        write(`${KEY}-applied`, pref());
        return pref();
      }
      if (!['auto', 'en', 'zh'].includes(accountLang) || applied === accountLang) return null;
      write(`${KEY}-applied`, accountLang);
      if (accountLang !== pref()) setLang(accountLang);
      return null;
    },
    /** A choice made here, saved to the account too: don't apply it back. */
    noteAccount(p) {
      write(`${KEY}-applied`, p);
    },
  };
})();
