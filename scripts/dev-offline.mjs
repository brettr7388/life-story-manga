// Serves the real Worker on http://localhost:8799 with a local D1 and a fake Workers AI that answers
// with a canned script and grey placeholder pages after a short delay. For UI work without an account.
//   node scripts/dev-offline.mjs
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import sharp from 'sharp';

const pages = await Promise.all([1, 2, 3, 4, 5, 6].map(async (n) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="1024"><rect width="768" height="1024" fill="#fff"/>
    <rect x="24" y="24" width="720" height="460" fill="#ddd" stroke="#000" stroke-width="10"/>
    <rect x="24" y="508" width="350" height="492" fill="#bbb" stroke="#000" stroke-width="10"/>
    <rect x="394" y="508" width="350" height="492" fill="#999" stroke="#000" stroke-width="10"/>
    <text x="384" y="290" font-size="120" font-family="sans-serif" font-weight="900" text-anchor="middle">PAGE ${n}</text></svg>`;
  return (await sharp(Buffer.from(svg)).jpeg().toBuffer()).toString('base64');
}));

const FAKE_AI = `
import { WorkerEntrypoint } from 'cloudflare:workers';
const IMAGES = ${JSON.stringify(pages)};
const page = (n) => ({ panels: ['wide shot of a town ' + n, 'close-up ' + n, 'hero smiles ' + n],
  caption: 'You grew up where the sea met the sky, page ' + n + ' of a life worth drawing.', speech: 'This is only the start!' });
export class AI extends WorkerEntrypoint {
  async run(model, input) {
    await new Promise((r) => setTimeout(r, model.includes('llama') ? 1500 : 2500 + Math.random() * 2000));
    if (model.includes('llama')) return { response: { title: 'Salt and Sunrise', pages: [1, 2, 3, 4, 5, 6].map(page) } };
    const form = await new Response(input.multipart.body, { headers: { 'content-type': input.multipart.contentType } }).formData();
    const n = Number(form.get('seed')) % 6;
    return { image: IMAGES[n] };
  }
}
export default { fetch: () => new Response('fake ai') };`;

const mf = new Miniflare({
  port: 8799,
  workers: [
    {
      name: 'main',
      modules: true,
      modulesRoot: '.',
      scriptPath: 'src/worker.js',
      modulesRules: [
        { type: 'Text', include: ['**/public/*.html', '**/public/*.css', '**/public/*.svg', '**/public/app.js', '**/public/audio.js'], fallthrough: false },
        { type: 'Data', include: ['**/*.mp3'], fallthrough: false },
        { type: 'ESModule', include: ['**/*.js'] },
      ],
      compatibilityDate: '2026-01-15',
      d1Databases: { DB: 'offline-db' },
      bindings: { DAILY_CAP: '8', SIGNING_KEY: 'offline-only-key' },
      serviceBindings: { AI: { name: 'fakeai', entrypoint: 'AI' } },
    },
    { name: 'fakeai', modules: true, script: FAKE_AI, compatibilityDate: '2026-01-15' },
  ],
});
const db = await mf.getD1Database('DB', 'main');
for (const stmt of readFileSync('migrations/0001_init.sql', 'utf8').replace(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean)) {
  await db.prepare(stmt).run();
}
console.log('offline dev server on', (await mf.ready).href);
