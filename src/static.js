// The page, its scripts and the two sound files ship inside the Worker as Text and Data modules
// (see the [[rules]] in wrangler.toml), so one script upload deploys everything.
// Audio answers HEAD and single byte-range requests (206): iOS Safari needs both for <audio>.
import indexHtml from '../public/index.html';
import appJs from '../public/app.js';
import audioJs from '../public/audio.js';
import styleCss from '../public/style.css';
import favicon from '../public/favicon.svg';
import music from '../public/audio/music.mp3';
import turn from '../public/audio/turn.mp3';

const HTML = 'text/html; charset=utf-8';
const JS = 'text/javascript; charset=utf-8';
export const FILES = {
  '/': { body: indexHtml, type: HTML, cache: 'no-cache' },
  '/app.js': { body: appJs, type: JS, cache: 'no-cache' },
  '/audio.js': { body: audioJs, type: JS, cache: 'no-cache' },
  '/style.css': { body: styleCss, type: 'text/css; charset=utf-8', cache: 'no-cache' },
  '/favicon.svg': { body: favicon, type: 'image/svg+xml', cache: 'public, max-age=86400' },
  '/audio/music.mp3': { body: music, type: 'audio/mpeg', cache: 'public, max-age=86400' },
  '/audio/turn.mp3': { body: turn, type: 'audio/mpeg', cache: 'public, max-age=86400' },
};

export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

const encoder = new TextEncoder();

export function serveStatic(request, pathname, headers) {
  const file = FILES[pathname];
  if (!file) return null;
  const bytes = typeof file.body === 'string' ? encoder.encode(file.body) : new Uint8Array(file.body);
  const h = { ...headers, 'content-type': file.type, 'cache-control': file.cache, 'accept-ranges': 'bytes' };
  const head = request.method === 'HEAD';
  const range = request.headers.get('range') ? parseRange(request.headers.get('range'), bytes.length) : null;
  if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { ...h, 'content-range': `bytes */${bytes.length}` } });
  if (range) {
    const part = bytes.subarray(range.start, range.end + 1);
    return new Response(head ? null : part, {
      status: 206,
      headers: { ...h, 'content-range': `bytes ${range.start}-${range.end}/${bytes.length}`, 'content-length': String(part.length) },
    });
  }
  return new Response(head ? null : bytes, { headers: { ...h, 'content-length': String(bytes.length) } });
}
