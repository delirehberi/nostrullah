-- BUG-08: Add composite index for the hot getPostHistory query path.
-- Without this index, every getPostHistory call does a full table scan as the
-- post_history table grows, causing progressively slower scheduled runs.
CREATE INDEX IF NOT EXISTS idx_post_history_account_created
    ON post_history(account_id, created_at DESC);
