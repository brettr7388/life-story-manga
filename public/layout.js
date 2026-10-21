// Where the caption and the speech bubble go on a drawn page, worked out from the page's own pixels.
// Pure functions over a small grayscale grid, so they run the same in the browser and in tests.
//
// The page is asked for as three stacked panels. We find the real panel bands from the white gutters,
// then put the bubble on the emptiest spot of its panel: few edges and little ink, which keeps it off
// faces and hair (both are dense line work or solid black). The caption takes the emptier top corner.

export const CENTER_COST = 0.25;
export const GRID = 4; // one grid cell = 4x4 page pixels; averaging also melts screentone dots into flat grey

// gray: Uint8Array of w*h luminance values (0 black .. 255 white).
export function toGrid(rgba, width, height, cell = GRID) {
  const w = Math.floor(width / cell), h = Math.floor(height / cell);
  const gray = new Uint8Array(w * h);
  for (let gy = 0; gy < h; gy++) {
    for (let gx = 0; gx < w; gx++) {
      let sum = 0;
      for (let y = gy * cell; y < gy * cell + cell; y++) {
        for (let x = gx * cell; x < gx * cell + cell; x++) {
          const k = (y * width + x) * 4;
          sum += rgba[k] * 0.299 + rgba[k + 1] * 0.587 + rgba[k + 2] * 0.114;
        }
      }
      gray[gy * w + gx] = sum / (cell * cell);
    }
  }
  return { gray, w, h };
}

// Rows with no ink at all are gutters or margins; inside a panel every row crosses its side borders.
export function findBands({ gray, w, h }) {
  const inked = [];
  for (let y = 0; y < h; y++) {
    let dark = 0;
    for (let x = 0; x < w; x++) if (gray[y * w + x] < 200) dark++;
    inked.push(dark >= 2);
  }
  const bands = [];
  let start = -1;
  for (let y = 0; y <= h; y++) {
    if (y < h && inked[y]) { if (start < 0) start = y; continue; }
    if (start >= 0 && y - start >= h * 0.1) bands.push({ top: start, bottom: y - 1 });
    start = -1;
  }
  return bands;
}

// The three bands the script's panels 1-3 map to. Falls back to thirds when the art did its own thing.
export function panelBands(grid) {
  const found = findBands(grid);
  if (found.length === 3) return { bands: found, found };
  const thirds = [0, 1, 2].map((k) => ({ top: Math.round((grid.h * k) / 3), bottom: Math.round((grid.h * (k + 1)) / 3) - 1 }));
  if (found.length < 2) return { bands: thirds, found };
  // 2 or 4+ bands: each third takes the found band whose middle is closest to its own.
  const mid = (b) => (b.top + b.bottom) / 2;
  return { bands: thirds.map((t) => found.reduce((a, b) => (Math.abs(mid(b) - mid(t)) < Math.abs(mid(a) - mid(t)) ? b : a))), found };
}

// Summed-area tables of edges and ink, for O(1) "how busy is this rectangle".
function tables({ gray, w, h }) {
  const edge = new Float64Array((w + 1) * (h + 1));
  const ink = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let er = 0, ir = 0;
    for (let x = 0; x < w; x++) {
      const g = gray[y * w + x];
      const gx = x + 1 < w ? Math.abs(g - gray[y * w + x + 1]) : 0;
      const gy = y + 1 < h ? Math.abs(g - gray[(y + 1) * w + x]) : 0;
      er += gx + gy > 40 ? 1 : 0;
      ir += (255 - g) / 255;
      edge[(y + 1) * (w + 1) + x + 1] = edge[y * (w + 1) + x + 1] + er;
      ink[(y + 1) * (w + 1) + x + 1] = ink[y * (w + 1) + x + 1] + ir;
    }
  }
  const sum = (t, x, y, rw, rh) => t[(y + rh) * (w + 1) + x + rw] - t[y * (w + 1) + x + rw] - t[(y + rh) * (w + 1) + x] + t[y * (w + 1) + x];
  return (x, y, rw, rh) => {
    const a = rw * rh;
    return sum(edge, x, y, rw, rh) / a + 0.6 * (sum(ink, x, y, rw, rh) / a);
  };
}

