import { unlock, startMusic, turn, isMuted, setMuted } from './audio.js';
import { toGrid, planPage } from './layout.js';

const PAGES = 6;
const MAX_PHOTOS = 4;
const MAX_SIDE = 496; // FLUX.2 [klein] on Workers AI needs reference images under 512x512
const DRAW_CONCURRENCY = 2;
// One page is at most two model calls on the server (a flagged page gets one soft retry), about 30 s.
// Past this the request is abandoned and the page offers a redraw, so a lost connection can never leave it inking.
const DRAW_TIMEOUT_MS = globalThis.__drawTimeoutMs ?? 90_000;

const $ = (id) => document.getElementById(id);
const photos = []; // { blob, url } — kept in memory only, dropped on "start over"
let story = null;   // { run, title, pages: [{ panels, caption, speech, sig, image?, state }] }
let current = 0;

// ---------- sound button + gesture unlock ----------
const soundBtn = $('sound');
function paintSound() {
  soundBtn.textContent = isMuted() ? '♪̸' : '♪';
  soundBtn.setAttribute('aria-pressed', String(!isMuted()));
  soundBtn.setAttribute('aria-label', isMuted() ? 'Sound off' : 'Sound on');
}
soundBtn.addEventListener('click', () => { setMuted(!isMuted()); paintSound(); });
paintSound();
// iOS only counts pointerup / click as a gesture that may start audio.
document.addEventListener('pointerup', unlock, { capture: true });

// ---------- form ----------
async function loadStatus() {
  try {
    const s = await (await fetch('/api/status')).json();
    if (!$('questions').querySelector('textarea')) buildQuestions(s.questions);
    $('quota').textContent = s.left > 0 ? `${s.left} of ${s.cap} free mangas left today` : `Today's ${s.cap} free mangas are drawn. Back after midnight UTC.`;
    $('go').disabled = s.left <= 0;
  } catch { $('quota').textContent = ''; }
}

function buildQuestions(questions) {
  const box = $('questions');
  for (const q of questions) {
    const label = document.createElement('label');
    label.className = 'q';
    label.innerHTML = `<span></span><textarea rows="2"></textarea>`;
    label.querySelector('span').textContent = q.label;
    const ta = label.querySelector('textarea');
    ta.name = q.id;
    ta.maxLength = q.max;
    ta.rows = q.id === 'name' ? 1 : 2;
    ta.required = !q.optional;
    if (q.optional) label.classList.add('optional');
    box.append(label);
  }
}

async function shrink(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  const src = bitmap ?? (await new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = URL.createObjectURL(file);
  }));
  const w = src.width, h = src.height;
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
  bitmap?.close?.();
  return new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.86));
}

function paintPhotos() {
  const box = $('photos');
  box.querySelectorAll('.thumb').forEach((n) => n.remove());
  photos.forEach((p, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'thumb';
    b.setAttribute('aria-label', `Remove photo ${i + 1}`);
    b.style.backgroundImage = `url(${p.url})`;
    b.addEventListener('click', () => { URL.revokeObjectURL(p.url); photos.splice(i, 1); paintPhotos(); });
    box.insertBefore(b, $('add-photo'));
  });
  $('add-photo').hidden = photos.length >= MAX_PHOTOS;
}

$('photo-input').addEventListener('change', async (e) => {
  for (const f of [...e.target.files].slice(0, MAX_PHOTOS - photos.length)) {
    const blob = await shrink(f).catch(() => null);
    if (blob) photos.push({ blob, url: URL.createObjectURL(blob) });
  }
  e.target.value = '';
  paintPhotos();
});

