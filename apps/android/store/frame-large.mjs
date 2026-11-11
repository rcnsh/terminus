// Frames the Play Store's tablet screenshots, the same way frame.mjs frames
// the phone's: each capture inside the device it came from, under a headline,
// the four slides one picture cut in four, the sky going from dawn to night.
//
// Two sets, one per slot in Play Console:
// - tablet: the Pixel Tablet emulator landscape (2560×1600 captures) for the
//   10-inch slot, drawn 2560×1440 (16:9, the shape Play asks for).
// - fold: the Pixel 10 Pro Fold emulator open (2076×2152 captures) for the
//   7-inch slot, drawn 1440×2560 (9:16).
// Captures in captures/<set>/{en,zh}, slides to screenshots/<set>/ and
// screenshots/<set>/zh/. Each is laid out in CSS pixels at 3/4 of its size and
// drawn at a device scale factor of 4/3, so the captures keep their detail.
//
//   node apps/android/store/frame-large.mjs              # both sets
//   node apps/android/store/frame-large.mjs tablet       # one set
//   node apps/android/store/frame-large.mjs fold 2-map   # one slide, both languages
//
// Draws with Chromium, as frame.mjs does, and needs a Mac for the Chinese.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SKIES, chrome, head } from './frame.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fonts = join(here, '../../web/public/assets/fonts');
const SCALE = 4 / 3;

// The words, in the listing's order. A headline is two lines split at "|" on
// the fold, one line on the tablet; its part in braces is in the accent colour.
const SLIDES = [
  {
    file: '1-leave-by',
    sky: 'dawn',
    en: { head: 'Know when to|{leave for class}', sub: 'Your trip on one side, your day on the other.' },
    zh: { head: '{什么时候出发}，|一看就知道', sub: '一边是这趟行程，一边是你的一天。' },
  },
  {
    file: '2-map',
    sky: 'golden',
    en: { head: 'Every bus,|{live on the map}', sub: 'Pick a service to see its line, its stops and its buses.' },
    zh: { head: '每辆巴士，|{地图上实时看}', sub: '选一条线路，看它的路线、车站和巴士。' },
  },
  {
    file: '3-stops',
    sky: 'dusk',
    en: { head: 'What’s coming|{at your stop}', sub: 'Pin your stops: every service’s next buses, live.' },
    zh: { head: '{你的车站}，|下一班什么时候到', sub: '固定常用的车站，看每条线路的下一班巴士，实时到站。' },
  },
  {
    file: '4-line',
    sky: 'night',
    en: { head: 'Every bus|{along its line}', sub: 'Open a service to see where each of its buses is.' },
    zh: { head: '{每条线路}，|巴士开到哪了', sub: '打开一条线路，看它的每辆巴士开到了哪一站。' },
  },
];

// Each set's page (W×H CSS pixels), its capture's size, where the device's
// screen sits (top, width), and how big the scenery is drawn.
const SETS = {
  tablet: {
    W: 1920,
    H: 1080,
    capture: [2560, 1600],
    top: 236,
    screenW: 1264,
    bezel: 22,
    radius: 46,
    oneLine: true,
    words: { top: 52, h1: 70, h1zh: 66, sub: 30, subzh: 29, gap: 14 },
    scenery: 0.75,
  },
  fold: {
    W: 1080,
    H: 1920,
    capture: [2076, 2152],
    top: 476,
    screenW: 960,
    bezel: 18,
    radius: 46,
    oneLine: false,
    words: { top: 96, h1: 88, h1zh: 84, sub: 37, subzh: 36, gap: 24 },
    scenery: 1,
  },
};

/**
 * The strip, as wide as all four slides, in the app's skies: the sun rising
 * on the first, a shuttle across the first join, Marina Bay Sands and the
 * setting sun across the third with a lit shuttle under them, the moon over
 * the last. Heights count up from the foot of the page, scaled by `s`.
 */
