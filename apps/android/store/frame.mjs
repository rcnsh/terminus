// Frames the Play Store screenshots: each capture from the emulator
// (captures/en, captures/zh, unchanged) inside a phone, under a headline,
// against the app's own sky at a different hour of the day, from dawn to
// night. Writes screenshots/ and screenshots/zh/, 1080×1920 like the
// captures (Play's phone limit is a 2:1 ratio).
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
// accent colour; the Chinese follows the app's glossary (src/i18n.ts).
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
    en: { head: 'With you|{all the way}', sub: 'On the bus: the next stop, and when you’ll get there.' },
    zh: { head: '上车以后，|{一路}都在身边', sub: '在车上：下一站是哪里，什么时候到。' },
  },
];

// The skies of apps/web/public/assets/sky.css (light), and night's from the
// dark one: top to horizon, the far hills, the trees, the city, the sun.
const SKIES = {
  dawn: { s: ['#8fc1e8', '#b7d6ee', '#f1d6c2', '#f7c9a4'], far: '#b3b0c3', tree: '#6a7568', city: '#cfc8d8', sun: '#fff1d6', dark: false },
  day: { s: ['#5ea8e5', '#8ec4ec', '#c7e2f4', '#e3f0f8'], far: '#9fbcae', tree: '#4f6f58', city: '#b7cbd9', sun: null, dark: false },
  golden: {
    s: ['#78aadb', '#a7c3dc', '#f0cf9c', '#f4b46c'],
    far: '#c4a983',
    tree: '#5e5a42',
    city: '#dcc6a2',
    sun: '#ffe2a8',
    dark: false,
  },
  dusk: { s: ['#2c3566', '#4a4275', '#6c4260', '#e08a62'], far: '#4b3f62', tree: '#2c2440', city: '#7d6a90', sun: '#ffb37a', dark: true },
  night: { s: ['#121a33', '#181a30', '#24243a', '#2e2a44'], far: '#3a3550', tree: '#5b5568', city: '#45405f', sun: null, dark: true },
};

/** The horizon along the bottom, as the app draws it (sky.js Horizon), scaled up: hills, the city, rain trees, the flag, the road. */
function horizon(k) {
  const w = W;
  // Gentle hills, as smooth curves across the width.
  const far = `M0 1500 C 180 1440, 320 1470, 470 1452 S 760 1400, 900 1440 S 1040 1470, 1080 1455 V1920 H0 Z`;
  const near = `M0 1640 C 200 1600, 380 1625, 560 1612 S 900 1590, 1080 1620 V1920 H0 Z`;
  // Marina Bay Sands on the far hill, right of centre.
  const cx = 840;
  const cy = 1432;
  const city = [-52, -8, 36]
    .map((x) => `<path d="M${cx + x} ${cy} L${cx + x + 4} ${cy - 104} H${cx + x + 20} L${cx + x + 24} ${cy} Z"/>`)
    .join('');
  const deck = `<path d="M${cx - 60} ${cy - 112} L${cx + 100} ${cy - 117} L${cx + 92} ${cy - 104} H${cx - 56} Z"/>`;
  const tree = (c, g, s) => `<g transform="translate(${c} ${g}) scale(${s})">
      <path d="M-1.5 2V-7L-7 -13H-4.5L0 -9L4.5 -13H7L1.5 -7V2Z"/>
      <ellipse cx="0" cy="-18" rx="21" ry="5.5"/><ellipse cx="-8" cy="-21.5" rx="11" ry="4.5"/><ellipse cx="8" cy="-22" rx="12" ry="4.5"/>
    </g>`;
  // Low over the hills, right of the phone, where it isn't hidden.
  const sun = k.sun ? `<circle cx="1012" cy="1418" r="${k.dark ? 70 : 56}" fill="${k.sun}" opacity="0.95"/>` : '';
  const stars = k.dark
    ? Array.from({ length: 46 }, (_, i) => {
        // Fixed, scattered: the same picture every run.
        const x = (i * 211 + 37) % w;
        // Above the headline, or beside the phone below it; never among the words.
        const y = i % 3 === 0 ? 20 + ((i * 37) % 70) : 470 + ((i * 137) % 860);
        return `<circle cx="${x}" cy="${y}" r="${i % 5 === 0 ? 2.6 : 1.6}" fill="#fff" opacity="${0.35 + (i % 4) * 0.15}"/>`;
      }).join('')
    : '';
  const moon = k.s[0] === '#121a33' ? `<circle cx="78" cy="1330" r="40" fill="#fde9c9"/>` : '';
  const road = Array.from({ length: 14 }, (_, i) => `<rect x="${i * 84 + 10}" y="1868" width="44" height="6" rx="3"/>`).join('');
  const ground = k.dark ? '#1c1a24' : '#fafaf9';
  const roadInk = k.dark ? '#3a3542' : '#d6cfc7';
  return `<svg class="sky" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${k.s[0]}"/><stop offset="0.35" stop-color="${k.s[1]}"/>
      <stop offset="0.62" stop-color="${k.s[2]}"/><stop offset="0.8" stop-color="${k.s[3]}"/></linearGradient></defs>
    <rect width="${w}" height="${H}" fill="url(#g)"/>
    ${stars}${moon}${sun}
    <g fill="${k.city}">${city}${deck}</g>
    <path d="${far}" fill="${k.far}"/>
    <g fill="${k.tree}">${tree(70, 1630, 3.4)}${tree(1010, 1640, 3)}</g>
    <path d="${near}" fill="${ground}"/>
    <g fill="${roadInk}">${road}</g>
  </svg>`;
}

