-- Debug page: a trace of every scheduled account run, and Nostr-login sessions.

-- One row per account per scheduled run (skips included). `details` is the JSON
-- trace (schedule decision, resources tried, format choice, generation attempts,
-- publish result). Rows older than 30 days are pruned.
CREATE TABLE IF NOT EXISTS run_log (
    id TEXT PRIMARY KEY,
    account_id INTEGER,
    account_name TEXT,
    started_at INTEGER NOT NULL,
    duration_ms INTEGER,
    outcome TEXT NOT NULL,
    summary TEXT,
    post_format TEXT,
    event_id TEXT,
    details TEXT
);

CREATE INDEX IF NOT EXISTS idx_run_log_started
    ON run_log(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_run_log_account_started
    ON run_log(account_id, started_at DESC);

-- Debug page sessions; only the SHA-256 hash of the session cookie is stored.
CREATE TABLE IF NOT EXISTS debug_sessions (
    token_hash TEXT PRIMARY KEY,
    pubkey TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

-- Ids of NIP-98 login events already used, so a signed login cannot be replayed.
CREATE TABLE IF NOT EXISTS debug_login_events (
    event_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
);
