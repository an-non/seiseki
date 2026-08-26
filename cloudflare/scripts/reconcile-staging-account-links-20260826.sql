-- STAGING ONLY.
-- Preserve every historical account->response link before enforcing one current response per account.
-- No responses, answers, response_questions, analysis_runs, opinion_chunks, accounts, sessions,
-- app_config, or response_access rows are deleted by this script.
--
-- Current-response selection deliberately matches the existing application semantics in auth.mjs:
-- latest linked_at wins, with response_id as a deterministic tie-breaker.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS account_responses_legacy_20260826 (
  account_id TEXT NOT NULL,
  response_id TEXT NOT NULL,
  linked_at INTEGER NOT NULL,
  archived_at INTEGER NOT NULL,
  archive_reason TEXT NOT NULL,
  was_current INTEGER NOT NULL CHECK (was_current IN (0, 1)),
  PRIMARY KEY (account_id, response_id)
);

CREATE INDEX IF NOT EXISTS account_responses_legacy_20260826_account_idx
  ON account_responses_legacy_20260826(account_id, linked_at DESC);

INSERT OR IGNORE INTO account_responses_legacy_20260826 (
  account_id, response_id, linked_at, archived_at, archive_reason, was_current
)
SELECT
  account_id,
  response_id,
  linked_at,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  'pre-0006 staging ownership reconciliation',
  CASE WHEN position = 1 THEN 1 ELSE 0 END
FROM (
  SELECT
    ar.account_id,
    ar.response_id,
    ar.linked_at,
    ROW_NUMBER() OVER (
      PARTITION BY ar.account_id
      ORDER BY ar.linked_at DESC, ar.response_id DESC
    ) AS position
  FROM account_responses ar
);

-- Remove only redundant rows from the ACTIVE ownership relation, after they have been archived.
-- The response rows and all of their child data remain in place.
DELETE FROM account_responses
WHERE EXISTS (
  SELECT 1
  FROM (
    SELECT
      account_id,
      response_id,
      ROW_NUMBER() OVER (
        PARTITION BY account_id
        ORDER BY linked_at DESC, response_id DESC
      ) AS position
    FROM account_responses
  ) ranked
  WHERE ranked.position > 1
    AND ranked.account_id = account_responses.account_id
    AND ranked.response_id = account_responses.response_id
);
