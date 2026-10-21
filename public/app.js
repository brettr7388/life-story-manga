import { unlock, startMusic, turn, isMuted, setMuted } from './audio.js';

const PAGES = 6;
const MAX_PHOTOS = 4;
const MAX_SIDE = 496; // FLUX.2 [klein] on Workers AI needs reference images under 512x512
const DRAW_CONCURRENCY = 2;

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
    ta.required = true;
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
  if (!photos.length) return formError('Add at least one photo of yourself.');
  const answers = Object.fromEntries([...$('form').querySelectorAll('textarea')].map((t) => [t.name, t.value.trim()]));
  const missing = [...$('form').querySelectorAll('textarea')].find((t) => !t.value.trim());
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
    page.querySelector('.redraw').addEventListener('click', () => { story.pages[i].state = 'queued'; drawAll(); });
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
}

function status(msg) { $('status').textContent = msg; }

async function drawOne(i) {
  const p = story.pages[i];
  const run = story.run;
  p.state = 'drawing';
  const el = pageEl(i);
  el.classList.add('inking');
  el.classList.remove('failed');
  el.querySelector('.redraw').hidden = true;
  const fd = new FormData();
  fd.append('run', run);
  fd.append('page', String(i));
  fd.append('panels', JSON.stringify(p.panels));
  fd.append('sig', p.sig);
  photos.forEach((ph, k) => fd.append(`photo${k}`, ph.blob, `photo${k}.jpg`));
  try {
    const res = await fetch('/api/page', { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) throw new Error(data.error || 'failed');
    if (!story || story.run !== run) return;
    p.image = `data:image/jpeg;base64,${data.image}`;
    const img = el.querySelector('img');
    img.onload = () => {
      el.classList.remove('inking');
      el.classList.add('inked');
      // Render the shareable PNG now, so Share can call navigator.share inside the tap (iOS needs that).
      renderPage(i).then((png) => { p.png = png; p.state = 'done'; afterDraw(); });
    };
    img.src = p.image;
  } catch (err) {
    if (!story || story.run !== run) return;
    p.state = 'failed';
    (window.__pageErrors ??= []).push({ page: i + 1, error: err.message });
    el.classList.remove('inking');
    el.classList.add('failed');
    const btn = el.querySelector('.redraw');
    btn.hidden = false;
    if (/used all/.test(err.message)) { btn.textContent = err.message; btn.disabled = true; }
    afterDraw();
  }
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

async function renderPage(i) {
  const p = story.pages[i];
  const img = pageEl(i).querySelector('img');
  const W = img.naturalWidth, H = img.naturalHeight;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.filter = 'grayscale(1) contrast(1.08)';
  ctx.drawImage(img, 0, 0, W, H);
  ctx.filter = 'none';
  const pad = W * 0.03;
  const font = Math.round(W * 0.032);
  if (p.caption) {
    ctx.font = `700 ${font}px system-ui, sans-serif`;
    const lines = wrap(ctx, p.caption, W * 0.62);
    const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 1.4;
    const bh = lines.length * font * 1.25 + pad;
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(3, W * 0.005);
    ctx.fillRect(pad, pad, bw, bh); ctx.strokeRect(pad, pad, bw, bh);
    ctx.fillStyle = '#000';
    lines.forEach((l, k) => ctx.fillText(l, pad * 1.7, pad + font * (1.05 + k * 1.25)));
  }
  if (p.speech) {
    ctx.font = `800 ${font}px system-ui, sans-serif`;
    const lines = wrap(ctx, p.speech, W * 0.5);
    const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
    const bh = lines.length * font * 1.25 + pad * 1.2;
    const x = W - bw * 1.08 - pad * 1.4, y = H - bh - pad * 2.6; // the ellipse reaches past the text box
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(3, W * 0.005);
    ctx.beginPath(); ctx.ellipse(x + bw / 2, y + bh / 2, bw / 1.75, bh / 1.4, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#000'; ctx.textAlign = 'center';
    lines.forEach((l, k) => ctx.fillText(l, x + bw / 2, y + pad * 0.6 + font * (0.95 + k * 1.25)));
    ctx.textAlign = 'start';
  }
  const small = Math.round(font * 0.6);
  ctx.font = `700 ${small}px system-ui, sans-serif`;
  const label = `${story.title} · ${i + 1}/${PAGES}`;
  ctx.fillStyle = '#fff';
  ctx.fillRect(pad * 0.6, H - small * 1.9, ctx.measureText(label).width + small, small * 1.5);
  ctx.fillStyle = '#000';
  ctx.fillText(label, pad * 0.6 + small / 2, H - small * 0.75);
  return new Promise((res) => c.toBlob(res, 'image/png'));
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
window.__manga = () => ({ current, title: story?.title, states: story?.pages.map((p) => p.state) ?? [] });
