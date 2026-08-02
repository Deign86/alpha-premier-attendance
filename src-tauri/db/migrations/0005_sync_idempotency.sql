ALTER TABLE sync_queue ADD COLUMN idempotency_key TEXT;
ALTER TABLE sync_queue ADD COLUMN last_error_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_sync_queue_idempotency ON sync_queue(idempotency_key);
CREATE TABLE IF NOT EXISTS sheet_schema_state (
  spreadsheet_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  header_hash TEXT NOT NULL,
  last_validated_at TEXT NOT NULL,
  last_error TEXT,
  PRIMARY KEY (spreadsheet_id, table_name)
);
