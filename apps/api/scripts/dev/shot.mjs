import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    width: { type: 'string', default: '1280' },
    height: { type: 'string', default: '860' },
    scheme: { type: 'string', default: 'light' },
    wait: { type: 'string' },
    operator: { type: 'string' },
    full: { type: 'boolean', default: false },
  },
});
const ANIMATIONS_AND_FONTS_MS = 1_000;
const [url, out] = positionals;
if (!url || !out) {
  console.error(
    'usage: shot.mjs <url> <out.png> [--width N] [--height N] [--scheme dark|light] [--wait selector] [--operator token] [--full]',
  );
  process.exit(1);
}
if (!['dark', 'light'].includes(o.scheme)) {
  console.error('--scheme is dark or light');
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: Number(o.width), height: Number(o.height) },
    colorScheme: o.scheme,
  });
  if (o.operator) {
    await context.addInitScript((token) => sessionStorage.setItem('terminus-operator-token', token), o.operator);
  }
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(url);
  if (o.wait) await page.waitForSelector(o.wait, { timeout: 60_000 });
  await page.waitForTimeout(ANIMATIONS_AND_FONTS_MS);
  await page.screenshot({ path: out, fullPage: o.full });
  console.log(out);
} finally {
  await browser.close();
}
