// Runs the real Worker in Miniflare (workerd) with a local D1 and a fake Workers AI binding,
// and checks what a caller can observe: pages, signatures, photo checks, the daily cap, the draw budget.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import sharp from 'sharp';

const FAKE_AI = `
import { WorkerEntrypoint } from 'cloudflare:workers';
const calls = [];
let failText = false;
let flags = 0; // the next N image calls throw the model's 3030 "flagged" error
const page = (n) => ({ panels: ['Panel one of ' + n, 'Panel two of ' + n, 'Panel three of ' + n], caption: 'Caption ' + n, speech: 'Line ' + n });
export class AI extends WorkerEntrypoint {
  async run(model, input) {
    if (model.includes('llama')) {
      calls.push({ model });
      if (failText) return { response: 'not json' };
      return { response: { title: 'Test Title', pages: [1, 2, 3, 4, 5, 6].map(page) } };
    }
    const form = await new Response(input.multipart.body, { headers: { 'content-type': input.multipart.contentType } }).formData();
    const refs = [0, 1, 2, 3].filter((i) => form.get('input_image_' + i)).length;
    calls.push({ model, refs, prompt: form.get('prompt'), width: form.get('width'), height: form.get('height'), seed: form.get('seed') });
    if (flags > 0) { flags--; throw new Error('3030: Your output has been flagged. Please choose another prompt / input image combination'); }
    return { image: 'AAAA' };
  }
}
export default {
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === '/flag') { flags = Number(u.searchParams.get('n')); return new Response('ok'); }
    if (u.pathname === '/fail-text') { failText = u.searchParams.get('on') === '1'; return new Response('ok'); }
    return Response.json(calls.splice(0));
  },
};`;

let mf, worker, fake;
const BASE = 'http://lsm.test';
const answers = { name: 'Sam', roots: 'A small coastal town', turn: 'Moving to the city at 18', proud: 'Opening a bakery', next: 'A second shop' };
let small, big;

