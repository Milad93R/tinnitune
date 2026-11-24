// Quick visual check: node scripts/quick-shot.mjs <hash> <w>x<h> <out.jpg> [fullPage=1]
import { chromium } from 'playwright';
const [hash, size, out, full = '1'] = process.argv.slice(2);
const [w, h] = size.split('x').map(Number);
const BASE = process.env.BASE_URL || 'http://127.0.0.1:6805';
const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: w < 760, hasTouch: w < 760, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/#${hash}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: out, type: 'jpeg', quality: 80, fullPage: full === '1' });
} finally {
  await browser.close();
}