/** "Know when to|{leave for class}": two lines, the braces' part in the accent colour. */
function head(text) {
  return text
    .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
    .replace(/\{(.+?)\}/, '<em>$1</em>')
    .replace('|', '<br>');
}

function page(slide, lang, shot) {
  const k = SKIES[slide.sky];
  const words = slide[lang];
  const ink = k.dark ? '#f5f3f0' : '#1c1917';
  const muted = k.dark ? 'rgba(245,243,240,0.78)' : 'rgba(28,25,23,0.72)';
  const accent = k.dark ? '#fb923c' : '#9a3412';
  const zh = lang === 'zh';
  const face = zh ? `'PingFang SC', 'Hiragino Sans GB', sans-serif` : `'Space Grotesk', sans-serif`;
  const body = zh ? `'PingFang SC', 'Hiragino Sans GB', sans-serif` : `'Inter', sans-serif`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face { font-family: 'Space Grotesk'; font-weight: 300 700; src: url('${pathToFileURL(join(fonts, 'space-grotesk-latin.woff2'))}') format('woff2'); }
    @font-face { font-family: 'Inter'; font-weight: 100 900; src: url('${pathToFileURL(join(fonts, 'inter-latin.woff2'))}') format('woff2'); }
    html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; }
    .sky { position: absolute; inset: 0; }
    .words { position: absolute; top: 112px; left: 56px; right: 56px; text-align: center; color: ${ink}; }
    h1 { font-family: ${face}; font-weight: 700; font-size: ${zh ? 84 : 88}px; line-height: 1.08; letter-spacing: ${zh ? '0.01em' : '-0.025em'}; margin: 0; }
    h1 em { font-style: normal; color: ${accent}; }
    p { font-family: ${body}; font-weight: 500; font-size: ${zh ? 36 : 37}px; line-height: 1.35; color: ${muted}; margin: 26px auto 0; max-width: 940px; text-wrap: pretty; }
    /* A phone a little like the Pixel the captures are from: a thin dark bezel, round corners, the camera's punch hole. */
    .phone { position: absolute; left: 50%; top: 452px; transform: translateX(-50%); width: 744px; padding: 16px; border-radius: 84px;
      background: linear-gradient(145deg, #3a3a3e, #121214 45%, #26262a); box-shadow: 0 0 0 2px rgba(255,255,255,0.10) inset, 0 50px 90px rgba(10,12,30,0.35), 0 12px 30px rgba(10,12,30,0.22); }
    /* The power and volume keys on the right edge. */
    .phone::before, .phone::after { content: ''; position: absolute; right: -5px; width: 6px; border-radius: 0 4px 4px 0; background: linear-gradient(90deg, #1a1a1c, #3c3c40); }
    .phone::before { top: 250px; height: 92px; }
    .phone::after { top: 390px; height: 170px; }
    .screen { position: relative; border-radius: 68px; overflow: hidden; background: #000; line-height: 0; }
    .screen img { width: 744px; height: ${Math.round((744 * H) / W)}px; display: block; }
    .screen::after { content: ''; position: absolute; top: 22px; left: 50%; width: 30px; height: 30px; margin-left: -15px; border-radius: 50%; background: #0b0b0c; box-shadow: 0 0 0 3px rgba(255,255,255,0.04); }
  </style></head><body>
    ${horizon(k)}
    <div class="words"><h1>${head(words.head)}</h1><p>${words.sub}</p></div>
    <div class="phone"><div class="screen"><img src="${pathToFileURL(shot)}"></div></div>
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
  for (const slide of SLIDES.filter((s) => !only || s.file === only)) {
    for (const lang of ['en', 'zh']) {
      const shot = join(here, 'captures', lang, `${slide.file}.png`);
      const outDir = join(here, 'screenshots', lang === 'en' ? '' : 'zh');
      mkdirSync(outDir, { recursive: true });
      const html = join(tmp, `${lang}-${slide.file}.html`);
      writeFileSync(html, page(slide, lang, shot));
      const out = join(outDir, `${slide.file}.png`);
      execFileSync(
        bin,
        [
          '--headless',
          '--disable-gpu',
          '--hide-scrollbars',
          '--force-device-scale-factor=1',
          '--allow-file-access-from-files',
          '--virtual-time-budget=2000',
          `--window-size=${W},${H}`,
          `--screenshot=${out}`,
          pathToFileURL(html).href,
        ],
        { stdio: 'ignore' },
      );
      console.log(`wrote ${out}`);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
