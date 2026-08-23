PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key TEXT PRIMARY KEY,
  hit_count INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (hit_count >= 0),
  CHECK (reset_at > 0),
  CHECK (updated_at > 0)
);

CREATE INDEX IF NOT EXISTS rate_limit_reset_idx
  ON rate_limit_buckets(reset_at);
