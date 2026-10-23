// Makes one real manga in headless Chromium at 390x844 (iPhone 14 size) and records it.
//   BASE_URL=https://... OUT=out PHOTOS=a.jpg,b.jpg node scripts/e2e.mjs
// Uses one of the day's mangas. Saves screenshots, a video, the six saved PNGs and timings.json in OUT.
// Use stand-in photos (a generated or stock face), never someone's real photos, for tests.
// ANSWERS_FILE=answers.json swaps in other answers. HEADED=1 runs a visible, unmuted, full-screen browser
// (for screen + audio capture on an X display); result.json then logs the wall-clock time of each tap and swipe.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8799';
const OUT = process.env.OUT ?? 'out';
const PHOTOS = (process.env.PHOTOS ?? '').split(',').filter(Boolean);
const ANSWERS = process.env.ANSWERS_FILE ? JSON.parse(readFileSync(process.env.ANSWERS_FILE, 'utf8')) : {
  name: 'Theo',
  roots: 'A windy harbor town where my dad fixed fishing boats and I drew comics on receipt paper',
  turn: 'At 19 I missed the last ferry home and ended up sleeping in an art school studio, then enrolled',
  proud: 'Opening a tiny print shop that teaches kids to make their own zines',
  next: 'Taking the shop on the road in an old ferry-blue van',
};
if (!PHOTOS.length && !ANSWERS.look) throw new Error('Set PHOTOS to one to four stand-in photo paths, or give a "look" answer');
mkdirSync(OUT, { recursive: true });
const shot = (page, name) => page.screenshot({ path: join(OUT, name) });
const log = [];
const t0 = Date.now();
const mark = (what) => { const s = ((Date.now() - t0) / 1000).toFixed(1); log.push({ t: Number(s), at: Date.now(), what }); console.log(`${s}s ${what}`); };
const HEADED = process.env.HEADED === '1';

const browser = await chromium.launch(HEADED
  ? { headless: false, ignoreDefaultArgs: ['--mute-audio'], args: ['--window-position=0,0', '--window-size=390,844', '--force-device-scale-factor=1', '--disable-features=DownloadBubble,DownloadBubbleV2'] }
  : {});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: HEADED ? 1 : 2,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  recordVideo: { dir: join(OUT, 'video-raw'), size: { width: 390, height: 844 } },
  acceptDownloads: true,
});
const page = await context.newPage();
if (HEADED) {
  // Full screen hides the tab strip and address bar, so the display shows only the 390x844 page.
  const win = await context.newCDPSession(page);
  const { windowId } = await win.send('Browser.getWindowForTarget');
  await win.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } });
  await page.waitForTimeout(5000); // let the "press Esc to exit full screen" notice fade before recording starts
}
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
// The script the Worker wrote (plot, captions, speech, art panels), saved next to the shots for review.
page.on('response', async (r) => { if (r.url().endsWith('/api/start') && r.ok()) writeFileSync(join(OUT, 'script.json'), JSON.stringify(await r.json().catch(() => null), null, 1)); });

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('textarea');
await shot(page, '01-form.png');
mark('form loaded');

// The sound files: 200, audio/mpeg, and a byte range (what iOS asks for).
const audio = {};
for (const p of ['/audio/music.mp3', '/audio/turn.mp3']) {
  const full = await page.request.get(BASE + p);
  const part = await page.request.get(BASE + p, { headers: { range: 'bytes=0-99' } });
  audio[p] = { status: full.status(), type: full.headers()['content-type'], bytes: (await full.body()).length, rangeStatus: part.status(), contentRange: part.headers()['content-range'] };
}
const before = await page.evaluate(() => window.__audio());

if (PHOTOS.length) {
  await page.setInputFiles('#photo-input', PHOTOS);
  await page.waitForFunction((n) => document.querySelectorAll('.thumb').length === n, PHOTOS.length);
}
for (const [id, v] of Object.entries(ANSWERS)) await page.fill(`textarea[name=${id}]`, v);
await page.evaluate(() => window.scrollTo(0, 0));
await shot(page, '02-form-filled.png');
await page.locator('#go').scrollIntoViewIfNeeded();
await shot(page, '02b-form-bottom.png');

const tTap = Date.now();
await page.tap('#go');
mark('tapped Draw my manga');
await page.waitForFunction(() => window.__manga().title, null, { timeout: 90_000 });
const tScript = Date.now();
mark(`script written: ${await page.textContent('#title')}`);
await page.waitForTimeout(400);
await shot(page, '03-script-inking.png');

