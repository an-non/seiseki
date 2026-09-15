PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS account_recovery_tokens (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  CHECK (length(token_hash) = 64)
);
