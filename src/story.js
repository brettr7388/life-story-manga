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
    pronoun: { type: 'string', enum: ['he', 'she', 'they'] },
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
          speechPanel: { type: 'integer', minimum: 1, maximum: 3 },
        },
        required: ['panels', 'caption', 'speech', 'speechPanel'],
      },
    },
  },
  required: ['title', 'pronoun', 'pages'],
};

const SYSTEM = `You write short, heartfelt manga scripts about a real person's life. You get five answers from them.
Write exactly ${PAGES} pages that tell their story in order: 1 childhood and roots, 2 growing up, 3 the turning point,
4 the struggle after it, 5 the proud achievement, 6 looking ahead (end on hope).
"pronoun": "he" or "she" when the name or the answers make it clear, "they" only when it is truly unclear.
Each page has:
- "panels": exactly 3 visual descriptions for three stacked panels (top, middle, bottom), each 12 to 30 words.
  Describe only what we SEE: setting, action, camera angle (close-up, wide shot, low angle), emotion on the face.
  Call the main character "the hero". Every panel is a full scene; never describe an empty or blank panel.
  Anyone else who appears gets a short, distinct look EVERY time they appear: age, build, hair, clothes,
  for example "the hero's father, a stocky bald man in his sixties with a gray mustache and oil-stained overalls".
  Make them look clearly unlike the hero (different age, hair, build). Keep other people to one or two per panel.
  Never mention signs, posters, banners, book covers, newspapers, screens, menus, labels, letters, numbers or any
  writing. Never put words or speech bubbles in a panel.
- "caption": one full narration sentence of 10 to 18 words (60 to 110 characters), warm and specific to their answers.
  Narrate in the third person and call the person by the NAME they gave, on every page, the same way every time.
  After the name use the "pronoun" you chose (his, her, him, himself, herself); never "they" or "their" for the
  hero unless "pronoun" is "they". Never use "you", "your", "I", "my", "me", "we" or "our" in a caption.
- "speech": one line the hero says out loud, 4 to 10 words, first person is fine.
- "speechPanel": 1, 2 or 3, the panel where the hero says that line. That panel must show the hero's face
  close enough to be speaking, and the line must fit what happens in that panel.
Example page for someone named Mia whose answers say she:
{"panels": ["Wide shot of a rainy harbor at dawn, fishing boats rocking, gulls overhead",
 "Close-up of the hero, age eight, sketching on a receipt roll at a cluttered workbench, tongue out in focus",
 "Low angle of the hero's father, a tall thin man in his forties with a shaved head and a thick wool sweater, lifting a boat engine while the hero looks up at him, grinning"],
 "caption": "Every morning the harbor smelled of salt and diesel, and Mia drew all of it in her notebook.",
 "speech": "Dad, one day I'll draw the whole sea!",
 "speechPanel": 3}
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
    const at = Number.parseInt(p?.speechPanel, 10);
    const speechPanel = Number.isInteger(at) ? Math.min(Math.max(at, 1), panels.length || 1) - 1 : panels.length - 1;
    return { panels, caption: trim(p?.caption, 140), speech: trim(p?.speech, 80), speechPanel };
  });
  if (pages.some((p) => p.panels.length < 2 || !p.caption)) return null;
  const pronoun = ['he', 'she'].includes(String(obj.pronoun).toLowerCase()) ? String(obj.pronoun).toLowerCase() : 'they';
  return { title: trim(obj.title, 60) || `The Story of ${name}`, pronoun, pages };
}

// Captions narrate in the third person with the person's name. These catch "you" / "I" narration.
const OFF_VOICE = /\b(you|your|yours|yourself|you're|you've|you'll|you'd|i|i'm|i've|i'll|my|me|myself|we|our|us)\b/i;
// With a clear he/she, "they/their" in a caption is the model drifting into a vague voice.
const THEY = /\b(they|their|theirs|them|themself|themselves)\b/i;
export const voiceOk = (script) =>
  script.pages.every((p) => !OFF_VOICE.test(p.caption) && (script.pronoun === 'they' || !THEY.test(p.caption)));

// Last resort when the model keeps narrating in the second person: rewrite the common forms to the name.
export function toThirdPerson(caption, name) {
  const n = name.split(' ')[0] || name;
  const rules = [
    [/\byou are\b|\byou're\b/gi, `${n} is`], [/\byou were\b/gi, `${n} was`], [/\byou have\b|\byou've\b/gi, `${n} has`],
    [/\byou'll\b/gi, `${n} will`], [/\byou'd\b/gi, `${n} would`], [/\byourself\b/gi, 'themself'],
    [/\byours\b/gi, `${n}'s`], [/\byour\b/gi, `${n}'s`], [/\byou\b/gi, n],
    [/\bI am\b|\bI'm\b/g, `${n} is`], [/\bI was\b/g, `${n} was`], [/\bI\b/g, n], [/\bmy\b/gi, `${n}'s`], [/\bme\b/gi, n],
  ];
  let out = caption;
  for (const [re, to] of rules) out = out.replace(re, to);
  return out.charAt(0).toUpperCase() + out.slice(1);
}

