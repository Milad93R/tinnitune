import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, webkit } from 'playwright';

const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:6805').replace(/\/$/, '');
const QA_DIR = path.resolve(process.cwd(), process.env.QA_DIR || 'test-results');
const SAVE_SCREENSHOTS = process.env.SKIP_SCREENSHOTS !== '1';
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const TELEGRAM_ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 Telegram-Android/11.5';

if (SAVE_SCREENSHOTS) {
  fs.mkdirSync(QA_DIR, { recursive: true });
}

function makeTinyWavBuffer() {
  const sampleRate = 22050;
  const numSamples = sampleRate * 2;
  const dataBytes = numSamples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.25;
    buf.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }
  return buf;
}

async function assertNoOverflow(page, label) {
  const { docScrollWidth, bodyScrollWidth, innerWidth } = await page.evaluate(() => ({
    docScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  assert.ok(
    docScrollWidth <= innerWidth + 1 && bodyScrollWidth <= innerWidth + 1,
    `Horizontal overflow on ${label}: doc=${docScrollWidth}, body=${bodyScrollWidth} > innerWidth=${innerWidth}`
  );
}

async function assertMuteVisibleInViewport(page, label) {
  const rect = await page.locator('[data-testid="global-stop-audio"]').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  });
  const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  assert.ok(
    rect.width > 0 &&
      rect.height > 0 &&
      rect.left >= 0 &&
      rect.right <= vp.w + 0.5 &&
      rect.top >= 0 &&
      rect.bottom <= vp.h + 0.5,
    `Global Mute clipped/invisible on ${label}: rect=${JSON.stringify(rect)}, vp=${JSON.stringify(vp)}`
  );
}

async function assertMinTouchTargets(page, selectors, label) {
  for (const sel of selectors) {
    const count = await page.locator(sel).count();
    if (count === 0) continue;
    const box = await page.locator(sel).first().boundingBox();
    assert.ok(
      box && box.height >= 43.5 && box.width >= 43.5,
      `Touch target ${sel} too small on ${label}: ${JSON.stringify(box)}`
    );
  }
}

/** Every visible tappable control inside the app must be >= 44x44 px on phones (MINOR-1). */
async function assertAllTouchTargets(page, label) {
  const small = await page.evaluate(() => {
    const sel = 'button, a[href], [role="button"], input[type="checkbox"], select, label.checkbox-row';
    const out = [];
    for (const el of document.querySelectorAll(sel)) {
      if (el.closest('.app-footer')) continue;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || st.visibility === 'hidden' || st.display === 'none') continue;
      // A checkbox wrapped in a full-width label row is tapped via the label
      if (el.matches('input[type="checkbox"]') && el.closest('label')) {
        const lr = el.closest('label').getBoundingClientRect();
        if (lr.height >= 43.5) continue;
      }
      if (r.height < 43.5 || r.width < 43.5) {
        const name = (el.getAttribute('data-testid') || el.className || el.tagName).toString().slice(0, 50);
        out.push(`${name} "${(el.textContent || '').trim().slice(0, 20)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return out;
  });
  if (process.env.TOUCH_REPORT === '1') {
    if (small.length) console.log(`  [touch] ${label}: ${small.join(' | ')}`);
    return;
  }
  assert.equal(small.length, 0, `Touch targets < 44px on ${label}: ${small.join(' | ')}`);
}

async function snap(page, name, fullPage = true) {
  if (!SAVE_SCREENSHOTS) return;
  if (!/^(desktop|mobile)-/.test(name) && !/(?:-04-match|-07-relief|-09-journal|offline|round5)/.test(name)) return;
  const t0 = Date.now();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(50);
  if (fullPage && /^(mobile|android-360x640|android-390x664|webkit)-(01-|04-|06-|09-)/.test(name)) {
    await page.screenshot({
      path: path.join(QA_DIR, `${name}-viewport.jpg`), type: 'jpeg', quality: 74,
      animations: 'disabled', style: '.toast-banner { visibility: hidden; }',
    });
  }
  try {
    await page.screenshot({
      path: path.join(QA_DIR, `${name}.jpg`),
      type: 'jpeg',
      quality: 84,
      fullPage,
      // Full-document captures place fixed navigation at the real bottom so no section is masked.
      style: fullPage ? '.mobile-bottom-nav { position: absolute; bottom: 0; } .app-shell { position: relative; } .toast-banner { visibility: hidden; }' : undefined,
      animations: 'disabled',
      timeout: 35000,
    });
  } catch {
    // Fallback to viewport JPEG if SwiftShader software compositor stalls on fullPage
    await page.screenshot({
      path: path.join(QA_DIR, `${name}.jpg`),
      type: 'jpeg',
      quality: 84,
      fullPage: false,
      animations: 'disabled',
      timeout: 35000,
    });
  }
  console.log(`  [snap] ${name}.jpg (${Date.now() - t0}ms)`);
}

function attachListeners(page) {
  const consoleIssues = [];
  const failedRequests = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      const txt = msg.text();
      // Cloudflare Web Analytics rum beacon warning on offline reload is expected
      if (txt.includes('cdn-cgi/rum')) return;
      consoleIssues.push(`[${msg.type()}] ${txt}`);
    }
  });
  page.on('pageerror', (err) => consoleIssues.push(`[pageerror] ${err.message}`));
  page.on('response', (res) => {
    if (res.status() >= 400 && !res.url().includes('nonexistent-route-check')) {
      failedRequests.push(`${res.status()} ${res.url()}`);
    }
  });
  page.on('requestfailed', (req) => {
    const errText = req.failure()?.errorText || 'unknown';
    if (req.url().startsWith('blob:') && errText === 'net::ERR_ABORTED') return;
    if (req.url().includes('/cdn-cgi/rum')) return;
    failedRequests.push(`FAILED ${req.url()} (${errText})`);
  });

  return { consoleIssues, failedRequests };
}

async function verifyLogTicksAligned(page, label) {
  const check = await page.evaluate(() => {
    const slider = document.querySelector('[data-testid="fine-freq-slider"]');
    const track = document.querySelector('[data-testid="log-scale-ticks"]');
    if (!slider || !track) return { ok: false, reason: 'missing slider or ticks' };
    const trackRect = track.getBoundingClientRect();
    const minHz = 250;
    const maxHz = 18000;
    const freqToNorm = (f) => Math.log(f / minHz) / Math.log(maxHz / minHz);
    const errors = [];
    for (const hz of [1000, 4000, 8000]) {
      const el = track.querySelector(`[data-tick-hz="${hz}"]`);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const centerPct = (r.left + r.width / 2 - trackRect.left) / trackRect.width;
      const expected = freqToNorm(hz);
      const diff = Math.abs(centerPct - expected);
      if (diff > 0.035) {
        errors.push(`${hz}Hz visual=${(centerPct * 100).toFixed(1)}% expected=${(expected * 100).toFixed(1)}%`);
      }
    }
    return { ok: errors.length === 0, errors };
  });
  assert.ok(check.ok, `Log slider tick misalignment on ${label}: ${JSON.stringify(check)}`);
}

async function assertInsideVisualViewport(locator, label) {
  const bounds = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop ?? 0;
    const height = viewport?.height ?? window.innerHeight;
    const header = document.querySelector('.app-header')?.getBoundingClientRect().bottom ?? 0;
    const nav = document.querySelector('.mobile-bottom-nav');
    const navStyle = nav && getComputedStyle(nav);
    const navTop = navStyle && navStyle.display !== 'none' && navStyle.visibility === 'visible'
      ? nav.getBoundingClientRect().top : top + height;
    const inDialog = el.closest('dialog');
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right,
      visibleTop: inDialog ? top : Math.max(top, header),
      visibleBottom: inDialog ? top + height : Math.min(top + height, navTop),
      visibleWidth: viewport?.width ?? window.innerWidth };
  });
  assert.ok(bounds.top >= bounds.visibleTop - 1 && bounds.bottom <= bounds.visibleBottom + 1 &&
    bounds.left >= -1 && bounds.right <= bounds.visibleWidth + 1,
  `${label} is fully reachable within the viewport: ${JSON.stringify(bounds)}`);
}

async function verifyPageBottom(page, name, attribute = 'data-testid') {
  const target = page.locator(`[${attribute}="${name}"]`);
  await target.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await assertInsideVisualViewport(target, name);
}

async function resizeViewport(page, size) {
  await page.setViewportSize(size);
  await page.waitForFunction(({ width, height }) =>
    Math.abs(window.innerWidth - width) <= 1 &&
    Math.abs((window.visualViewport?.height ?? window.innerHeight) - height) <= 1,
  size, { timeout: 8000 });
}

async function verifyLandscapeHeader(page, label) {
  const original = page.viewportSize();
  const shell = page.locator('.app-shell');
  const header = page.locator('.header-inner');
  await page.getByTestId('header-profile-chip').waitFor();
  const mute = page.getByTestId('global-stop-audio');
  await mute.getByText('Mute', { exact: true }).waitFor();
  const originalPadding = await header.evaluate((el) => {
    const { paddingLeft, paddingRight } = getComputedStyle(el);
    return [paddingLeft, paddingRight];
  });
  // WebKit can expose resized viewport dimensions before the header reflows.
  const waitForPadding = (padding) => page.waitForFunction(([left, right]) => {
    const el = document.querySelector('.header-inner');
    if (!el) return false;
    const { paddingLeft, paddingRight } = getComputedStyle(el);
    return paddingLeft === left && paddingRight === right;
  }, padding);
  await shell.evaluate((el) => {
    el.style.setProperty('--safe-area-left', '47px');
    el.style.setProperty('--safe-area-right', '47px');
  });
  try {
    for (const width of [740, 761, 768, 812, 900, 901]) {
      await resizeViewport(page, { width, height: 390 });
      await waitForPadding(['47px', '47px']);
      const compact = width <= 900;
      await page.getByTestId(compact ? 'mobile-nav-relief' : 'nav-relief').waitFor({ state: 'visible' });
      await page.getByTestId(compact ? 'nav-relief' : 'mobile-nav-relief').waitFor({ state: 'hidden' });
      await assertMuteVisibleInViewport(page, `${label} ${width}×390`);
      await assertNoOverflow(page, `${label} ${width}×390 with safe areas`);
      const muteBounds = await mute.evaluate((el) => {
        const { right, top, height } = el.getBoundingClientRect();
        return { right, availableRight: innerWidth - 47, enabled: !el.disabled,
          hit: el.contains(document.elementFromPoint(right - 2, top + height / 2)) };
      });
      assert.ok(muteBounds.enabled && muteBounds.hit && muteBounds.right <= muteBounds.availableRight + 0.5,
        `${label} Mute must be fully tappable inside the safe area at ${width}px: ${JSON.stringify(muteBounds)}`);
      if (SAVE_SCREENSHOTS && (width === 768 || width === 901)) {
        await page.screenshot({ path: path.join(QA_DIR, `${label}-round7-header-${width}.jpg`), type: 'jpeg', quality: 77 });
      }
    }
  } finally {
    await shell.evaluate((el) => {
      el.style.removeProperty('--safe-area-left');
      el.style.removeProperty('--safe-area-right');
    });
    await resizeViewport(page, original);
    await waitForPadding(originalPadding);
  }
}

async function verifyJournalKeyboard(page, label) {
  const original = page.viewportSize();
  const note = page.getByTestId('checkin-note-input');
  await note.focus();
  await resizeViewport(page, { width: original.width, height: Math.max(245, original.height - 320) });
  await note.fill('A note while the keyboard is open.');
  await verifyPageBottom(page, 'checkin-note-input');
  await verifyPageBottom(page, 'save-checkin-btn');
  if (SAVE_SCREENSHOTS) {
    await page.screenshot({ path: path.join(QA_DIR, `${label}-journal-keyboard.jpg`), type: 'jpeg', quality: 80 });
  }
  await page.getByTestId('save-checkin-btn').click();
  await page.getByTestId('history-checkin-row').getByText('A note while the keyboard is open.').waitFor({ timeout: 8000 });
  await note.blur();
  await resizeViewport(page, original);
}

async function swipe(context, page, start, end) {
  const cdp = await context.newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
    for (let i = 1; i <= 5; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: start.x + (end.x - start.x) * i / 5, y: start.y + (end.y - start.y) * i / 5 }],
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}

async function assertAudition(page, frequency) {
  await page.waitForFunction((hz) => {
    const analyser = window.qaOutputAnalyser;
    if (!analyser) return false;
    const time = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(time);
    const spectrum = window.__tinnituneDsp.computeMagnitudeSpectrumDb(time, analyser.fftSize);
    let peak = 0;
    for (let i = 1; i < spectrum.length; i++) {
      if (spectrum[i] > spectrum[peak]) peak = i;
    }
    const binHz = analyser.context.sampleRate / analyser.fftSize;
    return Math.abs(peak * binHz - hz) <= binHz && spectrum[peak] > -90;
  }, frequency, { timeout: 6000 });
}

async function outputRms(page) {
  return page.evaluate(() => {
    const analyser = window.qaOutputAnalyser;
    const pcm = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(pcm);
    return 10 * Math.log10(pcm.reduce((sum, sample) => sum + sample * sample, 0) / pcm.length);
  });
}

async function assertBandEdges(locator, widthOct) {
  const text = await locator.innerText();
  assert.match(text, /[\d,]+–[\d,]+ Hz at −3 dB/);
  const [low, high] = text.split(' Hz')[0].replaceAll(',', '').split('–').map(Number);
  assert.ok(Math.abs(Math.log2(high / low) - widthOct) < 0.006, `${text} must span ${widthOct} octave`);
}

async function assertStereoRoute(page, audibleSide, label) {
  const read = await page.waitForFunction((side) => {
    if (window.qaOutputChannels?.length !== 3) return false;
    const rms = window.qaOutputChannels.slice(1).map((analyser) => {
      const data = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(data);
      return Math.sqrt(data.reduce((sum, sample) => sum + sample * sample, 0) / data.length);
    });
    if (side === null) return rms.every((value) => value > 0.0002) ? rms : false;
    return rms[side] > 0.0002 && rms[1 - side] < 0.000001 ? rms : false;
  }, audibleSide, { timeout: 6000 });
  const [left, right] = await read.jsonValue();
  console.log(`  [route] ${label}: L ${left.toExponential(3)}, R ${right.toExponential(3)} RMS`);
}

async function assertMaskSpectrum(page, matchedHz, otherHz) {
  const ratio = await page.waitForFunction(([matched, other]) => {
    const analyser = window.qaOutputAnalyser;
    if (!analyser) return false;
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    const spectrum = window.__tinnituneDsp.computeMagnitudeSpectrumDb(data, analyser.fftSize);
    const binHz = analyser.context.sampleRate / analyser.fftSize;
    const power = (center) => {
      const low = Math.ceil(center * 0.95 / binHz);
      const high = Math.min(spectrum.length, Math.floor(center * 1.05 / binHz));
      return spectrum.slice(low, high).reduce((sum, db) => sum + 10 ** (db / 10), 0) / (high - low);
    };
    const gap = 10 * Math.log10(power(matched) / power(other));
    return power(matched) > 1e-11 && gap > 20 ? gap : false;
  }, [matchedHz, otherHz], { timeout: 5000 });
  console.log(`  [RI] matched band over edited notch: ${(await ratio.jsonValue()).toFixed(1)} dB`);
}

async function clockShows(page, expression) {
  await page.waitForFunction((pattern) =>
    new RegExp(pattern).test(document.querySelector('[data-testid="therapy-countdown"]').textContent), expression);
}

async function downloadBackup(page) {
  const event = page.waitForEvent('download');
  await page.getByTestId('export-json-btn').click();
  const download = await event;
  assert.match(download.suggestedFilename(), /^tinnitune-journal-\d{4}-\d{2}-\d{2}\.json$/);
  return JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
}

async function uploadBackup(page, bundle) {
  await page.getByTestId('import-json-input').setInputFiles({
    name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bundle)),
  });
}

async function assertTabBetween(page, first, second) {
  await first.focus();
  await page.keyboard.press('Tab');
  assert.ok(await second.evaluate((el) => el === document.activeElement), 'Tab skips the hidden upload input');
  await page.keyboard.press('Shift+Tab');
  assert.ok(await first.evaluate((el) => el === document.activeElement), 'Shift+Tab skips the hidden upload input');
}

const roundedSeconds = (seconds) => `${Number.isInteger(seconds) ? '' : '≈'}${Math.round(seconds)}s`;

async function verifyJournalDeletion(browser, engine) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce',
    userAgent: engine === 'webkit' ? IPHONE_UA : undefined,
  });
  try {
    const page = await context.newPage();
    const issues = attachListeners(page);
    await page.goto(`${BASE_URL}/#journal`, { waitUntil: 'domcontentloaded' });
    const records = (name, fields) => [0, 1].map((i) => ({
      id: `${name}-${i}`, createdAt: Date.UTC(2026, 10, 23, 13 - i), ...fields[i],
    }));
    await uploadBackup(page, {
      app: 'tinnitune', version: 1, activeMatchId: 'matches-0',
      matches: records('matches', [{ frequencyHz: 253, ear: 'right' }, { frequencyHz: 252, ear: 'left' }]),
      checkins: records('checkins', [
        { dateKey: '2026-11-23', loudness: 6, note: 'First check-in' },
        { dateKey: '2026-11-23', loudness: 5, note: 'Second check-in' },
      ]),
      riTests: records('riTests', [
        { frequencyHz: 250, stimulusSeconds: 10, reliefSeconds: 2, ear: 'right' },
        { frequencyHz: 250, stimulusSeconds: 10, reliefSeconds: 2, ear: 'left' },
      ]),
      sessions: records('sessions', [
        { mode: 'notched-noise', noiseType: 'ocean', durationSeconds: 26 },
        { mode: 'notched-noise', noiseType: 'rain', durationSeconds: 23, filterSegments: [
          { state: 'notched', frequencyHz: 250, notchWidthOct: 1, noiseType: 'rain', durationSeconds: 19.4 },
          { state: 'notched', frequencyHz: 250, notchWidthOct: 1, noiseType: 'ocean', durationSeconds: 3.4 },
        ] },
      ]),
    });
    await page.getByTestId('toast-banner').getByText(/Imported 2 matches/).waitFor();
    for (const [filter, rowType, label, survivor] of [
      ['matches', 'match', 'match', '252 Hz'],
      ['checkins', 'checkin', 'check-in', 'Second check-in'],
      ['ri', 'ri', 'residual inhibition record', '250 Hz · left ear · 10s mask'],
      ['sessions', 'session', 'therapy session', 'Rain Therapy'],
    ]) {
      await page.getByTestId(`history-filter-${filter}`).tap();
      const rows = page.getByTestId(`history-${rowType}-row`);
      const trash = rows.first().getByRole('button', { name: `Delete ${label}`, exact: true });
      await trash.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await assertInsideVisualViewport(trash, `${label} trash`);
      const bounds = await trash.boundingBox();
      const x = bounds.x + bounds.width / 2;
      const y = bounds.y + bounds.height / 2;
      await page.touchscreen.tap(x, y);
      await page.waitForTimeout(85);
      await page.touchscreen.tap(x, y);
      const prompt = page.getByTestId('history-delete-prompt');
      assert.equal(await rows.count(), 2, `Rapid taps opened one prompt without deleting either ${label}`);
      assert.equal(await prompt.getAttribute('id'), await trash.getAttribute('aria-controls'));
      assert.ok((await prompt.innerText()).includes(`Delete this ${label}?`));
      if (filter === 'matches') {
        await prompt.getByRole('button', { name: 'Cancel' }).tap();
        assert.equal(await prompt.count(), 0);
        assert.equal(await rows.count(), 2);
        await trash.tap();
        if (SAVE_SCREENSHOTS) await page.screenshot({
          path: path.join(QA_DIR, `${engine}-round8-delete.jpg`), type: 'jpeg', quality: 77,
        });
      }
      const confirm = prompt.getByRole('button', { name: 'Delete', exact: true });
      await confirm.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await assertInsideVisualViewport(confirm, `${label} confirmation`);
      await confirm.tap();
      await prompt.waitFor({ state: 'detached' });
      assert.equal(await rows.count(), 1);
      assert.ok((await rows.first().innerText()).includes(survivor));
      if (filter === 'sessions') {
        assert.match(await rows.first().innerText(), /≈23s[\s\S]+≈19s[\s\S]+≈3s/);
      }
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('history-session-row').waitFor();
    const exported = await downloadBackup(page);
    for (const key of ['matches', 'checkins', 'riTests', 'sessions']) {
      assert.deepEqual(exported[key].map(({ id }) => id), [`${key}-1`]);
    }
    assert.equal(exported.activeMatchId, 'matches-1');
    assert.deepEqual(issues.consoleIssues, []);
    assert.deepEqual(issues.failedRequests, []);
    console.log(`[PASS] ${engine} rapid touch repeats on all four Journal trash actions preserve the unselected records through reload and export`);
  } finally {
    await context.close();
  }
}

async function verifyDial(page, context, touch) {
  const dial = page.getByTestId('tuning-dial');
  const slider = page.getByTestId('fine-freq-slider');
  await dial.focus();
  await dial.press('Home');
  assert.equal(await dial.getAttribute('aria-valuenow'), '250');
  await dial.press('ArrowRight');
  assert.equal(await dial.getAttribute('aria-valuenow'), '265', 'Keyboard advances one rounded semitone');
  await dial.press('End');
  assert.equal(await dial.getAttribute('aria-valuenow'), '18000');
  assert.equal(await slider.inputValue(), '1000');
  await slider.fill('510');
  await dial.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const b = await dial.boundingBox();
  const at = (x, y) => ({ x: b.x + b.width * x / 340, y: b.y + b.height * y / 247 });
  const start = at(170, 105);
  const end = at(202, 138);
  const startHz = Number(await dial.getAttribute('aria-valuenow'));
  if (touch) {
    await swipe(context, page, start, end);
  } else {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 5 });
    await page.mouse.up();
  }
  const turnedHz = Number(await dial.getAttribute('aria-valuenow'));
  assert.ok(turnedHz > startHz, `Clockwise turn should raise pitch (${startHz} → ${turnedHz})`);
  const detent = Math.round(12 * Math.log2(turnedHz / 250));
  assert.equal(turnedHz, Math.round(250 * 2 ** (detent / 12)), 'Drag settles at an exact rounded detent');
  if (touch) {
    await dial.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    const rect = await dial.boundingBox();
    const from = { x: rect.x + rect.width * 0.97, y: rect.y + rect.height * 0.65 };
    const y = await page.evaluate(() => scrollY);
    await swipe(context, page, from, { x: from.x, y: Math.max(62, from.y - 110) });
    await page.waitForFunction((previous) => scrollY > previous + 15, y, { timeout: 4000 });
    assert.equal(Number(await dial.getAttribute('aria-valuenow')), turnedHz, 'A margin swipe scrolls without retuning');
  }
  assert.ok(await page.getByTestId('global-stop-audio').isDisabled(), 'Turning silently must not start audio');
  await page.getByTestId('fine-play-toggle').click();
  await page.getByTestId('fine-play-toggle').getByText('Pause Tone').waitFor();
  await dial.press('ArrowLeft');
  await page.getByTestId('fine-play-toggle').click();
  await page.getByTestId('fine-play-toggle').getByText('Listen & Tune').waitFor();
}

async function verifyShareSheet(page, openerId, sheetId, label, engine, context) {
  const original = page.viewportSize();
  const opener = page.getByTestId(openerId);
  await opener.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await opener.focus();
  await opener.evaluate((el) => {
    el.addEventListener('click', () => { el.dataset.qaOpenerScroll = String(scrollY); }, { capture: true, once: true });
  });
  await opener.click();
  // The engine may scroll an additional few pixels while dispatching the real click.
  const previousScroll = Number(await opener.getAttribute('data-qa-opener-scroll'));
  const sheet = page.getByTestId(sheetId);
  const img = sheet.locator('img');
  await img.waitFor();
  assert.deepEqual(await img.evaluate((el) => ({ w: el.naturalWidth, h: el.naturalHeight })), { w: 1200, h: 675 });
  await assertNoOverflow(page, label);
  await assertInsideVisualViewport(sheet.getByTestId('download-share-card'), label);
  if (SAVE_SCREENSHOTS) {
    await page.screenshot({ path: path.join(QA_DIR, `${label}.jpg`), type: 'jpeg', quality: 80 });
  }

  const landscape = original.width === 844;
  const compactPortrait = !landscape && original.width <= 390;
  const height = landscape ? 155 : compactPortrait ? 185 : 255;
  const top = compactPortrait ? 44 : 0;
  await sheet.evaluate((el) => {
    el.style.setProperty('--sheet-safe-top', '8px');
    el.style.setProperty('--sheet-safe-bottom', '21px');
  });
  if (top) {
    // A portrait software keyboard shrinks the visual viewport while the layout
    // viewport, media queries and orientation stay in portrait.
    await page.evaluate(({ height, top }) => {
      Object.defineProperties(visualViewport, {
        height: { value: height, configurable: true },
        offsetTop: { value: top, configurable: true },
      });
      visualViewport.dispatchEvent(new Event('resize'));
    }, { height, top });
    assert.ok(await page.evaluate(() => matchMedia('(orientation: portrait)').matches));
  } else {
    await resizeViewport(page, { width: original.width, height });
  }
  const layout = landscape ? 'split' : 'stacked';
  await sheet.locator('xpath=self::*[@data-short="' + layout + '"]').waitFor();
  // WebKit can expose the updated layout attribute before it reflows the dialog.
  await sheet.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const scroller = sheet.locator(landscape ? '.share-sheet-scroll' : '.share-sheet-panel');
  const dimensions = await scroller.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const top = visualViewport.offsetTop;
    const bottom = top + visualViewport.height;
    return {
      scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
      visibleHeight: Math.round(Math.min(rect.bottom, bottom - 21) - Math.max(rect.top, top + 8)),
    };
  });
  assert.ok(dimensions.scrollHeight > dimensions.clientHeight, `Share sheet must scroll at keyboard height: ${JSON.stringify(dimensions)}`);
  assert.ok(dimensions.visibleHeight >= 120, `Readable scroll area for ${label}: ${JSON.stringify(dimensions)}`);
  console.log(`  [sheet] ${label} visible ${dimensions.visibleHeight}px at visual height ${height}px, top ${top}px`);
  await assertInsideVisualViewport(sheet.getByRole('button', { name: 'Close share preview' }), label);
  if (SAVE_SCREENSHOTS) {
    await page.screenshot({ path: path.join(QA_DIR, `${label}-keyboard-top.jpg`), type: 'jpeg', quality: 80 });
  }
  if (engine === 'chromium' && (landscape || compactPortrait)) {
    const rect = await scroller.boundingBox();
    const x = rect.x + rect.width * 0.45;
    for (let i = 0; i < 6; i++) {
      const atEnd = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop <= 2);
      if (atEnd) break;
      await swipe(context, page, { x, y: rect.y + rect.height - 12 }, { x, y: rect.y + 12 });
    }
  } else {
    await scroller.focus();
    await page.keyboard.press('End');
  }
  await page.waitForFunction(({ id, layout }) => {
    const el = document.querySelector(`[data-testid="${id}"] ${layout === 'split' ? '.share-sheet-scroll' : '.share-sheet-panel'}`);
    return el.scrollTop > 0 && el.scrollHeight - el.clientHeight - el.scrollTop <= 2;
  }, { id: sheetId, layout }, { timeout: 6000 });
  await assertInsideVisualViewport(sheet.locator('.share-sheet-caption'), `${label} full caption`);
  const locked = await scroller.evaluate((el) => (
    getComputedStyle(el).overscrollBehaviorY === 'contain' &&
    getComputedStyle(document.body).position === 'fixed' && window.scrollY <= 1
  ));
  assert.ok(locked, `Background is locked and sheet overscroll contained for ${label}`);
  const footer = sheet.getByTestId('download-share-card');
  await assertInsideVisualViewport(footer, `${label} at keyboard height`);
  if (SAVE_SCREENSHOTS) {
    await page.screenshot({ path: path.join(QA_DIR, `${label}-scrolled.jpg`), type: 'jpeg', quality: 80 });
  }
  const downloadEvent = page.waitForEvent('download');
  if (landscape || compactPortrait) await footer.tap();
  else await footer.click();
  const download = await downloadEvent;
  assert.match(download.suggestedFilename(), /^tinnitune-\d+hz\.png$/);
  const png = fs.readFileSync(await download.path());
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 675]);
  if (top) {
    await page.evaluate(() => {
      delete visualViewport.height;
      delete visualViewport.offsetTop;
      visualViewport.dispatchEvent(new Event('resize'));
    });
  }
  await resizeViewport(page, original);
  if (sheetId === 'share-card-preview') await page.keyboard.press('Escape');
  else await sheet.getByRole('button', { name: 'Close share preview' }).click();
  await sheet.waitFor({ state: 'detached' });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const restored = await opener.evaluate((el) => ({
    focus: el === document.activeElement, y: scrollY, max: document.scrollingElement.scrollHeight - innerHeight,
  }));
  assert.ok(restored.focus && Math.abs(restored.y - Math.min(previousScroll, restored.max)) <= 2,
    `Closing ${sheetId} restores focus and scroll (${previousScroll} → ${restored.y})`);
}

