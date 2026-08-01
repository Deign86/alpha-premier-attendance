CREATE TABLE IF NOT EXISTS sync_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, row_id TEXT NOT NULL, operation TEXT NOT NULL, payload_json TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, status TEXT NOT NULL DEFAULT 'PENDING', next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, locked_at TEXT);
CREATE INDEX IF NOT EXISTS ix_sync_ready ON sync_queue(status, next_attempt_at, id);
CREATE TABLE IF NOT EXISTS sync_state (table_name TEXT NOT NULL, row_id TEXT NOT NULL, last_synced_hash TEXT NOT NULL, sheet_row_number INTEGER, last_synced_at TEXT NOT NULL, PRIMARY KEY (table_name, row_id));

