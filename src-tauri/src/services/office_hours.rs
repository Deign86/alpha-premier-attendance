use chrono::{DateTime, Timelike};
use chrono_tz::Asia::Manila;

/// Official office-hours policy for attendance.
///
/// The office does not allow overtime: a time-out recorded strictly after the
/// end of office hours is saved as `LATE_TIMEOUT` (flagged for manual
/// correction) instead of a normal `COMPLETED` shift. This mirrors the shared
/// TS policy in `shared/src/api-contracts.ts` (`isLateTimeout` /
/// `OFFICE_HOURS_END`) so the desktop app and the web-compatible server agree.
pub const OFFICE_HOURS_END_HOUR: u32 = 18;
pub const OFFICE_HOURS_END_MINUTE: u32 = 0;

/// True when the Manila-local clock time of an RFC3339 timestamp is strictly
/// after the end of office hours (18:00 / 6 PM onwards). A time-out up to 18:00
/// is a normal end-of-day COMPLETED shift; anything later must be corrected.
pub fn is_late_timeout(timestamp: &str) -> bool {
    let Ok(parsed) = DateTime::parse_from_rfc3339(timestamp) else {
        return false;
    };
    let local = parsed.with_timezone(&Manila);
    let minutes = local.hour() * 60 + local.minute();
    minutes > OFFICE_HOURS_END_HOUR * 60 + OFFICE_HOURS_END_MINUTE
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_time_outs_strictly_after_18_00_manila() {
        assert!(is_late_timeout("2026-08-04T18:55:12+08:00"));
        assert!(is_late_timeout("2026-08-04T18:01:00+08:00"));
        assert!(is_late_timeout("2026-08-04T23:59:00+08:00"));
    }

    #[test]
    fn keeps_time_outs_at_or_before_18_00_manila_normal() {
        assert!(!is_late_timeout("2026-08-04T18:00:00+08:00"));
        assert!(!is_late_timeout("2026-08-04T17:05:00+08:00"));
        assert!(!is_late_timeout("2026-08-04T17:00:00+08:00"));
        assert!(!is_late_timeout("2026-08-04T16:59:00+08:00"));
        assert!(!is_late_timeout("2026-08-04T07:30:00+08:00"));
    }

    #[test]
    fn compares_in_manila_time_regardless_of_offset() {
        // 18:55 Manila == 10:55 UTC on the same day (late).
        assert!(is_late_timeout("2026-08-04T10:55:00Z"));
        // 17:05 Manila == 09:05 UTC on the same day (normal).
        assert!(!is_late_timeout("2026-08-04T09:05:00Z"));
        // 18:00 Manila == 10:00 UTC on the same day (normal).
        assert!(!is_late_timeout("2026-08-04T10:00:00Z"));
        // 16:00 Manila == 08:00 UTC (normal).
        assert!(!is_late_timeout("2026-08-04T08:00:00Z"));
    }

    #[test]
    fn never_treats_an_unparseable_timestamp_as_late() {
        assert!(!is_late_timeout("not-a-timestamp"));
        assert!(!is_late_timeout(""));
    }
}
