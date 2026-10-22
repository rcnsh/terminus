// Frames the App Store screenshots as the Play set is framed
// (apps/android/store/frame.mjs): each capture from the simulator
// (captures/en, captures/zh, unchanged) inside an iPhone, under a headline.
// The five are one picture cut in five, as the App Store shows them side by
// side: the app's sky going from dawn to night along it, its hills, city and
// road running through, and shuttles, the setting sun and Marina Bay Sands
// crossing from one to the next. Writes screenshots/ and screenshots/zh/,
// 1320×2868 like the captures (the App Store's 6.9" iPhone size, which it
// scales for every smaller one).
//
// The landscape is the Play set's, drawn at the same scale across the width
// and sat at the bottom; the sky fills the taller page above it.
//
// The home screen's capture is rebuilt around its own pixels: the widgets and
// the app's icon as captured, on a wallpaper of the app's dusk, without the
// test runner's icon, the search pill and the dock. Its status bar is redrawn
// with the time the capture showed (2-widget.time, from capture.sh).
//
//   node apps/ios/store/frame.mjs            # all of them
//   node apps/ios/store/frame.mjs 3-map      # one, both languages
//
// Draws with Chromium, headless: CHROME if set, else Playwright's download
// (~/Library/Caches/ms-playwright), else Google Chrome. The Chinese uses the
// system's PingFang SC and the status bar SF Pro, so run it on a Mac.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fonts = join(here, '../../web/public/assets/fonts');
const W = 1320;
const H = 2868;
// The Play set's landscape is drawn for 1080 wide: scaled to this width and
// lowered to the bottom of the taller page.
const S = W / 1080;
const LAND_Y = H - 1920 * S;

