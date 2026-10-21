// Deploys over the Cloudflare REST API instead of `wrangler deploy` (how the live copy was shipped).
// Bundles with wrangler's dry run, then uploads the Worker and its Text/Data modules in one PUT.
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... D1_DATABASE_ID=... SIGNING_KEY=... node deploy/rest-deploy.mjs
// Needs a token with Workers Scripts edit, D1 edit and Workers AI read. SIGNING_KEY is only sent when set;
// without it the existing secret is kept.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account, D1_DATABASE_ID: d1, SIGNING_KEY: key } = process.env;
if (!token || !account || !d1) throw new Error('Set CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and D1_DATABASE_ID');
const NAME = 'life-story-manga';

export function moduleType(file) {
  if (file.endsWith('.mp3')) return 'application/octet-stream';      // Data module (ArrayBuffer)
  if (file === 'worker.js') return 'application/javascript+module';  // the entry point
  return 'text/plain';                                               // Text module (string)
}

execFileSync('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', 'dist'], { stdio: 'inherit' });
const files = readdirSync('dist').filter((f) => !f.endsWith('.map') && f !== 'README.md');
const toml = readFileSync('wrangler.toml', 'utf8');
const cap = /DAILY_CAP\s*=\s*"(\d+)"/.exec(toml)[1];
const date = /compatibility_date\s*=\s*"([^"]+)"/.exec(toml)[1];
const bindings = [
  { type: 'ai', name: 'AI' },
  { type: 'd1', name: 'DB', id: d1 },
  { type: 'plain_text', name: 'DAILY_CAP', text: cap },
  ...(key ? [{ type: 'secret_text', name: 'SIGNING_KEY', text: key }] : []),
];
const metadata = { main_module: 'worker.js', compatibility_date: date, bindings, ...(key ? {} : { keep_bindings: ['secret_text'] }) };

const form = new FormData();
form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
for (const f of files) form.append(f, new Blob([readFileSync(join('dist', f))], { type: moduleType(f) }), f);
const api = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${NAME}`;
const res = await fetch(api, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body: form });
const out = await res.json();
if (!out.success) throw new Error(JSON.stringify(out.errors));
await fetch(`${api}/subdomain`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
console.log(`deployed ${NAME}: ${files.length} modules, DAILY_CAP=${cap}`);
