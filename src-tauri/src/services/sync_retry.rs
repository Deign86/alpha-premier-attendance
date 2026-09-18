// Queue retry domain: transient-forever versus finite classification plus the
// capped backoff both branches share. Deliberately dependency-free (std
// only) so the classifier can be executed outside the Tauri-linked crate.
// `sheets_sync` re-exports this vocabulary; the run_once fail arm consumes it.

/// Google API error codes surfaced to the sync queue. They intentionally
/// contain no credentials, paths, or response bodies.
pub const GOOGLE_RATE_LIMITED: &str = "GOOGLE_RATE_LIMITED";
pub const GOOGLE_REQUEST_FAILED: &str = "GOOGLE_REQUEST_FAILED";
pub const GOOGLE_PERMISSION_DENIED: &str = "GOOGLE_PERMISSION_DENIED";
/// 403 dailyLimitExceeded: finite 5-strike-to-DEAD with this code (operator
/// action, ~24h block — retrying within-day clogs the queue). Never transient.
pub const GOOGLE_DAILY_LIMIT: &str = "GOOGLE_DAILY_LIMIT";
/// 5xx from Google (server-side; idempotent cell writes are safe to replay).
/// Preserved end-to-end (status mappers emit it, the queue stores it) so a
/// 503 can never degrade into an anonymous finite failure.
pub const GOOGLE_SERVER_ERROR: &str = "GOOGLE_SERVER_ERROR";

/// Returns true if the error indicates a Google Sheets API rate limit / 429 quota exhaustion.
pub fn is_rate_limited_error(error: &str) -> bool {
    error.contains(GOOGLE_RATE_LIMITED) || error.contains("429")
}

/// Domain classifier for Google API failures: transient-forever versus finite.
///
/// Transient-forever (queue row stays RETRY, attempts NOT incremented, capped backoff):
/// 429, any 5xx, timeout-after-connect (request reached Google, reply stalled —
/// replaying an idempotent cell write is safe), and 403 carrying a
/// rateLimitExceeded|userRateLimitExceeded reason.
/// Finite 5-strike-to-DEAD: corrupt/validation 4xx (400 invalid payload, missing
/// userId, 403 forbidden/permissions, 404, ...).
/// `status` 0 means no HTTP status was observed (transport-level failure); only
/// the explicit `timeout-after-connect` io marker is transient, a bare timeout
/// stays finite so genuinely unreachable backends still age out.
// Staged API (repo precedent: SHEETS_SCHEMA_VERSION): the first non-test
// caller lands in todo 5, which plumbs 403 reason bodies into (status, reason).
#[allow(dead_code)]
pub fn is_transient_google_error(status: u16, reason: &str, io_kind: &str) -> bool {
    if status == 429 {
        return true;
    }
    if (500..=599).contains(&status) {
        return true;
    }
    if status == 403
        && (reason.contains("rateLimitExceeded")
            || reason.contains("userRateLimitExceeded")
            || reason.contains("quotaExceeded"))
    {
        return true;
    }
    io_kind == "timeout-after-connect"
}

/// Maps a Google 403 response body to its queue error string via the
/// errors[].reason fragment both Sheets and DTR mappers share. Rate/quota
/// reasons collapse to GOOGLE_RATE_LIMITED (transient-forever downstream);
/// dailyLimitExceeded keeps the DAILY_LIMIT code plus the operator note
/// (stored in last_error, surfaced by health); anything else stays a
/// finite permission failure. dailyLimit is checked first so a body
/// carrying both reasons still lands on the operator-action path.
pub fn classify_403_body(body: &str) -> String {
    if body.contains("dailyLimitExceeded") {
        return format!(
            "{GOOGLE_DAILY_LIMIT}: daily quota exhausted, operator action required (24h block)"
        );
    }
    if body.contains("rateLimitExceeded")
        || body.contains("userRateLimitExceeded")
        || body.contains("quotaExceeded")
    {
        return GOOGLE_RATE_LIMITED.to_string();
    }
    GOOGLE_PERMISSION_DENIED.to_string()
}

