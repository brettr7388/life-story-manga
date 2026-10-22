// Life-story manga: five answers and up to four photos in, six black-and-white manga pages out.
//
//   POST /api/start  {name, roots, turn, proud, next}   -> takes a daily slot, writes the 6-page script,
//                                                          returns it with one signature per page
//   POST /api/page   multipart: run, page, panels, sig,  -> draws one page with FLUX.2 [klein], using
//                    photo0..photo3 (JPEG, < 512x512)       the photos as references; returns base64
//   GET  /api/status                                     -> {cap, used, left, questions} for today (UTC)
//
// Photos live only in the /api/page request: they go to the model and are never written anywhere.
// D1 holds two counters (mangas per day, drawings per manga) and nothing about the person.
import { PAGES, dailyCap, takeSlot, returnSlot, used, openRun, takeDraw, utcDay } from './limits.js';
import { QUESTIONS, parseAnswers, writeScript, artPanels, artPrompt, drawPage } from './story.js';
import { signPage, verifyPage } from './sign.js';
import { jpegSize } from './jpeg.js';
import { serveStatic } from './static.js';

const MAX_PHOTOS = 4;
const MAX_PHOTO_BYTES = 300_000;

const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy':
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...SECURITY, 'content-type': 'application/json', 'cache-control': 'no-store' } });

const capMessage = (cap) => ({ error: `Today's ${cap} free mangas are all drawn. Come back after midnight UTC.`, code: 'cap' });

async function status(env) {
  const cap = dailyCap(env);
  const n = await used(env.DB, utcDay());
  return json({ cap, used: Math.min(n, cap), left: Math.max(0, cap - n), questions: QUESTIONS });
}

async function start(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Send your answers as JSON.' }, 400); }
  const { answers, error } = parseAnswers(body);
  if (error) return json({ error }, 400);

  const day = utcDay();
  const cap = dailyCap(env);
  if ((await takeSlot(env.DB, day, cap)) === null) return json(capMessage(cap), 429);

  let script = null;
  try { script = await writeScript(env.AI, answers); } catch (e) { console.log('script model error', e?.message); }
  if (!script) {
    await returnSlot(env.DB, day);
    return json({ error: 'The writer got stuck. Try again in a moment.' }, 502);
  }

  const run = crypto.randomUUID();
  await openRun(env.DB, run, day);
  const pages = await Promise.all(
    script.pages.map(async (p, i) => {
      const panels = artPanels(p, script);
      return { beat: p.beat, caption: p.caption, speaker: p.speaker, speech: p.speech, speechPanel: p.speechPanel, panels,
        sig: await signPage(env.SIGNING_KEY, run, i, scene(JSON.stringify(panels), answers.look)) };
    }),
  );
  return json({ run, title: script.title, plot: script.plot, look: answers.look, pages });
}

async function page(request, env) {
  let form;
  try { form = await request.formData(); } catch { return json({ error: 'Bad upload.' }, 400); }
  const run = String(form.get('run') ?? '');
  const index = Number(form.get('page'));
  const panelsRaw = String(form.get('panels') ?? '');
  if (!/^[0-9a-f-]{36}$/.test(run) || !Number.isInteger(index) || index < 0 || index >= PAGES) return json({ error: 'Bad page.' }, 400);
  const look = String(form.get('look') ?? '');
  if (!(await verifyPage(env.SIGNING_KEY, run, index, scene(panelsRaw, look), form.get('sig')))) return json({ error: 'That page was not written here.' }, 403);

  const photos = [];
  for (let i = 0; i < MAX_PHOTOS; i++) {
    const f = form.get(`photo${i}`);
    if (!f || typeof f === 'string') continue;
    if (f.size > MAX_PHOTO_BYTES) return json({ error: 'A photo is too large.' }, 413);
    const size = jpegSize(new Uint8Array(await f.slice(0, 65536).arrayBuffer())); // the SOF marker is near the start
    if (!size || size.width >= 512 || size.height >= 512) return json({ error: 'Photos must be JPEGs under 512x512.' }, 400);
    photos.push(f);
  }
  if (!photos.length && !look) return json({ error: 'Add at least one photo, or describe how you look.' }, 400);

  if (!(await takeDraw(env.DB, run))) return json({ error: 'This manga has used all its drawings.', code: 'draws' }, 429);

  const panels = JSON.parse(panelsRaw);
  const seed = Number.parseInt(run.replace(/-/g, '').slice(0, 7), 16) + index;
  // A page the safety filter flags (3030) is retried once with softer wording and a new seed.
  // The retry is a second drawing, so it is taken from the same per-manga budget.
  let soft = false;
  for (;;) {
    try {
      const image = await drawPage(env.AI, artPrompt(panels, photos.length, { soft, look }), photos, soft ? seed + 7919 : seed);
      if (soft) console.log('image soft retry ok', index);
      return json({ page: index, image, retried: soft });
    } catch (e) {
      const message = String(e?.message ?? e);
      console.log('image model error', index, soft ? 'soft' : 'first', message);
      if (isQuota(message)) return json({ error: 'The artist is out of ink for today. Come back after midnight UTC.', code: 'quota' }, 429);
      if (soft || !isFlagged(message)) break;
      if (!(await takeDraw(env.DB, run))) return json({ error: 'This manga has used all its drawings.', code: 'draws' }, 429);
      soft = true;
    }
  }
  return json({ error: 'The artist smudged this page. Tap to redraw.' }, 502);
}

// What a page signature covers: the panels and the look, both of which go into the art prompt.
const scene = (panelsRaw, look) => (look ? `${panelsRaw}\nlook:${look}` : panelsRaw);

const isFlagged = (message) => /\b3030\b|flagged/i.test(message);
// 4006: the account's free daily neurons are used up. Redrawing cannot help until the UTC day resets.
const isQuota = (message) => /\b4006\b|daily free allocation/i.test(message);

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (pathname === '/api/status') return status(env);
      const file = serveStatic(request, pathname, SECURITY);
      if (file) return file;
      return new Response('Not found', { status: 404, headers: { ...SECURITY, 'content-type': 'text/plain' } });
    }
    if (request.method === 'POST' && pathname === '/api/start') return start(request, env);
    if (request.method === 'POST' && pathname === '/api/page') return page(request, env);
    return new Response('Method not allowed', { status: 405, headers: SECURITY });
  },
};
