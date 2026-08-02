CREATE TABLE IF NOT EXISTS payroll_snapshots (
  snapshot_id TEXT PRIMARY KEY NOT NULL,
  payroll_id TEXT NOT NULL REFERENCES payroll_cutoffs(payroll_id),
  revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('FINALIZED','VOID')),
  snapshot_json TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(payroll_id, revision)
);
CREATE INDEX IF NOT EXISTS ix_payroll_snapshots_payroll ON payroll_snapshots(payroll_id, revision);