/// Queue-string form of the classifier: recovers the transient verdict from the
/// short error strings producers store in `sync_queue.last_error`
/// (`GOOGLE_SERVER_ERROR`, numeric 5xx markers, rate-limit reason fragments,
/// the `timeout-after-connect` marker). Anything unrecognized stays finite so
/// unknown failures keep aging toward DEAD instead of clogging the queue.
pub fn is_transient_sync_error(error: &str) -> bool {
    if is_rate_limited_error(error) {
        return true;
    }
    if error.contains(GOOGLE_SERVER_ERROR)
        || error.contains("rateLimitExceeded")
        || error.contains("userRateLimitExceeded")
        || error.contains("quotaExceeded")
        || error.contains("timeout-after-connect")
    {
        return true;
    }
    [
        "502",
        "503",
        "504",
        "507",
        "599",
        "Internal Server Error",
        "Bad Gateway",
        "Service Unavailable",
        "Gateway Timeout",
    ]
    .iter()
    .any(|marker| error.contains(marker))
}

/// Per-call (single Google HTTP call) retry policy shared by the DTR call
/// sites. At most 3 attempts with full-jitter backoff (base 1500ms doubling);
/// a Retry-After header overrides the jittered sleep, clamped to 15s.
/// Cumulative added sleep never exceeds 19.5s (1.5 + 3 + 15), so one row can
/// never overrun the 30s tick. Exhaustion returns the transient code upward;
/// queue-row infiniteness lives in the queue fail arm, never in-call.
pub const PER_CALL_MAX_ATTEMPTS: u32 = 3;
pub const PER_CALL_BASE_BACKOFF_MS: u64 = 1500;
pub const PER_CALL_RETRY_AFTER_CAP_SECS: u64 = 15;
pub const PER_CALL_SLEEP_BUDGET_MS: u64 = 19_500;

/// In-call retry applies to 429 + 5xx only. 403 reason routing is a later
/// todo; other 4xx fail fast to their mapped code.
pub fn is_per_call_retryable(status: u16) -> bool {
    status == 429 || (500..=599).contains(&status)
}

/// True when `attempt` (0-based) may sleep-and-retry after `status`: the
/// status is retryable AND attempts remain. The 3rd attempt never sleeps.
pub fn per_call_should_retry(status: u16, attempt: u32) -> bool {
    is_per_call_retryable(status) && attempt + 1 < PER_CALL_MAX_ATTEMPTS
}

/// Retry-After carries whole seconds; anything else (dates, garbage) is
/// ignored so the jittered backoff applies instead.
pub fn parse_retry_after_secs(raw: &str) -> Option<u64> {
    raw.trim().parse::<u64>().ok()
}

/// Full-jitter sample in `[0, cap_ms]` without new deps: one xorshift mix over
/// the current wall-clock nanos is plenty of entropy for backoff spreading.
fn full_jitter_ms(cap_ms: u64) -> u64 {
    if cap_ms == 0 {
        return 0;
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| u64::from(elapsed.subsec_nanos()))
        .unwrap_or(750_000);
    let mut mixed = nanos
        .wrapping_add(0x9E3779B97F4A7C15)
        .wrapping_mul(0xBF58476D1CE4E5B9);
    mixed ^= mixed >> 29;
    mixed = mixed.wrapping_mul(0x2806191);
    mixed % cap_ms.saturating_add(1)
}

/// Sleep before the next in-call attempt: `min(Retry-After, 15s)` when the
/// server asked for a delay, else full jitter over base*2^attempt.
pub fn per_call_sleep_ms(failed_attempt: u32, retry_after_secs: Option<u64>) -> u64 {
    if let Some(secs) = retry_after_secs {
        let cap_ms = PER_CALL_RETRY_AFTER_CAP_SECS.saturating_mul(1000);
        return secs.saturating_mul(1000).min(cap_ms);
    }
    let cap_ms = PER_CALL_BASE_BACKOFF_MS.saturating_mul(1_u64 << failed_attempt.min(4));
    full_jitter_ms(cap_ms)
}