function panoramaScript(set, device) {
  const phases = SLIDES.map((sl) => SKIES[sl.sky]);
  return `(() => {
  const P = ${JSON.stringify(phases)};
  const W = ${set.W}, H = ${set.H}, N = P.length, PW = W * N, s = ${set.scenery};
  const D = ${JSON.stringify(device)}, WORDS = ${set.words.top + 260 * set.scenery};
  const c = document.getElementById('pano');
  const g = c.getContext('2d');
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, t) => { const x = hex(a), y = hex(b); return 'rgb(' + x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(',') + ')'; };
  const at = (x) => {
    const f = Math.min(N - 1, Math.max(0, x / W - 0.5));
    const i = Math.min(N - 2, Math.floor(f)), t = f - i;
    const e = t < 0.25 ? 0 : t > 0.75 ? 1 : (t - 0.25) / 0.5;
    return [i, e * e * (3 - 2 * e)];
  };
  const col = (x, key, k) => { const [i, t] = at(x); const a = k === undefined ? P[i][key] : P[i][key][k], b = k === undefined ? P[i + 1][key] : P[i + 1][key][k]; return mix(a, b, t); };
  const dark = (x) => { const [i, t] = at(x); return (P[i].dark ? 1 : 0) * (1 - t) + (P[i + 1].dark ? 1 : 0) * t; };
  const up = (y) => H - y * s;
  for (let x = 0; x < PW; x += 4) {
    const gr = g.createLinearGradient(0, 0, 0, H);
    [0, 0.35, 0.62, 0.8].forEach((o, k) => gr.addColorStop(o, col(x + 2, 's', k)));
    g.fillStyle = gr;
    g.fillRect(x, 0, 5, H);
  }
  // Stars where it's dark, clear of the words and the device.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let n = 0; n < 420; n++) {
    const x = rnd() * PW, y = rnd() * up(540), local = x % W;
    const words = y < WORDS && local > 40 && local < W - 40;
    const dev = y > D.top - 30 && local > D.left - 30 && local < D.left + D.width + 30;
    const a = dark(x) * (0.35 + rnd() * 0.6);
    if (words || dev || a < 0.05) continue;
    g.fillStyle = 'rgba(255,255,255,' + a.toFixed(2) + ')';
    g.beginPath(); g.arc(x, y, (rnd() < 0.15 ? 2.8 : 1.7) * s, 0, 7); g.fill();
  }
  const disc = (x, y, r, fill, glow) => {
    const gl = g.createRadialGradient(x, y, r * 0.6, x, y, r * 2.6);
    gl.addColorStop(0, glow); gl.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gl; g.beginPath(); g.arc(x, y, r * 2.6, 0, 7); g.fill();
    g.fillStyle = fill; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
  };
  disc(78 * s, up(670), 58 * s, '#fff1d6', 'rgba(255,241,214,0.45)');
  disc(3 * W - 30 * s, up(480), 84 * s, '#ffb37a', 'rgba(255,179,122,0.42)');
  disc(4 * W - 100 * s, up(710), 40 * s, '#fde9c9', 'rgba(253,233,201,0.25)');
  const farY = (x) => up(442) + s * (26 * Math.sin(x / 233 / s) + 14 * Math.sin(x / 91 / s + 1.3) + 10 * Math.sin(x / 611 / s + 0.4));
  const nearY = (x) => up(268) + s * (16 * Math.sin(x / 377 / s + 2) + 9 * Math.sin(x / 143 / s));
  const band = (key) => { const gr = g.createLinearGradient(0, 0, PW, 0); for (let x = 0; x <= PW; x += 90) gr.addColorStop(x / PW, col(x, key)); return gr; };
  g.fillStyle = band('city');
  const sands = (cx) => {
    const cy = farY(cx) + 6 * s;
    for (const dx of [-52, -8, 36]) { g.beginPath(); g.moveTo(cx + dx * s, cy); g.lineTo(cx + (dx + 4) * s, cy - 110 * s); g.lineTo(cx + (dx + 20) * s, cy - 110 * s); g.lineTo(cx + (dx + 24) * s, cy); g.fill(); }
    g.beginPath(); g.moveTo(cx - 62 * s, cy - 118 * s); g.lineTo(cx + 104 * s, cy - 124 * s); g.lineTo(cx + 96 * s, cy - 110 * s); g.lineTo(cx - 58 * s, cy - 110 * s); g.fill();
  };
  sands(3 * W - 60 * s);
  for (const [f, w, h] of [[0.06, 46, 70], [0.96, 60, 96], [1.04, 34, 58], [1.9, 50, 80], [2.55, 70, 110], [2.62, 36, 64], [3.4, 54, 84]]) { const x = f * W; g.fillRect(x, farY(x) - (h - 8) * s, w * s, h * s); }
  g.fillStyle = band('far');
  g.beginPath(); g.moveTo(0, H); for (let x = 0; x <= PW; x += 6) g.lineTo(x, farY(x)); g.lineTo(PW, H); g.fill();
  g.fillStyle = band('tree');
  const tree = (cx, k) => {
    const gy = nearY(cx) + 4 * s;
    g.save(); g.translate(cx, gy); g.scale(k * s, k * s);
    g.beginPath(); g.moveTo(-1.5, 2); g.lineTo(-1.5, -7); g.lineTo(-7, -13); g.lineTo(-4.5, -13); g.lineTo(0, -9); g.lineTo(4.5, -13); g.lineTo(7, -13); g.lineTo(1.5, -7); g.lineTo(1.5, 2); g.fill();
    for (const [x, y, rx, ry] of [[0, -18, 21, 5.5], [-8, -21.5, 11, 4.5], [8, -22, 12, 4.5]]) { g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, 7); g.fill(); }
    g.restore();
  };
  for (const [f, k] of [[0.06, 3.4], [0.94, 2.6], [1.06, 3.2], [1.95, 3], [2.08, 2.4], [2.9, 2.8], [3.08, 3.6], [3.95, 3]]) tree(f * W, k);
  { const fx = W - 80 * s, fy = nearY(fx); g.fillStyle = band('tree'); g.fillRect(fx - 2 * s, fy - 120 * s, 4 * s, 124 * s); g.fillStyle = '#ef3340'; g.fillRect(fx + 2 * s, fy - 120 * s, 52 * s, 17 * s); g.fillStyle = '#f2efeb'; g.fillRect(fx + 2 * s, fy - 103 * s, 52 * s, 17 * s); }
  g.fillStyle = band('ground');
  g.beginPath(); g.moveTo(0, H); for (let x = 0; x <= PW; x += 6) g.lineTo(x, nearY(x)); g.lineTo(PW, H); g.fill();
  g.fillStyle = band('road');
  for (let x = 12 * s; x < PW; x += 84 * s) { g.beginPath(); g.roundRect(x, up(54), 46 * s, 7 * s, 3.5 * s); g.fill(); }
  const bus = (x, lit) => {
    g.save(); g.translate(x, up(54)); g.scale(0.82 * s, 0.82 * s); g.translate(0, -84);
    const w = 300, h = 82;
    if (lit) { const b = g.createLinearGradient(w, 0, w + 260, 0); b.addColorStop(0, 'rgba(254,243,199,0.55)'); b.addColorStop(1, 'rgba(254,243,199,0)'); g.fillStyle = b; g.beginPath(); g.moveTo(w - 4, 46); g.lineTo(w + 260, 20); g.lineTo(w + 260, 82); g.closePath(); g.fill(); }
    g.fillStyle = '#24211e'; g.beginPath(); g.roundRect(0, 0, w, h, [16, 26, 10, 10]); g.fill();
    g.fillStyle = '#d32f2f'; g.fillRect(6, 50, w - 12, 10);
    g.fillStyle = lit ? '#fde9c9' : '#cfe0f0';
    for (let i = 0; i < 6; i++) { g.beginPath(); g.roundRect(18 + i * 42, 12, 32, 28, 5); g.fill(); }
    g.beginPath(); g.roundRect(w - 34, 12, 24, 34, [5, 14, 5, 5]); g.fill();
    g.fillStyle = lit ? '#fef3c7' : '#8a847d'; g.beginPath(); g.arc(w - 6, 66, 6, 0, 7); g.fill();
    g.fillStyle = lit ? '#ef4444' : '#7f1d1d'; g.fillRect(1, 62, 6, 10);
    for (const cx of [62, w - 64]) { g.fillStyle = '#151311'; g.beginPath(); g.arc(cx, h, 20, 0, 7); g.fill(); g.fillStyle = '#8a847d'; g.beginPath(); g.arc(cx, h, 8, 0, 7); g.fill(); }
    g.restore();
  };
  bus(W - 123 * s, false);
  bus(3 * W - 123 * s, true);
})();`;
}

