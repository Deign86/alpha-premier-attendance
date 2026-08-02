CREATE TABLE IF NOT EXISTS export_jobs (
    job_id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('ATTENDANCE_XLSX','DAILY_XLSX','PAYROLL_XLSX','PAYSLIP_XLSX','AUDIT_XLSX','MASTER_XLSX','PAYSLIP_PDF','PAYROLL_REGISTER_PDF','PAYROLL_COVER_PDF')),
    scope_json TEXT NOT NULL,
    format TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','PARTIAL','FAILED','CANCELLED')),
    requested_by TEXT NOT NULL DEFAULT 'LOCAL_ADMIN',
    requested_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    progress_current INTEGER NOT NULL DEFAULT 0,
    progress_total INTEGER NOT NULL DEFAULT 0,
    row_count INTEGER NOT NULL DEFAULT 0,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    app_version TEXT NOT NULL,
    error_code TEXT,
    error_message TEXT
);
CREATE INDEX IF NOT EXISTS ix_export_jobs_status_requested ON export_jobs(status, requested_at);

CREATE TABLE IF NOT EXISTS export_job_attempts (
    attempt_id TEXT PRIMARY KEY NOT NULL,
    job_id TEXT NOT NULL REFERENCES export_jobs(job_id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL,
    error_code TEXT,
    error_message TEXT,
    UNIQUE(job_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS generated_artifacts (
    artifact_id TEXT PRIMARY KEY NOT NULL,
    job_id TEXT NOT NULL REFERENCES export_jobs(job_id) ON DELETE CASCADE,
    document_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    format TEXT NOT NULL,
    file_name TEXT NOT NULL,
    managed_relative_path TEXT NOT NULL UNIQUE,
    sha256 TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (state IN ('AVAILABLE','MISSING','DELETED','SUPERSEDED')),
    created_at TEXT NOT NULL,
    expires_at TEXT,
    deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_generated_artifacts_created ON generated_artifacts(created_at);