export async function writeScript(ai, answers) {
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: userPrompt(answers) }];
  let fallback = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await ai.run(TEXT_MODEL, {
      messages,
      max_tokens: 1400,
      temperature: 0.8,
      response_format: { type: 'json_schema', json_schema: SCHEMA },
    });
    const script = parseScript(out?.response ?? out, answers.name);
    if (!script) continue;
    if (voiceOk(script)) return script;
    fallback = script;
  }
  if (fallback) fallback.pages.forEach((p) => { p.caption = toThirdPerson(p.caption, answers.name); });
  return fallback;
}

// Nouns that make FLUX letter the art. Each one is drawn blank instead.
const LETTERED = /\b(signs?|signboards?|posters?|banners?|billboards?|newspapers?|headlines?|labels?|menus?|scoreboards?|placards?|plaques?|books?|notebooks?|letters?|notes?|screens?|monitors?|phones?|laptops?|t-shirts?|shirts?|jerseys?|certificates?|diplomas?|trophies|trophy|awards?)\b/gi;
export const unletter = (s) => s.replace(LETTERED, (w) => `wordless ${w}`).replace(/\bwordless wordless\b/gi, 'wordless');

// Words the safety filter tends to flag; the soft retry drops them.
const HEAVY = /\b(bats?|baseball|clubs?|smash\w*|hit|hits|hitting|throw\w*|threw|bang\w*|whack\w*|blood\w*|bleed\w*|wound\w*|injur\w*|hurt\w*|fight\w*|punch\w*|weapons?|guns?|knife|knives|fire|burn\w*|smok\w*|drunk|beer|wine|bar|naked|shirtless|bath\w*|bed|kiss\w*|cry\w*|cries|cried|tears?|sobb\w*|alone|lonely|dark\w*|storm\w*|hospital|funeral|death|dead|dying|grave|crash\w*|fall\w*|fell|struggl\w*|despair\w*|anger|angry|scream\w*|shout\w*|rage)\b/gi;
export const soften = (s) =>
  s.replace(HEAVY, '').replace(/\s{2,}/g, ' ').replace(/\s+([,.])/g, '$1').replace(/,(\s*,)+/g, ',').replace(/^[\s,]+/, '').trim();

// The art prompt sent to FLUX.2 [klein]. `refs` is how many reference photos came with the request.
// `speak` is the panel (0-2) where the hero speaks; `soft` is the gentler wording used to retry a flagged page.
export function artPrompt(scene, refs, { speak = -1, soft = false } = {}) {
  const who = refs > 1 ? `the person shown in reference images 0 to ${refs - 1}` : 'the person shown in reference image 0';
  const panels = scene.map((s) => unletter(soft ? soften(s) : s).replace(/[^.!?]$/, '$&.'));
  return [
    'A silent, wordless black-and-white manga page told only in pictures, classic shonen/seinen style,',
    'bold clean ink lines, screentone shading, high contrast, pure monochrome, no color at all.',
    `The page is exactly ${panels.length} full-width horizontal panels stacked from top to bottom, equal height,`,
    'thick black borders, white gutters. Every panel is fully drawn from border to border; no empty or blank panels, no extra panels.',
    `The hero is ${who}: keep the same face, head shape, hair and any glasses or facial hair, drawn as a manga character.`,
    'Only the hero comes from the reference images. Every other person is a different individual who looks clearly unlike',
    'the hero, with their own face, age, build, hair and clothes as described, never a copy of the hero.',
    soft ? 'A gentle, wholesome, all-ages slice-of-life scene. Everyone is fully clothed, calm and hopeful.' : '',
    ...panels.map((s, i) => `Panel ${i + 1} (${['top', 'middle', 'bottom'][i] ?? 'next'}): ${s}${i === speak ? " The hero's mouth is open mid-sentence." : ''}`),
    'Pictures only: nothing is written anywhere on the page, no lettering, no page number, no title, no signature.',
    'Shop fronts, book covers, papers, screens and clothes show only simple shapes and patterns. Plain white paper margins.',
  ].filter(Boolean).join(' ');
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