function page(set, name, index, lang) {
  const slide = SLIDES[index];
  const k = SKIES[slide.sky];
  const words = slide[lang];
  const zh = lang === 'zh';
  const ink = k.dark ? '#f5f3f0' : '#1c1917';
  const muted = k.dark ? 'rgba(245,243,240,0.8)' : 'rgba(28,25,23,0.72)';
  const accent = k.dark ? '#fb923c' : '#9a3412';
  const face = zh ? `'PingFang SC', 'Hiragino Sans GB', sans-serif` : `'Space Grotesk', sans-serif`;
  const body = zh ? `'PingFang SC', 'Hiragino Sans GB', sans-serif` : `'Inter', sans-serif`;
  const [cw, ch] = set.capture;
  const sw = set.screenW;
  const sh = Math.round((sw * ch) / cw);
  const dw = sw + 2 * set.bezel;
  const left = Math.round(set.W / 2 - dw / 2);
  const device = { top: set.top, left, width: dw };
  const line = set.oneLine ? words.head.replace('|', zh ? '' : ' ') : words.head;
  const devices = SLIDES.map((s, i) => {
    const shot = join(here, 'captures', name, lang, `${s.file}.png`);
    return `<div class="device" style="left:${i * set.W + left}px"><div class="screen"><img src="${pathToFileURL(shot)}"></div></div>`;
  }).join('');
  const w = set.words;
  // The fold's crease: a faint line down the middle of its inner screen, as the real one catches the light.
  const crease =
    name === 'fold'
      ? `.screen::after { content: ''; position: absolute; top: 0; bottom: 0; left: 50%; width: 10px; margin-left: -5px; background: linear-gradient(90deg, rgba(0,0,0,0), rgba(0,0,0,0.05) 40%, rgba(255,255,255,0.06) 60%, rgba(0,0,0,0)); }`
      : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face { font-family: 'Space Grotesk'; font-weight: 300 700; src: url('${pathToFileURL(join(fonts, 'space-grotesk-latin.woff2'))}') format('woff2'); }
    @font-face { font-family: 'Inter'; font-weight: 100 900; src: url('${pathToFileURL(join(fonts, 'inter-latin.woff2'))}') format('woff2'); }
    html, body { margin: 0; width: ${set.W}px; height: ${set.H}px; overflow: hidden; position: relative; }
    .world { position: absolute; top: 0; left: -${index * set.W}px; width: ${set.W * SLIDES.length}px; height: ${set.H}px; }
    #pano { position: absolute; top: 0; left: 0; width: ${set.W * SLIDES.length}px; height: ${set.H}px; }
    .words { position: absolute; top: ${w.top}px; left: 56px; right: 56px; text-align: center; color: ${ink}; }
    h1 { font-family: ${face}; font-weight: 700; font-size: ${zh ? w.h1zh : w.h1}px; line-height: 1.08; letter-spacing: ${zh ? '0.01em' : '-0.025em'}; margin: 0; }
    h1 em { font-style: normal; color: ${accent}; }
    p { font-family: ${body}; font-weight: 500; font-size: ${zh ? w.subzh : w.sub}px; line-height: 1.35; color: ${muted}; margin: ${w.gap}px auto 0; max-width: 940px; text-wrap: pretty; }
    .device { position: absolute; top: ${set.top}px; width: ${sw}px; padding: ${set.bezel}px; border-radius: ${set.radius}px;
      background: linear-gradient(145deg, #3a3a3e, #121214 45%, #26262a); box-shadow: 0 0 0 2px rgba(255,255,255,0.10) inset, 0 40px 80px rgba(10,12,30,0.35), 0 12px 30px rgba(10,12,30,0.22); }
    .screen { position: relative; width: ${sw}px; height: ${sh}px; border-radius: ${set.radius - set.bezel}px; overflow: hidden; background: #000; line-height: 0; }
    .screen > img { width: ${sw}px; height: ${sh}px; display: block; }
    ${crease}
  </style></head><body>
    <div class="world"><canvas id="pano" width="${Math.round(set.W * SLIDES.length * SCALE)}" height="${Math.round(set.H * SCALE)}"></canvas>${devices}</div>
    <div class="words"><h1>${head(line)}</h1><p>${words.sub}</p></div>
    <script>document.getElementById('pano').getContext('2d').scale(${SCALE}, ${SCALE});${panoramaScript(set, device)}</script>
  </body></html>`;
}

const [onlySet, onlySlide] = process.argv.slice(2);
const bin = chrome();
const tmp = mkdtempSync(join(tmpdir(), 'terminus-frames-'));
try {
  for (const [name, set] of Object.entries(SETS)) {
    if (onlySet && onlySet !== name) continue;
    SLIDES.forEach((slide, index) => {
      if (onlySlide && slide.file !== onlySlide) return;
      for (const lang of ['en', 'zh']) {
        const outDir = join(here, 'screenshots', name, lang === 'en' ? '' : 'zh');
        mkdirSync(outDir, { recursive: true });
        const html = join(tmp, `${name}-${lang}-${slide.file}.html`);
        writeFileSync(html, page(set, name, index, lang));
        const out = join(outDir, `${slide.file}.png`);
        execFileSync(
          bin,
          [
            '--headless',
            '--disable-gpu',
            '--hide-scrollbars',
            `--force-device-scale-factor=${SCALE}`,
            '--allow-file-access-from-files',
            '--virtual-time-budget=3000',
            `--window-size=${set.W},${set.H}`,
            `--screenshot=${out}`,
            pathToFileURL(html).href,
          ],
          { stdio: 'ignore' },
        );
        console.log(`wrote ${out}`);
      }
    });
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
