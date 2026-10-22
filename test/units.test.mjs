import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { jpegSize } from '../src/jpeg.js';
import { parseScript, parseAnswers, artPrompt, artPanels, artText, speakerPanel, speechOk, voiceOk, toThirdPerson, unletter, soften } from '../src/story.js';
import { signPage, verifyPage } from '../src/sign.js';
import { dailyCap, DEFAULT_DAILY_CAP } from '../src/limits.js';

test('jpegSize reads baseline and progressive JPEGs', async () => {
  for (const progressive of [false, true]) {
    const buf = await sharp({ create: { width: 333, height: 211, channels: 3, background: '#000' } }).jpeg({ progressive }).withMetadata().toBuffer();
    assert.deepEqual(jpegSize(new Uint8Array(buf)), { width: 333, height: 211 });
  }
  assert.equal(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null);
});

test('parseScript accepts JSON text or objects and trims to six pages', () => {
  const page = { panels: ['a', 'b', 'c'], caption: 'cap', speech: 'hi' };
  const s = parseScript(`Here you go: ${JSON.stringify({ title: 'T', pages: Array(7).fill(page) })}`, 'Sam');
  assert.equal(s.pages.length, 6);
  assert.equal(parseScript({ title: '', pages: Array(6).fill(page) }, 'Sam').title, 'The Story of Sam');
  assert.equal(parseScript({ pages: Array(5).fill(page) }, 'Sam'), null);
  assert.equal(parseScript('nope', 'Sam'), null);
});

test('the look answer is optional and goes to the script model when given', () => {
  const base = { name: 'Sam', roots: 'r', turn: 't', proud: 'p', next: 'n' };
  assert.equal(parseAnswers(base).answers.look, '');
  assert.equal(parseAnswers({ ...base, look: 'a wooden log' }).answers.look, 'a wooden log');
  assert.match(artPrompt(['x'], 1, { look: 'a wooden log' }), /reference image 0.*The hero looks like this: a wooden log\./);
});

test('parseAnswers strips control characters and caps length', () => {
  const { answers } = parseAnswers({ name: 'Sam\u0000\n', roots: 'x'.repeat(500), turn: 't', proud: 'p', next: 'n' });
  assert.equal(answers.name, 'Sam');
  assert.equal(answers.roots.length, 160);
});

test('artPrompt names every reference image and forbids lettering', () => {
  const p = artPrompt(['one', 'two', 'three'], 4);
  assert.match(p, /reference images 0 to 3/);
  assert.match(p, /nothing is written anywhere/);
});

test('page signatures verify only for the same run, page and panels', async () => {
  const sig = await signPage('k', 'run', 2, '["a"]');
  assert.equal(await verifyPage('k', 'run', 2, '["a"]', sig), true);
  assert.equal(await verifyPage('k', 'run', 3, '["a"]', sig), false);
  assert.equal(await verifyPage('other', 'run', 2, '["a"]', sig), false);
  assert.equal(await verifyPage('k', 'run', 2, '["a"]', 'short'), false);
});

test('dailyCap falls back to the default for missing or bad values', () => {
  assert.equal(dailyCap({}), DEFAULT_DAILY_CAP);
  assert.equal(dailyCap({ DAILY_CAP: 'abc' }), DEFAULT_DAILY_CAP);
  assert.equal(dailyCap({ DAILY_CAP: '3' }), 3);
});

test('speech is tied to a panel: speechPanel 1-3 becomes an index, clamped, defaulting to the last panel', () => {
  const mk = (speechPanel) => ({ panels: ['a', 'b', 'c'], caption: 'Sam ran.', speech: 'hi', speechPanel });
  const at = (v) => parseScript({ title: 'T', pages: Array(6).fill(mk(v)) }, 'Sam').pages[0].speechPanel;
  assert.deepEqual([at(1), at(2), at(3), at(9), at(0), at(undefined)], [0, 1, 2, 2, 0, 2]);
});

test('the bubble moves to a panel that shows the speaker, never a hands-only close-up', () => {
  const panels = ['Wide shot of the village, snow falling', 'Medium shot of Sari laughing at the hero', "Close-up of the hero's hands holding a saw"];
  assert.equal(speakerPanel(panels, 'the hero', 2), 1, 'hands-only panel is skipped for one that shows the hero');
  assert.equal(speakerPanel(panels, 'Sari', 0), 1, 'the panel that names the speaker');
  assert.equal(speakerPanel(panels, 'the hero', 1), 1, 'a good choice is kept');
});