/// Budget arithmetic behind the async sleep: actual sleep ms for a `want_ms`
/// request given `already_slept_ms`, so every call holds total added sleep
/// under 19.5s whatever headers arrive. The caller adds the return value.
pub fn per_call_budget_actual(already_slept_ms: u64, want_ms: u64) -> u64 {
    want_ms.min(PER_CALL_SLEEP_BUDGET_MS.saturating_sub(already_slept_ms))
}

/// DTR values.batchUpdate coalescing budget (plan todo 6 — kept in this
/// std-only file so the exact-bytes harness can include! it): at most 50
/// ranges per call, at most 2MB of serialized range payload per call, one
/// spreadsheet per call. Whichever bound hits first splits the drain.
/// Paint (spreadsheets.batchUpdate) never rides these values-only calls.
pub const DTR_BATCH_MAX_RANGES: usize = 50;
pub const DTR_BATCH_MAX_BYTES: usize = 2 * 1024 * 1024;

/// Chunk `entry_bytes` (serialized bytes of each values-only range entry, in
/// plan order) into `(start, end)` index pairs, one pair per
/// values:batchUpdate call. A single oversized entry still gets its own
/// chunk (one range per call) — it fails closed downstream instead of
/// wedging the splitter, and an empty drain yields zero chunks.
pub fn split_dtr_batch(entry_bytes: &[usize]) -> Vec<(usize, usize)> {
    let mut chunks: Vec<(usize, usize)> = Vec::new();
    let mut start = 0_usize;
    let mut bytes = 0_usize;
    for (index, size) in entry_bytes.iter().enumerate() {
        let count = index - start;
        if count > 0
            && (count >= DTR_BATCH_MAX_RANGES
                || bytes.saturating_add(*size) > DTR_BATCH_MAX_BYTES)
        {
            chunks.push((start, index));
            start = index;
            bytes = 0;
        }
        bytes = bytes.saturating_add(*size);
    }
    if start < entry_bytes.len() {
        chunks.push((start, entry_bytes.len()));
    }
    chunks
}

/// Shared in-progress guard (plan todo 8 — frozen primitive): ONE in-memory
/// AtomicBool owner (fast mutual exclusion, lives on AppState) + ONE
/// persisted `sync_state` row owner/startedAt (health + crash detection).
/// Covers admin_sync_now + admin_sync_intern_dtr + per-row sync (the latter
/// routes through admin_sync_intern_dtr with a user id); the second
/// concurrent caller gets DTR_SYNC_IN_PROGRESS. Clean restart always clears
/// in-memory and marks the persisted row completed; a crash-held row
/// releases after 5-min stale, mirroring the PROCESSING lease recovery.
/// Kill-switch (is_dtr_sync_enabled) still blocks manual entry before the
/// guard is touched. Kiosk scans never consult this guard.
pub const DTR_SYNC_IN_PROGRESS: &str = "DTR_SYNC_IN_PROGRESS";
pub const SYNC_GUARD_TABLE: &str = "__sync_guard__";
pub const SYNC_GUARD_ROW: &str = "manual_dtr_sync";
pub const SYNC_GUARD_COMPLETED: &str = "completed";
/// Crash-release horizon, mirroring PROCESSING_LEASE_TIMEOUT_MINUTES (5).
pub const SYNC_GUARD_STALE_SECS: u64 = 5 * 60;

/// Pure acquire decision over the persisted guard row: releasable when there
/// is no row, the row is marked completed (clean restart), the start instant
/// is 5+ min old (crash), or the row is corrupt (missing/garbled timestamp —
/// a corrupt row must never wedge manual sync forever). Epoch seconds keep
/// this std-only and virtual-clock injectable; the DB layer converts RFC3339.
pub fn sync_guard_row_releasable(
    stored_owner: Option<&str>,
    stored_started_at_secs: Option<u64>,
    now_secs: u64,
) -> bool {
    match (stored_owner, stored_started_at_secs) {
        (None, _) => true,
        (Some(owner), _) if owner == SYNC_GUARD_COMPLETED => true,
        (Some(_), None) => true,
        (Some(_), Some(started)) => now_secs.saturating_sub(started) >= SYNC_GUARD_STALE_SECS,
    }
}

