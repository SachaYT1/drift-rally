#!/usr/bin/env node
/**
 * Dev tool: screenshot a page with software WebGL and report console errors.
 *
 * Usage: node scripts/screenshot.mjs <url> <out.png> [width=1280] [height=720] [waitMs=2500]
 * The page may set `window.__previewReady = true` to signal it finished rendering;
 * otherwise the script waits `waitMs`.
 */
import { chromium } from '@playwright/test';

const [url, out, w = '1280', h = '720', waitMs = '2500'] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node scripts/screenshot.mjs <url> <out.png> [width] [height] [waitMs]');
  process.exit(2);
}

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
const errors = [];
page.on('console', (m) => {
  const text = m.text();
  if (text.includes('GPU stall due to ReadPixels')) return; // SwiftShader noise
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${text}`);
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

await page.goto(url, { waitUntil: 'load' });
try {
  await page.waitForFunction(() => window.__previewReady === true, null, { timeout: Number(waitMs) });
} catch {
  // no ready signal: fall through after the timeout
}
await page.screenshot({ path: out });
await browser.close();

console.log(JSON.stringify({ out, errors }, null, 2));
process.exit(0);
