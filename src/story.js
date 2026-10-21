// The five questions, the script model call, and the art prompt for each page.
import { PAGES } from './limits.js';

export const TEXT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const IMAGE_MODEL = '@cf/black-forest-labs/flux-2-klein-4b';
export const PAGE_W = 768;
export const PAGE_H = 1024;

export const QUESTIONS = [
  { id: 'name', label: 'What should the story call you?', max: 40 },
  { id: 'roots', label: 'Where did you grow up, and what was it like?', max: 160 },
  { id: 'turn', label: 'A moment that changed everything', max: 160 },
  { id: 'proud', label: 'Something you are proud of', max: 160 },
  { id: 'next', label: 'What comes next for you?', max: 160 },
];

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// Parses the client's answers. Returns { answers } or { error }.
export function parseAnswers(body) {
  if (!body || typeof body !== 'object') return { error: 'Send your answers as JSON.' };
  const answers = {};
  for (const q of QUESTIONS) {
    const v = clean(body[q.id], q.max);
    if (!v) return { error: `Please answer: ${q.label}` };
    answers[q.id] = v;
  }
  return { answers };
}

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    pages: {
      type: 'array',
      minItems: PAGES,
      maxItems: PAGES,
      items: {
        type: 'object',
        properties: {
          panels: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string' } },
          caption: { type: 'string' },
          speech: { type: 'string' },
        },
        required: ['panels', 'caption', 'speech'],
      },
    },
  },
  required: ['title', 'pages'],
};

const SYSTEM = `You write short, heartfelt manga scripts about a real person's life. You get five answers from them.
Write exactly ${PAGES} pages that tell their story in order: 1 childhood and roots, 2 growing up, 3 the turning point,
4 the struggle after it, 5 the proud achievement, 6 looking ahead (end on hope).
Each page has:
- "panels": exactly 3 visual descriptions, one per panel, each 12 to 25 words. Describe only what we SEE: setting,
  action, camera angle (close-up, wide shot, low angle), emotion on the face. Call the main character "the hero".
  Never put words, signs, letters or speech bubbles in a panel description.
- "caption": one full narration sentence of 10 to 18 words (60 to 110 characters), in second person or using
  the person's name, warm and specific to their answers.
- "speech": one line the hero says or thinks, 4 to 10 words.
Example page:
{"panels": ["Wide shot of a rainy harbor at dawn, fishing boats rocking, gulls overhead",
 "Close-up of the hero, age eight, sketching on a receipt roll at a cluttered workbench, tongue out in focus",
 "Low angle of the hero's father lifting a boat engine, grinning down at the hero"],
 "caption": "Every morning the harbor smelled of salt and diesel, and you drew all of it.",
 "speech": "One day I'll draw the whole sea!"}
Use the person's real details. Do not invent tragedies they did not mention. Keep it kind and PG.
"title" is a 2 to 5 word manga title. Reply with JSON only.`;

export function userPrompt(a) {
  return `Name: ${a.name}\nWhere they grew up: ${a.roots}\nA moment that changed everything: ${a.turn}\nProud of: ${a.proud}\nWhat comes next: ${a.next}`;
}

const trim = (s, max) => clean(s, max);

// Validates and normalizes whatever the model returned. Returns a script or null.
export function parseScript(raw, name) {
  let obj = raw;
  if (typeof raw === 'string') {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { obj = JSON.parse(m[0]); } catch { return null; }
  }
  if (!obj || !Array.isArray(obj.pages) || obj.pages.length < PAGES) return null;
  const pages = obj.pages.slice(0, PAGES).map((p) => {
    const panels = Array.isArray(p?.panels) ? p.panels.map((x) => trim(x, 220)).filter(Boolean).slice(0, 3) : [];
    return { panels, caption: trim(p?.caption, 140), speech: trim(p?.speech, 80) };
  });
  if (pages.some((p) => p.panels.length < 2 || !p.caption)) return null;
  return { title: trim(obj.title, 60) || `The Story of ${name}`, pages };
}

export async function writeScript(ai, answers) {
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: userPrompt(answers) }];
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await ai.run(TEXT_MODEL, {
      messages,
      max_tokens: 1400,
      temperature: 0.8,
      response_format: { type: 'json_schema', json_schema: SCHEMA },
    });
    const script = parseScript(out?.response ?? out, answers.name);
    if (script) return script;
  }
  return null;
}

// The art prompt sent to FLUX.2 [klein]. `refs` is how many reference photos came with the request.
export function artPrompt(scene, refs) {
  const who = refs > 1 ? `the person shown in reference images 0 to ${refs - 1}` : 'the person shown in reference image 0';
  return [
    'A single black-and-white manga page, classic shonen/seinen style, bold clean ink lines, screentone shading,',
    'high contrast, pure monochrome, no color at all.',
    `The page has ${scene.length} panels in a dynamic layout with thick black borders and white gutters.`,
    `The hero is ${who}: keep the same face, hairstyle, facial hair and glasses, drawn as a manga character.`,
    ...scene.map((s, i) => `Panel ${i + 1}: ${s}`),
    'No text, no letters, no Japanese characters, no speech bubbles, no captions, no sound effects, no signs with writing, no watermark.',
  ].join(' ');
}

// Draws one page. `photos` are JPEG Blobs, each under 512x512. Returns the base64 image string.
export async function drawPage(ai, prompt, photos, seed) {
  const form = new FormData();
  form.append('prompt', prompt);
  form.append('width', String(PAGE_W));
  form.append('height', String(PAGE_H));
  form.append('seed', String(seed));
  photos.forEach((p, i) => form.append(`input_image_${i}`, p, `ref${i}.jpg`));
  const body = new Response(form);
  const out = await ai.run(IMAGE_MODEL, { multipart: { body: body.body, contentType: body.headers.get('content-type') } });
  if (!out?.image) throw new Error('no image in model output');
  return out.image;
}
