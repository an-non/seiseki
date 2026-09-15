PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS analysis_cache (
  input_hmac TEXT PRIMARY KEY,
  engine TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  scoring_mode TEXT NOT NULL CHECK (scoring_mode IN ('direct', 'distribution')),
  analysis_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  CHECK (length(input_hmac) = 64),
  CHECK (length(engine) BETWEEN 1 AND 40),
  CHECK (length(model) BETWEEN 1 AND 100),
  CHECK (length(prompt_version) BETWEEN 1 AND 40),
  CHECK (json_valid(analysis_json)),
  CHECK (hit_count >= 0)
);

CREATE INDEX IF NOT EXISTS analysis_cache_last_used_idx
  ON analysis_cache(last_used_at);
