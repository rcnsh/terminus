// The API docs page (/docs) on a phone. The page never scrolls (only the
// docs inside it do), so it must be exactly as tall as the part of the
// screen the browser shows. CSS can't say that: Chrome on Android sizes
// 100vh and fixed boxes as if its bars were hidden, and with its toolbar at
// the bottom the end of the docs, and of their menu, sat underneath it.
// The visual viewport is what's really shown; times its scale, it stays the
// same when the reader zooms in.
const root = document.documentElement;

function fit() {
  const vv = window.visualViewport;
  const seen = vv ? vv.height * vv.scale : window.innerHeight;
  root.style.setProperty('--seen', `${Math.round(seen)}px`);
}

fit();
window.visualViewport?.addEventListener('resize', fit);
window.addEventListener('resize', fit);
window.addEventListener('orientationchange', fit);
