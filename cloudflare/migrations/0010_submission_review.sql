PRAGMA foreign_keys = ON;

ALTER TABLE responses
ADD COLUMN publication_status TEXT NOT NULL DEFAULT 'accepted'
CHECK (publication_status IN ('accepted', 'held_duplicate'));

CREATE TABLE IF NOT EXISTS response_text_fingerprints (
  response_id TEXT PRIMARY KEY REFERENCES responses(id) ON DELETE CASCADE,
  input_hmac TEXT NOT NULL,
  normalized_length INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (length(input_hmac) = 64),
  CHECK (normalized_length >= 40)
);

CREATE INDEX IF NOT EXISTS response_text_fingerprints_hmac_idx
  ON response_text_fingerprints(input_hmac, updated_at);

CREATE INDEX IF NOT EXISTS responses_publication_status_idx
  ON responses(publication_status, analysis_status, demo_flag);
