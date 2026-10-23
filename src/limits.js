// The daily cap and the per-manga drawing budget, both enforced in D1 with single atomic statements.
//
// Why 8 a day: the account is on Workers Free, which includes 10,000 Workers AI neurons per day.
// One manga costs about 800 neurons (measured, see README "Daily cap"), so 8 mangas use about 6,400 and leave
// room for page retries and the account's other Workers. Past 10,000 the free plan refuses AI calls;
// the cap makes us refuse first, with a clear message, instead of failing halfway through a story.
export const DEFAULT_DAILY_CAP = 8;
export const PAGES = 6;
// 9 = 6 pages + 3 redraws or soft retries. It was 14 (6 + 8) for the Tung Tung Tung Sahur demo on Oct 21-22 2026
// and is back to 9 after it; see README "Daily cap". Worst case is about 112 + 9 x 114 = 1,138 neurons per manga.
export const MAX_DRAWS = PAGES + 3;

export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

export function dailyCap(env) {
  const n = Number.parseInt(env.DAILY_CAP ?? '', 10);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_DAILY_CAP;
}

// Takes one slot from today's budget. Returns the new count, or null when the cap is reached.
export async function takeSlot(db, day, cap) {
  if (cap <= 0) return null;
  const row = await db
    .prepare('INSERT INTO usage (day, n) VALUES (?1, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1 WHERE n < ?2 RETURNING n')
    .bind(day, cap)
    .first();
  return row ? row.n : null;
}

// Gives a slot back when the script model failed, so a broken run does not eat the budget.
export async function returnSlot(db, day) {
  await db.prepare('UPDATE usage SET n = n - 1 WHERE day = ?1 AND n > 0').bind(day).run();
}

export async function used(db, day) {
  const row = await db.prepare('SELECT n FROM usage WHERE day = ?1').bind(day).first();
  return row ? row.n : 0;
}

export async function openRun(db, id, day) {
  await db.prepare('INSERT INTO runs (id, day, draws) VALUES (?1, ?2, 0)').bind(id, day).run();
  await db.prepare('DELETE FROM runs WHERE day < ?1').bind(day).run();
}

// Takes one drawing from a manga's budget. Returns false when the run is unknown or used up.
export async function takeDraw(db, id) {
  const row = await db
    .prepare('UPDATE runs SET draws = draws + 1 WHERE id = ?1 AND draws < ?2 RETURNING draws')
    .bind(id, MAX_DRAWS)
    .first();
  return !!row;
}
