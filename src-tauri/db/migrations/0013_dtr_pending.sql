CREATE TABLE IF NOT EXISTS dtr_pending (
  user_id TEXT PRIMARY KEY NOT NULL,
  full_name TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_checked TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);
