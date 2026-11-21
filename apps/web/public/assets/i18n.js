(() => {
  const KEY = 'terminus-lang';
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
    } catch {}
  };

  function browserLang() {
    for (const l of navigator.languages?.length ? navigator.languages : [navigator.language || 'en']) {
      const t = (l || '').toLowerCase();
      if (t === 'zh' || t.startsWith('zh-')) return 'zh';
      if (t === 'en' || t.startsWith('en-')) return 'en';
    }
    return 'en';
  }

  const pref = () => {
    const v = read(KEY);
    return v === 'en' || v === 'zh' ? v : 'auto';
  };
  const lang = pref() === 'auto' ? browserLang() : pref();
  const alt = document.documentElement.dataset[lang === 'zh' ? 'altZh' : 'altEn'];
  if (alt && !location.search.includes('original')) location.replace(alt);
  document.documentElement.lang = lang === 'zh' ? 'zh-Hans' : 'en';
  if (lang === 'zh' && !window.TERMINUS_ZH) document.write('<script src="/assets/zh.js"></script>');

  const fill = (s, args) => s.replace(/\{(\d+)\}/g, (_, i) => String(args[i] ?? ''));
  const t = (en, ...args) => fill(lang === 'zh' && zh()[en] != null ? zh()[en] : en, args);

  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  let byHtml = null;
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
    if (node.dataset.t) {
      let args = [];
      try {
        args = JSON.parse(node.dataset.tArgs || '[]');
      } catch {}
      node.textContent = t(node.dataset.t, ...args);
      return;
    }
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
    for (const c of Array.from(node.childNodes)) walk(c);
  }

  function translate(root = document.body) {
    if (lang !== 'zh' || !root) return;
    walk(root);
  }

  function cookie(p) {
    document.cookie = p === 'auto' ? `${KEY}=; path=/; max-age=0; samesite=lax` : `${KEY}=${p}; path=/; max-age=31536000; samesite=lax`;
  }

  function setLang(p) {
    write(KEY, p === 'auto' ? null : p);
    cookie(p);
    location.reload();
  }

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

  if (lang === 'zh') {
    document.documentElement.classList.add('i18n-wait');
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
    locale: lang === 'zh' ? 'zh-CN' : undefined,
    header: lang === 'zh' ? 'zh-Hans' : 'en',
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
    noteAccount(p) {
      write(`${KEY}-applied`, p);
    },
  };
})();
