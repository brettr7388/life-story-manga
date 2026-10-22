# Life-Story Manga

Upload up to 4 photos, answer 5 short questions about your life, and get a 6-page black-and-white manga
about you that you swipe through on your phone, with music and page-turn sounds. Save or share any page.

Live: https://life-story-manga.brettr7388.workers.dev

It is one Cloudflare Worker on the free plan:

- A Workers AI text model (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, JSON mode) writes the 6-page script:
  three panel descriptions, a narration caption and one spoken line per page.
- FLUX.2 [klein] 4B on Workers AI (`@cf/black-forest-labs/flux-2-klein-4b`) draws each page at 768x1024,
  with your photos passed as reference images `input_image_0` to `input_image_3`.
- The page shows the six pages as they finish ("inking in"), and lays the caption and speech bubble over the
  art as real text, so the words are always readable. Save and Share bake them into a PNG.

## Privacy: photos are never stored

- Your phone shrinks each photo to at most 496 px on its long side (FLUX.2 [klein] needs references under
  512x512) and keeps it in memory.
- Each `/api/page` request carries the photos to the Worker, which passes them straight to the image model
  and drops them when the request ends. There is no KV, R2, Cache API or D1 write of any image.
- Your answers go to the text model once, in `/api/start`, and are not saved either. The script comes back to
  your browser; each page's panel text is signed (HMAC) so `/api/page` will only draw prompts this Worker wrote.
- D1 stores two counters and nothing about you: mangas started per UTC day, and drawings used per manga
  (keyed by a random id, deleted the next day).
- "Start over" drops the photos and the story from the page.

## Daily cap

`DAILY_CAP` in `wrangler.toml` is **8 mangas per UTC day**. When it is reached, `/api/start` answers 429
before calling any model, and the page says to come back after midnight UTC. Each manga may draw at most
14 drawings (6 pages plus 8 spare, used by redraws and by the automatic soft retry of a flagged page).

**Demo setting, Oct 21 2026:** the budget was 9 (6 + 3). It was raised to 14 for the Tung Tung Tung Sahur
demo, because the image filter flags (3030) about half of that character's pages and each flagged page costs
two drawings (first try + soft retry). The daily cap stays at 8. Worst case is now about 1,700 neurons per
manga (112 + 14 x 114), so 8 worst-case mangas would pass the free 10,000; typical mangas with real photos
use about 800. **Set `MAX_DRAWS` back to `PAGES + 3` (9) after the demo**: for ordinary photo runs, where
3030s are rare, 9 is enough and keeps 8 mangas a day safely inside the free plan.

When the image model's safety filter flags a page (error 3030), the Worker retries it once on its own with
softer wording and a new seed. That retry is a drawing and comes out of the same 9. A page that still fails,
or that gets no answer within 90 seconds (the browser gives up on the request), shows "Tap to redraw".

Why 8: Workers Free includes 10,000 Workers AI neurons a day, and resets at 00:00 UTC. Measured on the
live Worker (Cloudflare's AI analytics, Oct 21 2026):

| Step | Measured |
| --- | --- |
| Script: 481 input + 482 output tokens on Llama 3.3 70B fp8-fast | 112 neurons |
| One page: 768x1024 with 2 reference photos on FLUX.2 [klein] 4B | 114 neurons |
| One manga: script + 6 pages | about 800 neurons |

8 mangas use about 6,400 neurons, which leaves room for redraws (with the normal budget of 9, up to 3 per manga, about 340 more) and
anything else on the account. On the free plan, going past 10,000 makes the models refuse; the cap makes the
app refuse first, cleanly, before a story is half drawn. Raise the cap only on a paid plan, where each manga
costs about $0.009.

## Lettering

The art is asked for as a silent, wordless page of three stacked panels. The phone letters it: it finds the
real panels from the white gutters, puts the caption in the emptier top corner and the speech bubble on the
emptiest spot of the panel where the line is said (few lines, little ink, away from the middle where close-up
faces sit), and paints the paper margins white so stray page numbers disappear. The reader shows that
lettered PNG, the same file Save and Share hand over.

## Sound

Music and the page-turn are `<audio>` elements, started inside the first tap, the approach that plays on
iPhone even with the silent switch on (Web Audio alone is muted there). The Worker serves both files with
`audio/mpeg`, HEAD and byte ranges, which iOS Safari needs. Both sounds are synthesized by
`scripts/build-audio.py` (numpy + ffmpeg), with no samples, so they are covered by this repo's license.

## Run it

Node 22.5 or newer.

```bash
npm install
npm test                      # Worker in Miniflare with a fake AI, plus phone-size Chromium runs with a flagged and a hung page
node scripts/dev-offline.mjs  # the real Worker on :8799 with a fake AI and grey placeholder pages
                              # FAKE_FLAG_PAGE=2 FAKE_FLAG_TIMES=2 or FAKE_HANG_PAGE=1 inject model faults
npx wrangler dev              # the real thing; Workers AI always runs remotely and counts against your neurons
```

`scripts/e2e.mjs` makes one real manga at 390x844 in headless Chromium and records it:

```bash
npx playwright install chromium
BASE_URL=https://your-worker.workers.dev PHOTOS=a.jpg,b.jpg OUT=out node scripts/e2e.mjs
```

It uses one of the day's mangas. Test with stand-in photos (a generated face), not a real person's.

## Deploy

1. `npx wrangler login`
2. `npx wrangler d1 create life-story-manga`, then put the printed id in `wrangler.toml`.
3. `npm run db:migrate:remote`
4. `npx wrangler secret put SIGNING_KEY` and paste any long random string.
5. `npm run deploy`

`deploy/rest-deploy.mjs` does the same upload over the REST API with a token instead of `wrangler login`.

## Files

```
src/worker.js     routes: /api/start, /api/page, /api/status, static files
src/story.js      the questions, the script prompt and parser, the art prompt, the FLUX.2 call
src/limits.js     daily cap and per-manga draw budget (atomic D1 statements)
src/sign.js       HMAC page signatures
src/jpeg.js       reads JPEG width/height to enforce the 512x512 limit
src/static.js     the page and sounds, bundled into the Worker as Text and Data modules
public/           the page: index.html, app.js, audio.js, style.css, audio/*.mp3
public/layout.js  where the caption and bubble go, read from the drawn page's own pixels
migrations/       D1 schema
scripts/          sound builder, offline dev server, e2e recorder
test/             node --test suites
```

## License

MIT. The FLUX.2 [klein] model is used under Black Forest Labs' terms through Workers AI.
