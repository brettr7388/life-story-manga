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
  { id: 'look', label: 'No photos? Describe how you look instead (optional with photos)', max: 200, optional: true },
];

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// Parses the client's answers. Returns { answers } or { error }.
export function parseAnswers(body) {
  if (!body || typeof body !== 'object') return { error: 'Send your answers as JSON.' };
  const answers = {};
  for (const q of QUESTIONS) {
    const v = clean(body[q.id], q.max);
    if (!v && !q.optional) return { error: `Please answer: ${q.label}` };
    answers[q.id] = v;
  }
  return { answers };
}

const SCHEMA = {
  type: 'object',
  properties: {
    plot: { type: 'string' },
    title: { type: 'string' },
    pronoun: { type: 'string', enum: ['he', 'she', 'they'] },
    setting: { type: 'string' },
    cast: {
      type: 'array',
      maxItems: 3,
      items: { type: 'object', properties: { name: { type: 'string' }, look: { type: 'string' } }, required: ['name', 'look'] },
    },
    pages: {
      type: 'array',
      minItems: PAGES,
      maxItems: PAGES,
      items: {
        type: 'object',
        properties: {
          beat: { type: 'string' },
          panels: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string' } },
          caption: { type: 'string' },
          speaker: { type: 'string' },
          speech: { type: 'string' },
          speechPanel: { type: 'integer', minimum: 1, maximum: 3 },
        },
        required: ['beat', 'panels', 'caption', 'speaker', 'speech', 'speechPanel'],
      },
    },
  },
  required: ['plot', 'title', 'pronoun', 'setting', 'cast', 'pages'],
};

export const BEATS = ['setup', 'problem', 'rising action', 'climax', 'resolution', 'ending'];

