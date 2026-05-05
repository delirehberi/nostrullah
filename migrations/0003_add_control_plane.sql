ALTER TABLE accounts ADD COLUMN control_enabled BOOLEAN DEFAULT 0;
ALTER TABLE accounts ADD COLUMN control_admin_pubkeys TEXT DEFAULT '[]';
ALTER TABLE accounts ADD COLUMN control_last_checked_at INTEGER DEFAULT 0;

ALTER TABLE post_history ADD COLUMN event_id TEXT;

CREATE TABLE processed_control_events (
    event_id TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL,
    author_pubkey TEXT NOT NULL,
    raw_content TEXT NOT NULL,
    parsed_actions_json TEXT,
    status TEXT NOT NULL,
    result_message TEXT NOT NULL,
    event_created_at INTEGER NOT NULL,
    processed_at INTEGER NOT NULL,
    FOREIGN KEY(account_id) REFERENCES accounts(id)
);

CREATE INDEX idx_post_history_event_id ON post_history(event_id);
CREATE INDEX idx_processed_control_events_account_id ON processed_control_events(account_id);
