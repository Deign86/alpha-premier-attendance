use chrono::{DateTime, Timelike};
use chrono_tz::Asia::Manila;

/// Official office-hours policy for attendance.
///
/// The office does not allow overtime: a time-out recorded at or after 18:00
/// is saved as `LATE_TIMEOUT` (flagged for manual correction) instead of a
/// normal `COMPLETED` shift. This mirrors the shared TS policy in
/// `shared/src/api-contracts.ts` (`isLateTimeout` / `LATE_TIMEOUT_THRESHOLD`)
/// so the desktop app and the web-compatible server agree.
#[allow(dead_code)]
pub const OFFICE_HOURS_END_HOUR: u32 = 17;
#[allow(dead_code)]
pub const OFFICE_HOURS_END_MINUTE: u32 = 0;
/// Late time-out cutoff (6:00 PM / 18:00). Time-outs at or after this are flagged.
pub const LATE_TIMEOUT_HOUR: u32 = 18;
pub const LATE_TIMEOUT_MINUTE: u32 = 0;
#[allow(dead_code)]
pub const WORKDAY_END_HOUR: u32 = 17;
#[allow(dead_code)]
pub const WORKDAY_END_MINUTE: u32 = 0;

/// True when the Manila-local clock time of an RFC3339 timestamp is at or
/// after 18:00 (6 PM onwards). A time-out up to 17:59 is a normal end-of-day
/// COMPLETED shift; anything later must be corrected.
pub fn is_late_timeout(timestamp: &str) -> bool {
    let Ok(parsed) = DateTime::parse_from_rfc3339(timestamp) else {
        return false;
    };
    let local = parsed.with_timezone(&Manila);
    let minutes = local.hour() * 60 + local.minute();
    minutes >= LATE_TIMEOUT_HOUR * 60 + LATE_TIMEOUT_MINUTE
}

/// True when the Manila-local clock time of an RFC3339 timestamp is strictly
/// before 5:00 PM (17:00:00). A daytime time-out before 5:00 PM is automatically
/// classified as a half day.
#[allow(dead_code)]
pub fn is_before_five_pm(timestamp: &str) -> bool {
    let Ok(parsed) = DateTime::parse_from_rfc3339(timestamp) else {
        return false;
    };
    let local = parsed.with_timezone(&Manila);
    let seconds = local.hour() * 3600 + local.minute() * 60 + local.second();
    seconds < WORKDAY_END_HOUR * 3600 + WORKDAY_END_MINUTE * 60
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_time_outs_at_or_after_18_00_manila() {
        assert!(is_late_timeout("2026-08-04T18:00:00+08:00"));
        assert!(is_late_timeout("2026-08-04T18:05:00+08:00"));
        assert!(is_late_timeout("2026-08-04T23:59:00+08:00"));
    }

    #[test]
    fn keeps_time_outs_before_18_00_manila_normal() {
        assert!(!is_late_timeout("2026-08-04T17:00:00+08:00"));
        assert!(!is_late_timeout("2026-08-04T17:01:00+08:00"));
        assert!(!is_late_timeout("2026-08-04T17:05:00+08:00"));
        assert!(!is_late_timeout("2026-08-04T17:59:00+08:00"));
        assert!(!is_late_timeout("2026-08-04T16:59:00+08:00"));
        assert!(!is_late_timeout("2026-08-04T12:00:00+08:00"));
        assert!(!is_late_timeout("2026-08-04T07:30:00+08:00"));
    }

    #[test]
    fn compares_in_manila_time_regardless_of_offset() {
        // 18:05 Manila == 10:05 UTC on the same day (late timeout).
        assert!(is_late_timeout("2026-08-04T10:05:00Z"));
        // 18:00 Manila == 10:00 UTC on the same day (late timeout).
        assert!(is_late_timeout("2026-08-04T10:00:00Z"));
        // 17:59 Manila == 09:59 UTC (normal).
        assert!(!is_late_timeout("2026-08-04T09:59:00Z"));
        // 17:05 Manila == 09:05 UTC (normal).
        assert!(!is_late_timeout("2026-08-04T09:05:00Z"));
        // 17:00 Manila == 09:00 UTC on the same day (normal).
        assert!(!is_late_timeout("2026-08-04T09:00:00Z"));
        // 16:59 Manila == 08:59 UTC (normal).
        assert!(!is_late_timeout("2026-08-04T08:59:00Z"));
        // 16:00 Manila == 08:00 UTC (normal).
        assert!(!is_late_timeout("2026-08-04T08:00:00Z"));
    }

    #[test]
    fn never_treats_an_unparseable_timestamp_as_late() {
        assert!(!is_late_timeout("not-a-timestamp"));
        assert!(!is_late_timeout(""));
    }

    #[test]
    fn flags_time_outs_strictly_before_17_00_manila_as_before_five_pm() {
        assert!(is_before_five_pm("2026-08-04T16:59:59+08:00"));
        assert!(is_before_five_pm("2026-08-04T16:30:00+08:00"));
        assert!(is_before_five_pm("2026-08-04T12:00:00+08:00"));
        assert!(is_before_five_pm("2026-08-04T08:00:00+08:00"));
    }

    #[test]
    fn keeps_time_outs_at_or_after_17_00_manila_not_before_five_pm() {
        assert!(!is_before_five_pm("2026-08-04T17:00:00+08:00"));
        assert!(!is_before_five_pm("2026-08-04T17:05:00+08:00"));
        assert!(!is_before_five_pm("2026-08-04T18:00:00+08:00"));
    }

    #[test]
    fn compares_before_five_pm_in_manila_time_regardless_of_offset() {
        // 16:59 Manila == 08:59 UTC (before 5 PM).
        assert!(is_before_five_pm("2026-08-04T08:59:00Z"));
        // 17:00 Manila == 09:00 UTC (not before 5 PM).
        assert!(!is_before_five_pm("2026-08-04T09:00:00Z"));
    }

    #[test]
    fn never_treats_an_unparseable_timestamp_as_before_five_pm() {
        assert!(!is_before_five_pm("not-a-timestamp"));
        assert!(!is_before_five_pm(""));
    }
}