const SYSTEM = `You write short manga scripts that turn a person's five answers into ONE clear story a stranger can follow.
Work in this order:
1. "plot": first write the whole story in one sentence: who wants what, what goes wrong, how it is solved, how it ends.
   Build it from the answers: where they grew up is the world, the moment that changed everything is the problem
   or the turning point, what they are proud of is how it gets solved, what comes next is the ending.
   Do not list the answers one per page; weave them into one chain of events.
2. "title": 2 to 5 words. "pronoun": "he" or "she" when the name or answers make it clear, "they" only if truly unclear.
3. "setting": one visual description of the main place, 15 to 35 words (place, era, season, weather, landmarks),
   used on every page so the world looks the same throughout.
4. "cast": up to 3 other characters who matter, each { "name", "look" }. "name" is a short proper name the story
   uses every time (like "Grandpa Budi", "Sari", "Dad"), never a generic label like "Little Girl" or "Villager".
   "look" is 12 to 25 words: species or age, build, hair, clothes, so each is drawn the same way every time and
   clearly unlike the hero. Use the cast again on later pages instead of introducing new people.
5. "pages": exactly ${PAGES} pages, one beat each, in this order: ${BEATS.map((b, i) => `${i + 1} ${b}`).join(', ')}.
   Write each beat ("beat") as its name. Setup: who the hero is and what they want. Problem: what goes wrong.
   Rising action: the hero's attempt and a complication. Climax: the tense moment it is solved, at the last second.
   Resolution: what the fix changed for everyone. Ending: a final happy image that matches what comes next. Every page follows directly from the page before: same hero, same cast,
   same setting, cause and effect. Someone reading only the captions must understand what happened and why.
   - "caption": one narration sentence, 10 to 22 words, that moves the plot forward (what happens now, and why).
     Narrate in the third person. Name the hero by the NAME they gave on page 1; later pages may use the
     name or the pronoun ("he", "his", "she", "her"). Never "you", "your", "I", "my", "me", "we" or "our" in a caption,
     and never "they"/"their" for the hero unless "pronoun" is "they".
   - "speaker": who says the speech line: "the hero" or the exact name of a cast member.
   - "speech": 5 to 12 words of natural dialogue the speaker says to someone else in the panel at this exact
     moment: a question, a worry, a joke, a plan, a thank-you. It reacts to what happens on this page and could not
     fit any other page. No catchphrases and no generic cheers: never lines like "We did it!", "Best day ever!",
     "Let's go!", "Feast time!" or "This is just the beginning!". Good lines sound like:
     "Kaito, hold that end steady while I saw!", "Why is everyone looking at me like that?", "Dad, can I borrow the van?"
   - Funny: keep the funniest detail from the answers and make it a moment we can SEE (a reaction, a mix-up).
   - "panels": exactly 3 panels (top, middle, bottom), each 15 to 35 words, showing exactly the moment the caption
     and the speech describe, in order. Each panel says WHO is in it (call the main character "the hero",
     and cast members by their name), WHAT they are doing, WHERE (a specific spot in the setting), the camera
     (wide shot, medium shot, close-up) and the emotion on faces. Keep it to at most 3 characters per panel.
     Never mention signs, posters, banners, books, newspapers, screens, menus, labels, forms, flyers, maps, letters,
     numbers or any writing, and never put words or speech bubbles in a panel.
   - "speechPanel": 1, 2 or 3, the panel where the speaker says the line. That panel is a medium shot or close-up
     of the speaker's FACE (never only hands or objects), and names the speaker in its description.
Keep it kind, funny where it fits, and PG. No violence and no weapons: name tools as workshop or kitchen tools
(saw, hammer, splitting wedge, ladle), never an axe, and tools only ever touch wood, food or objects, never a person.
Do not invent tragedies the answers do not mention. Reply with JSON only.
Example of one page (beat 2) for a girl named Mia whose story is about saving her dad's boat repair shop:
{"beat": "problem",
 "panels": ["Wide shot of the hero and Dad standing in the flooded boat workshop by the harbor, water up to their ankles, both shocked",
  "Medium shot of Dad, a stocky bald man in his sixties with a gray mustache and oil-stained overalls, holding a soaked toolbox, frowning",
  "Close-up of the hero, age ten with two braids, gripping Dad's sleeve, eyes wide with determination"],
 "caption": "The night before the big regatta, the tide flooded Dad's workshop and every engine stopped.",
 "speaker": "the hero", "speech": "Dad, we can still fix one boat by morning!", "speechPanel": 3}`;

// The text model request for one script. Exported so the offline script check sends exactly what the app sends.
export const scriptRequest = (answers) => ({
  messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userPrompt(answers) }],
  max_tokens: 2200,
  temperature: 0.7,
  response_format: { type: 'json_schema', json_schema: SCHEMA },
});

export function userPrompt(a) {
  return `Name: ${a.name}\nWhere they grew up: ${a.roots}\nA moment that changed everything: ${a.turn}\nProud of: ${a.proud}\nWhat comes next: ${a.next}` +
    (a.look ? `\nWhat they look like: ${a.look}` : '');
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
  const cast = (Array.isArray(obj.cast) ? obj.cast : [])
    .map((c) => ({ name: trim(c?.name, 40), look: trim(c?.look, 160) }))
    .filter((c) => c.name && c.look && !/^(the )?hero$/i.test(c.name))
    .slice(0, 3);
  const pages = obj.pages.slice(0, PAGES).map((p, i) => {
    const panels = Array.isArray(p?.panels) ? p.panels.map((x) => artText(trim(x, 260), name)).filter(Boolean).slice(0, 3) : [];
    const at = Number.parseInt(p?.speechPanel, 10);
    const speechPanel = Number.isInteger(at) ? Math.min(Math.max(at, 1), panels.length || 1) - 1 : panels.length - 1;
    const who = trim(p?.speaker, 40);
    const speaker = cast.find((c) => c.name.toLowerCase() === who.toLowerCase())?.name ?? 'the hero';
    return { beat: trim(p?.beat, 20) || BEATS[i], panels, caption: trim(p?.caption, 160), speaker, speech: trim(p?.speech, 90),
      speechPanel: speakerPanel(panels, speaker, speechPanel) };
  });
  if (pages.some((p) => p.panels.length < 2 || !p.caption)) return null;
  const pronoun = ['he', 'she'].includes(String(obj.pronoun).toLowerCase()) ? String(obj.pronoun).toLowerCase() : 'they';
  return { title: trim(obj.title, 60) || `The Story of ${name}`, plot: trim(obj.plot, 300), setting: trim(obj.setting, 240), pronoun, cast, pages };
}

