// Frames the Play Store screenshots: each capture from the emulator
// (captures/en, captures/zh, unchanged) inside a phone, under a headline.
// The five are one picture cut in five, as Play shows them side by side: the
// app's sky going from dawn to night along it, its hills, city and road
// running through, a shuttle crossing from one to the next, and a route line
// with a stop for each. Writes screenshots/ and screenshots/zh/, 1080×1920
// like the captures (Play's phone limit is a 2:1 ratio).
//
// The home screen's capture is rebuilt around its own pixels: the widgets and
// the app icons as captured, on a wallpaper of the app's dusk, without the
// search bar.
//
//   node apps/android/store/frame.mjs            # all of them
//   node apps/android/store/frame.mjs 3-map      # one, both languages
//
// Draws with Chromium, headless: CHROME if set, else Playwright's download
// (~/Library/Caches/ms-playwright), else Google Chrome. The Chinese uses the
// system's PingFang SC, so run it on a Mac.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fonts = join(here, '../../web/public/assets/fonts');
const W = 1080;
const H = 1920;

// The words, in the listing's order. The headline is two lines, split at
// "|", so every phone sits at the same height; its part in braces is in the
// accent colour; the Chinese follows the app's glossary (src/i18n.ts). `icon`
// is the stop's on the route line.
const SLIDES = [
  {
    file: '1-leave-by',
    sky: 'dawn',
    icon: 'clock',
    en: { head: 'Know when to|{leave for class}', sub: 'A countdown to setting off, and the bus to catch.' },
    zh: { head: '{什么时候出发}，|一看就知道', sub: '出发倒计时，还有该搭的那班巴士。' },
  },
  {
    file: '2-widget',
    sky: 'day',
    icon: 'widget',
    home: true,
    en: { head: 'Your buses,|{on the home screen}', sub: 'The next bus, and the buses near you, at a glance.' },
    zh: { head: '你的巴士，|就在{主屏幕上}', sub: '不用打开应用，就能看到下一班巴士和附近的巴士。' },
  },
  {
    file: '3-map',
    sky: 'golden',
    icon: 'map',
    en: { head: 'Every bus,|{live on the map}', sub: 'Pick a service to see its line, its stops and its buses.' },
    zh: { head: '每辆巴士，|{地图上实时看}', sub: '选一条线路，看它的路线、车站和巴士。' },
  },
  {
    file: '4-buses',
    sky: 'dusk',
    icon: 'stop',
    en: { head: 'What’s coming|{at your stop}', sub: 'Every service’s next buses, live, and how full.' },
    zh: { head: '{你的车站}，|下一班什么时候到', sub: '每条线路的下一班巴士，实时到站，还有多挤。' },
  },
  {
    file: '5-on-the-bus',
    sky: 'night',
    icon: 'bus',
    en: { head: 'With you|{all the way}', sub: 'On the bus: the next stop, and when you’ll get there.' },
    zh: { head: '上车以后，|{一路}都在身边', sub: '在车上：下一站是哪里，什么时候到。' },
  },
];

// The skies of apps/web/public/assets/sky.css (light), and night's from the
// dark one: top to horizon, the far hills, the trees, the city, the ground
// and the road; `dark` puts the words in light ink.
const SKIES = {
  dawn: {
    s: ['#8fc1e8', '#b7d6ee', '#f1d6c2', '#f7c9a4'],
    far: '#b3b0c3',
    tree: '#6a7568',
    city: '#cfc8d8',
    ground: '#fafaf9',
    road: '#d6cfc7',
  },
  day: {
    s: ['#5ea8e5', '#8ec4ec', '#c7e2f4', '#e3f0f8'],
    far: '#9fbcae',
    tree: '#4f6f58',
    city: '#b7cbd9',
    ground: '#fafaf9',
    road: '#d6cfc7',
  },
  golden: {
    s: ['#78aadb', '#a7c3dc', '#f0cf9c', '#f4b46c'],
    far: '#c4a983',
    tree: '#5e5a42',
    city: '#dcc6a2',
    ground: '#f7f3ee',
    road: '#d6cfc7',
  },
  dusk: {
    s: ['#2c3566', '#4a4275', '#6c4260', '#e08a62'],
    far: '#4b3f62',
    tree: '#2c2440',
    city: '#7d6a90',
    ground: '#24202e',
    road: '#4a4454',
    dark: true,
  },
  night: {
    s: ['#121a33', '#181a30', '#24243a', '#2e2a44'],
    far: '#3a3550',
    tree: '#4a4458',
    city: '#45405f',
    ground: '#1a1822',
    road: '#3a3542',
    dark: true,
  },
};

