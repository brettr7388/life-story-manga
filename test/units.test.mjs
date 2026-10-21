import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { jpegSize } from '../src/jpeg.js';
import { parseScript, parseAnswers, artPrompt, voiceOk, toThirdPerson, unletter, soften } from '../src/story.js';
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

test('parseAnswers strips control characters and caps length', () => {
  const { answers } = parseAnswers({ name: 'Sam\u0000\n', roots: 'x'.repeat(500), turn: 't', proud: 'p', next: 'n' });
  assert.equal(answers.name, 'Sam');
  assert.equal(answers.roots.length, 160);
});

test('artPrompt names every reference image and forbids lettering', () => {
  const p = artPrompt(['one', 'two', 'three'], 4);
  assert.match(p, /reference images 0 to 3/);
  assert.match(p, /no writing of any kind/);
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
  assert.match(artPrompt(['x', 'y', 'z'], 1, { speak: 1 }), /Panel 2 \(middle\): y\. The hero is talking here/);
  assert.doesNotMatch(artPrompt(['x', 'y', 'z'], 1), /talking here/);
});

test('captions keep one third-person voice with the name', () => {
  const page = (caption) => ({ panels: ['a', 'b'], caption, speech: '', speechPanel: 1 });
  const script = (c) => parseScript({ title: 'T', pages: Array(6).fill(page(c)) }, 'Theo');
  assert.equal(voiceOk(script('Theo grew up by the harbor, sketching every boat he saw.')), true);
  assert.equal(voiceOk(script('You grew up by the harbor.')), false);
  assert.equal(voiceOk(script('Theo told me about it.')), false);
  assert.equal(toThirdPerson('You were eight when your dad gave you a pencil.', 'Theo Marsh'), "Theo was eight when Theo's dad gave Theo a pencil.");
  assert.equal(toThirdPerson('Now you are ready.', 'Theo'), 'Now Theo is ready.');
});

test('the art prompt fights lettering and the soft retry drops heavy words', () => {
  assert.equal(unletter('A shop sign and a poster over books'), 'A shop blank sign and a blank poster over blank books');
  const p = artPrompt(['The hero cries alone in the dark hospital'], 1, { soft: true });
  assert.doesNotMatch(p, /cries|alone|dark|hospital/);
  assert.match(p, /wholesome/);
  assert.match(artPrompt(['x'], 1), /no page numbers/);
  assert.match(artPrompt(['x'], 1), /completely blank/);
  assert.equal(soften('The hero, crying, hugs a friend.'), 'The hero, hugs a friend.');
});
