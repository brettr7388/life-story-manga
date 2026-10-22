// Drives the real page in a phone-sized Chromium against scripts/dev-offline.mjs (real Worker, fake AI with
// fault injection) and checks what a reader sees when the image model misbehaves.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { chromium } from 'playwright';

let nextPort = 8811;
const servers = [];
after(() => servers.forEach((s) => s.kill()));

async function server(env) {
  const port = nextPort++;
  const proc = spawn(process.execPath, ['scripts/dev-offline.mjs'], { env: { ...process.env, ...env, PORT: String(port) } });
  servers.push(proc);
  const calls = [];
  let out = '';
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => {
      out += d;
      for (const m of String(d).matchAll(/fake-image (\{.*?\})/g)) calls.push(JSON.parse(m[1]));
      if (/offline dev server on/.test(out)) resolve();
    });
    proc.stderr.on('data', (d) => { out += d; });
    proc.on('exit', (code) => reject(new Error(`dev server exited ${code}: ${out}`)));
  });
  return { url: `http://127.0.0.1:${port}/`, calls };
}

let photo;
async function openManga(url, { timeoutMs } = {}) {
  photo ??= await sharp({ create: { width: 480, height: 480, channels: 3, background: '#777' } }).jpeg().toBuffer();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  if (timeoutMs) await ctx.addInitScript((ms) => { globalThis.__drawTimeoutMs = ms; }, timeoutMs);
  const page = await ctx.newPage();
  const pageRequests = [];
  page.on('request', (r) => { if (r.url().endsWith('/api/page')) pageRequests.push(r); });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.setInputFiles('#photo-input', { name: 'me.jpg', mimeType: 'image/jpeg', buffer: photo });
  await page.waitForSelector('.thumb');
  for (const t of await page.$$('textarea')) await t.fill('A small coastal town');
  await page.tap('#go');
  return { browser, page, pageRequests };
}

const settled = (page, ms = 60_000) =>
  page.waitForFunction(() => { const s = window.__manga().states; return s.length === 6 && s.every((x) => x === 'done' || x === 'failed'); }, null, { timeout: ms });
const states = (page) => page.evaluate(() => window.__manga().states);
const redrawVisible = (page, i) => page.locator('.page').nth(i).locator('.redraw').isVisible();

test('a 3030 on page 2 is retried once on the server with a softer prompt and the page inks', { timeout: 120_000 }, async () => {
  const s = await server({ FAKE_FLAG_PAGE: '2', FAKE_FLAG_TIMES: '1' });
  const { browser, page, pageRequests } = await openManga(s.url);
  try {
    await settled(page);
    assert.deepEqual(await states(page), Array(6).fill('done'));
    assert.equal(pageRequests.length, 6, 'the browser asks for each page once');
    const p2 = s.calls.filter((c) => c.page === 2);
    assert.deepEqual(p2, [{ page: 2, soft: false }, { page: 2, soft: true }]);
    assert.equal(s.calls.length, 7);
    assert.equal(await page.textContent('#status'), 'All six pages inked. Swipe to read.');

    // Lettering: each bubble is inside the panel its line belongs to and off that panel's hatched "face";
    // the reader shows the lettered PNG; the stray page number in the bottom margin is painted out.
    const { layouts } = await page.evaluate(() => window.__manga());
    const speech = [2, 3, 1, 2, 3, 1]; // the fake script's speechPanel per page (1-based)
    layouts.forEach((l, i) => {
      const k = speech[i] - 1;
      const band = l.bands[k];
      assert.equal(l.found, 3, `page ${i + 1}: three panels found`);
      assert.ok(l.bubble.y + l.bubble.h <= band.bottom && l.bubble.y >= band.top - l.bubble.h * 0.36, `page ${i + 1}: bubble on panel ${k + 1}`);
      const fx = (i + 1 + k) % 2 ? 480 : 70;
      const face = { x: fx, y: band.top + 30, w: 260, h: 250 };
      const hit = l.bubble.x < face.x + face.w && face.x < l.bubble.x + l.bubble.w && l.bubble.y < face.y + face.h && face.y < l.bubble.y + l.bubble.h;
      assert.ok(!hit, `page ${i + 1}: bubble covers the face`);
    });
    const shown = await page.evaluate(() => [...document.querySelectorAll('.page img')].map((im) => im.src.slice(0, 5)));
    assert.deepEqual(shown, Array(6).fill('blob:'));
    const marginInk = await page.evaluate(async () => {
      const bmp = await createImageBitmap(document.querySelector('.page img'));
      const c = new OffscreenCanvas(bmp.width, bmp.height); const ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(300, 998, 168, 22).data; let dark = 0;
      for (let k = 0; k < d.length; k += 4) if (d[k] < 128) dark++;
      return dark;
    });
    assert.equal(marginInk, 0, 'no page number left in the bottom margin');
  } finally { await browser.close(); }
});