// Panel text as the artist should read it: the hero by role, not by name (so the look or photos apply), no quoted
// words to draw, no dangling "as he says", and workshop tools instead of weapon words.
export function artText(text, name) {
  let t = text;
  const names = [name, name.split(/\s+/)[0]].filter((n, k, a) => n && n.length > 2 && a.indexOf(n) === k);
  for (const n of names) {
    t = t.replace(new RegExp(`\\bthe hero,? ${escapeRe(n)}('s)?,?`, 'gi'), (m, s) => `the hero${s ?? ''}`)
      .replace(new RegExp(`\\b${escapeRe(n)}'s\\b`, 'g'), "the hero's")
      .replace(new RegExp(`\\b${escapeRe(n)}\\b`, 'g'), 'the hero');
  }
  return t
    .replace(/\s*(that|which)\s+(says|reads|spells)\s*['"“‘][^'"”’]*['"”’]/gi, '')
    .replace(/['"“”][^'"“”]{1,40}['"“”]/g, '')
    .replace(/,?\s+as (he|she|they|the hero) (says|speaks|asks|shouts|exclaims)\s*[.!]?$/i, '')
    .replace(/\b(axes|hatchets)\b/gi, 'saws').replace(/\b(an axe|a hatchet)\b/gi, 'a saw').replace(/\b(axe|hatchet)\b/gi, 'saw')
    .replace(/\bthe hero the hero\b/gi, 'the hero')
    .replace(/\s{2,}/g, ' ').trim();
}

// The bubble goes on a panel that shows the speaker's face. Keeps the model's choice when it does; otherwise picks
// the panel that names the speaker (a face or close-up first), never a hands-only close-up.
export function speakerPanel(panels, speaker, chosen) {
  const term = speaker === 'the hero' ? /\bthe hero\b/i : new RegExp(`\\b${escapeRe(speaker.split(/\s+/)[0])}\\b`);
  const score = (t) => (term.test(t) ? 2 : 0) + (/\b(face|close-up|medium shot)\b/i.test(t) ? 1 : 0) - (handsOnly(t) ? 3 : 0);
  if (panels[chosen] && score(panels[chosen]) >= 2) return chosen;
  let best = chosen;
  panels.forEach((t, k) => { if (score(t) > score(panels[best] ?? '')) best = k; });
  return best;
}

const handsOnly = (t) => /\b(hands?|feet|fingers)\b/i.test(t) && !/\b(face|eyes|grin|smil\w*|mouth)\b/i.test(t);

