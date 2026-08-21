PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (length(id) BETWEEN 12 AND 64),
  CHECK (length(name) BETWEEN 2 AND 20),
  CHECK (length(normalized_name) BETWEEN 2 AND 40),
  CHECK (password_iterations BETWEEN 100000 AND 1000000)
);

CREATE TABLE IF NOT EXISTS account_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (length(token_hash) = 64),
  CHECK (expires_at > created_at)
);

CREATE TABLE IF NOT EXISTS account_responses (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  response_id TEXT NOT NULL UNIQUE REFERENCES responses(id) ON DELETE CASCADE,
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, response_id)
);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  response_id TEXT NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  engine TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  error_code TEXT,
  CHECK (length(engine) BETWEEN 1 AND 40),
  CHECK (length(model) BETWEEN 1 AND 100),
  CHECK (length(prompt_version) BETWEEN 1 AND 40),
  CHECK (error_code IS NULL OR length(error_code) <= 80)
);

CREATE INDEX IF NOT EXISTS account_sessions_account_idx
  ON account_sessions(account_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS account_responses_account_idx
  ON account_responses(account_id, linked_at DESC);
CREATE INDEX IF NOT EXISTS analysis_runs_response_idx
  ON analysis_runs(response_id, started_at DESC);