const overlap = (a, b) => a && b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// Plans one page. Sizes are in page pixels; the result is in page pixels too.
//   caption: { w, h } of the caption box, or null;  bubble: { w, h } of the bubble's bounding box, or null
//   speechPanel: 0-2
export function planPage(grid, { width, height, caption, bubble, speechPanel = 2 }) {
  const sx = width / grid.w, sy = height / grid.h;
  const { bands, found } = panelBands(grid);
  const busy = tables(grid);
  const score = (r) => busy(Math.floor(r.x / sx), Math.floor(r.y / sy), Math.max(1, Math.ceil(r.w / sx)), Math.max(1, Math.ceil(r.h / sy)));
  const pad = Math.round(width * 0.03);
  const top0 = bands[0].top * sy;

  let cap = null;
  if (caption) {
    const y = Math.max(pad * 0.5, top0 - caption.h * 0.35);
    const corners = [{ x: pad, y }, { x: width - pad - caption.w, y }].map((c) => ({ ...c, w: caption.w, h: caption.h }));
    cap = corners.reduce((a, b) => (score(b) < score(a) - 0.02 ? b : a));
  }

  let bub = null, tail = null;
  if (bubble) {
    const band = bands[Math.min(Math.max(speechPanel, 0), 2)];
    const bandTop = band.top * sy, bandBottom = (band.bottom + 1) * sy;
    // The bubble may straddle its panel's top border a little, the way letterers do, to find room.
    const y0 = Math.max(pad * 0.5, bandTop - bubble.h * 0.35), y1 = bandBottom - pad * 0.8 - bubble.h;
    const x0 = pad * 0.5, x1 = width - pad * 0.5 - bubble.w;
    const cx = width / 2, cy = (bandTop + bandBottom) / 2;
    const reach = Math.hypot(width / 2, (bandBottom - bandTop) / 2);
    const step = Math.max(4, Math.round(width / 96));
    let best = null;
    for (let y = y0; y <= Math.max(y0, y1); y += step) {
      for (let x = x0; x <= Math.max(x0, x1); x += step) {
        const r = { x, y, w: bubble.w, h: bubble.h };
        if (overlap(r, cap && { ...cap, x: cap.x - pad * 0.5, y: cap.y - pad * 0.5, w: cap.w + pad, h: cap.h + pad })) continue;
        // Close-up faces fill the middle of a panel with soft, sparse lines that can look "empty",
        // so the middle costs extra and corners are preferred, as in hand-lettered manga.
        const d = Math.hypot(x + bubble.w / 2 - cx, y + bubble.h / 2 - cy) / reach;
        const s = score(r) + CENTER_COST * Math.max(0, 1 - d) + 0.02 * ((y - y0) / Math.max(1, y1 - y0));
        if (!best || s < best.s) best = { ...r, s };
      }
    }
    bub = best ?? { x: x1, y: y0, w: bubble.w, h: bubble.h, s: 1 };
    // The tail points toward where the panel's line work is densest: the subject, usually the speaker.
    const gy0 = band.top, gy1 = band.bottom;
    let mass = 0, mx = 0;
    for (let gx = 0; gx < grid.w; gx++) {
      const col = busy(gx, gy0, 1, gy1 - gy0 + 1);
      mass += col; mx += col * gx;
    }
    const subjectX = mass ? (mx / mass) * sx : width / 2;
    tail = { toward: subjectX < bub.x + bub.w / 2 ? 'left' : 'right', down: bub.y + bub.h / 2 < ((band.top + band.bottom) / 2) * sy };
  }

  // Margins above the first and below the last panel are blank paper; page numbers the model adds land there.
  const first = found[0] ?? bands[0], last = found[found.length - 1] ?? bands[2];
  const margins = {
    top: first.top * sy <= height * 0.12 ? Math.max(0, first.top * sy - 1) : 0,
    bottom: (grid.h - 1 - last.bottom) * sy <= height * 0.12 ? (last.bottom + 1) * sy + 1 : height,
  };
  return { bands: bands.map((b) => ({ top: b.top * sy, bottom: (b.bottom + 1) * sy })), found: found.length, caption: cap, bubble: bub, tail, margins };
}
