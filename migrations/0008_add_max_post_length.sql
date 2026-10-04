-- Per-account post length limit in characters, links excluded (100-2000).
-- NULL = MAX_POST_LENGTH env var, or 500 when unset.
ALTER TABLE accounts ADD COLUMN max_post_length INTEGER;