function formError(msg) {
  const el = $('form-error');
  el.textContent = msg;
  el.hidden = !msg;
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  startMusic(); // inside the tap, before any await
  formError('');
  if (!photos.length && !$('form').querySelector('textarea[name=look]')?.value.trim()) {
    return formError('Add at least one photo of yourself, or describe how you look in the last box.');
  }
  const answers = Object.fromEntries([...$('form').querySelectorAll('textarea')].map((t) => [t.name, t.value.trim()]));
  const missing = [...$('form').querySelectorAll('textarea')].find((t) => t.required && !t.value.trim());
  if (missing) { missing.focus(); return formError('Answer all five questions.'); }
  $('go').disabled = true;
  openReader();
  try {
    const res = await fetch('/api/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(answers) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    story = { ...data, pages: data.pages.map((p) => ({ ...p, state: 'queued' })) };
    $('title').textContent = story.title;
    story.pages.forEach((p, i) => fillText(i, p));
    status('Inking page 1…');
    drawAll();
  } catch (err) {
    closeReader();
    formError(err.message);
    $('go').disabled = false;
    loadStatus();
  }
});

// ---------- reader ----------
function openReader() {
  $('form-screen').hidden = true;
  $('reader').hidden = false;
  $('title').textContent = 'Writing your story…';
  const pager = $('pager');
  pager.replaceChildren();
  $('dots').replaceChildren();
  for (let i = 0; i < PAGES; i++) {
    const page = document.createElement('article');
    page.className = 'page inking';
    page.dataset.index = i;
    page.innerHTML = `
      <div class="sheet">
        <div class="ink-wait"><div class="brush"></div><p>Inking page ${i + 1}…</p></div>
        <img alt="" decoding="async">
        <p class="caption" hidden></p>
        <p class="speech" hidden></p>
        <button class="redraw" type="button" hidden>Tap to redraw</button>
      </div>
      <p class="folio">${i + 1}</p>`;
    page.querySelector('.redraw').addEventListener('click', () => { if (story?.pages[i]?.state !== 'failed') return; story.pages[i].state = 'queued'; drawAll(); });
    pager.append(page);
    $('dots').append(document.createElement('i'));
  }
  pager.scrollLeft = 0;
  setCurrent(0, false);
  window.scrollTo(0, 0);
}

function closeReader() {
  $('reader').hidden = true;
  $('form-screen').hidden = false;
}

$('back').addEventListener('click', () => {
  story?.pages.forEach((p) => p.shown && URL.revokeObjectURL(p.shown));
  story = null;
  closeReader();
  $('go').disabled = false;
  loadStatus();
});

function pageEl(i) { return $('pager').children[i]; }

function fillText(i, p) {
  const el = pageEl(i);
  const cap = el.querySelector('.caption');
  const sp = el.querySelector('.speech');
  cap.textContent = p.caption; cap.hidden = !p.caption;
  sp.textContent = p.speech; sp.hidden = !p.speech;
  sp.dataset.panel = String(p.speechPanel ?? 2);
}

function status(msg) { $('status').textContent = msg; }

async function drawOne(i) {
  const p = story.pages[i];
  const run = story.run;
  p.state = 'drawing';
  const el = pageEl(i);
  el.classList.add('inking');
  el.classList.remove('failed', 'inked');
  el.querySelector('.redraw').hidden = true;
  const fd = new FormData();
  fd.append('run', run);
  fd.append('page', String(i));
  fd.append('panels', JSON.stringify(p.panels));
  fd.append('sig', p.sig);
  if (story.look) fd.append('look', story.look);
  photos.forEach((ph, k) => fd.append(`photo${k}`, ph.blob, `photo${k}.jpg`));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('This page took too long. Tap to redraw.', 'TimeoutError')), DRAW_TIMEOUT_MS);
  try {
    const res = await fetch('/api/page', { method: 'POST', body: fd, signal: ctrl.signal });
    const data = await res.json().catch((e) => { if (ctrl.signal.aborted) throw e; return { error: `HTTP ${res.status}` }; });
    if (!res.ok) throw Object.assign(new Error(data.error || 'The artist smudged this page. Tap to redraw.'), { code: data.code });
    if (!data.image) throw new Error('The artist smudged this page. Tap to redraw.');
    if (!story || story.run !== run) return;
    p.image = `data:image/jpeg;base64,${data.image}`;
    const art = new Image();
    await loadImage(art, p.image, ctrl.signal);
    if (!story || story.run !== run) return;
    // Letter the page (caption, bubble) into one PNG now: the reader shows exactly what Save and Share give,
    // and Share can call navigator.share inside the tap (iOS needs that).
    const img = el.querySelector('img');
    try {
      p.png = await renderPage(i, art);
      p.shown = URL.createObjectURL(p.png);
      await loadImage(img, p.shown, ctrl.signal);
      el.classList.add('lettered');
    } catch (e) {
      if (ctrl.signal.aborted) throw e;
      console.warn('lettering failed, showing the bare page', e);
      p.png = dataUrlBlob(p.image);
      await loadImage(img, p.image, ctrl.signal);
      el.classList.remove('lettered');
    }
    el.classList.remove('inking');
    el.classList.add('inked');
    p.state = 'done';
  } catch (err) {
    if (!story || story.run !== run) return;
    p.state = 'failed';
    const message = ctrl.signal.aborted ? ctrl.signal.reason?.message ?? 'This page took too long. Tap to redraw.' : err?.message || 'Tap to redraw.';
    (window.__pageErrors ??= []).push({ page: i + 1, error: message });
    el.classList.remove('inking', 'inked');
    el.classList.add('failed');
    const btn = el.querySelector('.redraw');
    btn.hidden = false;
    if (err?.code === 'draws') { btn.textContent = 'This manga has used all its drawings.'; btn.disabled = true; }
  } finally {
    clearTimeout(timer);
  }
  afterDraw();
}

