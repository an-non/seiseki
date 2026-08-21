PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS responses (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  app_version TEXT NOT NULL DEFAULT '',
  consent_version TEXT NOT NULL,
  consent_at INTEGER NOT NULL,
  age TEXT,
  gender TEXT,
  region TEXT,
  occupation TEXT,
  party TEXT,
  free_text TEXT NOT NULL DEFAULT '',
  analysis_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (analysis_status IN ('pending', 'completed', 'failed')),
  analysis_json TEXT,
  demo_flag INTEGER NOT NULL DEFAULT 0 CHECK (demo_flag IN (0, 1)),
  CHECK (length(id) BETWEEN 12 AND 64),
  CHECK (length(app_version) <= 20),
  CHECK (length(consent_version) BETWEEN 1 AND 20),
  CHECK (length(free_text) <= 1500),
  CHECK (analysis_json IS NULL OR json_valid(analysis_json))
);

CREATE TABLE IF NOT EXISTS answers (
  response_id TEXT NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  qid TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (response_id, qid),
  CHECK (length(qid) BETWEEN 1 AND 64),
  CHECK (length(value) BETWEEN 1 AND 60)
);

CREATE TABLE IF NOT EXISTS opinion_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  response_id TEXT NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  summary TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('提言','不満','要望','評価','事実主張')),
  topic TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('政党','省庁','地方自治体','企業','団体','政府全般','その他')),
  target_name TEXT NOT NULL DEFAULT '',
  emotion REAL NOT NULL CHECK (emotion BETWEEN -1 AND 1),
  criticality INTEGER NOT NULL CHECK (criticality BETWEEN 0 AND 100),
  fact_status TEXT NOT NULL CHECK (fact_status IN ('意見','要検証')),
  provenance_json TEXT NOT NULL DEFAULT '{}',
  CHECK (length(summary) BETWEEN 1 AND 48),
  CHECK (length(topic) BETWEEN 1 AND 24),
  CHECK (length(target_name) <= 40),
  CHECK (json_valid(provenance_json))
);

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (length(key) BETWEEN 1 AND 40),
  CHECK (json_valid(value_json))
);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

CREATE INDEX IF NOT EXISTS responses_created_at_idx ON responses(created_at DESC);
CREATE INDEX IF NOT EXISTS answers_qid_value_idx ON answers(qid, value);
CREATE INDEX IF NOT EXISTS chunks_topic_idx ON opinion_chunks(topic);
CREATE INDEX IF NOT EXISTS chunks_target_idx ON opinion_chunks(target_type, target_name);
CREATE INDEX IF NOT EXISTS chunks_created_at_idx ON opinion_chunks(created_at DESC);