/// Busy error for the second concurrent caller. The literal code
/// DTR_SYNC_IN_PROGRESS is the contract todos 9-10 build UI on — keep it.
pub fn sync_guard_busy_error(owner: &str, started_at: &str) -> String {
    format!("{DTR_SYNC_IN_PROGRESS}: sync already in progress (owner={owner}, startedAt={started_at})")
}
/// std-only file so the bucket stays dependency-free and virtual-clock
/// injectable): at most 50 DTR cell-writes AND at most 10 batch calls per
/// 60s fixed window. Writes/min is the binding quota (60 coalesced rows ≈
/// 2 calls, so calls/min is the safety rail). DTR-spreadsheet values
/// writes + values:batchUpdate calls only — ops exports bypass, paint and
/// metadata reads stay separate, drain-pause on 429 is untouched.
/// Concurrency 1: one bucket per drain owner (`&mut` / single mutex);
/// the queue path consults it exclusively, the manual path keeps its own
/// 1000ms pacing floor and never touches it.
pub const DTR_THROTTLE_WRITES_PER_MIN: u32 = 50;
pub const DTR_THROTTLE_CALLS_PER_MIN: u32 = 10;
pub const DTR_THROTTLE_WINDOW_MS: u64 = 60_000;

/// Wall-clock millisecond source for production admissions. Tests pass
/// explicit virtual instants instead, so no test ever sleeps.
pub fn wall_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

/// Fixed-window token bucket over an injected `now_ms` clock.
#[derive(Debug, Clone)]
pub struct DtrThrottleBucket {
    window_start_ms: u64,
    writes_used: u32,
    calls_used: u32,
}

/// Operator-facing reason attached to the todo-10 health contract while the
/// DTR bucket is exhausted. Single constant so the Data card can match it.
pub const DTR_THROTTLE_REASON: &str = "DTR_THROTTLE: 50-writes/min budget spent";
/// Retryable rows older than this raise `pendingAgeAlert` in health, bounding
/// infinite-RETRY queue growth visibility (todo 10).
pub const PENDING_AGE_ALERT_SECS: i64 = 6 * 3600;

impl DtrThrottleBucket {
    pub fn new(now_ms: u64) -> Self {
        Self {
            window_start_ms: now_ms,
            writes_used: 0,
            calls_used: 0,
        }
    }

    /// Admits `writes` cell-writes + `calls` batch calls at `now_ms`.
    /// Returns 0 when admitted (quota consumed), else the bounded wait in
    /// ms until the window rolls — the caller defers (never sleeps in a
    /// hot loop). Callers are bounded by construction (queue rows take
    /// 1+1, backfill chunks take ≤50 ranges + their chunk count), so a
    /// same-window denial always clears on the next window.
    pub fn take(&mut self, writes: u32, calls: u32, now_ms: u64) -> u64 {
        if now_ms.saturating_sub(self.window_start_ms) >= DTR_THROTTLE_WINDOW_MS {
            self.window_start_ms = now_ms;
            self.writes_used = 0;
            self.calls_used = 0;
        }
        if self.writes_used.saturating_add(writes) <= DTR_THROTTLE_WRITES_PER_MIN
            && self.calls_used.saturating_add(calls) <= DTR_THROTTLE_CALLS_PER_MIN
        {
            self.writes_used = self.writes_used.saturating_add(writes);
            self.calls_used = self.calls_used.saturating_add(calls);
            return 0;
        }
        self.window_end_ms(now_ms).saturating_sub(now_ms).max(1)
    }

    fn effective_used(&self, now_ms: u64) -> (u32, u32) {
        if now_ms.saturating_sub(self.window_start_ms) >= DTR_THROTTLE_WINDOW_MS {
            (0, 0)
        } else {
            (self.writes_used, self.calls_used)
        }
    }

