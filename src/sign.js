// HMAC-SHA256 over each page's art prompt, so /api/page only draws prompts this Worker wrote.
// The key is the SIGNING_KEY secret (set with `wrangler secret put SIGNING_KEY`), never in the repo.
const enc = new TextEncoder();

async function key(secret) {
  if (!secret) throw new Error('SIGNING_KEY is not set');
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function unb64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const message = (run, page, scene) => enc.encode(`${run}\n${page}\n${scene}`);

export async function signPage(secret, run, page, scene) {
  return b64url(await crypto.subtle.sign('HMAC', await key(secret), message(run, page, scene)));
}

export async function verifyPage(secret, run, page, scene, sig) {
  if (typeof sig !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return false;
  return crypto.subtle.verify('HMAC', await key(secret), unb64url(sig), message(run, page, scene));
}
