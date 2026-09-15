ALTER TABLE responses
ADD COLUMN follow_up_text TEXT NULL
CHECK (follow_up_text IS NULL OR length(follow_up_text) <= 1500);