    fn window_end_ms(&self, now_ms: u64) -> u64 {
        let start_ms = if now_ms.saturating_sub(self.window_start_ms) >= DTR_THROTTLE_WINDOW_MS
        {
            now_ms
        } else {
            self.window_start_ms
        };
        start_ms.saturating_add(DTR_THROTTLE_WINDOW_MS)
    }

    fn exhausted_at(&self, writes: u32, calls: u32, now_ms: u64) -> bool {
        let (writes_used, calls_used) = self.effective_used(now_ms);
        writes_used.saturating_add(writes) > DTR_THROTTLE_WRITES_PER_MIN
            || calls_used.saturating_add(calls) > DTR_THROTTLE_CALLS_PER_MIN
    }

    /// Non-mutating throttle probe for the todo-10 health contract: returns
    /// the window-end instant (epoch ms) when one more DTR write + call would
    /// be denied right now, else `None`. Never consumes quota.
    pub fn throttled_until_ms(&self, now_ms: u64) -> Option<u64> {
        if self.exhausted_at(1, 1, now_ms) {
            Some(self.window_end_ms(now_ms))
        } else {
            None
        }
    }
}
/// with the `run_once` fail arm in `sheets_sync.rs`, which owns the attempts
/// writes while this function owns the delays):
/// - Transient-forever (429 / 5xx / timeout-after-connect / 403-rateLimit):
///   60s base doubling per strike, capped at 960s, full-jitter ±50% of the
///   capped value (sampled in [0.5x, 1.5x]). Stays RETRY forever; the fail
///   arm must NOT increment `attempts` for these rows, so they can never
///   age into DEAD. The cap bounds the sleep: an attempt-10 row still waits
///   at most 960s + 50% jitter (1440s), never unbounded growth.
/// - Generic finite (corrupt/validation 4xx, unknown): 2^min(attempts,5)s,
///   capped at 32s. The fail arm increments `attempts` on every strike and
///   flips the row to DEAD on the 5th strike (attempts+1 >= 5).
/// Drain-pause (break on rate-limit) lives in the fail arm, not here.
pub const TRANSIENT_BACKOFF_BASE_SECS: u64 = 60;
pub const TRANSIENT_BACKOFF_CAP_SECS: u64 = 960;
pub const GENERIC_BACKOFF_CAP_SECS: u64 = 32;
pub const GENERIC_MAX_SHIFT: u32 = 5;
pub const GENERIC_DEAD_STRIKES: i64 = 5;

/// Full-jitter sample of a capped queue backoff in `[base/2, base + base/2]`
/// (±50%), reusing the xorshift wall-clock mixer so no new deps are needed.
/// Millisecond arithmetic keeps the ±50% window exact; the caller rounds up
/// to whole seconds with a 1s floor so a zero roll still schedules ahead.
fn jittered_queue_backoff_secs(capped_base_secs: u64) -> u64 {
    let base_ms = capped_base_secs.saturating_mul(1000);
    let half_ms = base_ms / 2;
    let sampled_ms = half_ms.saturating_add(full_jitter_ms(base_ms));
    sampled_ms.div_ceil(1000).max(1)
}

