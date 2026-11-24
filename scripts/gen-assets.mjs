import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:6805';
const publicDir = path.resolve('public');
const emblem = fs.readFileSync(path.join(publicDir, 'favicon.svg'), 'utf8');

const browser = await chromium.launch({ args: ['--disable-webgl', '--disable-gpu'] });
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 630 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  if (!process.argv.includes('--og-only')) {
    for (const [file, size] of [['favicon-32.png', 32], ['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(`<style>body{margin:0;background:#263d30}svg{width:100vw;height:100vh;display:block}</style>${emblem}`);
      await page.screenshot({ path: path.join(publicDir, file) });
    }
  }

  // Pull the exact dial and self-hosted type from Match for the social card.
  await page.setViewportSize({ width: 1200, height: 630 });
  await page.goto(`${baseUrl}/#match`);
  await page.getByTestId('match-step-3').click();
  await page.getByTestId('tuning-dial').press('End');
  await page.addStyleTag({ content: `
    .og-plate { height: 630px; display: grid; grid-template-columns: 47% 53%; padding: 34px; background: var(--paper); }
    .og-copy { position: relative; display: grid; align-content: center; justify-items: start; padding-left: 38px;
      border-block: 1px solid var(--strong-rule); }
    .og-copy::before { content: ''; display: block; width: 62px; height: 5px; margin-bottom: 22px; background: var(--rust); }
    .og-copy h1 { font: 400 142px/.93 var(--font-serif); letter-spacing: -.045em; color: var(--pine); }
    .og-copy p { margin-top: 20px; font: 600 35px/1.2 var(--font-sans); color: var(--ink-secondary); }
    .og-face { position: relative; overflow: hidden; border: 1px solid var(--strong-rule); border-radius: 10px;
      background: repeating-linear-gradient(90deg, #b39a7420 0 1px, transparent 1px 4px), var(--cream); }
    .og-face .tuning-dial { position: absolute; top: -21px; left: -88px; width: 775px; max-width: none; }
  ` });
  await page.evaluate(() => {
    const dial = document.querySelector('.tuning-dial').cloneNode(true);
    const plate = document.createElement('main');
    plate.className = 'og-plate';
    plate.innerHTML = `
      <div class="og-copy"><h1>Tinnitune</h1><p>Find your tinnitus pitch</p></div>
      <div class="og-face"></div>
    `;
    plate.querySelector('.og-face').append(dial);
    document.body.replaceChildren(plate);
  });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(publicDir, 'og.png'), animations: 'disabled' });
  await context.close();
} finally {
  await browser.close();
}
