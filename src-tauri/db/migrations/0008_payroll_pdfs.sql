-- Generated payroll PDF registry. Replaces browser-based payroll printing:
-- every payroll sheet PDF produced by the desktop app is recorded here with
-- its local path and cutoff metadata so the Payroll tab can list history and
-- offer Open PDF / Show in folder actions.
CREATE TABLE IF NOT EXISTS payroll_pdfs (
  payroll_pdf_id TEXT PRIMARY KEY NOT NULL,
  file_name TEXT NOT NULL,
  managed_relative_path TEXT NOT NULL,
  cutoff_start TEXT NOT NULL,
  cutoff_end TEXT NOT NULL,
  payroll_cutoff_label TEXT NOT NULL,
  worker_type TEXT NOT NULL CHECK (worker_type IN ('EMPLOYEE', 'INTERN')),
  employee_count INTEGER NOT NULL,
  total_amount_centavos INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_payroll_pdfs_created ON payroll_pdfs(created_at);