// The words, in the listing's order: the Play set's, so both stores say the
// same. The headline is two lines, split at "|", so every phone sits at the
// same height; its part in braces is in the accent colour.
const SLIDES = [
  {
    file: '1-leave-by',
    sky: 'dawn',
    en: { head: 'Know when to|{leave for class}', sub: 'A countdown to setting off, and the bus to catch.' },
    zh: { head: '{什么时候出发}，|一看就知道', sub: '出发倒计时，还有该搭的那班巴士。' },
  },
  {
    file: '2-widget',
    sky: 'day',
    home: true,
    en: { head: 'Your buses,|{on the home screen}', sub: 'The next bus, and the buses near you, at a glance.' },
    zh: { head: '你的巴士，|就在{主屏幕上}', sub: '不用打开应用，就能看到下一班巴士和附近的巴士。' },
  },
  {
    file: '3-map',
    sky: 'golden',
    en: { head: 'Every bus,|{live on the map}', sub: 'Pick a service to see its line, its stops and its buses.' },
    zh: { head: '每辆巴士，|{地图上实时看}', sub: '选一条线路，看它的路线、车站和巴士。' },
  },
  {
    file: '4-buses',
    sky: 'dusk',
    en: { head: 'What’s coming|{at your stop}', sub: 'Every service’s next buses, live, and how full.' },
    zh: { head: '{你的车站}，|下一班什么时候到', sub: '每条线路的下一班巴士，实时到站，还有多挤。' },
  },
  {
    file: '5-on-the-bus',
    sky: 'night',
    // The card's "Updated" line under Today: it reads the phone's clock,
    // which a simulator can't move to the trip's morning, so it's covered in
    // the page's own colour (y and height in the capture's pixels).
    hide: { y: 2045, h: 70, colour: '#fafaf9' },
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

// Where the phones sit, and the iPhone's own proportions at this size: its
// corners, its bezel and the Dynamic Island, which a simulator's screenshot
// leaves out.
const SCREEN_W = 900;
const SCREEN_H = Math.round((SCREEN_W * H) / W);
const BEZEL = 20;
const PHONE_TOP = 600;
const SCREEN_R = 118;
const K = SCREEN_W / W;

// The home screen's capture (both languages lay it out alike): the two
// widgets and the app's icon, in its own pixels.
const HOME = {
  widgets: [
    { x: 95, y: 282, w: 1130, h: 530 },
    { x: 95, y: 934, w: 1130, h: 530 },
  ],
  radius: 82,
  icon: { x: 207, y: 1688, size: 196, r: 44 },
};

/**
 * The whole strip, five slides wide, drawn in the page with a canvas: each
 * slide's page shows its own fifth of it, so the hills, the road and the
 * shuttles carry on across the joins. The sky and the stars are drawn at this
 * page's size; the landscape is the Play set's drawing, scaled.
 */
function panoramaScript() {
  const phases = SLIDES.map((s) => SKIES[s.sky]);
  return `(() => {
  const P = ${JSON.stringify(phases)};
  const DW = ${W}, DH = ${H}, S = ${S}, LAND_Y = ${LAND_Y};
  const W = 1080, H = 1920, N = P.length, PW = W * N;
  const c = document.getElementById('pano');
  const g = c.getContext('2d');
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, t) => { const x = hex(a), y = hex(b); return 'rgb(' + x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(',') + ')'; };
  // How far along the day at x (in the drawing's units): whole numbers at the
  // slides' middles, easing from one to the next across the join.
  const at = (x) => {
    const f = Math.min(N - 1, Math.max(0, x / W - 0.5));
    const i = Math.min(N - 2, Math.floor(f)), t = f - i;
    const e = t < 0.25 ? 0 : t > 0.75 ? 1 : (t - 0.25) / 0.5;
    return [i, e * e * (3 - 2 * e)];
  };
  const col = (x, key, k) => { const [i, t] = at(x); const a = k === undefined ? P[i][key] : P[i][key][k], b = k === undefined ? P[i + 1][key] : P[i + 1][key][k]; return mix(a, b, t); };
  const dark = (x) => { const [i, t] = at(x); return (P[i].dark ? 1 : 0) * (1 - t) + (P[i + 1].dark ? 1 : 0) * t; };
  // The sky, in strips, its horizon where the landscape's is.
  const stops = [0, 0.35, 0.62, 0.8].map((o) => o === 0 ? 0 : (o * H * S + LAND_Y) / DH);
  for (let x = 0; x < DW * N; x += 4) {
    const gr = g.createLinearGradient(0, 0, 0, DH);
    stops.forEach((o, k) => gr.addColorStop(o, col((x + 2) / S, 's', k)));
    g.fillStyle = gr;
    g.fillRect(x, 0, 4, DH);
  }
  // Stars where it's dark: above the words, or beside the phones, never among them.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let n = 0; n < 640; n++) {
    const x = rnd() * DW * N, y = rnd() * (1380 * S + LAND_Y), local = x % DW;
    const words = y > 80 && y < 540 && local > 60 && local < DW - 60;
    const phone = y > ${PHONE_TOP - 40} && local > ${(W - SCREEN_W) / 2 - BEZEL - 40} && local < ${(W + SCREEN_W) / 2 + BEZEL + 40};
    const a = dark(x / S) * (0.35 + rnd() * 0.6);
    if (words || phone || a < 0.05) continue;
    g.fillStyle = 'rgba(255,255,255,' + a.toFixed(2) + ')';
    g.beginPath(); g.arc(x, y, rnd() < 0.15 ? 3.4 : 2.1, 0, 7); g.fill();
  }
  // From here on, the Play set's landscape in its own units.
  g.setTransform(S, 0, 0, S, 0, LAND_Y);
  // The sun rising beside the first phone, setting behind Marina Bay Sands across the fourth join; the moon over the last.
  const disc = (x, y, r, fill, glow) => {
    const gl = g.createRadialGradient(x, y, r * 0.6, x, y, r * 2.6);
    gl.addColorStop(0, glow); gl.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gl; g.beginPath(); g.arc(x, y, r * 2.6, 0, 7); g.fill();
    g.fillStyle = fill; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
  };
  disc(78, 1250, 58, '#fff1d6', 'rgba(255,241,214,0.45)');
  disc(4 * W - 30, 1440, 84, '#ffb37a', 'rgba(255,179,122,0.42)');
  disc(4 * W + 980, 1210, 40, '#fde9c9', 'rgba(253,233,201,0.25)');
  // The far hills, one ridge the whole way, in each hour's colour.
  const farY = (x) => 1478 + 26 * Math.sin(x / 233) + 14 * Math.sin(x / 91 + 1.3) + 10 * Math.sin(x / 611 + 0.4);
  const nearY = (x) => 1652 + 16 * Math.sin(x / 377 + 2) + 9 * Math.sin(x / 143);
  const band = (key) => { const gr = g.createLinearGradient(0, 0, PW, 0); for (let x = 0; x <= PW; x += 90) gr.addColorStop(x / PW, col(x, key)); return gr; };
  // The city on the far hills: Marina Bay Sands across the fourth join, towers here and there.
  g.fillStyle = band('city');
  const sands = (cx) => {
    const cy = farY(cx) + 6;
    for (const dx of [-52, -8, 36]) { g.beginPath(); g.moveTo(cx + dx, cy); g.lineTo(cx + dx + 4, cy - 110); g.lineTo(cx + dx + 20, cy - 110); g.lineTo(cx + dx + 24, cy); g.fill(); }
    g.beginPath(); g.moveTo(cx - 62, cy - 118); g.lineTo(cx + 104, cy - 124); g.lineTo(cx + 96, cy - 110); g.lineTo(cx - 58, cy - 110); g.fill();
  };
  sands(4 * W - 60);
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
  bus(2 * W - 123, false);
  bus(4 * W - 123, true);
})();`;
}

/** The home screen, rebuilt: the capture's widgets and icon on the app's dusk, its status bar redrawn. */
function homeScreen(shot, time) {
  const src = pathToFileURL(shot).href;
  // Each piece is cut a few pixels inside its edge, so nothing of the old wallpaper comes with it.
  const crop = (x, y, w, h, r, extra = '') =>
    `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;border-radius:${r}px;background:url('${src}') -${x}px -${y}px / ${W}px ${H}px;${extra}"></div>`;
  const widgets = HOME.widgets.map((b) => crop(b.x + 3, b.y + 3, b.w - 6, b.h - 6, HOME.radius - 3)).join('');
  const i = HOME.icon;
  const icon =
    crop(i.x - i.size / 2, i.y - i.size / 2, i.size, i.size, i.r, 'box-shadow:0 8px 22px rgba(0,0,0,0.28);') +
    `<div class="label" style="left:${i.x - 150}px;top:${i.y + i.size / 2 + 14}px">terminus</div>`;
  const tree = (cx, gy, s, fill) => `<g transform="translate(${cx} ${gy}) scale(${s})" fill="${fill}">
      <path d="M-1.5 2V-7L-7 -13H-4.5L0 -9L4.5 -13H7L1.5 -7V2Z"/>
      <ellipse cx="0" cy="-18" rx="21" ry="5.5"/><ellipse cx="-8" cy="-21.5" rx="11" ry="4.5"/><ellipse cx="8" cy="-22" rx="12" ry="4.5"/></g>`;
  const stars = Array.from({ length: 60 }, (_, n) => {
    const x = (n * 263 + 41) % 1080;
    const y = 30 + ((n * 151) % 1100);
    return `<circle cx="${x}" cy="${y}" r="${n % 6 === 0 ? 2.6 : 1.5}" fill="#fff" opacity="${0.25 + (n % 5) * 0.12}"/>`;
  }).join('');
  // The Play set's dusk wallpaper, drawn for 1080×1920 and filling this taller screen from the bottom.
  const wallpaper = `<svg width="${W}" height="${H}" viewBox="0 0 1080 1920" preserveAspectRatio="xMidYMax slice" style="position:absolute;inset:0">
    <defs>
      <linearGradient id="hs" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a1c3a"/><stop offset="0.38" stop-color="#3a3466"/><stop offset="0.62" stop-color="#7a4766"/><stop offset="0.78" stop-color="#e08a62"/></linearGradient>
      <radialGradient id="hg" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#ffcf9e" stop-opacity="0.7"/><stop offset="1" stop-color="#ffb37a" stop-opacity="0"/></radialGradient>
    </defs>
    <rect y="-1000" width="1080" height="2920" fill="#1a1c3a"/><rect width="1080" height="1920" fill="url(#hs)"/>${stars}
    <circle cx="700" cy="1500" r="330" fill="url(#hg)"/><circle cx="700" cy="1500" r="120" fill="#ffc48f"/>
    <g fill="#5b4870"><path d="M790 1500 L794 1360 H812 L816 1500Z"/><path d="M834 1500 L838 1356 H856 L860 1500Z"/><path d="M878 1500 L882 1352 H900 L904 1500Z"/><path d="M772 1350 L930 1342 L924 1358 L776 1360Z"/></g>
    <path d="M0 1530 C 160 1470, 300 1500, 460 1488 S 760 1440, 900 1478 S 1040 1500, 1080 1490 V1920 H0Z" fill="#4b3f62"/>
    <path d="M0 1640 C 220 1590, 420 1625, 620 1608 S 960 1580, 1080 1612 V1920 H0Z" fill="#2c2440"/>
    ${tree(120, 1612, 4, '#2c2440')}${tree(960, 1602, 3.4, '#2c2440')}
    <path d="M0 1790 C 260 1750, 520 1770, 760 1758 S 1000 1745, 1080 1760 V1920 H0Z" fill="#17121f"/>
  </svg>`;
  // The status bar as the simulator draws it: the time, then signal, Wi-Fi and a full battery.
  const bars = [0, 1, 2, 3]
    .map((n) => `<rect x="${n * 15}" y="${34 - (n + 1) * 8.5}" width="11" height="${(n + 1) * 8.5}" rx="3" fill="#fff"/>`)
    .join('');
  const sys = `<svg width="56" height="34" viewBox="0 0 56 34">${bars}</svg>
    <svg width="46" height="34" viewBox="0 0 24 18" fill="#fff"><path d="M12 17.5 8.6 13.9a4.8 4.8 0 0 1 6.8 0zM5.8 11a8.8 8.8 0 0 1 12.4 0l1.9-1.9a11.5 11.5 0 0 0-16.2 0zM2.2 7.4a13.9 13.9 0 0 1 19.6 0L23.7 5.5a16.6 16.6 0 0 0-23.4 0z"/></svg>
    <svg width="82" height="38" viewBox="0 0 41 19"><rect x="0.8" y="0.8" width="35" height="17.4" rx="5.4" fill="none" stroke="rgba(255,255,255,0.45)" stroke-width="1.6"/><rect x="3" y="3" width="30.6" height="13" rx="3.4" fill="#fff"/><rect x="37.6" y="6.2" width="2.6" height="6.6" rx="1.3" fill="rgba(255,255,255,0.45)"/></svg>`;
  return `<div class="home">${wallpaper}
    <div class="status"><span>${time}</span><span class="sys">${sys}</span></div>
    ${widgets}${icon}
    <div class="pill"></div></div>`;
}

/** "Know when to|{leave for class}": two lines, the braces' part in the accent colour. */
function head(text) {
  return text
    .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
    .replace(/\{(.+?)\}/, '<em>$1</em>')
    .replace('|', '<br>');
}

function page(index, lang) {
  const slide = SLIDES[index];
  const k = SKIES[slide.sky];
  const words = slide[lang];
  const ink = k.dark ? '#f5f3f0' : '#1c1917';
  const muted = k.dark ? 'rgba(245,243,240,0.8)' : 'rgba(28,25,23,0.72)';
  const accent = k.dark ? '#fb923c' : '#9a3412';
  const zh = lang === 'zh';
  const face = zh ? `'PingFang SC', 'Hiragino Sans GB', sans-serif` : `'Space Grotesk', sans-serif`;
  const body = zh ? `'PingFang SC', 'Hiragino Sans GB', sans-serif` : `'Inter', sans-serif`;
  // Every slide's phone, in the middle of its own fifth of the strip.
  const phones = SLIDES.map((s, i) => {
    const shot = join(here, 'captures', lang, `${s.file}.png`);
    const time = s.home ? readFileSync(join(here, 'captures', lang, `${s.file}.time`), 'utf8').trim() : '';
    const cover = s.hide
      ? `<div style="position:absolute;left:0;right:0;top:${s.hide.y * K}px;height:${s.hide.h * K}px;background:${s.hide.colour}"></div>`
      : '';
    const screen = s.home ? homeScreen(shot, time) : `<img src="${pathToFileURL(shot)}">${cover}`;
    const left = i * W + W / 2 - SCREEN_W / 2 - BEZEL;
    return `<div class="phone" style="left:${left}px"><div class="screen">${screen}</div></div>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face { font-family: 'Space Grotesk'; font-weight: 300 700; src: url('${pathToFileURL(join(fonts, 'space-grotesk-latin.woff2'))}') format('woff2'); }
    @font-face { font-family: 'Inter'; font-weight: 100 900; src: url('${pathToFileURL(join(fonts, 'inter-latin.woff2'))}') format('woff2'); }
    html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; position: relative; }
    .world { position: absolute; top: 0; left: -${index * W}px; width: ${W * SLIDES.length}px; height: ${H}px; }
    #pano { position: absolute; top: 0; left: 0; }
    .words { position: absolute; top: 132px; left: 68px; right: 68px; text-align: center; color: ${ink}; }
    h1 { font-family: ${face}; font-weight: 700; font-size: ${zh ? 103 : 108}px; line-height: 1.08; letter-spacing: ${zh ? '0.01em' : '-0.025em'}; margin: 0; }
    h1 em { font-style: normal; color: ${accent}; }
    p { font-family: ${body}; font-weight: 500; font-size: ${zh ? 44 : 45}px; line-height: 1.35; color: ${muted}; margin: 30px auto 0; max-width: 1150px; text-wrap: pretty; }
    /* An iPhone: a thin titanium-dark band, the screen's round corners, the Action button and volume keys on the left, the side button on the right. */
    .phone { position: absolute; top: ${PHONE_TOP}px; width: ${SCREEN_W}px; padding: ${BEZEL}px; border-radius: ${SCREEN_R + BEZEL}px;
      background: linear-gradient(145deg, #4a4a4f, #151517 40%, #2c2c30); box-shadow: 0 0 0 3px #5a5a60 inset, 0 0 0 7px #0d0d0f inset, 0 60px 110px rgba(10,12,30,0.35), 0 14px 36px rgba(10,12,30,0.22); }
    .phone::before, .phone::after { content: ''; position: absolute; width: 7px; background: linear-gradient(90deg, #2a2a2e, #4a4a50); }
    .phone::before { left: -6px; top: 300px; height: 70px; border-radius: 4px 0 0 4px;
      box-shadow: 0 130px 0 0 #3a3a3f, 0 260px 0 0 #3a3a3f; }
    .phone::after { right: -6px; top: 420px; height: 190px; border-radius: 0 4px 4px 0; }
    .screen { position: relative; width: ${SCREEN_W}px; height: ${SCREEN_H}px; border-radius: ${SCREEN_R}px; overflow: hidden; background: #000; line-height: 0; }
    .screen > img { width: ${SCREEN_W}px; height: ${SCREEN_H}px; display: block; }
    .screen::after { content: ''; position: absolute; top: ${Math.round(33 * K)}px; left: 50%; width: ${Math.round(378 * K)}px; height: ${Math.round(111 * K)}px; margin-left: -${Math.round(189 * K)}px; border-radius: ${Math.round(56 * K)}px; background: #050506; }
    .home { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; transform: scale(${K}); transform-origin: 0 0; line-height: normal; overflow: hidden; }
    .home .status { position: absolute; top: 66px; left: 150px; right: 120px; height: 62px; display: flex; justify-content: space-between; align-items: center; color: #fff; font: 600 52px -apple-system, 'SF Pro Text', sans-serif; letter-spacing: 0.01em; }
    .home .sys { display: flex; gap: 14px; align-items: center; }
    .home .label { position: absolute; width: 300px; text-align: center; color: #fff; font: 500 36px -apple-system, 'SF Pro Text', sans-serif; text-shadow: 0 1px 4px rgba(0,0,0,0.35); }
    .home .pill { position: absolute; left: 50%; bottom: 24px; width: 420px; height: 15px; margin-left: -210px; border-radius: 8px; background: rgba(255,255,255,0.9); }
  </style></head><body>
    <div class="world"><canvas id="pano" width="${W * SLIDES.length}" height="${H}"></canvas>${phones}</div>
    <div class="words"><h1>${head(words.head)}</h1><p>${words.sub}</p></div>
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
      const outDir = join(here, 'screenshots', lang === 'en' ? '' : 'zh');
      mkdirSync(outDir, { recursive: true });
      const html = join(tmp, `${lang}-${slide.file}.html`);
      writeFileSync(html, page(index, lang));
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
