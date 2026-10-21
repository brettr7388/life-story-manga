-- One row per UTC day: how many mangas were started. Nothing about the person is stored.
CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, n INTEGER NOT NULL);
-- One row per manga: how many page drawings it has used. The id is random; no answers, prompts or photos.
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, day TEXT NOT NULL, draws INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS runs_day ON runs (day);
