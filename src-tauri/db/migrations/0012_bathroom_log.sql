-- Migration 0012: Add bathroom key logging table and indexes

CREATE TABLE IF NOT EXISTS bathroom_log (
    log_id TEXT PRIMARY KEY NOT NULL,
    log_date TEXT NOT NULL,
    user_id TEXT NOT NULL,
    full_name TEXT NOT NULL,
    department TEXT,
    gender_key TEXT NOT NULL CHECK (gender_key IN ('MALE', 'FEMALE')),
    time_out TEXT NOT NULL,
    time_in TEXT,
    duration_seconds INTEGER,
    status TEXT NOT NULL DEFAULT 'OUT' CHECK (status IN ('OUT', 'RETURNED')),
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_bathroom_active_key ON bathroom_log(gender_key) WHERE status = 'OUT';
CREATE INDEX IF NOT EXISTS ix_bathroom_date_gender ON bathroom_log(log_date, gender_key);
CREATE INDEX IF NOT EXISTS ix_bathroom_user ON bathroom_log(user_id);