// Where the phone sits, and the route line above it.
const SCREEN_W = 700;
const SCREEN_H = Math.round((SCREEN_W * H) / W);
const PHONE_TOP = 512;
const LINE_Y = 446;

// The home screen's capture (both languages lay it out alike): the two widgets
// and the four app icons, in its own pixels.
const HOME = {
  widgets: [
    { x: 50, y: 367, w: 981, h: 397 },
    { x: 50, y: 785, w: 981, h: 606 },
  ],
  radius: 63,
  icons: [158, 413, 668, 923].map((x) => ({ x, y: 1537 })),
  iconR: 62,
};

/**
 * The whole strip, five slides wide, drawn in the page with a canvas: each
 * slide's page shows its own fifth of it, so the hills, the road and the
 * shuttles carry on across the joins.
 */
function panoramaScript() {
  const phases = SLIDES.map((s) => SKIES[s.sky]);
  return `(() => {
  const P = ${JSON.stringify(phases)};
  const W = ${W}, H = ${H}, N = P.length, PW = W * N;
  const c = document.getElementById('pano');
  const g = c.getContext('2d');
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, t) => { const x = hex(a), y = hex(b); return 'rgb(' + x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(',') + ')'; };
  // How far along the day at x: whole numbers at the slides' middles, easing
  // from one to the next across the join.
  const at = (x) => {
    const f = Math.min(N - 1, Math.max(0, x / W - 0.5));
    const i = Math.min(N - 2, Math.floor(f)), t = f - i;
    const e = t < 0.25 ? 0 : t > 0.75 ? 1 : (t - 0.25) / 0.5;
    return [i, e * e * (3 - 2 * e)];
  };
  const col = (x, key, k) => { const [i, t] = at(x); const a = k === undefined ? P[i][key] : P[i][key][k], b = k === undefined ? P[i + 1][key] : P[i + 1][key][k]; return mix(a, b, t); };
  const dark = (x) => { const [i, t] = at(x); return (P[i].dark ? 1 : 0) * (1 - t) + (P[i + 1].dark ? 1 : 0) * t; };
  // The sky, in strips.
  for (let x = 0; x < PW; x += 4) {
    const gr = g.createLinearGradient(0, 0, 0, H);
    [0, 0.35, 0.62, 0.8].forEach((o, k) => gr.addColorStop(o, col(x + 2, 's', k)));
    g.fillStyle = gr;
    g.fillRect(x, 0, 4, H);
  }
  // Stars where it's dark: above the words, or beside the phones, never among them.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let n = 0; n < 420; n++) {
    const x = rnd() * PW, y = rnd() * 1380, local = x % W;
    const words = y > 70 && y < 420 && local > 50 && local < W - 50;
    const phone = y > ${PHONE_TOP - 30} && local > 150 && local < W - 150;
    const a = dark(x) * (0.35 + rnd() * 0.6);
    if (words || phone || a < 0.05) continue;
    g.fillStyle = 'rgba(255,255,255,' + a.toFixed(2) + ')';
    g.beginPath(); g.arc(x, y, rnd() < 0.15 ? 2.8 : 1.7, 0, 7); g.fill();
  }
  // The sun rising over the first join, setting over the third; the moon over the last slide.
  const disc = (x, y, r, fill, glow) => {
    const gl = g.createRadialGradient(x, y, r * 0.6, x, y, r * 2.6);
    gl.addColorStop(0, glow); gl.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gl; g.beginPath(); g.arc(x, y, r * 2.6, 0, 7); g.fill();
    g.fillStyle = fill; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
  };
  disc(W, 1300, 58, '#fff1d6', 'rgba(255,241,214,0.45)');
  disc(3 * W, 1420, 84, '#ffb37a', 'rgba(255,179,122,0.42)');
  disc(4 * W + 980, 1210, 40, '#fde9c9', 'rgba(253,233,201,0.25)');
  // The far hills, one ridge the whole way, in each hour's colour.
  const farY = (x) => 1478 + 26 * Math.sin(x / 233) + 14 * Math.sin(x / 91 + 1.3) + 10 * Math.sin(x / 611 + 0.4);
  const nearY = (x) => 1652 + 16 * Math.sin(x / 377 + 2) + 9 * Math.sin(x / 143);
  const band = (key) => { const gr = g.createLinearGradient(0, 0, PW, 0); for (let x = 0; x <= PW; x += 90) gr.addColorStop(x / PW, col(x, key)); return gr; };
  // The city on the far hills: Marina Bay Sands beside the golden slide's phone, towers here and there.
  g.fillStyle = band('city');
  const sands = (cx) => {
    const cy = farY(cx) + 6;
    for (const dx of [-52, -8, 36]) { g.beginPath(); g.moveTo(cx + dx, cy); g.lineTo(cx + dx + 4, cy - 110); g.lineTo(cx + dx + 20, cy - 110); g.lineTo(cx + dx + 24, cy); g.fill(); }
    g.beginPath(); g.moveTo(cx - 62, cy - 118); g.lineTo(cx + 104, cy - 124); g.lineTo(cx + 96, cy - 110); g.lineTo(cx - 58, cy - 110); g.fill();
  };
  sands(2 * W + 1000);
  for (const [x, w, h] of [[70, 46, 70], [1150, 60, 96], [1230, 34, 58], [3120, 50, 80], [4300, 70, 110], [4380, 36, 64], [5330, 54, 84]]) g.fillRect(x, farY(x) - h + 8, w, h);
  g.fillStyle = band('far');
  g.beginPath(); g.moveTo(0, H); for (let x = 0; x <= PW; x += 6) g.lineTo(x, farY(x)); g.lineTo(PW, H); g.fill();
  // Rain trees beside the phones.
  g.fillStyle = band('tree');
  const tree = (cx, s) => {
    const gy = nearY(cx) + 4;
    g.save(); g.translate(cx, gy); g.scale(s, s);
    g.beginPath(); g.moveTo(-1.5, 2); g.lineTo(-1.5, -7); g.lineTo(-7, -13); g.lineTo(-4.5, -13); g.lineTo(0, -9); g.lineTo(4.5, -13); g.lineTo(7, -13); g.lineTo(1.5, -7); g.lineTo(1.5, 2); g.fill();
    for (const [x, y, rx, ry] of [[0, -18, 21, 5.5], [-8, -21.5, 11, 4.5], [8, -22, 12, 4.5]]) { g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, 7); g.fill(); }
    g.restore();
  };
  for (const [x, s] of [[64, 3.4], [1010, 2.6], [1150, 3.2], [2100, 3], [2250, 2.4], [3330, 3.4], [4180, 2.8], [4340, 3.6], [5320, 3]]) tree(x, s);
  // The flag beside the first phone, as on Now.
  { const fx = 1000, fy = nearY(fx); g.fillStyle = band('tree'); g.fillRect(fx - 2, fy - 120, 4, 124); g.fillStyle = '#ef3340'; g.fillRect(fx + 2, fy - 120, 52, 17); g.fillStyle = '#f2efeb'; g.fillRect(fx + 2, fy - 103, 52, 17); }
  // The near hill and the road along it.
  g.fillStyle = band('ground');
  g.beginPath(); g.moveTo(0, H); for (let x = 0; x <= PW; x += 6) g.lineTo(x, nearY(x)); g.lineTo(PW, H); g.fill();
  g.fillStyle = band('road');
  for (let x = 12; x < PW; x += 84) { g.beginPath(); g.roundRect(x, 1866, 46, 7, 3.5); g.fill(); }
  // Two shuttles on the road, each across a join: the morning's, and the night's with its lights on.
  const bus = (x, lit) => {
    g.save(); g.translate(x, 1866); g.scale(0.82, 0.82); g.translate(-x, -1866);
    const y = 1782, w = 300, h = 82;
    if (lit) { const b = g.createLinearGradient(x + w, 0, x + w + 260, 0); b.addColorStop(0, 'rgba(254,243,199,0.55)'); b.addColorStop(1, 'rgba(254,243,199,0)'); g.fillStyle = b; g.beginPath(); g.moveTo(x + w - 4, y + 46); g.lineTo(x + w + 260, y + 20); g.lineTo(x + w + 260, y + 82); g.closePath(); g.fill(); }
    g.fillStyle = '#24211e'; g.beginPath(); g.roundRect(x, y, w, h, [16, 26, 10, 10]); g.fill();
    g.fillStyle = '#d32f2f'; g.fillRect(x + 6, y + 50, w - 12, 10);
    g.fillStyle = lit ? '#fde9c9' : '#cfe0f0';
    for (let i = 0; i < 6; i++) { g.beginPath(); g.roundRect(x + 18 + i * 42, y + 12, 32, 28, 5); g.fill(); }
    g.beginPath(); g.roundRect(x + w - 34, y + 12, 24, 34, [5, 14, 5, 5]); g.fill();
    g.fillStyle = lit ? '#fef3c7' : '#8a847d'; g.beginPath(); g.arc(x + w - 6, y + 66, 6, 0, 7); g.fill();
    g.fillStyle = lit ? '#ef4444' : '#7f1d1d'; g.fillRect(x + 1, y + 62, 6, 10);
    for (const cx of [x + 62, x + w - 64]) { g.fillStyle = '#151311'; g.beginPath(); g.arc(cx, y + h, 20, 0, 7); g.fill(); g.fillStyle = '#8a847d'; g.beginPath(); g.arc(cx, y + h, 8, 0, 7); g.fill(); }
    g.restore();
  };
  bus(W - 123, false);
  bus(4 * W - 123, true);
})();`;
}