test('a 3030 twice on page 2 ends with that page offering a redraw, and the redraw works', { timeout: 120_000 }, async () => {
  const s = await server({ FAKE_FLAG_PAGE: '2', FAKE_FLAG_TIMES: '2' });
  const { browser, page, pageRequests } = await openManga(s.url);
  try {
    await settled(page);
    assert.deepEqual(await states(page), ['done', 'failed', 'done', 'done', 'done', 'done']);
    assert.ok(await redrawVisible(page, 1), 'page 2 shows Tap to redraw');
    assert.equal(await page.textContent('#status'), '5 of 6 pages inked, 1 to redraw…');
    assert.equal(pageRequests.length, 6);
    assert.deepEqual(s.calls.filter((c) => c.page === 2).map((c) => c.soft), [false, true]);
    await page.locator('.page').nth(1).locator('.redraw').evaluate((b) => b.click());
    await page.waitForFunction(() => window.__manga().states[1] === 'done', null, { timeout: 30_000 });
    assert.equal(pageRequests.length, 7);
  } finally { await browser.close(); }
});

test('a request that never answers times out, frees its slot, and offers a redraw', { timeout: 120_000 }, async () => {
  const s = await server({ FAKE_HANG_PAGE: '1' });
  const { browser, page } = await openManga(s.url, { timeoutMs: 12_000 });
  try {
    await settled(page);
    assert.deepEqual(await states(page), ['failed', 'done', 'done', 'done', 'done', 'done']);
    assert.ok(await redrawVisible(page, 0), 'page 1 shows Tap to redraw');
    assert.match(await page.locator('.page').nth(0).locator('.ink-wait').innerText().catch(() => ''), /^$|redraw/i);
    const errors = await page.evaluate(() => window.__pageErrors);
    assert.match(errors[0].error, /took too long/);
    await page.locator('.page').nth(0).locator('.redraw').evaluate((b) => b.click());
    await page.waitForFunction(() => window.__manga().states[0] === 'done', null, { timeout: 30_000 });
    assert.equal(await page.textContent('#status'), 'All six pages inked. Swipe to read.');
  } finally { await browser.close(); }
});

test('the sound button scrolls away with the form instead of covering it', { timeout: 60_000 }, async () => {
  const s = await server({});
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  try {
    await page.goto(s.url, { waitUntil: 'networkidle' });
    await page.waitForSelector('textarea');
    for (const y of [300, 700, 1200]) {
      await page.evaluate((v) => window.scrollTo(0, v), y);
      const btn = await page.locator('#sound').boundingBox();
      const hits = await page.evaluate(({ x, y: top, w, h }) => {
        const out = [];
        for (const [px, py] of [[x + w / 2, top + h / 2], [x + 4, top + 4], [x + w - 4, top + h - 4]]) {
          if (py < 0 || py > innerHeight) continue;
          const under = document.elementsFromPoint(px, py).filter((e) => e.id !== 'sound' && e.closest('#form'));
          if (under.length && document.elementFromPoint(px, py)?.id === 'sound') out.push(under[0].tagName);
        }
        return out;
      }, { x: btn.x, y: btn.y, w: btn.width, h: btn.height });
      assert.deepEqual(hits, [], `at scroll ${y} the sound button covers ${hits}`);
    }
  } finally { await browser.close(); }
});

test('no photos: a described look is enough to make a manga, and neither is a form error', { timeout: 120_000 }, async () => {
  const s = await server({});
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  try {
    await page.goto(s.url, { waitUntil: 'networkidle' });
    for (const t of await page.$$('textarea:not([name=look])')) await t.fill('A small coastal town');
    await page.tap('#go');
    assert.match(await page.textContent('#form-error'), /describe how you look/);
    await page.fill('textarea[name=look]', 'a tall wooden log with big round eyes');
    await page.tap('#go');
    await settled(page);
    assert.deepEqual(await states(page), Array(6).fill('done'));
  } finally { await browser.close(); }
});
