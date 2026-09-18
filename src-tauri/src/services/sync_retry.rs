// Queue retry domain: transient-forever versus finite classification plus the
// capped backoff both branches share. Deliberately dependency-free (std
// only) so the classifier can be executed outside the Tauri-linked crate.
// `sheets_sync` re-exports this vocabulary; the run_once fail arm consumes it.

/// Google API error codes surfaced to the sync queue. They intentionally
/// contain no credentials, paths, or response bodies.
pub const GOOGLE_RATE_LIMITED: &str = "GOOGLE_RATE_LIMITED";
pub const GOOGLE_REQUEST_FAILED: &str = "GOOGLE_REQUEST_FAILED";
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
        && (reason.contains("rateLimitExceeded") || reason.contains("userRateLimitExceeded"))
    {
        return true;
    }
    io_kind == "timeout-after-connect"
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

/// Computes backoff duration, new queue status, and error code for failed sync rows.
/// Transient failures (429 / 5xx / timeout-after-connect / 403-rateLimit via
/// `is_transient_sync_error`) use a 60-second base doubling backoff capped at
/// 960s, always stay RETRY, and never consume the 5-strike DEAD budget — the
/// run_once fail arm must skip the attempts increment for them.
/// Other errors follow 2^min(attempts, 5) exponential backoff and become DEAD at 5 attempts.
pub fn calculate_retry_backoff(attempts: i64, error: &str) -> (u64, &'static str, &'static str) {
    if is_transient_sync_error(error) {
        let clamped: u32 = u32::try_from(attempts.clamp(0, 4)).unwrap_or(4);
        let backoff_secs = 60_u64.saturating_mul(2_u64.saturating_pow(clamped));
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
        let clamped: u32 = u32::try_from(attempts.max(0)).unwrap_or(u32::MAX).min(5);
        let backoff_secs = 2_u64.saturating_pow(clamped);
        let status = if attempts + 1 >= 5 { "DEAD" } else { "RETRY" };
        (backoff_secs, status, "GOOGLE_SYNC_FAILED")
    }
}

#[cfg(test)]
mod tests {
    use super::{calculate_retry_backoff, is_transient_google_error};

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