/** The route line through all five, a stop on each slide (its icon) and a small one at each join. */
function routeLine() {
  const ICONS = {
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
    widget:
      '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="17" height="7" rx="1.6"/>',
    map: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
    stop: '<rect x="6" y="3" width="12" height="9" rx="2"/><path d="M12 12v9M9 21h6M9 7.5h6"/>',
    bus: '<rect x="4" y="4" width="16" height="13" rx="3"/><path d="M4 11h16M8 17v2.5M16 17v2.5"/><circle cx="8" cy="14" r="0.6"/><circle cx="16" cy="14" r="0.6"/>',
  };
  const stops = SLIDES.map((s, i) => {
    const cx = i * W + W / 2;
    return `<circle cx="${cx}" cy="${LINE_Y}" r="44" fill="#fffdfa" stroke="#f97316" stroke-width="9"/>
      <g transform="translate(${cx - 26} ${LINE_Y - 26}) scale(2.17)" fill="none" stroke="#1c1917" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS[s.icon]}</g>`;
  }).join('');
  const joins = SLIDES.slice(1)
    .map((_, i) => `<circle cx="${(i + 1) * W}" cy="${LINE_Y}" r="13" fill="#fffdfa" stroke="#f97316" stroke-width="6"/>`)
    .join('');
  return `<svg class="route" width="${W * SLIDES.length}" height="${H}" viewBox="0 0 ${W * SLIDES.length} ${H}">
    <line x1="0" y1="${LINE_Y}" x2="${W * SLIDES.length}" y2="${LINE_Y}" stroke="#f97316" stroke-width="12" stroke-linecap="round"/>
    ${joins}${stops}</svg>`;
}