test('art panels carry the setting, each cast look, and who is talking', () => {
  const script = { setting: 'A snowy mountain village with wooden cabins', cast: [{ name: 'Sari', look: 'a little girl in a pink coat with pigtails' }], pages: [] };
  const page = { panels: ['Wide shot of the hero in the square', 'Medium shot of Sari waving', 'Close-up of the hero smiling'], speaker: 'Sari', speech: 'Tung, the stove is cold!', speechPanel: 1 };
  const [a, b, c] = artPanels(page, script);
  assert.match(a, /^Setting: A snowy mountain village with wooden cabins\. Wide shot/);
  assert.match(b, /Sari is a little girl in a pink coat with pigtails\. Sari is in this panel, talking, mouth open\./);
  assert.doesNotMatch(c, /Setting|Sari|talking/);
  const elder = { ...script, cast: [{ name: 'Village Elder', look: 'a tall woman with gray hair' }] };
  assert.doesNotMatch(artPanels({ ...page, speaker: 'the hero', speechPanel: 2 }, elder)[0], /Village Elder is/, '"village square" is not the Village Elder');
  // These phrasings drew speech bubbles and empty white panels into the art; they must not come back.
  const p = artPrompt([a, b, c], 0, { look: 'a log' });
  assert.doesNotMatch(p, /talking here|empty sky|upper right|completely blank|speech bubble|Japanese|beside the hero's head/i);
});

test('panel text names the hero by role and drops quoted words, dangling "as he says" and axes', () => {
  assert.equal(artText('Wide shot of the hero, Tung Tung Tung Sahur, splitting firewood with a big axe', 'Tung Tung Tung Sahur'), 'Wide shot of the hero splitting firewood with a big saw');
  assert.equal(artText("Close-up of Tung's face, grinning, as he says", 'Tung Tung Tung Sahur'), "Close-up of the hero's face, grinning");
  assert.equal(artText("Wide shot of Theo holding a sign that says 'Open'", 'Theo'), 'Wide shot of the hero holding a sign');
  const s = parseScript({ title: 'T', pages: Array(6).fill({ panels: ['Theo waves', 'b', 'c'], caption: 'Theo ran.', speech: 'hi there you two' }) }, 'Theo');
  assert.equal(s.pages[0].panels[0], 'the hero waves');
});

test('speech must be real lines: at least four words and none repeated', () => {
  const mk = (lines) => ({ pages: lines.map((speech) => ({ speech })) });
  assert.equal(speechOk(mk(['Sari, hold that end steady!', 'Why is everyone staring at me?', 'Grab the small branches first.', 'Just one more log to go!', 'Thank you all for helping today.', 'Pass the soup down here, Grandpa!'])), true);
  assert.equal(speechOk(mk(['Feast time!', 'Why is everyone staring at me?', 'a b c d', 'e f g h', 'i j k l', 'm n o p'])), false);
  assert.equal(speechOk(mk(Array(6).fill('We can do this together!'))), false);
});

test('captions keep one third-person voice with the name', () => {
  const page = (caption) => ({ panels: ['a', 'b'], caption, speech: '', speechPanel: 1 });
  const script = (c) => parseScript({ title: 'T', pages: Array(6).fill(page(c)) }, 'Theo');
  assert.equal(voiceOk(script('Theo grew up by the harbor, sketching every boat he saw.')), true);
  assert.equal(voiceOk(script('You grew up by the harbor.')), false);
  assert.equal(voiceOk(script('Theo told me about it.')), false);
  const he = (c) => ({ ...script(c), pronoun: 'he' });
  assert.equal(voiceOk(he('Theo honed their craft by the water.')), false, 'their, when the pronoun is clear');
  assert.equal(voiceOk(he('Theo honed his craft by the water.')), true);
  assert.equal(voiceOk({ ...script('Theo honed their craft.'), pronoun: 'they' }), true);
  assert.equal(voiceOk(he('Theo and the kids printed their own zines.')), true, 'their, for a group');
  assert.equal(parseScript({ title: 'T', pronoun: 'She', pages: Array(6).fill(page('Ana ran.')) }, 'Ana').pronoun, 'she');
  assert.equal(parseScript({ title: 'T', pronoun: 'it', pages: Array(6).fill(page('Ana ran.')) }, 'Ana').pronoun, 'they');
  assert.equal(toThirdPerson('You were eight when your dad gave you a pencil.', 'Theo Marsh'), "Theo was eight when Theo's dad gave Theo a pencil.");
  assert.equal(toThirdPerson('Now you are ready.', 'Theo'), 'Now Theo is ready.');
});

test('the art prompt fights lettering and the soft retry drops heavy words', () => {
  assert.equal(unletter('A shop sign and a poster over books'), 'A shop wordless sign and a wordless poster over wordless books');
  const p = artPrompt(['The hero cries alone in the dark hospital'], 1, { soft: true });
  assert.doesNotMatch(p, /cries|alone|dark|hospital/);
  assert.match(p, /wholesome/);
  assert.match(artPrompt(['x'], 1), /no page number/);
  assert.match(artPrompt(['x'], 1), /silent, wordless/);
  assert.match(artPrompt(['x'], 1), /no empty or blank panels/);
  assert.match(artPrompt(['x'], 1), /Only the hero comes from the reference images/);
  assert.equal(soften('The hero, crying, hugs a friend.'), 'The hero, hugs a friend.');
  assert.doesNotMatch(soften('The hero swings his baseball bat and bangs on a door'), /bat|bang/);
});
