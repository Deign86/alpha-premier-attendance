-- Migration 0016: Friday DTR Reconciliation service tables

CREATE TABLE IF NOT EXISTS dtr_recon_runs (
    run_id TEXT PRIMARY KEY NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
    report_only INTEGER NOT NULL DEFAULT 1,
    summary_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS dtr_recon_discrepancies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    full_name TEXT NOT NULL,
    attendance_date TEXT NOT NULL,
    sheet_b TEXT,
    sheet_c TEXT,
    sheet_d TEXT,
    sheet_e TEXT,
    db_time_in TEXT,
    db_time_out TEXT,
    action_taken TEXT NOT NULL CHECK (action_taken IN ('IN_SYNC', 'CORRECTED', 'REPORTED', 'CLEARED', 'FAILED', 'UNRESOLVABLE')),
    error_message TEXT,
    FOREIGN KEY(run_id) REFERENCES dtr_recon_runs(run_id)
);

CREATE INDEX IF NOT EXISTS ix_dtr_recon_discrepancies_run ON dtr_recon_discrepancies(run_id);
CREATE INDEX IF NOT EXISTS ix_dtr_recon_discrepancies_user_date ON dtr_recon_discrepancies(user_id, attendance_date);

CREATE TABLE IF NOT EXISTS dtr_recon_state (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