function loadImage(img, src, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason ?? new Error('aborted'));
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    img.onload = () => { signal.removeEventListener('abort', stop); resolve(); };
    img.onerror = () => { signal.removeEventListener('abort', stop); reject(new Error('The page came back damaged. Tap to redraw.')); };
    img.src = src;
  });
}

function dataUrlBlob(url) {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const bytes = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
  return new Blob([bytes], { type: 'image/jpeg' });
}

function afterDraw() {
  if (!story) return;
  const done = story.pages.filter((p) => p.state === 'done').length;
  const failed = story.pages.filter((p) => p.state === 'failed').length;
  status(done === PAGES ? 'All six pages inked. Swipe to read.' : `${done} of ${PAGES} pages inked${failed ? `, ${failed} to redraw` : ''}…`);
  document.documentElement.dataset.inked = String(done);
  paintActions();
  drawAll();
}

function drawAll() {
  if (!story) return;
  const busy = story.pages.filter((p) => p.state === 'drawing').length;
  let free = DRAW_CONCURRENCY - busy;
  story.pages.forEach((p, i) => {
    if (free > 0 && p.state === 'queued') { free--; drawOne(i); }
  });
}

// Swiping: CSS scroll-snap does the motion; we track which page is in view.
let scrollTimer = 0;
$('pager').addEventListener('scroll', () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    const pager = $('pager');
    const i = Math.round(pager.scrollLeft / pager.clientWidth);
    if (i !== current) setCurrent(i, true);
  }, 60);
}, { passive: true });

$('pager').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const i = Math.max(0, Math.min(PAGES - 1, current + (e.key === 'ArrowRight' ? 1 : -1)));
    $('pager').scrollTo({ left: i * $('pager').clientWidth, behavior: 'smooth' });
  }
});

function setCurrent(i, sound) {
  current = i;
  if (sound) turn();
  $('counter').textContent = `${i + 1}/${PAGES}`;
  [...$('dots').children].forEach((d, k) => d.classList.toggle('on', k === i));
  paintActions();
}

function paintActions() {
  const ready = !!story?.pages[current]?.png;
  $('save').disabled = !ready;
  $('share').disabled = !ready;
}