async function runDesktopOrMobileSuite(browser, mode, viewport, engine = 'chromium', silentWebKit = false) {
  const isMobile = mode !== 'desktop';
  const mobileNav = viewport.width <= 900;
  const context = await browser.newContext({ reducedMotion: 'reduce',
    viewport,
    userAgent: engine === 'webkit' ? IPHONE_UA : mode === 'android-360x640' ? TELEGRAM_ANDROID_UA : isMobile
      ? `Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Mobile Safari/537.36`
      : undefined,
    isMobile,
    hasTouch: isMobile,
  });

  if (silentWebKit) {
    // WPE on this host has no output sink. Keep its native nodes and supply a
    // clock and end event for the UI when device resume fails.
    await context.addInitScript(() => {
      const AudioContextWithOutput = window.AudioContext;
      const silentClockOrigins = new WeakMap();
      const now = performance.now.bind(performance);
      const scheduleEnd = window.setTimeout.bind(window);
      const cancelEnd = window.clearTimeout.bind(window);
      window.AudioContext = class extends AudioContextWithOutput {
        resume() {
          return super.resume().catch(() => {
            if (!silentClockOrigins.has(this)) silentClockOrigins.set(this, now() - super.currentTime * 1000);
          });
        }
        get currentTime() {
          const origin = silentClockOrigins.get(this);
          return origin === undefined || this.state === 'running' ? super.currentTime : (now() - origin) / 1000;
        }
        createBufferSource() {
          const source = super.createBufferSource();
          const stop = source.stop.bind(source);
          let endEvent;
          source.stop = (when) => {
            stop(when);
            if (!silentClockOrigins.has(this) || this.state === 'running' || !source.loop || !when) return;
            cancelEnd(endEvent);
            endEvent = scheduleEnd(() => source.dispatchEvent(new Event('ended')), Math.max(0, (when - this.currentTime) * 1000));
          };
          return source;
        }
      };
    });
  }

  const measuredAudio = engine === 'chromium' && (mode === 'desktop' || mode === 'mobile');
  if (measuredAudio) {
    await context.addInitScript(() => {
      const nativeCreate = AudioContext.prototype.createAnalyser;
      AudioContext.prototype.createAnalyser = function () {
        const analyser = nativeCreate.call(this);
        window.qaOutputAnalyser ??= analyser;
        (window.qaOutputChannels ??= []).push(analyser);
        return analyser;
      };
    });
  }
  const page = await context.newPage();
  page.setDefaultTimeout(18000);
  if (mode === 'desktop') await page.clock.install();
  const { consoleIssues, failedRequests } = attachListeners(page);

  const shot = async (name, fullPage = true) => {
    if (isMobile) await assertAllTouchTargets(page, name);
    await snap(page, name, fullPage);
  };

  const clickNav = async (tab) =>
    page.locator(`[data-testid="mobile-nav-${tab}"]:visible, [data-testid="nav-${tab}"]:visible`).click();

  try {
    // 1. Fresh load -> Setup & Safety
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="test-left-ear"]');
    await assertNoOverflow(page, `${mode}-setup`);
    await assertMuteVisibleInViewport(page, `${mode}-setup`);

    // Verify generated hero artwork loaded cleanly
    const heroArtLoaded = await page
      .waitForFunction(() => {
        const img = document.querySelector('.hero-banner-art');
        const onboard = document.querySelector('.onboard-art img');
        return Boolean(img && img.complete && img.naturalWidth > 0 && onboard && onboard.complete && onboard.naturalWidth > 0);
      }, null, { timeout: 15000 })
      .then(() => true, () => false);
    assert.ok(heroArtLoaded, 'Setup hero WebP artwork must load cleanly');

    // Assert audio starts silent (muted until first tap)
    const muteBtn = page.locator('[data-testid="global-stop-audio"]');
    assert.ok(await muteBtn.isDisabled(), 'Audio must start muted until first user tap');

    const ack = page.getByTestId('safety-ack-checkbox');
    assert.equal(await ack.isChecked(), false);
    assert.ok(await page.getByTestId('start-matching-btn').isDisabled());
    await clickNav('match');
    await page.getByTestId('preview-type-tone').click();
    const matchError = page.getByTestId('match-audio-error');
    assert.match(await matchError.getByRole('alert').innerText(), /Acknowledge the safety notice/);
    await assertInsideVisualViewport(matchError, `${mode} matching failure`);
    assert.ok(await muteBtn.isDisabled(), 'Direct Match entry must stay silent before consent');
    await clickNav('relief');
    const therapyPlay = page.getByTestId('therapy-play-toggle');
    await verifyPageBottom(page, 'therapy-play-toggle');
    if (isMobile) await therapyPlay.tap();
    else await therapyPlay.press('Enter');
    const reliefError = page.getByTestId('relief-audio-error');
    assert.match(await reliefError.getByRole('alert').innerText(), /Acknowledge the safety notice/);
    await assertInsideVisualViewport(reliefError, `${mode} therapy failure`);
    assert.ok(await muteBtn.isDisabled(), 'Direct Relief entry must stay silent before consent');
    if (!isMobile) assert.ok(await therapyPlay.evaluate((el) => el === document.activeElement));
    if (SAVE_SCREENSHOTS && mode === 'mobile') {
      await page.screenshot({ path: path.join(QA_DIR, 'mobile-therapy-failure.jpg'), type: 'jpeg', quality: 78 });
    }
    if (mode === 'mobile') {
      await page.getByTestId('relief-tab-ri').tap();
      await page.getByTestId('ri-match-first').waitFor();
      assert.equal(await page.getByTestId('ri-start-btn').count(), 0);
      assert.ok(await muteBtn.isDisabled());
      await page.getByTestId('relief-tab-music').tap();
      await page.getByTestId('load-sample-music-btn').tap();
      await verifyPageBottom(page, 'music-play-toggle');
      await page.getByTestId('music-play-toggle').tap();
      const blockedMusic = page.getByTestId('music-error');
      assert.match(await blockedMusic.getByRole('alert').innerText(), /Acknowledge the safety notice/);
      await assertInsideVisualViewport(blockedMusic, 'Music startup failure');
      await blockedMusic.getByRole('button', { name: 'Review safety in Setup' }).tap();
    } else {
      await reliefError.getByRole('button', { name: 'Review safety in Setup' }).click();
    }
    assert.equal(await ack.isChecked(), false);
    await page.locator('.checkbox-row').click();
    assert.equal(await ack.isChecked(), true);
    await page.getByTestId('test-left-ear').click();
    await page.getByTestId('confirm-left-ear').waitFor();
    assert.equal(await page.getByText('Confirmed chime', { exact: true }).count(), 0);
    await page.getByTestId('confirm-left-ear').click();
    await page.getByTestId('test-right-ear').click();
    await page.getByTestId('confirm-right-ear').waitFor();
    assert.equal(await page.getByText('Confirmed chime', { exact: true }).count(), 1);
    assert.equal(await page.locator('.verified-pill:has-text("Verified")').count(), 0);
    await page.getByTestId('confirm-right-ear').click();
    await page.locator('.verified-pill:has-text("Verified")').waitFor();

    // Match leaves the graph routed Right. Calibration reads Setup's still-selected Both.
    await clickNav('match');
    await page.getByTestId('match-ear-right').click();
    await page.getByTestId('preview-type-tone').click();
    if (measuredAudio) await assertStereoRoute(page, 1, 'Match before returning to Setup');
    await clickNav('setup');
    assert.equal(await page.getByTestId('select-ear-both').getAttribute('aria-checked'), 'true');
    await page.locator('[data-testid="toggle-calibration-audio"]').click();
    await page.waitForTimeout(150);
    assert.ok(!(await muteBtn.isDisabled()), 'Audio should be active during calibration');
    if (measuredAudio) {
      await assertStereoRoute(page, null, 'Calibration Both before adjusting comfort');
      await page.getByTestId('comfort-volume-slider').fill('100');
      await page.waitForFunction(() => /-?\d+\.\d dBTP/.test(document.querySelector('.meter-labels').textContent));
      await page.waitForTimeout(170);
      const loud = await outputRms(page);
      await page.getByTestId('comfort-volume-slider').fill('10');
      await page.waitForTimeout(170);
      const quiet = await outputRms(page);
      assert.ok(loud - quiet > 26, `Calibration applies to audio already playing: ${loud} → ${quiet}`);
      await page.getByTestId('comfort-volume-slider').fill('100');
    }
    await muteBtn.click();
    await page.waitForTimeout(120);
    assert.ok(await muteBtn.isDisabled(), 'Global mute must silence audio');

    // Ear selection + safety checkbox
    const setupBoth = page.getByTestId('select-ear-both');
    const setupRight = page.getByTestId('select-ear-right');
    await setupBoth.press('ArrowRight');
    assert.equal(await setupRight.getAttribute('aria-checked'), 'true');
    assert.ok(await setupRight.evaluate((el) => el === document.activeElement && el.tabIndex === 0));
    assert.equal(await setupBoth.getAttribute('tabindex'), '-1');
    await page.getByTestId('toggle-calibration-audio').click();
    if (measuredAudio) {
      await assertStereoRoute(page, 1, 'Calibration uses Setup Right');
      await page.getByTestId('comfort-volume-slider').fill('55');
      await page.waitForTimeout(150);
      await assertStereoRoute(page, 1, 'Calibration Right after adjusting comfort');
      await page.getByTestId('comfort-volume-slider').fill('100');
    }
    await muteBtn.click();
    if (mode === 'mobile') {
      await page.getByTestId('select-ear-right').press('ArrowLeft');
      assert.equal(await setupBoth.getAttribute('aria-checked'), 'true');
    }
    await page.locator('[data-testid="safety-ack-checkbox"]').check();
    if (isMobile) {
      await assertMinTouchTargets(page, ['[data-testid="global-stop-audio"]'], 'mobile-setup');
    }
    await shot(`${mode}-01-setup`);

    // 2. Match Your Sound — full 5-step guided flow
    await page.locator('[data-testid="start-matching-btn"]').click();
    await page.waitForSelector('[data-testid="step-1-panel"]');
    await assertNoOverflow(page, `${mode}-match-step1`);

    // Verify jumping to Step 5 BEFORE saving honestly shows "Unsaved draft" (MAJOR-3)
    await page.locator('[data-testid="match-step-5"]').click();
    await page.waitForSelector('[data-testid="result-unsaved-badge"]');
    assert.equal(
      await page.locator('[data-testid="result-saved-badge"]').count(),
      0,
      'Unsaved draft must NOT display Saved to Private Journal badge'
    );
    await page.getByTestId('result-start-relief').click();
    await page.getByTestId('relief-tab-ri').click();
    await page.getByTestId('ri-save-match').waitFor();
    assert.equal(await page.getByTestId('ri-use-previous-match').count(), 0);
    assert.equal(await page.getByTestId('ri-start-btn').count(), 0, 'An unsaved pitch cannot start a mask');
    assert.equal(await page.getByTestId('ri-band-edges').count(), 0);
    assert.ok(await muteBtn.isDisabled());
    if (['desktop', 'mobile', 'webkit'].includes(mode)) await snap(page, `${mode}-round5-ri-no-match`, false);
    await page.getByTestId('ri-match-first').click();
    await page.locator('[data-testid="match-step-1"]').click();
    await page.waitForSelector('[data-testid="step-1-panel"]');

    if (measuredAudio) {
      await page.getByTestId('step-1-next').click();
      await page.getByTestId('play-probe-a').click();
      await assertAudition(page, 902);
      await page.waitForTimeout(160);
      const loud = await outputRms(page);
      await muteBtn.click();
      await page.getByTestId('play-probe-a').click();
      await assertAudition(page, 902);
      await page.getByTestId('choose-probe-a').click();
      const nextA = Math.round(250 * 72 ** (0.62 * 0.3));
      await page.getByTestId('play-probe-a').click();
      await assertAudition(page, nextA);
      await page.getByRole('button', { name: 'Reset', exact: true }).click();
      await clickNav('journal');
      await uploadBackup(page, {
        app: 'tinnitune', version: 1,
        calibration: { safetyAcknowledged: true, comfortLevel: 0.1, ear: mode === 'mobile' ? 'both' : 'right', leftHeard: true, rightHeard: true, headphonesChecked: true },
      });
      await page.getByTestId('toast-banner').getByText(/Backup read/).waitFor();
      await clickNav('match');
      await page.getByTestId('play-probe-a').click();
      await assertAudition(page, 902);
      await page.waitForTimeout(160);
      const quiet = await outputRms(page);
      assert.ok(loud - quiet > 29 && loud - quiet < 33, `Imported calibration changes the live graph: ${loud} → ${quiet}`);
      console.log(`  [audio] ${mode} first/replayed probe 902 Hz; next ${nextA} Hz; restore ${loud.toFixed(2)} → ${quiet.toFixed(2)} dBFS RMS`);
      await page.getByTestId('match-step-1').click();
    }

    // Selection and audition are separate keyboard actions.
    const preview = page.getByTestId('preview-type-hiss');
    await page.getByTestId('sound-type-hiss').focus();
    await page.keyboard.press('Tab');
    assert.ok(await preview.evaluate((el) => el === document.activeElement));
    await page.keyboard.press('Enter');
    assert.equal(await page.getByTestId('sound-type-tone').getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(() => !document.querySelector('[data-testid="global-stop-audio"]').disabled);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('[data-testid="global-stop-audio"]').disabled);
    await page.getByTestId('sound-type-hiss').press('Space');
    await page.getByTestId('match-ear-right').click();
    await shot(`${mode}-02-match-type`);

    const advance = async (control, heading) => {
      const trigger = page.getByTestId(control);
      if (mode === 'desktop') await trigger.press('Enter');
      else await trigger.click();
      await heading.waitFor();
      assert.ok(await heading.evaluate((el) => el === document.activeElement), `Focus follows ${control}`);
    };
    await advance('step-1-next', page.getByTestId('step-2-panel').getByRole('heading', { level: 2 }));
    await page.waitForSelector('[data-testid="step-2-panel"]');
    await assertNoOverflow(page, `${mode}-match-step2`);

    // Step 2: Coarse Binary Search A/B
    await page.locator('[data-testid="play-probe-a"]').click();
    await page.waitForTimeout(120);
    await page.locator('[data-testid="play-probe-b"]').click();
    await page.waitForTimeout(120);
    await shot(`${mode}-03-match-ab`);

    await page.locator('[data-testid="choose-probe-b"]').click();
    await page.locator('[data-testid="choose-probe-a"]').click();
    await advance('skip-to-fine', page.getByTestId('step-3-panel').getByRole('heading', { level: 2 }));

    // Step 3: Fine slider + log tick alignment + ±1/12 oct nudge + Octave-Confusion Check
    await page.waitForSelector('[data-testid="step-3-panel"]');
    await assertNoOverflow(page, `${mode}-match-step3`);
    await verifyLogTicksAligned(page, `${mode}-match-step3`);
    await verifyDial(page, context, isMobile && engine === 'chromium');

    const fineSlider = page.locator('[data-testid="fine-freq-slider"]');
    await fineSlider.fill('755');
    await fineSlider.dispatchEvent('input');
    const beforeNudge = await page.locator('[data-testid="fine-freq-readout"]').innerText();
    await page.locator('[data-testid="nudge-up-semitone"]').click();
    const afterNudge = await page.locator('[data-testid="fine-freq-readout"]').innerText();
    assert.notEqual(beforeNudge, afterNudge, 'Semitone nudge must change matched frequency');

    if (isMobile) {
      await assertMinTouchTargets(
        page,
        ['[data-testid="play-octave-half"]', '[data-testid="confirm-octave-current"]', '.mini-pill-btn'],
        'mobile-match-step3'
      );
    }

    // Octave check f/2, confirm f
    const octaveHalf = page.getByTestId('play-octave-half');
    const octaveBox = page.getByTestId('octave-check-box');
    const marker = page.locator('.fine-spectrum [data-marker-hz]');
    const draftHz = Number(await page.getByTestId('tuning-dial').getAttribute('aria-valuenow'));
    await octaveHalf.click();
    await octaveHalf.getByText('Stop', { exact: true }).waitFor();
    assert.equal(await octaveBox.locator('.octave-card.playing').count(), 1);
    assert.equal(Number(await marker.getAttribute('data-marker-hz')), Math.round(draftHz / 2));
    await muteBtn.click();
    await octaveHalf.getByText('Hear f/2', { exact: true }).waitFor();
    assert.equal(await octaveBox.locator('.octave-card.playing').count(), 0);
    assert.equal(Number(await marker.getAttribute('data-marker-hz')), draftHz);
    await octaveHalf.click();
    await octaveHalf.getByText('Stop', { exact: true }).waitFor();
    await octaveHalf.click();
    await octaveHalf.getByText('Hear f/2', { exact: true }).waitFor();
    assert.equal(Number(await marker.getAttribute('data-marker-hz')), draftHz);
    await page.locator('[data-testid="confirm-octave-current"]').click();
    await shot(`${mode}-04-match-fine-octave`);

    // Step 4: Loudness & Bandwidth
    await advance('step-3-next', page.getByTestId('step-4-panel').getByRole('heading', { level: 2 }));
    await page.waitForSelector('[data-testid="step-4-panel"]');
    await page.getByTestId('step-4-play-toggle').click();
    await page.getByTestId('bandwidth-match-slider').fill('50');
    assert.equal(await page.getByTestId('bandwidth-match-slider').getAttribute('aria-valuetext'), '0.50 octaves');
    await assertBandEdges(page.getByTestId('match-band-edges'), 0.50);
    const widthTick = await page.locator('[data-width-oct="0.5"]').evaluate((el) => parseFloat(el.style.left));
    assert.ok(Math.abs(widthTick - 21.875) < 0.01);
    await assertNoOverflow(page, `${mode}-match-step4`);
    await shot(`${mode}-04b-match-level`);

    const assertSavedResult = async () => {
      await page.getByTestId('result-saved-badge').getByText('Saved to Private Journal').waitFor();
      await page.getByRole('status').filter({ hasText: 'Tinnitus signature saved to journal' }).waitFor();
      assert.equal(await page.getByTestId('toast-banner').count(), 0, 'Saving Result must not overlay its actions');
    };

    // Step 5: Save + verify consistent headline/stat/CTA + Refine Pitch consistency (MAJOR-3)
    await advance('save-and-view-result', page.getByTestId('result-headline'));
    await assertSavedResult();
    if (isMobile) {
      await verifyPageBottom(page, 'generate-share-card');
      if (SAVE_SCREENSHOTS && ['android-360x640', 'android-390x664', 'webkit'].includes(mode)) {
        await page.screenshot({ path: path.join(QA_DIR, `${mode}-round9-result.jpg`), type: 'jpeg', quality: 80, animations: 'disabled' });
      }
    }
    const headline = await page.locator('[data-testid="result-headline"]').innerText();
    const pitchStat = await page.locator('[data-testid="result-center-pitch"]').innerText();
    assert.ok(headline.includes(pitchStat), `Headline "${headline}" must agree with stat "${pitchStat}"`);
    assert.ok(headline.includes('narrow-band hiss'), `Result headline should describe hiss: ${headline}`);
    assert.ok(headline.includes('right ear'), `Result headline should include right ear: ${headline}`);
    await assertBandEdges(page.getByTestId('result-band-edges'), 0.50);

    // Refine pitch -> tune higher -> return to Step 5 -> verify unsaved draft & unified pitch -> save
    await page.locator('[data-testid="result-refine-pitch"]').click();
    await page.waitForSelector('[data-testid="step-3-panel"]');
    await page.getByTestId('tuning-dial').press('End');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('step-3-panel').waitFor();
    assert.equal(await page.getByTestId('tuning-dial').getAttribute('aria-valuenow'), '18000');
    assert.equal(await fineSlider.getAttribute('aria-valuetext'), '18,000 Hz');
    assert.equal(await page.getByTestId('header-profile-chip').innerText().then((text) => text.includes('18 kHz')), false);
    await page.locator('[data-testid="match-step-5"]').click();
    await page.waitForSelector('[data-testid="result-unsaved-badge"]');
    await assertBandEdges(page.getByTestId('result-band-edges'), 0.50);
    const refinedHeadline = await page.locator('[data-testid="result-headline"]').innerText();
    const refinedStat = await page.locator('[data-testid="result-center-pitch"]').innerText();
    assert.ok(
      refinedHeadline.includes(refinedStat),
      `After refine, headline "${refinedHeadline}" must agree with stat "${refinedStat}"`
    );
    assert.notEqual(refinedStat, pitchStat, 'Refined pitch should differ from initial match');
    await page.locator('[data-testid="step5-save-match"]').click();
    await assertSavedResult();

    await assertNoOverflow(page, `${mode}-match-result`);
    await shot(`${mode}-05-match-result`);
    await verifyShareSheet(page, 'generate-share-card', 'share-card-preview', `${mode}-05b-result-share`, engine, context);

    // 3. Relief Tools — Notched Sound Therapy
    await page.locator('[data-testid="result-start-relief"]').click();
    await page.waitForSelector('[data-testid="therapy-panel"]');
    await assertNoOverflow(page, `${mode}-relief-therapy`);
    await assertMuteVisibleInViewport(page, `${mode}-relief-therapy`);
    if (mode === 'desktop' || mode === 'webkit') {
      const therapyTab = page.getByTestId('relief-tab-therapy');
      const musicTab = page.getByTestId('relief-tab-music');
      const riTab = page.getByTestId('relief-tab-ri');
      const assertActiveTool = async (tab) => {
        assert.equal(await tab.getAttribute('aria-selected'), 'true');
        assert.ok(await tab.evaluate((el) => el === document.activeElement && el.tabIndex === 0));
        const panel = page.locator(`#${await tab.getAttribute('aria-controls')}`);
        assert.ok(await panel.isVisible());
        assert.equal(await panel.getAttribute('aria-labelledby'), await tab.getAttribute('id'));
        assert.equal(await page.locator('[role="tab"][tabindex="0"]').count(), 1);
      };
      await therapyTab.press('ArrowRight');
      await assertActiveTool(musicTab);
      await page.keyboard.press('End');
      await assertActiveTool(riTab);
      await page.keyboard.press('ArrowRight');
      await assertActiveTool(therapyTab);
      await page.keyboard.press('ArrowLeft');
      await assertActiveTool(riTab);
      await page.keyboard.press('Home');
      await assertActiveTool(therapyTab);
    }
    if (isMobile) {
      for (const id of ['relief-tab-ri', 'timer-30']) {
        const highlight = await page.getByTestId(id).evaluate((el) => getComputedStyle(el).webkitTapHighlightColor);
        assert.equal(highlight, 'rgba(0, 0, 0, 0)');
      }
    }
    const routeRight = page.getByTestId('therapy-ear-right');
    const routeLeft = page.getByTestId('therapy-ear-left');
    assert.equal(await routeRight.getAttribute('aria-pressed'), 'true');
    if (mode === 'mobile') {
      await therapyPlay.click();
      await assertStereoRoute(page, 1, 'saved Right with Setup Both, before reload');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await therapyPlay.waitFor();
      assert.equal(await routeRight.getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#notch-center-slider').inputValue(), '1000');
      await therapyPlay.click();
      await assertStereoRoute(page, 1, 'saved Right with Setup Both, after reload');
      await routeLeft.click();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await routeLeft.waitFor();
      assert.equal(await routeLeft.getAttribute('aria-pressed'), 'true');
      await therapyPlay.click();
      await assertStereoRoute(page, 0, 'explicit Left override after reload');
      await routeRight.click();
      await muteBtn.click();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await routeRight.waitFor();
      assert.equal(await routeRight.getAttribute('aria-pressed'), 'true');
    }


    await page.locator('[data-testid="noise-type-pink"]').click();
    await page.locator('[data-testid="notch-width-1"]').click();
    if (viewport.width <= 530) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await assertInsideVisualViewport(therapyPlay, `${mode} garden transport from top of Relief`);
      assert.equal(await page.locator('.garden-legend [data-testid="therapy-play-toggle"]').count(), 1);
      assert.match(await therapyPlay.innerText(), /^Start Pink$/);
    }
    if (mode === 'mobile') {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await therapyPlay.evaluate((el) => {
        const paint = () => {
          const { color, backgroundColor } = getComputedStyle(el);
          return [color, backgroundColor];
        };
        const observer = new MutationObserver(() => {
          if (!el.classList.contains('btn-amber')) return;
          window.qaPauseColors = paint();
          observer.disconnect();
        });
        observer.observe(el, { attributes: true, attributeFilter: ['class'] });
      });
      await therapyPlay.tap();
      await therapyPlay.getByText('Pause Pink').waitFor();
      const [foreground, fill] = await page.evaluate(() => window.qaPauseColors);
      assert.equal(foreground, 'rgb(251, 245, 232)', 'The phone Pause label starts in cream');
      assert.ok(['rgb(134, 57, 38)', 'rgb(113, 48, 31)'].includes(fill), 'The phone Pause fill starts in rust');
      await page.emulateMedia({ reducedMotion: 'reduce' });
    } else await therapyPlay.click();
    await page.waitForTimeout(320);
    if (mode === 'android-360x640' || mode === 'webkit') await verifyLandscapeHeader(page, mode);
    await assertMuteVisibleInViewport(page, `${mode}-relief-therapy-playing`);
    await verifyPageBottom(page, 'therapy-play-toggle');
    await shot(`${mode}-06-relief-therapy`);

    // The garden tracks the real DSP notch controls.
    const gap = page.getByTestId('garden-gap');
    await gap.waitFor();
    const gapLeft = await gap.evaluate((el) => el.style.left);
    await page.locator('#notch-center-slider').fill('650');
    const editedCenter = await page.getByTestId('notch-center-slider').getAttribute('aria-valuetext');
    assert.match(editedCenter, /^[\d,]+ Hz$/);
    assert.notEqual(editedCenter, '18,000 Hz');
    assert.notEqual(await gap.evaluate((el) => el.style.left), gapLeft, 'Garden clearing tracks the notch');
    await page.getByTestId('notch-bypass-toggle').click();
    await gap.waitFor({ state: 'detached' });
    await page.getByTestId('notch-bypass-toggle').click();
    await gap.waitFor();
    await page.locator('[data-testid="global-stop-audio"]').click();

    // Relief — Notch Your Own Music (built-in AudioBuffer sample + local WAV upload + same-file re-upload)
    await page.locator('[data-testid="relief-tab-music"]').click();
    await page.waitForSelector('[data-testid="music-panel"]');
    if (mode === 'desktop') {
      await assertTabBetween(page, page.getByTestId('notch-width-1.5'), page.getByTestId('choose-music-file-btn'));
    }
    await page.locator('[data-testid="load-sample-music-btn"]').click();
    await page.waitForSelector('[data-testid="music-transport"]');
    await page.locator('[data-testid="music-play-toggle"]').click();
    await page.getByTestId('music-play-toggle').getByText('Pause Notched').waitFor();
    await page.getByRole('slider', { name: 'Audio playback position' }).fill('5');
    assert.equal(await page.getByRole('slider', { name: 'Audio playback position' }).inputValue(), '5');
    const toggle = page.getByTestId('notch-bypass-toggle');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    await page.getByTestId('music-play-toggle').getByText('Pause Notched').waitFor();
    await verifyPageBottom(page, 'music-vol-slider', 'id');
    await shot(`${mode}-07-relief-music`);
    await page.locator('[data-testid="global-stop-audio"]').click();

    // Upload local WAV + verify input value resets so same file can be re-selected (MINOR-5)
    const wavBuf = makeTinyWavBuffer();
    await page.getByTestId('music-file-input').setInputFiles({
      name: 'empty.mp3', mimeType: 'audio/mpeg', buffer: Buffer.alloc(0),
    });
    assert.match(await page.getByTestId('music-error').innerText(), /audio file is empty/);
    const longName = `My recording 🎧 فارسی ${'aز'.repeat(72)}.wav`;
    assert.ok(Buffer.byteLength(longName) <= 255, 'The mixed-script name fits the common 255-byte filename limit');
    await page.locator('[data-testid="music-file-input"]').setInputFiles({
      name: longName,
      mimeType: 'audio/wav',
      buffer: wavBuf,
    });
    await page.locator('[data-testid="music-transport"]').getByText(longName).waitFor();
    const inputValAfter = await page.locator('[data-testid="music-file-input"]').inputValue();
    assert.equal(inputValAfter, '', 'Music file input value must reset after selection');

    const localPlay = page.getByTestId('music-play-toggle');
    const repeat = page.getByTestId('music-repeat-toggle');
    assert.equal(await repeat.getAttribute('aria-pressed'), 'false');
    await verifyPageBottom(page, 'music-play-toggle');
    if (isMobile) await localPlay.tap();
    else await localPlay.click();
    const playingFile = localPlay.getByText(/^Pause/);
    const musicError = page.getByTestId('music-error');
    await playingFile.or(musicError).waitFor({ timeout: 12000 });
    if (silentWebKit && await musicError.isVisible()) {
      assert.match(await musicError.innerText(), /decod|format|audio data/i);
      console.log('[PASS] Headless WebKit missing file codec is handled without a crash');
    } else {
      await playingFile.waitFor({ timeout: 5000 });
      if (measuredAudio) await assertAudition(page, 440);
      await toggle.click();
      assert.equal(await toggle.getAttribute('aria-checked'), 'false');
      assert.match(await localPlay.innerText(), /Pause Bypassed/);
      await toggle.click();
      await playingFile.waitFor();
      await localPlay.getByText('Replay Notched').waitFor({ timeout: 6000 });
      assert.ok(await muteBtn.isDisabled(), 'Local track stops at its real end');
      if (SAVE_SCREENSHOTS && (mode === 'desktop' || mode === 'mobile')) {
        await page.getByTestId('music-transport').screenshot({
          path: path.join(QA_DIR, `${mode}-round5-replay.jpg`), type: 'jpeg', quality: 82,
        });
      }
      await repeat.click();
      assert.equal(await repeat.getAttribute('aria-pressed'), 'true');
      if (engine === 'chromium') {
        await page.locator('audio').evaluate((el) => {
          let reachedEnd = false;
          const observeWrap = () => {
            if (el.paused) return;
            if (el.currentTime > el.duration * 0.7) reachedEnd = true;
            if (reachedEnd && el.currentTime < el.duration * 0.3) {
              el.dataset.wrapped = 'true';
              el.removeEventListener('timeupdate', observeWrap);
            }
          };
          el.addEventListener('timeupdate', observeWrap);
        });
      }
      await localPlay.click();
      await playingFile.waitFor();
      if (engine === 'chromium') {
        await page.waitForFunction(() => document.querySelector('audio').dataset.wrapped === 'true');
      }
      await playingFile.waitFor();
      await repeat.click();
      assert.equal(await repeat.getAttribute('aria-pressed'), 'false');
      await localPlay.getByText('Replay Notched').waitFor({ timeout: 6000 });
    }

    // Verify toast does not cause horizontal overflow on long filenames (MINOR-2)
    await assertNoOverflow(page, `${mode}-relief-music-long-toast`);

    // Relief — Residual-Inhibition Test
    await page.getByTestId('relief-tab-therapy').click();
    await routeLeft.click();
    await page.locator('[data-testid="relief-tab-ri"]').click();
    await page.waitForSelector('[data-testid="ri-panel"]');
    assert.match(await page.getByTestId('ri-match').innerText(), /Saved match · 18,000 Hz · right ear/);
    await assertBandEdges(page.getByTestId('ri-band-edges'), 0.45);
    if (['desktop', 'mobile', 'webkit'].includes(mode)) await snap(page, `${mode}-round5-ri-match`, false);
    await page.locator('[data-testid="ri-dur-10"]').click();
    if (mode === 'desktop') {
      await page.getByTestId('ri-start-btn').click();
      await page.getByTestId('ri-masking-phase').waitFor();
      await assertStereoRoute(page, 1, 'RI uses saved Right despite Left relief override');
      await assertMaskSpectrum(page, 18000, Number(editedCenter.replace(/[^\d]/g, '')));
      await page.clock.fastForward(1000);
      await muteBtn.click();
      await page.getByTestId('ri-start-btn').waitFor();
      await page.getByTestId('relief-tab-therapy').click();
      await page.getByTestId('timer-15').click();
      await toggle.click();
      assert.match(await therapyPlay.innerText(), /Start Pink \(Bypassed\)/);
      await page.getByTestId('therapy-play-toggle').click();
      await therapyPlay.getByText('Pause Pink (Bypassed)').waitFor();
      await page.clock.fastForward(21000);
      assert.ok(!(await muteBtn.isDisabled()), 'A stale RI deadline cannot stop a new sound');
      await muteBtn.click();
      await page.getByTestId('therapy-play-toggle').click();
      await therapyPlay.getByText('Pause Pink (Bypassed)').waitFor();
      await page.clock.fastForward(8000);
      await toggle.click();
      await therapyPlay.getByText('Pause Pink Notched Therapy').waitFor();
      await page.clock.fastForward(14000);
      await clickNav('journal');
      await page.getByTestId('history-session-row').getByText(/Muted/).waitFor();
      await page.getByTestId('history-session-row').getByText(/Left tool/).waitFor();
      const filterFor = (label) => page.getByTestId('history-session-row').filter({ hasText: label })
        .getByTestId('history-session-filter');
      assert.match(await filterFor('Muted').innerText(), /^Pink · Bypassed · ≈?\d+s$/);
      assert.match(await filterFor('Left tool').innerText(), /^Pink · Bypassed · ≈?\d+s\s+Pink · Notched · .+ · 1\.0 oct · ≈?\d+s$/);
      assert.equal(await page.getByTestId('history-ri-row').count(), 0);
      await clickNav('relief');
      await page.getByTestId('timer-15').click();
      await page.getByTestId('therapy-play-toggle').click();
      await page.getByTestId('therapy-play-toggle').getByText(/Pause/).waitFor();
      await page.clock.fastForward(24000);
      await clockShows(page, '14:3[56]');
      await page.getByTestId('timer-60').click();
      assert.equal(await page.getByTestId('timer-60').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.getByTestId('timer-15').getAttribute('aria-pressed'), 'false');
      await clockShows(page, '59:3[56]');
      await page.clock.fastForward(877000);
      await clockShows(page, '44:5[78]');
      await therapyPlay.click();
      await therapyPlay.getByText(/Resume/).waitFor();
      const paused = await page.getByTestId('therapy-countdown').innerText();
      assert.match(paused, /44:5[6789]/);
      await page.clock.fastForward(24000);
      assert.equal(await page.getByTestId('therapy-countdown').innerText(), paused);
      await therapyPlay.click();
      await therapyPlay.getByText(/Pause/).waitFor();
      await clockShows(page, paused);
      await page.clock.fastForward(4000);
      await clockShows(page, '44:5[234]');
      await page.getByTestId('timer-30').click();
      await clockShows(page, '14:5[234]');
      await page.clock.fastForward(864000);
      await clockShows(page, '00:(2[6-9]|30)');
      await page.clock.fastForward(31000);
      await clockShows(page, '00:00');
      console.log(`  [timer] 15m → 60m, held at ${paused} through 24s paused, resumed, retimed 30m and completed at 00:00`);
      await muteBtn.waitFor();
      assert.ok(await muteBtn.isDisabled());
      await clickNav('journal');
      await page.getByTestId('history-session-row').getByText(/Completed/).waitFor();
      await clickNav('relief');
      await page.getByTestId('relief-tab-ri').click();
      await page.getByTestId('ri-dur-10').click();
    }
    const timedRI = mode === 'desktop' || mode === 'android-360x640' || mode === 'webkit';
    if (mode === 'desktop') {
      await page.evaluate(() => {
        const start = AudioBufferSourceNode.prototype.start;
        AudioBufferSourceNode.prototype.start = function (when, ...args) {
          if (window.qaHoldMaskTick) window.qaMaskStartedAt = when;
          return start.call(this, when, ...args);
        };
        const interval = window.setInterval;
        window.setInterval = (callback, delay, ...args) => interval(() => {
          if (delay !== 100 || !window.qaHoldMaskTick) callback(...args);
        }, delay);
        window.qaHoldMaskTick = true;
      });
    }
    const startRI = page.getByTestId('ri-start-btn');
    if (timedRI && mobileNav) {
      await startRI.evaluate((button) => {
        document.documentElement.style.setProperty('--safe-area-bottom', '21px');
        const navTop = document.querySelector('.mobile-bottom-nav').getBoundingClientRect().top;
        window.scrollBy({ top: button.getBoundingClientRect().bottom - navTop + 3, behavior: 'instant' });
      });
      await assertInsideVisualViewport(startRI, 'mask start just above the bottom bar');
      const point = await startRI.boundingBox();
      await page.touchscreen.tap(point.x + point.width / 2, point.y + point.height / 2);
    } else await startRI.click();
    await page.waitForSelector('[data-testid="ri-masking-phase"]');
    if (mode === 'desktop') {
      await page.waitForFunction(() => window.qaOutputAnalyser.context.currentTime - window.qaMaskStartedAt >= 1);
      await assertStereoRoute(page, 1, 'RI before the audio deadline');
      await page.waitForFunction(() => window.qaOutputAnalyser.context.currentTime - window.qaMaskStartedAt >= 11.5,
        null, { timeout: 18000 });
      assert.ok(await page.getByTestId('ri-masking-phase').isVisible(), 'Page callback must remain delayed during measurement');
      const afterDeadline = await page.evaluate(() => window.qaOutputChannels.slice(1).map((analyser) => {
        const samples = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(samples);
        return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
      }));
      assert.deepEqual(afterDeadline, [0, 0], 'Both destination channels must be silent while the page callback is delayed');
      await page.evaluate(() => { window.qaHoldMaskTick = false; });
      console.log('  [RI] destination output after 11.50 s of audio time: L 0 / R 0 RMS while the page still shows Masking');
    }
    else if (!timedRI) {
      await page.waitForTimeout(300);
      await page.locator('[data-testid="ri-skip-to-silence"]').click();
    }
    await page.waitForSelector('[data-testid="ri-listening-phase"]');
    const response = page.getByTestId('ri-returned-btn');
    if (mode === 'desktop') {
      assert.ok(parseFloat(await page.getByTestId('ri-stopwatch').innerText()) >= 1.4,
        'Silence stopwatch includes the delay since the audio endpoint');
    }
    await assertInsideVisualViewport(response, `${mode} response as the RI timer starts`);
    await assertInsideVisualViewport(page.getByTestId('ri-stopwatch'), `${mode} RI timer as it starts`);
    assert.ok(await response.evaluate((el) => el === document.activeElement));
    assert.ok(await response.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    }), `${mode} RI response can receive a tap at transition`);
    if (timedRI && mobileNav) {
      const placement = await response.evaluate((el) => ({
        responseBottom: Math.round(el.getBoundingClientRect().bottom),
        navTop: Math.round(document.querySelector('.mobile-bottom-nav').getBoundingClientRect().top),
      }));
      console.log(`  [RI] ${mode} button bottom ${placement.responseBottom}px, bar top ${placement.navTop}px (21px inset)`);
      if (SAVE_SCREENSHOTS) await page.screenshot({ path: path.join(QA_DIR, `${mode}-round6-ri-transition.jpg`), type: 'jpeg', quality: 75 });
    }
    await page.waitForTimeout(300);
    await shot(`${mode}-08-relief-ri`);
    await page.locator('[data-testid="ri-returned-btn"]').click();
    await page.waitForSelector('[data-testid="ri-done-phase"]');
    if (timedRI && mobileNav) {
      await page.evaluate(() => document.documentElement.style.removeProperty('--safe-area-bottom'));
    }

    let recoveryCheckpoint;
    if (mode === 'desktop' || mode === 'webkit') {
      if (mode === 'webkit') await page.clock.install();
      await page.getByTestId('relief-tab-therapy').click();
      await therapyPlay.click();
      await therapyPlay.getByText(/^Pause/).waitFor();
      await page.clock.fastForward(8000);
      await toggle.click();
      await page.clock.fastForward(10000);
      recoveryCheckpoint = await page.evaluate(() => {
        const key = Object.keys(sessionStorage).find((item) => item.startsWith('tinnitune_session_checkpoint_'));
        return key ? JSON.parse(sessionStorage.getItem(key)) : null;
      });
      assert.ok(recoveryCheckpoint?.durationSeconds >= 18, 'Active playback checkpoints before reload');
      if (mode === 'webkit') {
        await page.evaluate(() => {
          window.addEventListener('pagehide', (event) => event.stopImmediatePropagation(), { capture: true, once: true });
        });
      }
      await page.reload({ waitUntil: 'domcontentloaded' });
      await therapyPlay.getByText(/^Start/).waitFor();
      assert.ok(await muteBtn.isDisabled(), 'Reload stays silent');
      await clickNav('journal');
      await page.getByTestId('history-filter-sessions').click();
      const recovered = page.getByTestId('history-session-row').filter({ hasText: 'Interrupted' });
      await recovered.waitFor();
      const recoveredBed = mode === 'desktop' ? 'Rain' : 'Pink';
      assert.match(await recovered.getByTestId('history-session-filter').innerText(),
        new RegExp(`^${recoveredBed} · Notched[^\\n]+\\s+${recoveredBed} · Bypassed · ≈?\\d+s$`));
      if (SAVE_SCREENSHOTS) {
        await recovered.screenshot({ path: path.join(QA_DIR, `${mode}-round5-session.jpg`), type: 'jpeg', quality: 82 });
      }
      await page.reload({ waitUntil: 'domcontentloaded' });
      await recovered.waitFor();
      assert.equal(await recovered.count(), 1, 'Reconciliation does not duplicate the recovered row');

      await clickNav('relief');
      await page.getByTestId('relief-tab-music').click();
      await page.getByTestId('load-sample-music-btn').click();
      await toggle.click();
      await localPlay.getByText('Play Bypassed').click();
      await localPlay.getByText('Pause Bypassed').waitFor();
      await page.clock.fastForward(17000);
      await toggle.click();
      await localPlay.getByText('Pause Notched').waitFor();
      await page.clock.fastForward(5000);
      await muteBtn.click();
      await clickNav('journal');
      await page.getByTestId('history-session-row').filter({ hasText: 'Nocturne Dmaj9 Ambient Sample' })
        .getByTestId('history-session-filter').getByText(/Notched/).waitFor();
    }

    // 4. Journal — Daily Check-in + Adversarial Inputs + Therapy Sessions in History + Reload Persistence
    await clickNav('journal');
    await page.waitForSelector('[data-testid="checkin-form"]');
    await assertNoOverflow(page, `${mode}-journal-initial`);

    if (isMobile) {
      await assertMinTouchTargets(
        page,
        ['[data-testid="loudness-rate-5"]', '.tag-chip', '[data-testid="export-json-btn"]'],
        'mobile-journal'
      );
    }

    await shot(`${mode}-09a-journal-empty`);
    if (isMobile) await verifyJournalKeyboard(page, mode);
    if (mode === 'desktop') {
      await assertTabBetween(page, page.getByTestId('import-json-btn'), page.getByTestId('journal-share-latest'));
    }

    const countBeforeCheckIn = await page.getByTestId('history-checkin-row').count();
    const note = `Quiet after rain · شب آرام 🎧 ${'Aژ'.repeat(130)} ${'Unbroken segment '.repeat(165).trim()} END-MARKER`;
    await page.getByTestId('loudness-rate-6').click();
    await page.getByTestId('annoyance-rate-4').click();
    await page.getByTestId('checkin-note-input').fill(note);
    const saveCheckIn = page.getByTestId('save-checkin-btn');
    if (engine === 'webkit' && isMobile) await saveCheckIn.tap();
    else await saveCheckIn.dblclick();
    const readNote = page.getByRole('button', { name: 'Read full note' });
    await readNote.waitFor();
    const noteId = await readNote.getAttribute('aria-controls');
    const previewNote = page.locator(`[id="${noteId}"]`);
    const height = await previewNote.evaluate((el) => el.clientHeight);
    assert.ok(height <= 75, `Collapsed note preview was ${height}px`);
    assert.ok(!(await previewNote.textContent()).includes('END-MARKER'));
    assert.equal(await readNote.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.getByTestId('history-checkin-row').count(), countBeforeCheckIn + 1);
    if (SAVE_SCREENSHOTS && mode === 'android-360x640') {
      await readNote.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(QA_DIR, 'android-360x640-note-preview.jpg'), type: 'jpeg', quality: 78 });
    }
    await readNote.click();
    const showLess = page.getByRole('button', { name: 'Show less' });
    assert.equal(await showLess.getAttribute('aria-expanded'), 'true');
    assert.equal(await previewNote.textContent(), note);
    await showLess.click();
    assert.ok(!(await previewNote.textContent()).includes('END-MARKER'));
    await page.waitForSelector('[data-testid="history-match-row"]');
    await page.waitForSelector('[data-testid="history-ri-row"]');
    assert.match(await page.getByTestId('history-ri-row').first().innerText(), /18 kHz · right ear · [\d.]+s mask/);
    await assertNoOverflow(page, `${mode}-journal-long-note`);

    // Invalid JSON import shows clear error state
    await page.locator('[data-testid="import-json-input"]').setInputFiles({
      name: 'bad.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{not valid json'),
    });
    await page.waitForSelector('[data-testid="import-error"]');
    assert.equal(
      await page.locator('[data-testid="import-json-input"]').inputValue(),
      '',
      'Import file input must reset after selection'
    );

    // Adversarial out-of-range JSON import + therapy session record (MAJOR-4 & MAJOR-6)
    const adversarialBackup = JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      app: 'tinnitune',
      calibration: {
        ear: 'right',
        comfortLevel: 0.55,
        headphonesChecked: true,
        leftHeard: true,
        rightHeard: true,
        safetyAcknowledged: true,
      },
      activeMatchId: null,
      matches: [],
      checkins: [
        { id: 'invalid-timestamp', createdAt: 9e15, dateKey: '2026-11-22', loudness: 1, note: 'Invalid timestamp' },
        { id: 'invalid-calendar', createdAt: Date.now(), dateKey: '2026-02-31', loudness: 1, note: 'Invalid calendar' },
        {
          id: 'chk_seed_adv',
          createdAt: Date.now() - 86400000,
          dateKey: '2026-11-22',
          loudness: 99,
          annoyance: -5,
          tags: ['Quiet room'],
          note: 'Out-of-range loudness/annoyance must clamp to 1..10',
        },
      ],
      riTests: [],
      sessions: [
        {
          id: 'sess_seed_1',
          createdAt: Date.now() - 3600000,
          mode: 'notched-noise',
          noiseType: 'rain',
          frequencyHz: 6350,
          notchWidthOct: 1.0,
          durationSeconds: 1800,
        },
        {
          id: 'sess_seed_music', createdAt: Date.now() - 3000, mode: 'notched-music',
          trackName: longName, frequencyHz: 15500, notchWidthOct: 1, durationSeconds: 24, endReason: 'muted',
        },
      ],
    });
    await page.locator('[data-testid="import-json-input"]').setInputFiles({
      name: 'backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(adversarialBackup),
    });
    await page.getByTestId('import-error').getByText(/2 records were skipped/).waitFor();
    await page.getByTestId('history-session-row').getByText(longName, { exact: true }).waitFor();
    assert.equal(await page.getByTestId('history-session-row').filter({ hasText: longName })
      .getByTestId('history-session-filter').innerText(), 'Filter state unavailable');
    await readNote.click();
    assert.ok(await page.locator('.history-note').filter({ hasText: 'END-MARKER' }).evaluate(
      (el) => el.clientHeight > 32 && el.scrollWidth <= el.clientWidth + 1,
    ), 'Mixed-script note wraps inside its history row');
    await showLess.click();
    await assertNoOverflow(page, `${mode}-imported-mixed-script-filename`);

    // Assert loudness was clamped (AVG LOUDNESS <= 10.0) & SVG circles inside chart bounds
    const avgLoudnessText = await page.locator('[data-testid="metric-avg-loudness"]').innerText();
    const avgVal = parseFloat(avgLoudnessText);
    assert.ok(avgVal >= 1 && avgVal <= 10, `Clamped Avg Loudness must be 1..10, got "${avgLoudnessText}"`);

    const chartBoundsOk = await page.evaluate(() => {
      const circles = Array.from(document.querySelectorAll('[data-testid="trend-chart-svg"] circle'));
      return circles.length > 0 && circles.every((c) => {
        const cy = Number(c.getAttribute('cy'));
        return Number.isFinite(cy) && cy >= 10 && cy <= 170;
      });
    });
    assert.ok(chartBoundsOk, 'All TrendChart SVG points must stay inside chart Y bounds');

    // Verify Sessions filter tab shows session row(s) & delete works (MAJOR-4)
    await page.locator('[data-testid="history-filter-sessions"]').click();
    const sessCountBefore = await page.locator('[data-testid="history-session-row"]').count();
    assert.ok(sessCountBefore >= 1, `Expected >= 1 therapy session row, got ${sessCountBefore}`);
    await page.locator('[data-testid="history-filter-all"]').click();
    await shot(`${mode}-09-journal`);
    await verifyShareSheet(page, 'journal-share-latest', 'journal-share-preview', `${mode}-09b-journal-share`, engine, context);

    const rowShare = page.getByTestId('history-match-row').first()
      .getByRole('button', { name: 'Generate share card for this match' });
    await rowShare.click();
    const journalSheet = page.getByTestId('journal-share-preview');
    await journalSheet.getByRole('button', { name: 'Close share preview' }).click();
    assert.ok(await rowShare.evaluate((el) => el === document.activeElement), 'Row share restores focus');

    const exported = await downloadBackup(page);
    assert.ok(exported.matches.length >= 1 && exported.checkins.length >= 2 && exported.sessions.length >= 1);
    assert.ok(exported.riTests.every((item) => item.frequencyHz === 18000 && item.ear === 'right'));
    assert.equal(exported.checkins.find((item) => item.note.endsWith('END-MARKER')).note, note);
    if (mode === 'desktop') {
      assert.equal(exported.riTests.length, 1);
      assert.equal(exported.riTests[0].stimulusSeconds, 10);
      assert.ok(exported.riTests[0].reliefSeconds >= 1.7, 'Saved silence duration includes the delayed callback');
      console.log(`  [RI] exported ${exported.riTests[0].stimulusSeconds} s masker and ${exported.riTests[0].reliefSeconds} s silence`);
      const bypassed = exported.sessions.find((item) => item.mode === 'notched-noise' && item.endReason === 'muted');
      assert.ok(bypassed?.durationSeconds >= 21 && bypassed.durationSeconds <= 23);
      assert.deepEqual(bypassed.filterSegments.map((segment) => segment.state), ['bypassed']);
      const mixed = exported.sessions.find((item) => item.endReason === 'left');
      assert.ok(mixed?.durationSeconds >= 22 && mixed.durationSeconds <= 24);
      assert.deepEqual(mixed.filterSegments.map((segment) => segment.state), ['bypassed', 'notched']);
      assert.ok(mixed.filterSegments[0].durationSeconds >= 8 && mixed.filterSegments[1].durationSeconds >= 14);
      assert.equal(mixed.filterSegments[1].frequencyHz, Number(editedCenter.replace(/[^\d]/g, '')));
      assert.equal(mixed.filterSegments[1].notchWidthOct, 1);
      assert.ok(exported.sessions.some((item) => item.endReason === 'completed' && item.durationSeconds === 1800));
      assert.equal(exported.sessions.filter((item) => item.endReason === 'paused').length, 0,
        'Pausing the timer keeps one continuous session record');
    } else if (timedRI) {
      assert.ok(exported.riTests.some((item) => item.stimulusSeconds === 10));
    } else {
      assert.ok(exported.riTests.some((item) => item.stimulusSeconds > 0 && item.stimulusSeconds < 10));
    }
    if (recoveryCheckpoint) {
      const recovered = exported.sessions.filter((item) => item.endReason === 'interrupted');
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0].id, recoveryCheckpoint.id);
      assert.ok(recovered[0].durationSeconds >= recoveryCheckpoint.durationSeconds
        && recovered[0].durationSeconds <= recoveryCheckpoint.durationSeconds + 2);
      assert.deepEqual(recovered[0].filterSegments.map((segment) => segment.state), ['notched', 'bypassed']);
      const music = exported.sessions.find((item) =>
        item.mode === 'notched-music' && item.trackName === 'Nocturne Dmaj9 Ambient Sample (Built-in)');
      assert.ok(music, `Missing music session in backup: ${JSON.stringify(exported.sessions)}`);
      assert.deepEqual(music.filterSegments.map((segment) => segment.state), ['bypassed', 'notched']);
      assert.ok(music.filterSegments[0].durationSeconds >= 17 && music.filterSegments[1].durationSeconds >= 5,
        `Unexpected music segment durations: ${JSON.stringify(music.filterSegments)}`);
    }
    await uploadBackup(page, exported);
    await page.getByTestId('toast-banner').getByText(new RegExp(`Imported ${exported.matches.length} matches`)).waitFor();
    const restoredBackup = await downloadBackup(page);
    assert.deepEqual({ ...restoredBackup, exportedAt: exported.exportedAt }, exported);
    await assertNoOverflow(page, `${mode}-after-lossless-restore`);

    // Reload persistence verification
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="history-session-row"]');
    assert.ok((await page.locator('[data-testid="history-checkin-row"]').count()) >= 2);
    assert.ok((await page.locator('[data-testid="history-match-row"]').count()) >= 1);
    assert.ok((await page.locator('[data-testid="history-session-row"]').count()) >= 1);

    // 5. Education View + Browser Back / Forward navigation (MAJOR-5)
    await clickNav('learn');
    await page.waitForSelector('text=Notched sound therapy: honest evidence');
    await assertNoOverflow(page, `${mode}-learn`);
    const learnArtLoaded = await page
      .waitForFunction(() => {
        const img = document.querySelector('.hero-banner-art');
        return Boolean(img && img.complete && img.naturalWidth > 0);
      }, null, { timeout: 15000 })
      .then(() => true, () => false);
    assert.ok(learnArtLoaded, 'Education WebP artwork must load cleanly');
    const sourceLinks = await page.locator('.source-note a').evaluateAll((links) => links.map((link) => link.href));
    assert.equal(sourceLinks.length, 12);
    assert.ok(sourceLinks.every((href) => /^https:\/\//.test(href)));
    await shot(`${mode}-10-learn`);

    // Browser Back & Forward between tabs
    await page.goBack();
    await page.waitForSelector('[data-testid="checkin-form"]');
    assert.ok(page.url().includes('#journal'), `Expected #journal after goBack, got ${page.url()}`);
    await page.goForward();
    await page.waitForSelector('text=Notched sound therapy: honest evidence');
    assert.ok(page.url().includes('#learn'), `Expected #learn after goForward, got ${page.url()}`);

    if (mode === 'desktop' || mode === 'webkit') {
      // Reproduce the unsaved Left draft handoff over the previously saved Right match.
      const profile = page.getByTestId('header-profile-chip');
      const assertDraftGate = async () => {
        assert.equal(await profile.getAttribute('title'), 'Active match · 250 Hz · left ear');
        assert.match(await page.getByTestId('ri-match').innerText(), /Unsaved match · 250 Hz · left ear/);
        await page.getByTestId('ri-save-match').waitFor();
        assert.match(await page.getByTestId('ri-use-previous-match').innerText(), /18,000 Hz · right ear/);
        assert.equal(await page.getByTestId('ri-start-btn').count(), 0);
        assert.ok(await muteBtn.isDisabled());
      };
      const handoffDraft = async () => {
        await clickNav('match');
        await page.getByTestId('match-step-3').click();
        await page.getByTestId('tuning-dial').press('Home');
        await page.getByTestId('match-ear-left').click();
        await page.getByTestId('match-step-5').click();
        await page.getByTestId('result-unsaved-badge').waitFor();
        assert.match(await page.getByTestId('result-headline').innerText(), /250 Hz.+left ear/);
        await page.getByTestId('result-start-relief').click();
        await page.getByTestId('relief-tab-ri').click();
        await assertDraftGate();
      };
      const reloadIntoRI = async () => {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.getByTestId('relief-tab-ri').click();
      };
      const runSelectedMask = async (hz, ear, alternateHz) => {
        const matchLabel = `${hz.toLocaleString('en-US')} Hz · ${ear} ear`;
        assert.equal(await profile.getAttribute('title'), `Active match · ${matchLabel}`);
        assert.match(await page.getByTestId('ri-match').innerText(), new RegExp(`Saved match · ${matchLabel}`));
        await page.getByTestId('ri-start-btn').click();
        await page.getByTestId('ri-masking-phase').waitFor();
        if (measuredAudio) {
          await assertStereoRoute(page, ear === 'left' ? 0 : 1, `RI selected ${hz} Hz ${ear}`);
          await assertMaskSpectrum(page, hz, alternateHz);
        }
        await page.getByTestId('ri-skip-to-silence').click();
        await page.getByTestId('ri-no-change-btn').click();
        await page.getByTestId('ri-done-phase').waitFor();
      };
      await handoffDraft();
      await reloadIntoRI();
      await assertDraftGate();
      if (SAVE_SCREENSHOTS) await page.screenshot({ path: path.join(QA_DIR, `${mode}-round7-ri-reloaded.jpg`), type: 'jpeg', quality: 77 });
      const previous = page.getByTestId('ri-use-previous-match');
      await previous.click();
      await runSelectedMask(18000, 'right', 250);

      await handoffDraft();
      await page.evaluate(() => sessionStorage.removeItem('tinnitune_relief_draft_v1'));
      await reloadIntoRI();
      assert.match(await page.getByTestId('ri-lost-handoff').innerText(), /draft handoff was lost/i);
      assert.equal(await profile.count(), 0);
      assert.equal(await page.getByTestId('ri-start-btn').count(), 0);
      assert.equal(await page.getByTestId('ri-save-match').count(), 0);
      assert.ok(await muteBtn.isDisabled());
      assert.match(await previous.innerText(), /18,000 Hz · right ear/);
      await previous.click();
      assert.equal(await profile.getAttribute('title'), 'Active match · 18,000 Hz · right ear');
      await page.getByRole('button', { name: 'Begin 60s Masking Phase' }).waitFor();

      await handoffDraft();
      await reloadIntoRI();
      await assertDraftGate();
      await page.getByTestId('ri-save-match').click();
      await page.getByTestId('ri-start-btn').waitFor();
      await runSelectedMask(250, 'left', 18000);
      await clickNav('journal');
      const afterDraft = await downloadBackup(page);
      assert.equal(afterDraft.riTests.length, exported.riTests.length + 2);
      assert.ok(afterDraft.riTests.some(({ frequencyHz, ear }) => frequencyHz === 250 && ear === 'left'));
      assert.equal(afterDraft.riTests.filter(({ frequencyHz, ear }) => frequencyHz === 18000 && ear === 'right').length,
        exported.riTests.length + 1);
      assert.ok(afterDraft.matches.some(({ id, frequencyHz, ear }) => id === afterDraft.activeMatchId && frequencyHz === 250 && ear === 'left'));

      // Close the original tab and recover a mixed-bed session in a new tab.
      await clickNav('relief');
      await therapyPlay.click();
      await therapyPlay.getByText(/^Pause Rain/).waitFor();
      await page.clock.fastForward(18000);
      await page.getByTestId('noise-type-ocean').click();
      await therapyPlay.getByText(/^Pause Ocean/).waitFor();
      await page.clock.fastForward(1200);
      const hiddenCheckpoint = await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
        delete document.hidden;
        const key = Object.keys(localStorage).find((item) => item.startsWith('tinnitune_session_checkpoint_'));
        return key ? JSON.parse(localStorage.getItem(key)) : null;
      });
      assert.equal(hiddenCheckpoint?.noiseType, 'rain');
      assert.ok(hiddenCheckpoint.durationSeconds >= 19);
      await page.clock.fastForward(2100);
      // Isolate pagehide from the close's own visibilitychange.
      await page.evaluate(() => {
        document.addEventListener('visibilitychange', (event) => event.stopImmediatePropagation(), { capture: true });
      });
      if (engine === 'webkit') {
        // WPE does not complete Playwright's runBeforeUnload close. Navigation
        // dispatches the real pagehide before closing the now-empty tab.
        await page.goto('about:blank', { waitUntil: 'load' });
        await page.close();
      } else {
        const closed = page.waitForEvent('close', { timeout: 8000 });
        await page.close({ runBeforeUnload: true });
        await closed;
      }
      const reopened = await context.newPage();
      const reopenedIssues = attachListeners(reopened);
      await reopened.goto(`${BASE_URL}/#journal`, { waitUntil: 'domcontentloaded' });
      await reopened.getByTestId('history-filter-sessions').click();
      const recoveredRain = reopened.getByTestId('history-session-row').filter({ hasText: 'Rain Therapy' })
        .filter({ hasText: 'Interrupted' }).filter({ hasText: 'Ocean · Notched' });
      await recoveredRain.waitFor();
      if (SAVE_SCREENSHOTS) {
        await recoveredRain.screenshot({ path: path.join(QA_DIR, `${mode}-round7-mixed-bed.jpg`), type: 'jpeg', quality: 78 });
      }
      const closedSessions = (await downloadBackup(reopened)).sessions.filter(({ id }) => id === hiddenCheckpoint.id);
      assert.equal(closedSessions.length, 1);
      assert.equal(closedSessions[0].noiseType, 'rain');
      assert.equal(closedSessions[0].endReason, 'interrupted');
      const [rain, ocean] = closedSessions[0].filterSegments;
      assert.deepEqual(closedSessions[0].filterSegments.map(({ noiseType }) => noiseType), ['rain', 'ocean']);
      assert.ok(rain.durationSeconds >= 18 && rain.durationSeconds < 20, JSON.stringify(rain));
      assert.ok(ocean.durationSeconds >= 3.2 && ocean.durationSeconds < 5, JSON.stringify(ocean));
      const elapsedMs = Math.round(rain.durationSeconds * 1000) + Math.round(ocean.durationSeconds * 1000);
      assert.equal(closedSessions[0].durationSeconds, Math.round(elapsedMs / 1000));
      assert.equal(await recoveredRain.getByTestId('history-session-filter').innerText(),
        `Rain · Notched · 250 Hz · 1.0 oct · ${roundedSeconds(rain.durationSeconds)}\nOcean · Notched · 250 Hz · 1.0 oct · ${roundedSeconds(ocean.durationSeconds)}`);
      assert.ok(closedSessions[0].durationSeconds >= hiddenCheckpoint.durationSeconds + 2, 'Pagehide updates the earlier durable checkpoint');
      assert.equal(reopenedIssues.consoleIssues.length, 0, reopenedIssues.consoleIssues.join(' | '));
      assert.equal(reopenedIssues.failedRequests.length, 0, reopenedIssues.failedRequests.join(' | '));
    }

    assert.equal(consoleIssues.length, 0, `Console issues on ${mode}: ${consoleIssues.join(' | ')}`);
    assert.equal(failedRequests.length, 0, `Failed requests on ${mode}: ${failedRequests.join(' | ')}`);
    console.log(`[PASS] ${engine} ${mode} full E2E passed cleanly`);
  } finally {
    await context.close();
  }
}

