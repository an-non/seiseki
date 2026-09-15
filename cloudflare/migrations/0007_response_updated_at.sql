ALTER TABLE responses ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE responses SET updated_at = created_at WHERE updated_at = 0;
