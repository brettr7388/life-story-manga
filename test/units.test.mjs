import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { jpegSize } from '../src/jpeg.js';
import { parseScript, parseAnswers, artPrompt } from '../src/story.js';
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
  assert.match(p, /No text/);
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