async function verifyOutputCeiling(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  try {
    await context.addInitScript(() => {
      const NativeAudioContext = window.AudioContext;
      window.AudioContext = class extends NativeAudioContext {
        constructor(options) {
          super({ ...options, sampleRate: sessionStorage.getItem('qa-full-rate') ? 48000 : 32000 });
        }
        createAnalyser() {
          const analyser = super.createAnalyser();
          window.qaOutputAnalyser ??= analyser;
          return analyser;
        }
      };
    });
    const page = await context.newPage();
    await page.clock.install();
    const issues = attachListeners(page);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('safety-ack-checkbox').check();
    await page.getByTestId('nav-match').click();
    await page.getByTestId('match-step-3').click();
    const slider = page.getByTestId('fine-freq-slider');
    const pitch = page.getByTestId('fine-freq-readout');
    const listen = page.getByTestId('fine-play-toggle');
    await slider.press('End');
    assert.equal(await pitch.innerText(), '18,000 Hz');
    await listen.click();
    assert.match(await page.getByTestId('match-pitch-unavailable').innerText(), /18,000 Hz.+14,400 Hz audition limit/);
    assert.ok(await listen.isDisabled());
    assert.ok(await page.getByTestId('global-stop-audio').isDisabled());
    assert.equal(await page.evaluate(() => window.qaOutputAnalyser.context.sampleRate), 32000);
    assert.equal(await outputRms(page), -Infinity, 'Refused high pitch must produce silence at the output');
    assert.equal(await pitch.innerText(), '18,000 Hz');
    assert.equal(await slider.getAttribute('aria-valuetext'), '14,400 Hz');
    if (SAVE_SCREENSHOTS) await snap(page, 'desktop-round7-pitch-ceiling', false);

    await page.getByTestId('match-step-5').click();
    await page.getByTestId('step5-save-match').click();
    await page.getByTestId('result-saved-badge').waitFor();
    await page.getByTestId('result-refine-pitch').click();
    await slider.press('Home');
    await slider.press('End');
    assert.equal(await pitch.innerText(), '14,400 Hz');
    await listen.click();
    await assertAudition(page, 14400);
    await page.getByTestId('global-stop-audio').click();

    await page.getByTestId('nav-relief').click();
    const notchCenter = page.getByTestId('notch-center-slider');
    const notice = page.getByRole('status').filter({ hasText: 'This audio output limits the notch center' });
    assert.match(await notice.innerText(), /15,680 Hz.*18,000 Hz/);
    assert.equal(await notchCenter.getAttribute('aria-valuetext'), '15,680 Hz');
    assert.equal(await notchCenter.inputValue(), '1000');
    if (SAVE_SCREENSHOTS) await page.locator('.notch-strip').screenshot({
      path: path.join(QA_DIR, 'desktop-round8-notch-limit.jpg'), type: 'jpeg', quality: 77,
    });
    await notchCenter.press('ArrowLeft');
    assert.equal(await notice.count(), 0);
    await notchCenter.press('End');
    assert.equal(await notchCenter.getAttribute('aria-valuetext'), '15,680 Hz');
    const therapy = page.getByTestId('therapy-play-toggle');
    await therapy.click();
    await therapy.getByText(/Pause Rain/).waitFor();
    assert.match(await page.getByTestId('notch-garden').innerText(), /Quiet band · 15\.7 kHz/);
    assert.equal(await page.locator('[data-marker-hz]').getAttribute('data-marker-hz'), '15680');
    await page.clock.fastForward(16000);
    await page.getByTestId('global-stop-audio').click();
    await page.getByTestId('nav-journal').click();
    await page.getByTestId('history-session-filter').getByText(/Notched · 15\.7 kHz/).waitFor();
    const exported = await downloadBackup(page);
    assert.equal(exported.matches.find(({ id }) => id === exported.activeMatchId)?.frequencyHz, 18000);
    assert.equal(exported.sessions[0].frequencyHz, 15680);
    assert.equal(exported.sessions[0].filterSegments[0].frequencyHz, 15680);
    await page.getByTestId('nav-match').click();
    await page.getByTestId('tuning-dial').press('End');
    await page.evaluate(() => sessionStorage.setItem('qa-full-rate', '1'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await pitch.innerText(), '18,000 Hz');
    await listen.click();
    await assertAudition(page, 18000);
    await page.getByTestId('global-stop-audio').click();
    assert.deepEqual(issues.consoleIssues, []);
    assert.deepEqual(issues.failedRequests, []);
    console.log('[PASS] Chromium 32 kHz output preserves the 18 kHz match, caps audition at 14.4 kHz and logs the 15,680 Hz notch shown in Relief');
  } finally {
    await context.close();
  }
}

async function verifyOctaveNudges(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  try {
    await context.addInitScript(() => {
      const createAnalyser = AudioContext.prototype.createAnalyser;
      AudioContext.prototype.createAnalyser = function () {
        const analyser = createAnalyser.call(this);
        // The first analyser taps the final limiter output in parallel with the destination.
        window.qaOutputAnalyser ??= analyser;
        return analyser;
      };
    });
    const page = await context.newPage();
    const issues = attachListeners(page);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('safety-ack-checkbox').check();
    await page.getByTestId('nav-match').click();
    await page.getByTestId('match-step-3').click();

    const dial = page.getByTestId('tuning-dial');
    const slider = page.getByTestId('fine-freq-slider');
    const half = page.getByTestId('play-octave-half');
    const halfCard = page.locator('.octave-card').filter({ has: half });
    const marker = page.locator('.fine-spectrum [data-marker-hz]');
    const mute = page.getByTestId('global-stop-audio');
    const downSemitone = page.getByTestId('nudge-down-semitone');
    const downPercent = page.getByRole('button', { name: '−1%', exact: true });
    const hearHalf = async (hz) => {
      assert.equal(await halfCard.locator('strong').innerText(), `${hz.toLocaleString('en-US')} Hz`);
      await half.click();
      await half.getByText('Stop', { exact: true }).waitFor();
      assert.ok(await half.isEnabled(), 'A sounding comparison must have an enabled Stop control');
      assert.equal(await marker.getAttribute('data-marker-hz'), String(hz));
      await assertAudition(page, hz);
    };
    const assertComparisonStopped = async (pitch) => {
      assert.equal(await dial.getAttribute('aria-valuenow'), String(pitch));
      assert.equal(await marker.getAttribute('data-marker-hz'), String(pitch));
      assert.equal(await page.locator('.octave-card.playing').count(), 0);
      assert.ok(await mute.isDisabled());
      await page.waitForFunction(() => {
        const analyser = window.qaOutputAnalyser;
        const samples = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(samples);
        return samples.every((sample) => sample === 0);
      }, null, { timeout: 5000 });
    };

    await hearHalf(3000);
    for (const [button, pitch, target] of [
      [page.getByTestId('nudge-up-semitone'), 6357, 3179],
      [page.getByRole('button', { name: '+1%', exact: true }), 6421, 3211],
      [downPercent, 6357, 3179],
      [downSemitone, 6000, 3000],
    ]) {
      await button.click();
      await assertComparisonStopped(pitch);
      await hearHalf(target);
    }

    await dial.press('Home');
    await assertComparisonStopped(250);
    for (const [button, pitch] of [[downSemitone, 472], [downPercent, 495]]) {
      await slider.fill('162');
      assert.equal(await dial.getAttribute('aria-valuenow'), '500');
      await hearHalf(250);
      await button.click();
      await assertComparisonStopped(pitch);
      assert.equal(await halfCard.locator('strong').innerText(), 'Below 250 Hz');
      assert.equal(await half.innerText(), 'Hear f/2');
      assert.ok(await half.isDisabled());
    }

    await slider.fill('162');
    await hearHalf(250);
    await slider.press('Home');
    await assertComparisonStopped(250);
    assert.deepEqual(issues.consoleIssues, []);
    assert.deepEqual(issues.failedRequests, []);
    console.log('[PASS] Post-limiter octave targets: 3000, 3179, 3211, 3179, 3000 Hz; both downward nudges from 500 Hz stop the 250 Hz comparison');
  } finally {
    await context.close();
  }
}

async function verifyLearnCitations(browser) {
  const context = await browser.newContext({
    reducedMotion: 'reduce',
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`,
  });
  try {
    const page = await context.newPage();
    const citations = [
      ['VA pitch-matching study',
        'https://ohsu.elsevierpure.com/en/publications/comparison-of-two-computer-automated-procedures-for-tinnitus-pitc/',
        'Comparison of two computer-automated procedures for tinnitus pitch matching'],
      ['Heriot-Watt Research Portal', 'https://researchportal.hw.ac.uk/en/publications/tinnitus/', 'Tinnitus'],
      ['Cochrane sound therapy review',
        'https://www.cochrane.org/evidence/CD013094_sound-therapy-using-amplification-devices-andor-sound-generators-tinnitus',
        /Sound therapy .* for tinnitus/i],
    ];
    for (const [name, href, heading] of citations) {
      await page.goto(`${BASE_URL}/#learn`, { waitUntil: 'domcontentloaded' });
      const link = page.getByRole('link', { name, exact: true });
      assert.equal(await link.getAttribute('href'), href);
      if (name === 'Heriot-Watt Research Portal') {
        const primary = page.getByRole('link', { name: 'Baguley et al. (2013) · Tinnitus · The Lancet', exact: true });
        assert.equal(await primary.getAttribute('href'), 'https://pubmed.ncbi.nlm.nih.gov/23827090/');
      }
      const expected = new URL(href);
      const [response] = await Promise.all([
        page.waitForResponse((candidate) => {
          const destination = new URL(candidate.url());
          return candidate.request().isNavigationRequest() && candidate.status() === 200 &&
            destination.origin === expected.origin &&
            (destination.pathname === expected.pathname ||
              (name === 'Cochrane sound therapy review' && destination.pathname.startsWith('/evidence/CD013094_')));
        }, { timeout: 20000 }),
        link.click(),
      ]);
      await page.waitForURL(response.url(), { waitUntil: 'domcontentloaded' });
      const title = page.getByRole('heading', { name: heading, level: 1, exact: typeof heading === 'string' });
      await title.waitFor();
      if (name === 'Heriot-Watt Research Portal') {
        await page.getByRole('link', { name: /10\.1016\/S0140-6736\(13\)60142-7/ }).first().waitFor();
      }
      console.log(`[PASS] ${name} opens ${await title.innerText()} (HTTP 200)`);
    }
  } finally {
    await context.close();
  }
}

async function runOfflinePwaCheck(browser) {
  const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const { consoleIssues } = attachListeners(page);
  try {
    // Load once online and wait for Service Worker installation & activation
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="test-left-ear"]');

    const swState = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return { supported: false };
      const reg = await navigator.serviceWorker.ready;
      // Give clients.claim() a moment to attach controller on first visit
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 2500);
          navigator.serviceWorker.addEventListener('controllerchange', () => {
            clearTimeout(t);
            resolve();
          }, { once: true });
        });
      }
      const cacheNames = await caches.keys();
      const entries = [];
      let rootRedirected = null;
      for (const name of cacheNames) {
        const c = await caches.open(name);
        const keys = await c.keys();
        for (const req of keys) {
          const u = new URL(req.url);
          entries.push(u.pathname);
          if (u.pathname === '/') {
            const r = await c.match(req);
            rootRedirected = r?.redirected ?? null;
          }
        }
      }
      return {
        supported: true,
        active: Boolean(reg.active),
        controlled: Boolean(navigator.serviceWorker.controller),
        cacheNames,
        entryCount: entries.length,
        hasAssetsJs: entries.some((p) => p.startsWith('/assets/') && p.endsWith('.js')),
        hasAssetsCss: entries.some((p) => p.startsWith('/assets/') && p.endsWith('.css')),
        hasWoff2: entries.some((p) => p.endsWith('.woff2')),
        hasIndexHtml: entries.includes('/index.html'),
        artCached: ['listening-bench', 'garden-at-dusk', 'field-notes'].every((name) => entries.includes(`/art/${name}.webp`)),
        rootRedirected,
      };
    });

    assert.ok(swState.active, `SW must activate: ${JSON.stringify(swState)}`);
    assert.ok(swState.controlled, `SW must claim page on first load: ${JSON.stringify(swState)}`);
    assert.ok(swState.hasAssetsJs && swState.hasAssetsCss, `SW must precache built JS/CSS: ${JSON.stringify(swState)}`);
    assert.ok(swState.hasWoff2, `SW must precache .woff2 fonts: ${JSON.stringify(swState)}`);
    assert.ok(swState.artCached, 'All three artwork plates must be precached');
    assert.equal(swState.hasIndexHtml, false, 'SW must NOT precache /index.html');
    assert.equal(swState.rootRedirected, false, 'Cached / response must NOT have redirected=true');

    // Go offline IMMEDIATELY after first load and reload
    await ctx.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="test-left-ear"]', { timeout: 15000 });
    await snap(page, 'offline-after-first-load', false);

    // Tune, play Rain and save a check-in entirely offline.
    await page.locator('.checkbox-row').click();
    await page.getByTestId('nav-match').click();
    await page.getByTestId('match-step-3').click();
    await page.getByTestId('tuning-dial').press('End');
    assert.equal(await page.getByTestId('fine-freq-slider').inputValue(), '1000');
    await page.locator('[data-testid="nav-relief"]').click();
    await page.waitForSelector('[data-testid="therapy-panel"]');
    await page.getByTestId('therapy-play-toggle').click();
    await page.getByTestId('therapy-play-toggle').getByText(/Pause Rain/).waitFor();
    await page.getByTestId('global-stop-audio').click();
    await page.getByTestId('nav-journal').click();
    await page.getByTestId('checkin-note-input').fill('Saved offline');
    await page.getByTestId('save-checkin-btn').click();
    await page.getByText('Saved offline', { exact: true }).waitFor();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('Saved offline', { exact: true }).waitFor();
    await page.locator('[data-testid="nav-learn"]').click();
    await page.waitForSelector('text=Notched sound therapy: honest evidence');

    assert.equal(consoleIssues.length, 0, `Console issues during offline test: ${consoleIssues.join(' | ')}`);
    console.log(`[PASS] Offline PWA after first load passed (${swState.entryCount} precached assets)`);
  } finally {
    await ctx.close();
  }
}