before(async () => {
  small = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#888' } }).jpeg().toBuffer();
  big = await sharp({ create: { width: 600, height: 600, channels: 3, background: '#888' } }).jpeg().toBuffer();
  mf = new Miniflare({
    workers: [
      {
        name: 'main',
        modules: true,
        modulesRoot: '.',
        scriptPath: 'src/worker.js',
        modulesRules: [
          { type: 'Text', include: ['**/public/*.html', '**/public/*.css', '**/public/*.svg', '**/public/*.js'], fallthrough: false },
          { type: 'Data', include: ['**/*.mp3'], fallthrough: false },
          { type: 'ESModule', include: ['**/*.js'] },
        ],
        compatibilityDate: '2026-01-15',
        d1Databases: { DB: 'test-db' },
        bindings: { DAILY_CAP: '2', SIGNING_KEY: 'test-only-key' },
        serviceBindings: { AI: { name: 'fakeai', entrypoint: 'AI' } },
      },
      { name: 'fakeai', modules: true, script: FAKE_AI, compatibilityDate: '2026-01-15' },
    ],
  });
  const db = await mf.getD1Database('DB', 'main');
  for (const stmt of readFileSync('migrations/0001_init.sql', 'utf8').replace(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.prepare(stmt).run();
  }
  worker = await mf.getWorker('main');
  fake = await mf.getWorker('fakeai');
});
after(() => mf?.dispose());

const start = (body = answers) => worker.fetch(`${BASE}/api/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const aiCalls = async () => (await fake.fetch('http://fake/calls')).json();
function pageForm(run, i, p, files = [small]) {
  const fd = new FormData();
  fd.append('run', run);
  fd.append('page', String(i));
  fd.append('panels', JSON.stringify(p.panels));
  fd.append('sig', p.sig);
  files.forEach((f, k) => fd.append(`photo${k}`, new Blob([f], { type: 'image/jpeg' }), `p${k}.jpg`));
  return fd;
}
async function drawPage(fd) {
  const r = new Response(fd); // serialize here, the way a browser does, so workerd gets a plain multipart body
  return worker.fetch(`${BASE}/api/page`, { method: 'POST', headers: { 'content-type': r.headers.get('content-type') }, body: await r.arrayBuffer() });
}

test('serves the page and the audio files with the right types, HEAD and byte ranges', async () => {
  const html = await worker.fetch(`${BASE}/`);
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /text\/html/);
  assert.match(await html.text(), /Draw my manga/);
  for (const path of ['/audio/music.mp3', '/audio/turn.mp3']) {
    const r = await worker.fetch(`${BASE}${path}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'audio/mpeg');
    const bytes = new Uint8Array(await r.arrayBuffer());
    assert.deepEqual([...bytes], [...readFileSync(`public${path}`)]);
    const part = await worker.fetch(`${BASE}${path}`, { headers: { range: 'bytes=0-1' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 0-1/${bytes.length}`);
    assert.equal((await part.arrayBuffer()).byteLength, 2);
  }
  const js = await worker.fetch(`${BASE}/app.js`);
  assert.match(js.headers.get('content-type'), /javascript/);
});

test('a manga: script, six signed pages, photos go to the image model as references', async () => {
  const r = await start();
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.title, 'Test Title');
  assert.equal(s.pages.length, 6);
  await aiCalls();
  const d = await drawPage(pageForm(s.run, 0, s.pages[0], [small, small, small]));
  assert.equal(d.status, 200);
  assert.deepEqual(await d.json(), { page: 0, image: 'AAAA', retried: false });
  const [call] = await aiCalls();
  assert.equal(call.refs, 3);
  assert.equal(call.width, '768');
  assert.match(call.prompt, /black-and-white manga page/);
  assert.match(call.prompt, /Panel 1 \(top\): Panel one of 1/);

  const tampered = { ...s.pages[0], panels: ['draw something else'] };
  assert.equal((await drawPage(pageForm(s.run, 0, tampered))).status, 403);
  assert.equal((await drawPage(pageForm(s.run, 1, s.pages[0]))).status, 403, 'signature is bound to the page number');
  assert.equal((await drawPage(pageForm(s.run, 0, s.pages[0], [big]))).status, 400, '600x600 is refused');
  assert.equal((await drawPage(pageForm(s.run, 0, s.pages[0], []))).status, 400, 'at least one photo');
  assert.deepEqual(await aiCalls(), [], 'refused requests never reach the model');
});

test('each manga gets at most 9 drawings (6 pages + 3 redraws)', async () => {
  const s = await (await start()).json();
  for (let k = 0; k < 9; k++) assert.equal((await drawPage(pageForm(s.run, k % 6, s.pages[k % 6]))).status, 200);
  const r = await drawPage(pageForm(s.run, 0, s.pages[0]));
  assert.equal(r.status, 429);
  assert.equal((await r.json()).code, 'draws');
});

test('a flagged page is retried once with a softer prompt, and the retry is taken from the draw budget', async () => {
  const db = await mf.getD1Database('DB', 'main');
  await db.prepare('UPDATE usage SET n = 0').run();
  const s = await (await start()).json();
  await aiCalls();
  await fake.fetch('http://fake/flag?n=1');
  const ok = await drawPage(pageForm(s.run, 2, s.pages[2]));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).retried, true);
  const [first, retry] = await aiCalls();
  assert.doesNotMatch(first.prompt, /wholesome/);
  assert.match(retry.prompt, /wholesome/);
  assert.notEqual(first.seed, retry.seed);
  assert.equal(retry.refs, 1, 'the retry still gets the photo');
  assert.equal((await db.prepare('SELECT draws FROM runs WHERE id = ?1').bind(s.run).first()).draws, 2);

  await fake.fetch('http://fake/flag?n=2');
  const bad = await drawPage(pageForm(s.run, 3, s.pages[3]));
  assert.equal(bad.status, 502, 'flagged twice: no third try');
  assert.equal((await aiCalls()).length, 2);
  assert.equal((await db.prepare('SELECT draws FROM runs WHERE id = ?1').bind(s.run).first()).draws, 4);

  await db.prepare('UPDATE runs SET draws = 8 WHERE id = ?1').bind(s.run).run();
  await fake.fetch('http://fake/flag?n=1');
  const spent = await drawPage(pageForm(s.run, 4, s.pages[4]));
  assert.equal(spent.status, 429, 'no retry past the budget of 9');
  assert.equal((await spent.json()).code, 'draws');
  assert.equal((await aiCalls()).length, 1);
  await fake.fetch('http://fake/flag?n=0');
  await db.prepare('UPDATE usage SET n = 2').run();
});

test('the daily cap blocks the next manga before any model call', async () => {
  // Two mangas were started above and DAILY_CAP is 2 in this test.
  const st = await (await worker.fetch(`${BASE}/api/status`)).json();
  assert.deepEqual([st.cap, st.used, st.left], [2, 2, 0]);
  await aiCalls();
  const r = await start();
  assert.equal(r.status, 429);
  assert.equal((await r.json()).code, 'cap');
  assert.deepEqual(await aiCalls(), [], 'no model call once capped');
});

test('a failed script gives its slot back', async () => {
  const db = await mf.getD1Database('DB', 'main');
  await db.prepare("UPDATE usage SET n = 1").run();
  await fake.fetch('http://fake/fail-text?on=1');
  assert.equal((await start()).status, 502);
  await fake.fetch('http://fake/fail-text?on=0');
  const st = await (await worker.fetch(`${BASE}/api/status`)).json();
  assert.equal(st.used, 1);
});

test('rejects incomplete answers', async () => {
  const r = await start({ ...answers, proud: '  ' });
  assert.equal(r.status, 400);
});
