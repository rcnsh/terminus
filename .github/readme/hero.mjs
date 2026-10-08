// Renders hero.html to the README's banner, light and dark
// (banner-light.webp, banner-dark.webp). Run shots.mjs first when the app's
// screenshots change; this only composes them.
//
//   node .github/readme/hero.mjs
//
// Needs Playwright (PLAYWRIGHT=/path/to/node_modules/playwright if it isn't
// resolvable from here), a Chromium (CHROME, or Playwright's own) and cwebp.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT ? join(process.env.PLAYWRIGHT, 'index.mjs') : 'playwright');

const tmp = mkdtempSync(join(tmpdir(), 'readme-hero-'));
const browser = await chromium.launch({ args: ['--allow-file-access-from-files'], ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
try {
  for (const scheme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2, colorScheme: scheme });
    await page.goto(pathToFileURL(join(here, 'hero.html')).href);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    const png = join(tmp, `${scheme}.png`);
    await page.screenshot({ path: png });
    execFileSync('cwebp', ['-quiet', '-q', '85', png, '-o', join(here, `banner-${scheme}.webp`)]);
    await page.close();
  }
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}
