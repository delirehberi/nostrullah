-- Content sharing strategy: shared-item tracking, per-account scheduling, post
-- formats, post length and engagement feedback.

-- Resource items (e.g. RSS article links) already used for a post, so the same
-- story is not offered to the AI again. Rows older than 90 days are pruned.
CREATE TABLE IF NOT EXISTS shared_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    title TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(account_id) REFERENCES accounts(id),
    UNIQUE(account_id, url)
);

CREATE INDEX IF NOT EXISTS idx_shared_items_account_created
    ON shared_items(account_id, created_at DESC);

-- Scheduling: the frequency (preset or cron) and the active-hours window are
-- evaluated in `timezone`; each post is delayed by a random 0..jitter_hours
-- whole-hour offset after its scheduled slot (the worker cron runs hourly).
ALTER TABLE accounts ADD COLUMN timezone TEXT DEFAULT 'Europe/Istanbul';
ALTER TABLE accounts ADD COLUMN active_hours TEXT DEFAULT '07:00-23:00';
ALTER TABLE accounts ADD COLUMN jitter_hours INTEGER DEFAULT 1;

-- Post format rotation: per-account format weights as JSON
-- (NULL = default weights, {} = rotation off).
ALTER TABLE accounts ADD COLUMN post_formats TEXT;

-- Post length limit in characters, links excluded (100-2000).
-- NULL = MAX_POST_LENGTH env var, or 500 when unset.
ALTER TABLE accounts ADD COLUMN max_post_length INTEGER;

-- Unix seconds of the last engagement collection (refreshed every 6 hours).
ALTER TABLE accounts ADD COLUMN engagement_checked_at INTEGER DEFAULT 0;

-- Format used for each post, and its engagement counts and score.
ALTER TABLE post_history ADD COLUMN format TEXT;
ALTER TABLE post_history ADD COLUMN reactions INTEGER DEFAULT 0;
ALTER TABLE post_history ADD COLUMN reposts INTEGER DEFAULT 0;
ALTER TABLE post_history ADD COLUMN replies INTEGER DEFAULT 0;
ALTER TABLE post_history ADD COLUMN zaps INTEGER DEFAULT 0;
ALTER TABLE post_history ADD COLUMN zap_sats INTEGER DEFAULT 0;
ALTER TABLE post_history ADD COLUMN engagement_score INTEGER DEFAULT 0;
ALTER TABLE post_history ADD COLUMN engagement_updated_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_post_history_account_score
    ON post_history(account_id, engagement_score DESC);

-- Accounts with a custom cron expression were written against UTC: keep them on
-- UTC, without an active-hours window or random delay, so their posting times
-- do not move.
UPDATE accounts
SET timezone = 'UTC', active_hours = NULL, jitter_hours = 0
WHERE frequency IS NOT NULL
  AND TRIM(frequency) != ''
  AND frequency NOT IN ('hourly', 'every_2_hours', 'twice_a_day', 'daily');
