-- Transient sync failures (429 / 5xx / transport) back off on their own
-- strike count: they never touch `attempts`, which is the finite 5-strike
-- budget toward DEAD, so before this column their backoff never grew.
ALTER TABLE sync_queue ADD COLUMN transient_strikes INTEGER NOT NULL DEFAULT 0;