// ---------- save / share: the page art plus its caption and speech bubble, as one PNG ----------
function wrap(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > maxWidth && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

async function renderPage(i, art) {
  const p = story.pages[i];
  const W = art.naturalWidth, H = art.naturalHeight;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(art, 0, 0, W, H);
  const grid = toGrid(ctx.getImageData(0, 0, W, H).data, W, H);

  const pad = W * 0.03;
  const font = Math.round(W * 0.032);
  const line = font * 1.25;
  ctx.font = `700 ${font}px system-ui, sans-serif`;
  const capLines = p.caption ? wrap(ctx, p.caption, W * 0.6) : [];
  const capBox = capLines.length ? { w: Math.max(...capLines.map((l) => ctx.measureText(l).width)) + pad * 1.4, h: capLines.length * line + pad } : null;
  ctx.font = `800 ${font}px system-ui, sans-serif`;
  const spLines = p.speech ? wrap(ctx, p.speech, W * 0.42) : [];
  const textW = spLines.length ? Math.max(...spLines.map((l) => ctx.measureText(l).width)) : 0;
  const textH = spLines.length * line;
  // The ellipse that holds the text: its bounding box is what gets placed.
  const bubBox = spLines.length ? { w: (textW + pad * 2) * 1.16, h: (textH + pad * 1.2) * 1.45 } : null;

  const plan = planPage(grid, { width: W, height: H, caption: capBox, bubble: bubBox, speechPanel: p.speechPanel ?? 2 });
  p.layout = plan;

  ctx.filter = 'grayscale(1) contrast(1.08)';
  ctx.drawImage(art, 0, 0, W, H);
  ctx.filter = 'none';
  ctx.fillStyle = '#fff';
  if (plan.margins.top > 0) ctx.fillRect(0, 0, W, plan.margins.top);
  if (plan.margins.bottom < H) ctx.fillRect(0, plan.margins.bottom, W, H - plan.margins.bottom);
  ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(3, W * 0.005);

  if (plan.caption) {
    const { x, y, w, h } = plan.caption;
    ctx.fillStyle = '#fff'; ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = '#000'; ctx.font = `700 ${font}px system-ui, sans-serif`;
    capLines.forEach((l, k) => ctx.fillText(l, x + pad * 0.7, y + pad * 0.5 + font * 1.05 + k * line));
  }
  if (plan.bubble) {
    const { x, y, w, h } = plan.bubble;
    const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
    const dir = plan.tail.toward === 'left' ? -1 : 1, vy = plan.tail.down ? 1 : -1;
    const tip = { x: cx + dir * rx * 0.75, y: cy + vy * ry * 1.6 };
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.moveTo(cx + dir * rx * 0.15, cy + vy * ry * 0.7); ctx.lineTo(tip.x, tip.y); ctx.lineTo(cx + dir * rx * 0.5, cy + vy * ry * 0.55); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + dir * rx * 0.13, cy + vy * ry * 0.62); ctx.lineTo(cx + dir * rx * 0.52, cy + vy * ry * 0.48); ctx.lineTo(cx + dir * rx * 0.3, cy + vy * ry * 0.95); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.font = `800 ${font}px system-ui, sans-serif`;
    spLines.forEach((l, k) => ctx.fillText(l, cx, cy - textH / 2 + font * 0.95 + k * line));
    ctx.textAlign = 'start';
  }
  const small = Math.round(font * 0.6);
  ctx.font = `700 ${small}px system-ui, sans-serif`;
  const label = `${story.title} · ${i + 1}/${PAGES}`;
  ctx.fillStyle = '#fff';
  ctx.fillRect(pad * 0.6, H - small * 1.9, ctx.measureText(label).width + small, small * 1.5);
  ctx.fillStyle = '#000';
  ctx.fillText(label, pad * 0.6 + small / 2, H - small * 0.75);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('could not encode the page'))), 'image/png'));
}

const fileName = (i) => `${(story.title || 'manga').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-page-${i + 1}.png`;

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

$('save').addEventListener('click', () => {
  const i = current;
  download(story.pages[i].png, fileName(i));
});

$('share').addEventListener('click', () => {
  const i = current;
  const file = new File([story.pages[i].png], fileName(i), { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    navigator.share({ files: [file], title: story.title, text: `${story.title}, page ${i + 1}` }).catch(() => {});
  } else download(file, file.name);
});

loadStatus();
window.__manga = () => ({
  current, title: story?.title, states: story?.pages.map((p) => p.state) ?? [], status: $('status').textContent,
  layouts: story?.pages.map((p) => p.layout ?? null) ?? [],
});
