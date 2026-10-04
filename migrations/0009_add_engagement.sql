-- Engagement feedback: per-post reaction/repost/reply/zap counts and score,
-- refreshed at most every 6 hours per account.
ALTER TABLE post_history ADD COLUMN reactions INTEGER DEFAULT 0;
ALTER TABLE post_history ADD COLUMN reposts INTEGER DEFAULT 0;
ALTER TABLE post_history ADD COLUMN replies INTEGER DEFAULT 0;
ALTER TABLE post_history ADD COLUMN zaps INTEGER DEFAULT 0;
ALTER TABLE post_history ADD COLUMN zap_sats INTEGER DEFAULT 0;
ALTER TABLE post_history ADD COLUMN engagement_score INTEGER DEFAULT 0;
ALTER TABLE post_history ADD COLUMN engagement_updated_at INTEGER;

ALTER TABLE accounts ADD COLUMN engagement_checked_at INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_post_history_account_score
    ON post_history(account_id, engagement_score DESC);
