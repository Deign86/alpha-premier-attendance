use chrono::{DateTime, Datelike, Duration, TimeZone};
use chrono_tz::{Asia::Manila, Tz};

/// Fixed unpaid lunch break applied to every paid-hours calculation.
///
/// Work performed between 12:00 and 13:00 Manila time is never counted as
/// payable time — for employees and interns alike. The window is centralized
/// here so every consumer (daily payroll, worked-hours reports, overtime
/// inputs) stays consistent and the rule can be audited or changed in one
/// place.
pub const LUNCH_START_HOUR: u32 = 12;
pub const LUNCH_END_HOUR: u32 = 13;

/// Seconds of the lunch break that fall inside the `[start, end]` interval.
///
/// Only the overlapping portion is subtracted, which handles:
/// - shifts spanning the whole window (09:00–17:00 → 3600 s excluded),
/// - clock-in before / clock-out after the window,
/// - clock-in or clock-out inside the window (partial overlap),
/// - overnight or multi-day spans (every touched day's window is checked).
pub fn lunch_excluded_seconds(start: DateTime<Tz>, end: DateTime<Tz>) -> i64 {
    let mut excluded = 0_i64;
    let mut day = start.date_naive();
    let last_day = end.date_naive();
    while day <= last_day {
        let lunch_start = Manila
            .with_ymd_and_hms(
                day.year(),
                day.month(),
                day.day(),
                LUNCH_START_HOUR,
                0,
                0,
            )
            .single()
            .expect("12:00 is always a valid Manila time");
        let lunch_end = lunch_start + Duration::hours(1);
        let overlap_start = start.max(lunch_start);
        let overlap_end = end.min(lunch_end);
        if overlap_end > overlap_start {
            excluded += (overlap_end - overlap_start).num_seconds();
        }
        day += Duration::days(1);
    }
    excluded
}

/// Paid seconds between two timestamps, excluding the lunch window.
pub fn paid_work_seconds(start: DateTime<Tz>, end: DateTime<Tz>) -> i64 {
    let elapsed = (end - start).num_seconds().max(0);
    (elapsed - lunch_excluded_seconds(start, end)).max(0)
}

/// Paid work hours (fractional, e.g. 7.5) between two timestamps, excluding lunch.
pub fn paid_work_hours(start: DateTime<Tz>, end: DateTime<Tz>) -> f64 {
    paid_work_seconds(start, end) as f64 / 3600.0
}

/// Paid work hours rounded up to the next whole hour, excluding lunch.
///
/// Mirrors the existing payroll convention of ceiling fractional hours
/// (see `payroll::ceiling_hours`) so a 07:30–16:30 shift (8.0 paid hours
/// after the lunch cut) still reports 8 hours, never 9.
pub fn paid_work_hours_ceiled(start: DateTime<Tz>, end: DateTime<Tz>) -> i64 {
    super::payroll::ceiling_hours(paid_work_seconds(start, end))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono_tz::Asia::Manila;

    fn at(hour: u32, minute: u32, day: u32) -> DateTime<Tz> {
        Manila
            .with_ymd_and_hms(2026, 8, day, hour, minute, 0)
            .single()
            .expect("valid test time")
    }

    #[test]
    fn full_window_shift_excludes_one_hour() {
        // 09:00–17:00: 8 clocked hours, 1 excluded → 7 paid.
        assert_eq!(lunch_excluded_seconds(at(9, 0, 1), at(17, 0, 1)), 3600);
        assert_eq!(paid_work_seconds(at(9, 0, 1), at(17, 0, 1)), 7 * 3600);
        assert_eq!(paid_work_hours_ceiled(at(9, 0, 1), at(17, 0, 1)), 7);
    }

    #[test]
    fn shift_entirely_before_lunch_excludes_nothing() {
        assert_eq!(lunch_excluded_seconds(at(6, 0, 1), at(11, 0, 1)), 0);
        assert_eq!(paid_work_seconds(at(6, 0, 1), at(11, 0, 1)), 5 * 3600);
    }

    #[test]
    fn shift_entirely_after_lunch_excludes_nothing() {
        assert_eq!(lunch_excluded_seconds(at(13, 0, 1), at(18, 0, 1)), 0);
        assert_eq!(paid_work_seconds(at(13, 0, 1), at(18, 0, 1)), 5 * 3600);
    }

    #[test]
    fn clock_in_before_and_out_inside_lunch_window() {
        // 11:30–12:30: only 11:30–12:00 is paid (30 min).
        assert_eq!(lunch_excluded_seconds(at(11, 30, 1), at(12, 30, 1)), 1800);
        assert_eq!(paid_work_seconds(at(11, 30, 1), at(12, 30, 1)), 1800);
    }

    #[test]
    fn clock_in_inside_and_out_after_lunch_window() {
        // 12:30–14:00: only 13:00–14:00 is paid (60 min).
        assert_eq!(lunch_excluded_seconds(at(12, 30, 1), at(14, 0, 1)), 1800);
        assert_eq!(paid_work_seconds(at(12, 30, 1), at(14, 0, 1)), 3600);
    }

    #[test]
    fn both_inside_lunch_window_counts_only_the_non_lunch_edge() {
        // 12:10–12:50 is entirely inside the break → nothing paid.
        assert_eq!(paid_work_seconds(at(12, 10, 1), at(12, 50, 1)), 0);
        // 12:10–13:10: 12:10–13:00 excluded, 13:00–13:10 paid.
        assert_eq!(paid_work_seconds(at(12, 10, 1), at(13, 10, 1)), 600);
    }

    #[test]
    fn partial_hours_around_lunch_sum_only_the_working_edges() {
        // 11:45–13:15 → 15 min before + 15 min after = 30 min paid.
        assert_eq!(paid_work_seconds(at(11, 45, 1), at(13, 15, 1)), 1800);
    }

    #[test]
    fn overnight_span_excludes_each_days_lunch_window() {
        // 22:00 → next day 14:00 crosses the 12:00–13:00 window on day 2.
        let start = Manila
            .with_ymd_and_hms(2026, 8, 1, 22, 0, 0)
            .single()
            .unwrap();
        let end = Manila
            .with_ymd_and_hms(2026, 8, 2, 14, 0, 0)
            .single()
            .unwrap();
        assert_eq!(lunch_excluded_seconds(start, end), 3600);
        assert_eq!(paid_work_seconds(start, end), 15 * 3600);
    }

    #[test]
    fn inverted_or_zero_intervals_pay_nothing() {
        assert_eq!(paid_work_seconds(at(17, 0, 1), at(9, 0, 1)), 0);
        assert_eq!(paid_work_seconds(at(9, 0, 1), at(9, 0, 1)), 0);
    }
}
