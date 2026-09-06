-- Migration 0015: canonicalize bathroom_log open/closed state on time_in.
--
-- Previously openness was tracked two ways: status ('OUT' vs 'RETURNED') and
-- time_in NULL-ness. The two could disagree (a buggy write setting time_in
-- without flipping status would both block the key forever and misreport
-- occupancy). All writers derive status from time_in already; this migration
-- backfills any anomalous rows (trusting the timestamp) and re-keys the
-- single-key-per-gender guard on time_in IS NULL. The status column is kept
-- for API/test compatibility and continues to be written consistently.

-- Pre-flight (expect empty before/after):
--   SELECT COUNT(*) FROM bathroom_log WHERE (status = 'OUT') != (time_in IS NULL);

-- Backfill: trust the timestamp over the flag.
UPDATE bathroom_log SET status = 'RETURNED' WHERE time_in IS NOT NULL AND status = 'OUT';
UPDATE bathroom_log SET status = 'OUT' WHERE time_in IS NULL AND status = 'RETURNED';

DROP INDEX IF EXISTS ux_bathroom_active_key;
CREATE UNIQUE INDEX IF NOT EXISTS ux_bathroom_active_key ON bathroom_log(gender_key) WHERE time_in IS NULL;
