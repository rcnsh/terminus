/**
 * A screenshot of a page, for checking a web UI change against the dev stub
 * (dev-stub.mjs, docs/agents/dev-stub.md) in headless Chromium.
 *
 *   node apps/api/scripts/dev/shot.mjs http://localhost:8787/app/ /tmp/app.png \
 *     [--width 1280] [--height 860] [--scheme dark|light] [--wait <selector>] \
 *     [--operator dev] [--full]
 *
 * --operator puts that token in the tab's session before the page loads, as
 * a passkey sign-in would, so the dashboard (/admin/) opens signed in; the
 * stub's operator token is "dev". --wait waits for a selector; without it
 * the page gets a second after it loads (polling pages never go network
 * idle). The service worker is blocked, so the page is what's on disk now.
 * Needs Playwright's browser once: pnpm exec playwright install chromium-headless-shell.
 */

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
  // Entrance animations and late fonts.
  await page.waitForTimeout(1_000);
  await page.screenshot({ path: out, fullPage: o.full });
  console.log(out);
} finally {
  await browser.close();
}
