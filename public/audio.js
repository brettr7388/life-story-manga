// Sound, done the way that works on iPhone (same approach as Slop or Not).
//
// Music and the page-turn are plain <audio> elements, not Web Audio. On iOS, Web Audio alone counts as
// "ambient" sound that the silent switch mutes; a playing media element puts the page in the "playback"
// session. Every element is first played inside a tap (pointerup / click), never after an await, which is
// what unlocks it for later plays. Nothing is created before that first tap.
const KEY = 'manga-muted';
const TURN_VOICES = 3;
let music = null;
let turns = [];
let next = 0;
let wantMusic = false;
let muted = false;
try { muted = localStorage.getItem(KEY) === '1'; } catch {}

const state = (s) => { document.documentElement.dataset.audio = s; };

function make(src, loop, volume) {
  const a = new Audio();
  a.src = src;
  a.loop = loop;
  a.preload = 'auto';
  a.volume = volume;
  a.muted = muted;
  a.setAttribute('playsinline', '');
  return a;
}

function elements() {
  if (music) return;
  music = make('/audio/music.mp3', true, 0.55);
  music.addEventListener('playing', () => state(muted ? 'muted' : 'playing'));
  music.addEventListener('error', () => state('no-music'));
  turns = Array.from({ length: TURN_VOICES }, () => make('/audio/turn.mp3', false, 0.9));
}

// Call synchronously inside a tap handler. Safe to call on every tap.
export function unlock() {
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  const first = !music;
  elements();
  if (first) {
    // Prime the page-turn voices inside this gesture: play silently, then rewind.
    for (const t of turns) {
      t.muted = true;
      const p = t.play();
      const reset = () => { t.pause(); t.currentTime = 0; t.muted = muted; };
      if (p) p.then(reset, reset); else reset();
    }
  }
  if (wantMusic && !muted && music.paused) music.play().catch(() => state('blocked'));
}

export function startMusic() {
  wantMusic = true;
  unlock();
}

export function turn() {
  (window.__sfx ??= []).push('turn');
  if (!turns.length || muted) return;
  const t = turns[next++ % turns.length];
  try { t.currentTime = 0; } catch {}
  t.play().catch(() => {});
}

export const isMuted = () => muted;

export function setMuted(value) {
  muted = value;
  try { localStorage.setItem(KEY, value ? '1' : '0'); } catch {}
  if (music) music.muted = value;
  for (const t of turns) t.muted = value;
  if (value) state('muted');
  else { wantMusic = true; unlock(); }
}

document.addEventListener('visibilitychange', () => {
  if (!music) return;
  if (document.hidden) music.pause();
  else if (wantMusic && !muted) music.play().catch(() => {});
});

// Read by the e2e script.
window.__audio = () => ({
  music: music && { src: music.currentSrc, paused: music.paused, time: music.currentTime, muted: music.muted, ready: music.readyState },
  turns: turns.map((t) => ({ ready: t.readyState, muted: t.muted })),
  muted,
});

state('ready');