async function runStaticAssetChecks(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    const assets = [
      '/manifest.webmanifest',
      '/favicon.svg',
      '/robots.txt',
      '/og.png',
      '/icon-192.png',
      '/icon-512.png',
      '/art/listening-bench.webp',
      '/art/garden-at-dusk.webp',
      '/art/field-notes.webp',
    ];
    for (const asset of assets) {
      const res = await page.request.get(`${BASE_URL}${asset}`);
      assert.equal(res.status(), 200, `Asset ${asset} must return HTTP 200 (got ${res.status()})`);
      if (asset.endsWith('.webp') || asset === '/og.png') {
        const body = await res.body();
        assert.ok(body.length <= 250 * 1024, `${asset} must be <= 250 KB (got ${body.length} bytes)`);
        if (asset === '/og.png') assert.deepEqual([body.readUInt32BE(16), body.readUInt32BE(20)], [1200, 630]);
      }
    }
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    for (const selector of ['meta[property="og:image"]', 'meta[name="twitter:image"]']) {
      assert.equal(new URL(await page.locator(selector).getAttribute('content')).pathname, '/og.png');
    }
    assert.match(await page.locator('meta[property="og:image:alt"]').getAttribute('content'), /wordmark.+brass.+dial/);
    const swRes = await page.request.get(`${BASE_URL}/sw.js`);
    assert.equal(swRes.status(), 200, 'sw.js must return 200');
    const swCacheControl = swRes.headers()['cache-control'] || '';
    console.log(`  [headers] /sw.js cache-control: ${swCacheControl || '(none)'}`);
    assert.ok(
      /no-cache|no-store|max-age=0/.test(swCacheControl),
      `sw.js must be served with no-cache (got "${swCacheControl}")`
    );

    if (!BASE_URL.includes('127.0.0.1')) {
      const notFoundRes = await page.request.get(`${BASE_URL}/nonexistent-route-check`);
      assert.equal(notFoundRes.status(), 404, `Live unknown path should return 404 (got ${notFoundRes.status()})`);
    }
    console.log('[PASS] Static PWA / OG / WebP art / robots / icon assets verified');
  } finally {
    await ctx.close();
  }
}

