-- Tracks resource items (e.g. RSS article links) already used for a post, so the
-- same story is not offered to the AI again.
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
