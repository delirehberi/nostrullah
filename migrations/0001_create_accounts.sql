-- Create accounts table
CREATE TABLE accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    private_key TEXT NOT NULL,
    relays TEXT NOT NULL, -- JSON array
    categories TEXT NOT NULL, -- JSON array
    frequency TEXT NOT NULL,
    data_resources TEXT, -- JSON array of objects (type, url, etc.)
    prompt_template TEXT,
    last_run_at INTEGER DEFAULT 0, -- Epoch timestamp
    is_active BOOLEAN DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create post_history table
CREATE TABLE post_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(account_id) REFERENCES accounts(id)
);
