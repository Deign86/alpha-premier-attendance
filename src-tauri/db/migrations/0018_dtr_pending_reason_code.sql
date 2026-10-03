ALTER TABLE dtr_pending
ADD COLUMN reason_code TEXT NOT NULL DEFAULT 'missing_tab'
CHECK (
  reason_code IN ('missing_tab', 'backfill_failed', 'transport')
  OR reason_code GLOB 'unresolvable:?*'
);
