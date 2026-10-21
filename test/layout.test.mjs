// The lettering planner on synthetic pages: real panel bands are found from the gutters, the bubble lands on
// the empty part of its panel (not on the "face"), and the margins where stray page numbers land are cleared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { toGrid, findBands, planPage } from '../public/layout.js';

const W = 768, H = 1024;
// Three stacked panels; in each one a dense hatched "face" on one side, flat light grey elsewhere.
async function page({ faces = ['right', 'left', 'right'], number = true, bands = [[24, 330], [354, 660], [684, 990]] } = {}) {
  const hatch = (x, y) => Array.from({ length: 22 }, (_, k) => `<line x1="${x}" y1="${y + k * 10}" x2="${x + 220}" y2="${y + k * 10 + 30}" stroke="#000" stroke-width="3"/>`).join('');
  const panels = bands.map(([t, b], k) => {
    const fx = faces[k] === 'right' ? 480 : 70;
    return `<rect x="24" y="${t}" width="720" height="${b - t}" fill="#e8e8e8" stroke="#000" stroke-width="8"/>${hatch(fx, t + 40)}`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>${panels}
    ${number ? '<text x="384" y="1012" font-size="14" text-anchor="middle">13</text>' : ''}</svg>`;
  const { data } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return toGrid(data, W, H);
}
const opts = (speechPanel) => ({ width: W, height: H, caption: { w: 420, h: 90 }, bubble: { w: 300, h: 110 }, speechPanel });
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('finds the three panel bands from the white gutters', async () => {
  const bands = findBands(await page());
  assert.equal(bands.length, 3);
  assert.ok(Math.abs(bands[1].top * 4 - 354) <= 8 && Math.abs(bands[1].bottom * 4 - 660) <= 8);
});

test('the bubble sits in its own panel and off the busy face; the caption takes the emptier corner', async () => {
  const faces = ['right', 'left', 'right'];
  const grid = await page({ faces });
  for (const k of [0, 1, 2]) {
    const plan = planPage(grid, opts(k));
    const band = plan.bands[k];
    assert.ok(plan.bubble.y >= band.top && plan.bubble.y + plan.bubble.h <= band.bottom, `bubble inside panel ${k + 1}`);
    const fx = faces[k] === 'right' ? 480 : 70;
    const face = { x: fx, y: band.top + 30, w: 260, h: 250 };
    assert.ok(!overlaps(plan.bubble, face), `panel ${k + 1}: bubble ${JSON.stringify(plan.bubble)} covers the face`);
    assert.ok(!overlaps(plan.bubble, plan.caption), 'bubble and caption do not collide');
  }
  const plan = planPage(grid, opts(1));
  assert.ok(plan.caption.x < 40, 'face is top-right in panel 1, so the caption goes top-left');
  const flipped = planPage(await page({ faces: ['left', 'left', 'left'] }), opts(1));
  assert.ok(flipped.caption.x + flipped.caption.w > W - 40, 'face top-left, caption top-right');
});

test('the bottom margin under the last panel is cleared, so a stray page number goes away', async () => {
  const plan = planPage(await page(), opts(2));
  assert.ok(plan.margins.bottom > 990 && plan.margins.bottom < 1000, `cleared from ${plan.margins.bottom}`);
  assert.ok(plan.margins.top > 0 && plan.margins.top < 24);
});

test('art that ignored the layout falls back to thirds, and a page with no gutters keeps its margins', async () => {
  const one = await page({ bands: [[24, 990]] });
  const plan = planPage(one, opts(1));
  assert.equal(plan.found, 1);
  assert.ok(Math.abs(plan.bands[1].top - H / 3) < 8);
  assert.ok(plan.margins.bottom > 980);
});