// A close-up of only the hero's hands loses the look (a log hero came out as human hands), so the hero's face
// is pulled into the frame too.
export function heroInFrame(text) {
  if (!handsOnly(text)) return text;
  return text.replace(/\bthe hero's (hands?|fingers|feet)\b/i, "the hero's face and $1");
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// The panels as the artist gets them: the shared setting on the first panel, each cast member's look wherever
// that member appears, and who is talking in the speech panel. Built once in /api/start and signed, so every page
// draws the same world and the same faces, and the bubble's speaker is really in its panel.
export function artPanels(page, script) {
  return page.panels.map((text, i) => {
    const parts = [heroInFrame(text).replace(/[^.!?]$/, '$&.')];
    if (i === 0 && script.setting) parts.unshift(`Setting: ${script.setting.replace(/[^.!?]$/, '$&.')}`);
    for (const c of script.cast) {
      const first = c.name.split(/\s+/)[0];
      const named = new RegExp(`\\b${escapeRe(c.name)}\\b`, 'i').test(text) || (first.length > 3 && new RegExp(`\\b${escapeRe(first)}\\b`).test(text));
      if (named || (i === page.speechPanel && page.speaker === c.name)) parts.push(`${c.name} is ${c.look.replace(/[.!?]$/, '')}.`);
    }
    if (i === page.speechPanel && page.speech) {
      parts.push(`${page.speaker === 'the hero' ? 'The hero' : page.speaker} is in this panel, talking, mouth open.`);
    }
    return parts.join(' ');
  });
}

// Captions narrate in the third person with the person's name. These catch "you" / "I" narration.
const OFF_VOICE = /\b(you|your|yours|yourself|you're|you've|you'll|you'd|i|i'm|i've|i'll|my|me|myself|we|our|us)\b/i;
// With a clear he/she, "they/their" in a caption is the model drifting into a vague voice.
const THEY = /\b(they|their|theirs|them|themself|themselves)\b/i;
// Generic cheers the prompt forbids; a line with one is redrafted like any other weak line.
const CHEER = /\b(we did it|best day ever|let'?s go|feast time|just the beginning|let'?s (eat and )?celebrate|you saved the day|best \w+ ever|hooray|yay)\b/i;
// Last resort for a cheer the model kept writing: drop the cheer and keep the rest, or show no bubble when too little is left.
export function uncheer(speech) {
  const rest = speech.replace(new RegExp(`${CHEER.source}[,.!]*\\s*`, 'gi'), '').trim();
  if (rest === speech) return speech;
  if (rest.split(/\s+/).length < 4) return '';
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}
// Speech that is real dialogue: every line at least 4 words, no generic cheer, and no line repeated.
export const speechOk = (script) => {
  const lines = script.pages.map((p) => p.speech.toLowerCase().replace(/[^a-z' ]/g, '').trim());
  return lines.every((l) => l.split(/\s+/).length >= 4 && !CHEER.test(l)) && new Set(lines).size === lines.length;
};

// A caption about a group ("the kids and Theo ... their zines") may say "their"; only a solo caption may not.
const GROUP = /\band\b|\b(kids|children|villagers|everyone|friends|family|parents|students|people|crowd|together|neighbou?rs|team|town|village)\b/i;
export const voiceOk = (script) =>
  script.pages.every((p) => !OFF_VOICE.test(p.caption) && (script.pronoun === 'they' || !THEY.test(p.caption) || GROUP.test(p.caption)));

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
  let fallback = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await ai.run(TEXT_MODEL, scriptRequest(answers));
    const script = parseScript(out?.response ?? out, answers.name);
    if (!script) continue;
    if (voiceOk(script) && speechOk(script)) return script;
    if (!fallback || voiceOk(script)) fallback = script;
  }
  if (fallback) fallback.pages.forEach((p) => { p.caption = toThirdPerson(p.caption, answers.name); p.speech = uncheer(p.speech); });
  return fallback;
}

// Nouns that make FLUX letter the art. Each one is drawn blank instead.
const LETTERED = /\b(signs?|signboards?|posters?|banners?|billboards?|newspapers?|headlines?|labels?|menus?|scoreboards?|placards?|plaques?|books?|notebooks?|letters?|notes?|screens?|monitors?|phones?|laptops?|t-shirts?|shirts?|jerseys?|certificates?|diplomas?|trophies|trophy|awards?|flyers?|forms?|maps?|cards?|receipts?|logos?)\b/gi;
export const unletter = (s) => s.replace(LETTERED, (w) => `wordless ${w}`).replace(/\bwordless wordless\b/gi, 'wordless');

// Words the safety filter tends to flag; the soft retry drops them.
const HEAVY = /\b(axes?|hatchets?|bats?|baseball|clubs?|smash\w*|hit|hits|hitting|throw\w*|threw|bang\w*|whack\w*|blood\w*|bleed\w*|wound\w*|injur\w*|hurt\w*|fight\w*|punch\w*|weapons?|guns?|knife|knives|fire|burn\w*|smok\w*|drunk|beer|wine|bar|naked|shirtless|bath\w*|bed|kiss\w*|cry\w*|cries|cried|tears?|sobb\w*|alone|lonely|dark\w*|storm\w*|hospital|funeral|death|dead|dying|grave|crash\w*|fall\w*|fell|struggl\w*|despair\w*|anger|angry|scream\w*|shout\w*|rage)\b/gi;
export const soften = (s) =>
  s.replace(HEAVY, '').replace(/\s{2,}/g, ' ').replace(/\s+([,.])/g, '$1').replace(/,(\s*,)+/g, ',').replace(/^[\s,]+/, '').trim();

// A described look with none of these words is not a person (a log, a cat, a robot). FLUX draws "the hero" holding a
// tool, hugging or sitting at a table as a human boy, so such a hero gets the look and a "not a human" cue in every
// panel that shows the hero, not only once at the top of the prompt.
const PERSON = /\b(man|men|woman|women|boy|girl|person|guy|lady|kid|child|teen\w*|toddler|baby|grand(ma|pa|mother|father)|mom|mum|dad|father|mother|human|years? old|aged?)\b/i;
export const creatureLook = (look) => Boolean(look) && !PERSON.test(look);
const firstPhrase = (look) => look.split(/[,;.]/)[0].trim().replace(/^(i am|i'm)\s+/i, '').replace(/^(a|an)\s+/i, '');

// The art prompt sent to FLUX.2 [klein]. `refs` is how many reference photos came with the request.
// `scene` is the page's art panels (see artPanels); `soft` is the gentler wording used to retry a flagged page.
export function artPrompt(scene, refs, { soft = false, look: rawLook = '' } = {}) {
  const look = rawLook.replace(/[.!?\s]+$/, '');
  const who = refs > 1 ? `the person shown in reference images 0 to ${refs - 1}` : 'the person shown in reference image 0';
  const hero = refs > 0
    ? [`The hero is ${who}: keep the same face, head shape, hair and any glasses or facial hair, drawn as a manga character.`,
      look ? `The hero looks like this: ${look}.` : '',
      'Only the hero comes from the reference images. Every other person is a different individual who looks clearly unlike',
      'the hero, with their own face, age, build, hair and clothes as described, never a copy of the hero.']
    : [`The hero looks like this, the same on every panel: ${look}.`,
      creatureLook(look) ? `The hero is not a human: wherever the hero appears, even holding a tool, hugging, sitting or in close-up, draw the hero as this ${firstPhrase(look)}, never as a man, boy or person.` : '',
      'Every other character looks clearly unlike the hero, with their own face, age, build, hair and clothes as described.'];
  const creature = refs === 0 && creatureLook(look);
  const panels = scene.map((s) => {
    const text = unletter(soft ? soften(s) : s).replace(/[^.!?]$/, '$&.');
    return creature && /\bthe hero\b/i.test(s) ? `${text} The hero here is ${look.charAt(0).toLowerCase()}${look.slice(1)}, not a human.` : text;
  });
  return [
    'A silent, wordless black-and-white manga page told only in pictures, classic shonen/seinen style,',
    'bold clean ink lines, screentone shading, high contrast, pure monochrome, no color at all.',
    `The page is exactly ${panels.length} full-width horizontal panels stacked from top to bottom, equal height,`,
    'thick black borders, white gutters. Every panel is fully drawn from border to border; no empty or blank panels, no extra panels.',
    ...hero,
    soft ? 'A gentle, wholesome, all-ages slice-of-life scene. Everyone is fully clothed, calm and hopeful.' : '',
    ...panels.map((s, i) => `Panel ${i + 1} (${['top', 'middle', 'bottom'][i] ?? 'next'}): ${s}`),
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
