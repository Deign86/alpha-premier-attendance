-- Which dated payroll policy version priced each day (see docs/payroll-policy.md).
-- Boundary mirrors NO_GRACE_CUTOFF_DATE in src-tauri/src/services/intern_payroll.rs.
ALTER TABLE payroll ADD COLUMN policy_version TEXT;
UPDATE payroll
SET policy_version = CASE WHEN attendance_date >= '2026-10-01' THEN 'V2_NO_GRACE' ELSE 'V1_WEEKLY_GRACE' END
WHERE policy_version IS NULL;
