CREATE TABLE response_text_fingerprints_next (
  response_id TEXT PRIMARY KEY REFERENCES responses(id) ON DELETE CASCADE,
  input_hmac TEXT NOT NULL,
  normalized_length INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (length(input_hmac) = 64),
  CHECK (normalized_length >= 8)
);

INSERT INTO response_text_fingerprints_next (
  response_id, input_hmac, normalized_length, updated_at
)
SELECT response_id, input_hmac, normalized_length, updated_at
FROM response_text_fingerprints;

DROP TABLE response_text_fingerprints;
ALTER TABLE response_text_fingerprints_next RENAME TO response_text_fingerprints;

CREATE INDEX response_text_fingerprints_hmac_idx
  ON response_text_fingerprints(input_hmac, updated_at);