async function webKitNeedsSilentOutput(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, userAgent: IPHONE_UA, isMobile: true, hasTouch: true,
    reducedMotion: 'reduce',
  });
  try {
    const page = await context.newPage();
    const { consoleIssues, failedRequests } = attachListeners(page);
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.locator('.checkbox-row').tap();
    const trigger = page.getByTestId('test-left-ear');
    await verifyPageBottom(page, 'test-left-ear');
    await trigger.press('Enter');
    const error = page.getByTestId('setup-audio-error');
    await page.getByTestId('confirm-left-ear').or(error).waitFor({ timeout: 8000 });
    assert.equal(consoleIssues.length, 0, consoleIssues.join(' | '));
    assert.equal(failedRequests.length, 0, failedRequests.join(' | '));
    if (await error.isVisible()) {
      assert.match(await error.getByRole('alert').innerText(), /Audio output could not start/);
      await assertInsideVisualViewport(error, 'WebKit native startup failure');
      assert.ok(await trigger.evaluate((el) => el === document.activeElement));
      if (SAVE_SCREENSHOTS) {
        await page.screenshot({ path: path.join(QA_DIR, 'webkit-native-playback-error.jpg'), type: 'jpeg', quality: 78 });
      }
      console.log('[PASS] WebKit native audio startup reports unavailable output cleanly');
      return true;
    }
    return false;
  } finally {
    await context.close();
  }
}

