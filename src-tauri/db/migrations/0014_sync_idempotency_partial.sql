-- S14a: close the sync_queue idempotency hole (audit finding S14a, migration-only).
--
-- Background: 0005_sync_idempotency.sql added a NULLABLE idempotency_key TEXT
-- column plus a plain UNIQUE INDEX ux_sync_queue_idempotency. In SQLite, NULL
-- values are considered DISTINCT for UNIQUE enforcement, so rows with a NULL
-- idempotency_key bypass dedup entirely (unbounded duplicate NULL-key rows).
-- The plain index also cannot distinguish "not yet keyed" rows from keyed ones.
--
-- Fix (forward migration only -- never edit 0005 in place; state.rs
-- run_migrations() self-heals checksums/orphans but replays history forward,
-- so applied migrations are immutable): replace the plain unique index with a
-- PARTIAL unique index that enforces uniqueness only for keyed rows.
--
-- PRE-FLIGHT (run before applying; result set MUST be empty, otherwise the
-- CREATE UNIQUE INDEX below fails and duplicate keys must be deduped first):
--   SELECT idempotency_key, COUNT(*) AS n
--     FROM sync_queue
--    WHERE idempotency_key IS NOT NULL
--    GROUP BY idempotency_key
--    HAVING COUNT(*) > 1;
--
-- NULL AUDIT (informational -- NULLs are intentionally NOT deduped by the
-- partial index; every row counted here bypasses idempotency enforcement and
-- depends on the writer always binding a non-NULL key):
--   SELECT COUNT(*) AS null_key_rows FROM sync_queue WHERE idempotency_key IS NULL;
--
-- NOTE: SQLite resolves UPSERT conflict targets at prepare time. After this
-- migration, plain `ON CONFLICT(idempotency_key) DO UPDATE ...` NO LONGER
-- MATCHES any constraint; upserts must use the partial-index predicate:
--   ON CONFLICT(idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE ...
-- Updating the two enqueue upserts (lib.rs, services/sheets_sync.rs) is a
-- separate code change and is deliberately NOT part of this migration.

DROP INDEX IF EXISTS ux_sync_queue_idempotency;

CREATE UNIQUE INDEX ux_sync_queue_idempotency
    ON sync_queue(idempotency_key)
    WHERE idempotency_key IS NOT NULL;
