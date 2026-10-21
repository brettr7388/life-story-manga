"""Synthesizes the two sound files in public/audio/. No samples and no third-party audio, so the
output is ours to publish under the repo's MIT license.

music.mp3  a quiet minor-key piano loop (Am F C G at 72 BPM, 4 bars). We render three cycles and keep
           the middle one, so the reverb tail of the previous cycle is already in it and it loops clean.
turn.mp3   a page-turn swish: band-passed noise with a fast attack and a paper "flick" at the end.
"""
import pathlib, subprocess
import numpy as np

SR = 22050
OUT = pathlib.Path(__file__).resolve().parent.parent / "public" / "audio"
rng = np.random.default_rng(11)

def note(m): return 440 * 2 ** ((m - 69) / 12)

def piano(f, dur, vel):
    n = int(dur * SR); t = np.arange(n) / SR
    env = np.minimum(1, t / 0.004) * np.exp(-t * 2.6)
    s = sum(a * np.sin(2 * np.pi * f * k * t) * np.exp(-t * k * 0.9) for k, a in ((1, 1), (2, 0.45), (3, 0.18), (4, 0.08)))
    return vel * env * s

def onepole(x, a):
    y = np.empty_like(x); acc = 0.0
    for i, v in enumerate(x):
        acc += a * (v - acc); y[i] = acc
    return y

def mp3(name, x, kbps):
    wav = OUT / (name + ".wav")
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
    import wave
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-codec:a", "libmp3lame", "-b:a", f"{kbps}k",
                    "-map_metadata", "-1", "-id3v2_version", "0", "-write_xing", "0", str(OUT / (name + ".mp3"))], check=True)
    wav.unlink()

def music():
    bpm = 72; beat = 60 / bpm; cycle = 16 * beat
    chords = [(57, [57, 60, 64, 69]), (53, [53, 57, 60, 65]), (48, [52, 55, 60, 64]), (55, [55, 59, 62, 67])]
    n = int(round(cycle * SR)); out = np.zeros(n * 3 + SR * 3)
    def add(t, sig):
        i = int(round(t * SR)); out[i:i + len(sig)] += sig[: len(out) - i]
    for c in range(3):
        for bar, (root, tones) in enumerate(chords):
            t0 = c * cycle + bar * 4 * beat
            add(t0, piano(note(root - 12), 4 * beat, 0.32))
            for k, m in enumerate([0, 1, 2, 3, 2, 1, 2, 3]):
                add(t0 + k * beat / 2, piano(note(tones[m]), 1.6, 0.16 if k % 2 else 0.2))
            add(t0 + 3 * beat, piano(note(tones[3] + 12), 2.0, 0.07))
    # small room: two feedback-free echoes, then a gentle low-pass
    wet = np.zeros_like(out)
    for d, g in ((0.113, 0.22), (0.271, 0.14), (0.419, 0.08)):
        k = int(d * SR); wet[k:] += g * out[:-k]
    mix = onepole(out + wet, 0.35)
    loop = mix[n:2 * n]
    return 0.8 * loop / np.max(np.abs(loop))

def turn():
    dur = 0.42; n = int(dur * SR); t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    hp = noise - onepole(noise, 0.12)                    # drop the rumble
    sweep = onepole(hp, 0.25) * (0.5 + 0.5 * np.sin(np.pi * t / dur))
    env = np.minimum(1, t / 0.03) * np.exp(-((t - 0.16) ** 2) / 0.012)
    flick_t = t - 0.30
    flick = np.where(flick_t > 0, rng.standard_normal(n) * np.exp(-np.maximum(flick_t, 0) * 60), 0)
    x = sweep * env + 0.35 * flick
    return 0.7 * x / np.max(np.abs(x))

OUT.mkdir(parents=True, exist_ok=True)
mp3("music", music(), 40)
mp3("turn", turn(), 48)
for f in sorted(OUT.glob("*.mp3")):
    print(f.name, f.stat().st_size, "bytes")