const firstInk = Date.now();
await page.waitForFunction(() => document.querySelector('.page.inked'), null, { timeout: 120_000 });
const tFirst = Date.now();
mark('first page inking in');
await page.waitForTimeout(700);
await shot(page, '04-ink-in-progress.png');
const pageTimes = {};
const settled = () => page.waitForFunction(() => (window.__manga().states || []).every((s) => s === 'done' || s === 'failed'), null, { timeout: 300_000, polling: 250 }).catch(() => {});
await settled();
// A page the model failed on gets a "Tap to redraw" button, as a person would use it (up to REDRAW_ROUNDS rounds, default 6;
// the Worker's per-manga budget of 9 drawings is the real limit).
let redraws = 0;
for (let round = 0; round < Number(process.env.REDRAW_ROUNDS ?? 6); round++) {
  const failed = await page.evaluate(() => window.__manga().states.map((s, i) => (s === 'failed' ? i : -1)).filter((i) => i >= 0));
  if (!failed.length) break;
  mark(`redrawing pages ${failed.map((i) => i + 1).join(', ')}`);
  for (const i of failed) { await page.locator('.page').nth(i).locator('.redraw').evaluate((b) => b.click()); redraws++; }
  await page.waitForTimeout(300);
  await settled();
}
const states = await page.evaluate(() => window.__manga().states);
const pageErrors = await page.evaluate(() => window.__pageErrors ?? []);
const tAll = Date.now();
mark(`pages finished: ${JSON.stringify(states)}`);
await page.waitForTimeout(1800);
await shot(page, '05-page-1.png');

const audioAfterTap = await page.evaluate(() => window.__audio());
await page.waitForTimeout(1000);
const audioLater = await page.evaluate(() => window.__audio());

// Real touch swipes: raw touch events through CDP, so Chromium scrolls the pager like a finger would.
const cdp = await context.newCDPSession(page);
const box = await page.locator('#pager').boundingBox();
async function swipe(name) {
  mark('swipe');
  const y = Math.round(box.y + box.height / 2);
  const x0 = Math.round(box.x + box.width * 0.85);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
  for (let k = 1; k <= 12; k++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 - k * 24, y }] });
    await page.waitForTimeout(16);
    if (k === 6 && name) await shot(page, name); // finger still down, mid-turn
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(900);
}
const saved = [];
async function save(i) {
  if (await page.locator('#save').isDisabled()) { mark(`page ${i + 1} not saved: not drawn`); return; }
  const f = join(OUT, `saved-page-${i + 1}.png`);
  if (HEADED) {
    // No download (its toast would sit on the recording): copy the lettered page the reader shows,
    // which is the same PNG Save hands over, at its full size.
    const url = await page.locator('.page').nth(i).locator('img').evaluate((img) => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/png');
    });
    writeFileSync(f, Buffer.from(url.split(',')[1], 'base64'));
  } else {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.tap('#save')]);
    await dl.saveAs(f);
  }
  saved.push(f);
}
await save(0);
await swipe('06-swipe-mid.png');
await shot(page, '07-page-2.png');
await save(1);
for (let i = 2; i < 6; i++) {
  await swipe();
  await shot(page, `08-page-${i + 1}.png`);
  await save(i);
}
const current = await page.evaluate(() => window.__manga().current);
const sfx = await page.evaluate(() => window.__sfx ?? []);
mark(`swiped to page ${current + 1}; turn sounds: ${sfx.length}`);
await page.waitForTimeout(800);

await context.close();
await browser.close();
const raw = join(OUT, 'video-raw');
const [vid] = readdirSync(raw);
renameSync(join(raw, vid), join(OUT, 'run.webm'));

const result = {
  base: BASE,
  photos: PHOTOS.length,
  seconds: {
    tapToScript: (tScript - tTap) / 1000,
    tapToFirstPage: (tFirst - tTap) / 1000,
    tapToAllPages: (tAll - tTap) / 1000,
  },
  states,
  redraws,
  pageErrors,
  audio,
  audioBeforeTap: before,
  audioAfterTap,
  audioLater,
  musicAdvancing: !!audioLater.music && !audioLater.music.paused && audioLater.music.time !== audioAfterTap.music.time, // the loop is 13.3 s, so time may wrap
  turnSounds: sfx.length,
  finalPage: current + 1,
  saved,
  errors,
  log,
};
writeFileSync(join(OUT, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result.seconds), 'music advancing:', result.musicAdvancing, 'errors:', errors.length);