/** The home screen, rebuilt: the capture's widgets and icons on the app's dusk, its status bar redrawn. */
function homeScreen(shot) {
  const src = pathToFileURL(shot).href;
  // Each piece is cut a pixel inside its edge, so nothing of the old wallpaper comes with it.
  const crop = (x, y, w, h, r) =>
    `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;border-radius:${r}px;background:url('${src}') -${x}px -${y}px / ${W}px ${H}px;"></div>`;
  const widgets = HOME.widgets.map((b) => crop(b.x + 1, b.y + 1, b.w - 2, b.h - 2, HOME.radius - 1)).join('');
  // The icons a row lower, where the search bar was.
  const icons = HOME.icons
    .map((p) => {
      const r = HOME.iconR - 1;
      return `<div style="position:absolute;left:${p.x - r}px;top:${p.y + 150 - r}px;width:${2 * r}px;height:${2 * r}px;border-radius:50%;background:url('${src}') -${p.x - r}px -${p.y - r}px / ${W}px ${H}px;box-shadow:0 6px 18px rgba(0,0,0,0.25);"></div>`;
    })
    .join('');
  const tree = (cx, gy, s, fill) => `<g transform="translate(${cx} ${gy}) scale(${s})" fill="${fill}">
      <path d="M-1.5 2V-7L-7 -13H-4.5L0 -9L4.5 -13H7L1.5 -7V2Z"/>
      <ellipse cx="0" cy="-18" rx="21" ry="5.5"/><ellipse cx="-8" cy="-21.5" rx="11" ry="4.5"/><ellipse cx="8" cy="-22" rx="12" ry="4.5"/></g>`;
  const stars = Array.from({ length: 60 }, (_, i) => {
    const x = (i * 263 + 41) % W;
    const y = 30 + ((i * 151) % 1100);
    return `<circle cx="${x}" cy="${y}" r="${i % 6 === 0 ? 2.6 : 1.5}" fill="#fff" opacity="${0.25 + (i % 5) * 0.12}"/>`;
  }).join('');
  const wallpaper = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="position:absolute;inset:0">
    <defs>
      <linearGradient id="hs" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a1c3a"/><stop offset="0.38" stop-color="#3a3466"/><stop offset="0.62" stop-color="#7a4766"/><stop offset="0.78" stop-color="#e08a62"/></linearGradient>
      <radialGradient id="hg" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#ffcf9e" stop-opacity="0.7"/><stop offset="1" stop-color="#ffb37a" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#hs)"/>${stars}
    <circle cx="700" cy="1500" r="330" fill="url(#hg)"/><circle cx="700" cy="1500" r="120" fill="#ffc48f"/>
    <g fill="#5b4870"><path d="M790 1500 L794 1360 H812 L816 1500Z"/><path d="M834 1500 L838 1356 H856 L860 1500Z"/><path d="M878 1500 L882 1352 H900 L904 1500Z"/><path d="M772 1350 L930 1342 L924 1358 L776 1360Z"/></g>
    <path d="M0 1530 C 160 1470, 300 1500, 460 1488 S 760 1440, 900 1478 S 1040 1500, 1080 1490 V1920 H0Z" fill="#4b3f62"/>
    <path d="M0 1640 C 220 1590, 420 1625, 620 1608 S 960 1580, 1080 1612 V1920 H0Z" fill="#2c2440"/>
    ${tree(120, 1612, 4, '#2c2440')}${tree(960, 1602, 3.4, '#2c2440')}
    <path d="M0 1790 C 260 1750, 520 1770, 760 1758 S 1000 1745, 1080 1760 V1920 H0Z" fill="#17121f"/>
  </svg>`;
  const wifi = `<svg width="40" height="34" viewBox="0 0 24 20" fill="#fff"><path d="M12 19.5 1 7.6a15.6 15.6 0 0 1 22 0z"/></svg>`;
  const battery = `<svg width="70" height="34" viewBox="0 0 40 20"><rect x="1" y="2" width="33" height="16" rx="5" fill="#fff"/><rect x="35.5" y="7" width="3" height="6" rx="1.5" fill="#fff"/></svg>`;
  return `<div class="home">${wallpaper}
    <div class="status"><span>9:27</span><span class="sys">${wifi}${battery}</span></div>
    ${widgets}${icons}
    <div class="pill"></div></div>`;
}

/** "Know when to|{leave for class}": two lines, the braces' part in the accent colour. */
function head(text) {
  return text
    .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
    .replace(/\{(.+?)\}/, '<em>$1</em>')
    .replace('|', '<br>');
}

function page(index, lang, shot) {
  const slide = SLIDES[index];
  const k = SKIES[slide.sky];
  const words = slide[lang];
  const ink = k.dark ? '#f5f3f0' : '#1c1917';
  const muted = k.dark ? 'rgba(245,243,240,0.8)' : 'rgba(28,25,23,0.72)';
  const accent = k.dark ? '#fb923c' : '#9a3412';
  const zh = lang === 'zh';
  const face = zh ? `'PingFang SC', 'Hiragino Sans GB', sans-serif` : `'Space Grotesk', sans-serif`;
  const body = zh ? `'PingFang SC', 'Hiragino Sans GB', sans-serif` : `'Inter', sans-serif`;
  const screen = slide.home ? homeScreen(shot) : `<img src="${pathToFileURL(shot)}">`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face { font-family: 'Space Grotesk'; font-weight: 300 700; src: url('${pathToFileURL(join(fonts, 'space-grotesk-latin.woff2'))}') format('woff2'); }
    @font-face { font-family: 'Inter'; font-weight: 100 900; src: url('${pathToFileURL(join(fonts, 'inter-latin.woff2'))}') format('woff2'); }
    html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; position: relative; }
    #pano, .route { position: absolute; top: 0; left: -${index * W}px; }
    .words { position: absolute; top: 96px; left: 56px; right: 56px; text-align: center; color: ${ink}; }
    h1 { font-family: ${face}; font-weight: 700; font-size: ${zh ? 84 : 88}px; line-height: 1.08; letter-spacing: ${zh ? '0.01em' : '-0.025em'}; margin: 0; }
    h1 em { font-style: normal; color: ${accent}; }
    p { font-family: ${body}; font-weight: 500; font-size: ${zh ? 36 : 37}px; line-height: 1.35; color: ${muted}; margin: 24px auto 0; max-width: 940px; text-wrap: pretty; }
    /* A phone a little like the Pixel the captures are from: a thin dark bezel, round corners, the camera's punch hole, the keys on the right. */
    .phone { position: absolute; left: 50%; top: ${PHONE_TOP}px; transform: translateX(-50%); width: ${SCREEN_W}px; padding: 16px; border-radius: 80px;
      background: linear-gradient(145deg, #3a3a3e, #121214 45%, #26262a); box-shadow: 0 0 0 2px rgba(255,255,255,0.10) inset, 0 50px 90px rgba(10,12,30,0.35), 0 12px 30px rgba(10,12,30,0.22); }
    .phone::before, .phone::after { content: ''; position: absolute; right: -5px; width: 6px; border-radius: 0 4px 4px 0; background: linear-gradient(90deg, #1a1a1c, #3c3c40); }
    .phone::before { top: 240px; height: 88px; }
    .phone::after { top: 372px; height: 160px; }
    .screen { position: relative; width: ${SCREEN_W}px; height: ${SCREEN_H}px; border-radius: 64px; overflow: hidden; background: #000; line-height: 0; }
    .screen > img { width: ${SCREEN_W}px; height: ${SCREEN_H}px; display: block; }
    .screen::after { content: ''; position: absolute; top: 20px; left: 50%; width: 28px; height: 28px; margin-left: -14px; border-radius: 50%; background: #0b0b0c; box-shadow: 0 0 0 3px rgba(255,255,255,0.04); }
    .home { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; transform: scale(${SCREEN_W / W}); transform-origin: 0 0; line-height: normal; }
    .home .status { position: absolute; top: 38px; left: 75px; right: 80px; display: flex; justify-content: space-between; align-items: center; color: #fff; font: 500 40px 'Inter', sans-serif; letter-spacing: 0.01em; }
    .home .sys { display: flex; gap: 14px; align-items: center; }
    .home .pill { position: absolute; left: 50%; bottom: 28px; width: 284px; height: 10px; margin-left: -142px; border-radius: 5px; background: rgba(255,255,255,0.9); }
  </style></head><body>
    <canvas id="pano" width="${W * SLIDES.length}" height="${H}"></canvas>
    ${routeLine()}
    <div class="words"><h1>${head(words.head)}</h1><p>${words.sub}</p></div>
    <div class="phone"><div class="screen">${screen}</div></div>
    <script>${panoramaScript()}</script>
  </body></html>`;
}

function chrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  if (existsSync(cache)) {
    for (const d of readdirSync(cache)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort()
      .reverse()) {
      const bin = join(cache, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
      if (existsSync(bin)) return bin;
    }
  }
  const app = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(app)) return app;
  throw new Error('no Chromium: set CHROME to one');
}

const only = process.argv[2];
const bin = chrome();
const tmp = mkdtempSync(join(tmpdir(), 'terminus-frames-'));
try {
  SLIDES.forEach((slide, index) => {
    if (only && slide.file !== only) return;
    for (const lang of ['en', 'zh']) {
      const shot = join(here, 'captures', lang, `${slide.file}.png`);
      const outDir = join(here, 'screenshots', lang === 'en' ? '' : 'zh');
      mkdirSync(outDir, { recursive: true });
      const html = join(tmp, `${lang}-${slide.file}.html`);
      writeFileSync(html, page(index, lang, shot));
      const out = join(outDir, `${slide.file}.png`);
      execFileSync(
        bin,
        [
          '--headless',
          '--disable-gpu',
          '--hide-scrollbars',
          '--force-device-scale-factor=1',
          '--allow-file-access-from-files',
          '--virtual-time-budget=3000',
          `--window-size=${W},${H}`,
          `--screenshot=${out}`,
          pathToFileURL(html).href,
        ],
        { stdio: 'ignore' },
      );
      console.log(`wrote ${out}`);
    }
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
