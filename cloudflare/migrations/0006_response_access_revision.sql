PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS response_access (
  response_id TEXT PRIMARY KEY REFERENCES responses(id) ON DELETE CASCADE,
  manage_token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  CHECK (length(manage_token_hash) = 64)
);

ALTER TABLE responses ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE analysis_runs ADD COLUMN response_revision INTEGER;
ALTER TABLE analysis_runs ADD COLUMN lease_until INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS account_responses_account_unique
  ON account_responses(account_id);

CREATE UNIQUE INDEX IF NOT EXISTS analysis_runs_response_revision_running_unique
  ON analysis_runs(response_id, response_revision)
  WHERE response_revision IS NOT NULL AND status = 'running';