async function main() {
  const webkitOnly = process.env.E2E_ENGINE === 'webkit';
  console.log(`Running Tinnitune ${webkitOnly ? 'WebKit' : 'full Chromium + WebKit + offline'} E2E against ${BASE_URL}`);
  if (!webkitOnly) {
    const browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-webgl',
        '--disable-gpu',
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio',
      ],
    });
    try {
      await verifyOctaveNudges(browser);
      await verifyLearnCitations(browser);
      await runDesktopOrMobileSuite(browser, 'desktop', { width: 1440, height: 900 });
      await runDesktopOrMobileSuite(browser, 'mobile', { width: 390, height: 844 });
      await runDesktopOrMobileSuite(browser, 'android-360x640', { width: 360, height: 640 });
      await runDesktopOrMobileSuite(browser, 'android-390x664', { width: 390, height: 664 });
      await runDesktopOrMobileSuite(browser, 'landscape-844x390', { width: 844, height: 390 });
      await verifyOutputCeiling(browser);
      await verifyJournalDeletion(browser, 'chromium');
      await runOfflinePwaCheck(browser);
      await runStaticAssetChecks(browser);
    } finally {
      await browser.close();
    }
  }

  const safari = await webkit.launch({ headless: true });
  try {
    const silentOutput = await webKitNeedsSilentOutput(safari);
    await runDesktopOrMobileSuite(safari, 'webkit', { width: 390, height: 844 }, 'webkit', silentOutput);
    await runDesktopOrMobileSuite(safari, 'webkit-landscape', { width: 844, height: 390 }, 'webkit', silentOutput);
    await verifyJournalDeletion(safari, 'webkit');
    if (silentOutput) console.log('[PASS] WebKit full UI flow with native audio nodes and headless output and clock fallback');
  } finally {
    await safari.close();
  }
  console.log(webkitOnly ? 'WEBKIT E2E TESTS PASSED!' : 'ALL CHROMIUM + WEBKIT + OFFLINE E2E TESTS PASSED!');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('E2E SUITE FAILED:', err);
    process.exit(1);
  },
);