/// Computes backoff duration, new queue status, and error code for failed sync rows.
/// Transient failures (429 / 5xx / timeout-after-connect / 403-rateLimit via
/// `is_transient_sync_error`) use the pinned transient policy (60s base,
/// 960s cap, ±50% full jitter), always stay RETRY, and never consume the
/// 5-strike DEAD budget — the run_once fail arm must skip the attempts
/// increment for them.
/// Other errors follow 2^min(attempts, 5) exponential backoff (32s cap) and
/// become DEAD at 5 attempts (the fail arm increments attempts per strike).
pub fn calculate_retry_backoff(attempts: i64, error: &str) -> (u64, &'static str, &'static str) {
    if is_transient_sync_error(error) {
        let clamped: u32 = u32::try_from(attempts.clamp(0, 4)).unwrap_or(4);
        let uncapped = TRANSIENT_BACKOFF_BASE_SECS.saturating_mul(2_u64.saturating_pow(clamped));
        let backoff_secs = jittered_queue_backoff_secs(uncapped.min(TRANSIENT_BACKOFF_CAP_SECS));
        let error_code = if is_rate_limited_error(error)
            || error.contains("rateLimitExceeded")
            || error.contains("userRateLimitExceeded")
        {
            GOOGLE_RATE_LIMITED
        } else if error.contains(GOOGLE_SERVER_ERROR) {
            GOOGLE_SERVER_ERROR
        } else {
            GOOGLE_REQUEST_FAILED
        };
        (backoff_secs, "RETRY", error_code)
    } else {
        let clamped: u32 = u32::try_from(attempts.max(0))
            .unwrap_or(u32::MAX)
            .min(GENERIC_MAX_SHIFT);
        let backoff_secs = 2_u64
            .saturating_pow(clamped)
            .min(GENERIC_BACKOFF_CAP_SECS);
        let status = if attempts + 1 >= GENERIC_DEAD_STRIKES {
            "DEAD"
        } else {
            "RETRY"
        };
        // Daily-limit rows ride the finite ladder but keep their distinct
        // code so health/operators can tell quota exhaustion apart.
        let code = if error.contains(GOOGLE_DAILY_LIMIT) {
            GOOGLE_DAILY_LIMIT
        } else {
            "GOOGLE_SYNC_FAILED"
        };
        (backoff_secs, status, code)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        DTR_THROTTLE_CALLS_PER_MIN, DTR_THROTTLE_WINDOW_MS, DTR_THROTTLE_WRITES_PER_MIN,
        DtrThrottleBucket, GENERIC_BACKOFF_CAP_SECS, SYNC_GUARD_COMPLETED,
        SYNC_GUARD_STALE_SECS, TRANSIENT_BACKOFF_BASE_SECS,
        TRANSIENT_BACKOFF_CAP_SECS, calculate_retry_backoff, is_transient_google_error,
        split_dtr_batch, sync_guard_busy_error, sync_guard_row_releasable,
    };

    #[test]
    fn sync_guard_second_caller_busy() {
        // Plan todo 8 happy path: a freshly-held row (10s old) is NOT
        // releasable, and the busy error carries the frozen code.
        assert!(!sync_guard_row_releasable(
            Some("admin_sync_now"),
            Some(1000),
            1010
        ));
        let busy = sync_guard_busy_error("admin_sync_now", "2026-09-18T00:00:10+00:00");
        assert!(
            busy.contains(super::DTR_SYNC_IN_PROGRESS),
            "second caller must get DTR_SYNC_IN_PROGRESS, got {busy}"
        );
        assert!(busy.contains("admin_sync_now"));
        // Boundary: exactly 300s old releases; 299s still holds.
        assert!(!sync_guard_row_releasable(
            Some("admin_sync_intern_dtr:bulk"),
            Some(1000),
            1000 + SYNC_GUARD_STALE_SECS - 1
        ));
        assert!(sync_guard_row_releasable(
            Some("admin_sync_intern_dtr:bulk"),
            Some(1000),
            1000 + SYNC_GUARD_STALE_SECS
        ));
        // Future-dated start (clock skew) never reads as stale.
        assert!(!sync_guard_row_releasable(
            Some("admin_sync_now"),
            Some(2000),
            1000
        ));
    }

    #[test]
    fn sync_guard_stale_release() {
        // Plan todo 8 crash path: 6-min-old row releases like a stale lease.
        assert!(sync_guard_row_releasable(
            Some("admin_sync_intern_dtr:user:INT-1"),
            Some(1000),
            1000 + 6 * 60
        ));
        // No row yet, completed row, and corrupt rows (no timestamp) all
        // release — nothing may wedge manual sync forever.
        assert!(sync_guard_row_releasable(None, None, 9999));
        assert!(sync_guard_row_releasable(
            Some(SYNC_GUARD_COMPLETED),
            Some(1000),
            1010
        ));
        assert!(sync_guard_row_releasable(Some("admin_sync_now"), None, 1010));
        assert_eq!(SYNC_GUARD_STALE_SECS, 5 * 60);
    }

    #[test]
    fn sync_guard_restart_clear() {
        // Plan todo 8 restart path: clean boot marks the row completed, so
        // the next acquire succeeds even though a sync held it before the
        // kill. A completed row with a fresh timestamp still releases.
        assert!(sync_guard_row_releasable(
            Some(SYNC_GUARD_COMPLETED),
            Some(5000),
            5001
        ));
        // ...while a genuinely fresh active row still blocks (no
        // clear-then-immediately-busy regression).
        assert!(!sync_guard_row_releasable(
            Some("admin_sync_now"),
            Some(5000),
            5001
        ));
    }

    #[test]
    fn dtr_throttle() {
        // Plan todo 7: 60 queued writes ride the todo-6 coalescer into ~2
        // values:batchUpdate calls (50 + 10 ranges), inside the ≤10 rail.
        // Virtual clock only — no wall-clock sleep, no 60s wait.
        let sizes = vec![128_usize; 60];
        let chunks = split_dtr_batch(&sizes);
        assert_eq!(chunks.len(), 2, "60 rows must coalesce into 2 calls");
        assert!(
            (chunks.len() as u32) <= DTR_THROTTLE_CALLS_PER_MIN,
            "2 calls must sit inside the calls/min safety rail"
        );
        let mut now_ms = 0_u64;
        let mut bucket = DtrThrottleBucket::new(now_ms);
        // First chunk (50 writes + 1 call) fits the fresh window exactly.
        assert_eq!(bucket.take(50, 1, now_ms), 0);
        // Second chunk (10 writes + 1 call): budget spent → deferred with a
        // bounded wait inside one window, never a busy-loop zero.
        let wait_ms = bucket.take(10, 1, now_ms);
        assert!(
            wait_ms > 0 && wait_ms <= DTR_THROTTLE_WINDOW_MS,
            "deferral must be bounded, got {wait_ms}ms"
        );
        now_ms += wait_ms;
        assert_eq!(bucket.take(10, 1, now_ms), 0);
        // Whole 60-row burst schedules within ~2 windows of the
        // 50-writes/min budget (writes/min binding, calls/min rail).
        assert!(
            now_ms <= 2 * DTR_THROTTLE_WINDOW_MS,
            "burst scheduled at {now_ms}ms, outside budget"
        );
        assert_eq!(DTR_THROTTLE_WRITES_PER_MIN, 50);
        // Fail side: a 429 storm never busy-loops — every denial at the
        // same instant carries the same positive wait pinned to the window
        // end, and the window rolling re-admits without any sleep call.
        let mut storm = DtrThrottleBucket::new(0);
        assert_eq!(storm.take(50, 1, 0), 0);
        for _ in 0..20 {
            assert_eq!(storm.take(1, 1, 0), DTR_THROTTLE_WINDOW_MS);
        }
        assert_eq!(storm.take(1, 1, DTR_THROTTLE_WINDOW_MS), 0);
    }

    #[test]
    fn backoff_caps() {
        // Policy pins: transient base 60s cap 960s ±50% jitter, never DEAD;
        // generic 2^min(attempts,5)s cap 32s, DEAD on the 5th strike.
        assert_eq!(TRANSIENT_BACKOFF_BASE_SECS, 60);
        assert_eq!(TRANSIENT_BACKOFF_CAP_SECS, 960);
        assert_eq!(GENERIC_BACKOFF_CAP_SECS, 32);

        // Attempt-10 transient stays RETRY and within cap+jitter (960 ±50%).
        let floor = TRANSIENT_BACKOFF_CAP_SECS / 2;
        let ceiling = TRANSIENT_BACKOFF_CAP_SECS + TRANSIENT_BACKOFF_CAP_SECS / 2;
        for _ in 0..20 {
            let (backoff, status, _) = calculate_retry_backoff(10, "429 Too Many Requests");
            assert_eq!(status, "RETRY");
            assert!(
                (floor..=ceiling).contains(&backoff),
                "transient backoff {backoff}s outside [{floor},{ceiling}]"
            );
        }

        // Jitter spreads consecutive transient samples (never a fixed point).
        let samples: Vec<u64> = (0..20)
            .map(|_| calculate_retry_backoff(4, "503 Service Unavailable").0)
            .collect();
        let first = samples[0];
        assert!(
            samples.iter().any(|sample| *sample != first),
            "transient backoff never jitters: {samples:?}"
        );

        // Generic exponential ladder with the 32s cap and DEAD at strike 5.
        let expected: [(i64, u64, &str); 7] = [
            (0, 1, "RETRY"),
            (1, 2, "RETRY"),
            (2, 4, "RETRY"),
            (3, 8, "RETRY"),
            (4, 16, "DEAD"),
            (5, 32, "DEAD"),
            (10, 32, "DEAD"),
        ];
        for (attempts, backoff, status) in expected {
            let (actual_backoff, actual_status, code) =
                calculate_retry_backoff(attempts, "400 corrupt payload invalid");
            assert_eq!(actual_backoff, backoff, "attempts={attempts}");
            assert_eq!(actual_status, status, "attempts={attempts}");
            assert_eq!(code, "GOOGLE_SYNC_FAILED");
        }
    }

    #[test]
    fn transient_classifier() {
        // RETRY-forever inputs: 429 / 5xx / timeout-after-connect / 403-rateLimit.
        assert!(is_transient_google_error(429, "Too Many Requests", ""));
        assert!(is_transient_google_error(500, "Internal Error", ""));
        assert!(is_transient_google_error(503, "Service Unavailable", ""));
        assert!(is_transient_google_error(599, "Network Connect Timeout", ""));
        assert!(is_transient_google_error(0, "timeout", "timeout-after-connect"));
        assert!(is_transient_google_error(403, "rateLimitExceeded", ""));
        assert!(is_transient_google_error(403, "userRateLimitExceeded", ""));

        // Finite inputs: corrupt/validation 4xx stay on the 5-strike DEAD path.
        assert!(!is_transient_google_error(400, "invalid payload", ""));
        assert!(!is_transient_google_error(400, "corrupt", ""));
        assert!(!is_transient_google_error(403, "forbidden", ""));
        assert!(!is_transient_google_error(404, "not found", ""));
        assert!(!is_transient_google_error(0, "network timeout", ""));

        // Queue mapping: transient rows NEVER reach DEAD, however high attempts climb.
        for attempts in [0_i64, 4, 5, 10, 100] {
            for error in [
                "429 Too Many Requests",
                "GOOGLE_RATE_LIMITED",
                "503 Service Unavailable",
                "GOOGLE_SERVER_ERROR: execute push: 503",
                "timeout-after-connect: deadline exceeded",
                "403 rateLimitExceeded: quota exceeded",
            ] {
                let (_, status, _) = calculate_retry_backoff(attempts, error);
                assert_eq!(status, "RETRY", "attempts={attempts} error={error}");
            }
        }

        // Corrupt 400 rows keep the finite path: RETRY until the 5th strike, then DEAD with a code.
        let (backoff, status, code) = calculate_retry_backoff(0, "400 corrupt payload invalid");
        assert_eq!(backoff, 1);
        assert_eq!(status, "RETRY");
        assert_eq!(code, "GOOGLE_SYNC_FAILED");
        let (_, status, code) = calculate_retry_backoff(4, "400 corrupt payload invalid");
        assert_eq!(status, "DEAD");
        assert_eq!(code, "GOOGLE_SYNC_FAILED");
        let (_, status, _) = calculate_retry_backoff(4, "Google Sheets sync payload is invalid");
        assert_eq!(status, "DEAD");
    }
}
