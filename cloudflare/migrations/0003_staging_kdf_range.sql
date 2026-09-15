PRAGMA foreign_keys = ON;

CREATE TABLE accounts_next (
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
  CHECK (password_iterations BETWEEN 10000 AND 1000000)
);

INSERT INTO accounts_next
SELECT id, name, normalized_name, password_salt, password_hash,
       password_iterations, created_at, updated_at
FROM accounts;

CREATE TABLE account_sessions_next (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts_next(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (length(token_hash) = 64),
  CHECK (expires_at > created_at)
);

INSERT INTO account_sessions_next
SELECT token_hash, account_id, created_at, expires_at
FROM account_sessions;

CREATE TABLE account_responses_next (
  account_id TEXT NOT NULL REFERENCES accounts_next(id) ON DELETE CASCADE,
  response_id TEXT NOT NULL UNIQUE REFERENCES responses(id) ON DELETE CASCADE,
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, response_id)
);

INSERT INTO account_responses_next
SELECT account_id, response_id, linked_at
FROM account_responses;

DROP TABLE account_sessions;
DROP TABLE account_responses;
DROP TABLE accounts;

ALTER TABLE accounts_next RENAME TO accounts;
ALTER TABLE account_sessions_next RENAME TO account_sessions;
ALTER TABLE account_responses_next RENAME TO account_responses;

CREATE INDEX account_sessions_account_idx
  ON account_sessions(account_id, expires_at DESC);
CREATE INDEX account_responses_account_idx
  ON account_responses(account_id, linked_at DESC);
