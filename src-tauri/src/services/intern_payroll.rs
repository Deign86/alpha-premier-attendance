use super::payroll::{cap_late_timeout_out, early_half_day_noon_out, floor_zero, is_half_day, round_hours};
use chrono::{DateTime, Datelike, NaiveDate, TimeZone};
use chrono_tz::Asia::Manila;

/// Intern payroll policy shared with the admin payroll commands and the
/// printable payroll worksheet: a fixed PHP 80.00 daily rate. Late-hour and
/// recorded-hour shortfalls are separate deductions per the QA policy.
pub const INTERN_DAILY_RATE_PHP: i64 = 80;
/// Payroll profile id stored on intern cutoff records (not a payroll_profiles row).
pub const INTERN_PAYROLL_PROFILE_ID: &str = "INTERN_STANDARD";

#[derive(Debug, Clone, PartialEq)]
pub struct InternPayrollResult {
    pub computed_time_in: String,
    pub computed_time_out: String,
    pub late_hours: i64,
    pub late_deduction_centavos: i64,
    pub is_half_day: bool,
    pub half_day_deduction_centavos: i64,
    pub grace_used: bool,
    pub base_pay_centavos: i64,
    pub daily_pay_centavos: i64,
    pub worked_hours: i64,
}

pub fn calculate(
    attendance_date: &str,
    actual_time_in: &str,
    actual_time_out: &str,
    grace_available: bool,
) -> Result<InternPayrollResult, String> {
    let date = NaiveDate::parse_from_str(attendance_date, "%Y-%m-%d")
        .map_err(|_| "attendanceDate must be a valid Manila date")?;
    let time_in = DateTime::parse_from_rfc3339(actual_time_in)
        .map_err(|_| "Payroll timestamps must be valid ISO values")?
        .with_timezone(&Manila);
    let time_out = DateTime::parse_from_rfc3339(actual_time_out)
        .map_err(|_| "Payroll timestamps must be valid ISO values")?
        .with_timezone(&Manila);
    // Late time-out auto-cap (overtime forbidden): 18:00+ pays as 17:00.
    // Applied BEFORE the inverted-log check (TS parity): a post-close
    // arrival (e.g. in 19:00 / out 19:30) caps out to 17:00 first, then
    // fails the inverted check exactly like the TS engine.
    let time_out = cap_late_timeout_out(time_out);
    // P4: reject inverted time logs instead of silently flooring worked
    // hours to zero (BUG-PAY-03 parity with the employee engine).
    if time_out < time_in {
        return Err("time_out cannot be earlier than time_in".into());
    }
    let start = Manila
        .with_ymd_and_hms(date.year(), date.month(), date.day(), 8, 0, 0)
        .single()
        .ok_or("Invalid Manila start time")?;
    let late_seconds = time_in.signed_duration_since(start).num_seconds();
    let raw_late_hours = if late_seconds > 0 {
        (late_seconds + 3599) / 3600
    } else {
        0
    };
    let in_grace_window = late_seconds > 0 && late_seconds <= 15 * 60;
    let grace_used = grace_available && in_grace_window;
    let late_hours = if grace_used {
        0
    } else if raw_late_hours > 0 {
        1
    } else {
        0
    };
    let late_clamp = Manila
        .with_ymd_and_hms(date.year(), date.month(), date.day(), 9, 0, 0)
        .single()
        .ok_or("Invalid Manila late clamp time")?;
    // Every ungraced late arrival is capped to 09:00 for payroll, even when
    // the recorded time-in is later than 09:00.
    let computed_in = if grace_used || raw_late_hours == 0 || time_in > late_clamp {
        time_in
    } else {
        late_clamp
    };
    let base = INTERN_DAILY_RATE_PHP * 100;
    let hourly_rate_centavos = (INTERN_DAILY_RATE_PHP * 100) / 8;
    let late_deduction = late_hours * hourly_rate_centavos;
    let payable_in = if grace_used {
        start
    } else if raw_late_hours > 0 {
        late_clamp
    } else {
        time_in.max(start)
    };
    let paid_seconds = crate::services::lunch_break::paid_work_seconds(payable_in, time_out);
    let worked_hours = round_hours(paid_seconds).min(8);
    let is_half_day = is_half_day(worked_hours, time_out, time_in);
    let unrendered_hours = (8 - worked_hours).max(0);
    // payable_in already excludes late hours; only the remaining shortfall is undertime.
    let deduction = (unrendered_hours - late_hours).max(0) * hourly_rate_centavos;
    let daily_pay = base - late_deduction - deduction;
    // DTR DECOUPLING: `computed_time_out` is a PAYROLL-ONLY effective window.
    // A morning half-day closed before office close pays as 08:00-12:00 even
    // though the DTR row keeps the actual stamps. Never push computed values
    // back into the DTR sheet writer (build_dtr_row).
    // Intern else-branch keeps the raw capped stamp (not hour-floored), unlike
    // the employee engine — intentional difference locked in by tests.
    let effective_out = early_half_day_noon_out(is_half_day, time_in, time_out).unwrap_or(time_out);
    Ok(InternPayrollResult {
        computed_time_in: computed_in.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        computed_time_out: effective_out.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        late_hours,
        late_deduction_centavos: late_deduction,
        is_half_day,
        half_day_deduction_centavos: deduction,
        grace_used,
        base_pay_centavos: base,
        daily_pay_centavos: floor_zero(daily_pay),
        worked_hours,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn worked_hours_are_gross_elapsed_and_keep_fixed_daily_pay() {
        // 08:00–17:00 → 8 paid hours (9h elapsed minus 1h lunch 12:00–13:00).
        let result = calculate(
            "2026-08-01",
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T17:00:00+08:00",
            true,
        )
        .unwrap();
        assert_eq!(result.worked_hours, 8);
        // The fixed PHP 80.00/day intern base rate is independent of hours worked.
        assert_eq!(result.base_pay_centavos, 8000);
        assert_eq!(result.daily_pay_centavos, 8000);
    }
    #[test]
    fn late_arrival_is_capped_to_one_hour_before_pay_math() {
        // Any post-grace late arrival is clamped to 09:00 and deducted once.
        let result = calculate(
            "2026-08-01",
            "2026-08-01T09:30:00+08:00",
            "2026-08-01T17:00:00+08:00",
            false,
        )
        .unwrap();
        assert_eq!(result.late_hours, 1);
        assert_eq!(result.late_deduction_centavos, 1000);
        assert!(result.computed_time_in.contains("T09:30:00+08:00"));
        assert_eq!(result.worked_hours, 7);
        assert_eq!(result.half_day_deduction_centavos, 0);
        assert_eq!(result.daily_pay_centavos, 7000);
    }
    #[test]
    fn grace_period_applies_within_08_00_to_08_15() {
        // 08:12 is in 8:00 - 8:15 grace period
        let result = calculate(
            "2026-08-01",
            "2026-08-01T08:12:00+08:00",
            "2026-08-01T17:00:00+08:00",
            true,
        )
        .unwrap();
        assert!(result.grace_used);
        assert_eq!(result.late_hours, 0);
        assert_eq!(result.late_deduction_centavos, 0);
        assert_eq!(result.daily_pay_centavos, 8000);
    }

    #[test]
    fn only_first_08_05_arrival_in_a_week_uses_grace() {
        let mut grace_count = 0;

        for (index, date) in ["2026-08-03", "2026-08-04", "2026-08-05"].iter().enumerate() {
            let result = calculate(
                date,
                &format!("{date}T08:05:00+08:00"),
                &format!("{date}T17:00:00+08:00"),
                index == 0,
            )
            .unwrap();

            if result.grace_used {
                grace_count += 1;
                assert_eq!(result.late_hours, 0);
            } else {
                assert_eq!(result.late_hours, 1);
                assert_eq!(result.late_deduction_centavos, 1_000);
                assert_eq!(result.half_day_deduction_centavos, 0);
            }
        }

        assert_eq!(grace_count, 1);
    }

    #[test]
    fn late_attendance_with_one_additional_short_hour_totals_php_20() {
        for date in ["2026-09-24", "2026-09-22"] {
            let result = calculate(
                date,
                &format!("{date}T08:30:00+08:00"),
                &format!("{date}T16:00:00+08:00"),
                false,
            )
            .unwrap();
            assert_eq!(result.late_deduction_centavos, 1_000);
            assert_eq!(result.half_day_deduction_centavos, 1_000);
            assert_eq!(result.late_deduction_centavos + result.half_day_deduction_centavos, 2_000);
        }
    }

    #[test]
    fn maricon_second_weekly_grace_is_late() {
        for (index, date) in ["2026-09-24", "2026-09-25"].iter().enumerate() {
            let result = calculate(
                date,
                &format!("{date}T08:10:00+08:00"),
                &format!("{date}T17:00:00+08:00"),
                index == 0,
            )
            .unwrap();
            assert_eq!(result.grace_used, index == 0);
            assert_eq!(result.late_hours, if index == 0 { 0 } else { 1 });
            assert_eq!(result.late_deduction_centavos, if index == 0 { 0 } else { 1_000 });
            assert_eq!(result.half_day_deduction_centavos, 0);
            assert_eq!(result.daily_pay_centavos, if index == 0 { 8_000 } else { 7_000 });
        }
    }

    #[test]
    fn arrivals_after_0815_do_not_consume_grace() {
        let result = calculate(
            "2026-08-01",
            "2026-08-01T08:16:00+08:00",
            "2026-08-01T17:00:00+08:00",
            true,
        )
        .unwrap();
        assert!(!result.grace_used);
        assert_eq!(result.late_hours, 1);
        assert_eq!(result.late_deduction_centavos, 1000);
        assert_eq!(result.computed_time_in, "2026-08-01T09:00:00+08:00");
        assert_eq!(result.worked_hours, 7);
        assert_eq!(result.daily_pay_centavos, 7000);
    }

    #[test]
    fn grace_window_edges_and_late_display_boundary_match_policy() {
        for (time_in, grace_available, expected_grace) in [
            ("08:00:00", true, false),
            ("08:00:01", true, true),
            ("08:15:00", true, true),
            ("08:15:01", true, false),
            ("08:30:00", true, false),
            ("09:30:00", true, false),
        ] {
            let result = calculate(
                "2026-08-03",
                &format!("2026-08-03T{time_in}+08:00"),
                "2026-08-03T17:00:00+08:00",
                grace_available,
            )
            .unwrap();
            assert_eq!(result.grace_used, expected_grace, "{time_in}");
            assert_eq!(result.late_hours, i64::from(!expected_grace && time_in != "08:00:00"));
            assert_eq!(result.daily_pay_centavos, if expected_grace || time_in == "08:00:00" { 8_000 } else { 7_000 });
            if time_in > "08:15:00" && time_in <= "09:00:00" {
                assert!(result.computed_time_in.ends_with("T09:00:00+08:00"), "{time_in}");
            } else if time_in > "09:00:00" {
                assert!(result.computed_time_in.ends_with(&format!("T{time_in}+08:00")), "{time_in}");
            }
        }
    }

    #[test]
    fn weekly_grace_exhausted_08_08_rounds_to_09_and_charges_once() {
        let result = calculate(
            "2026-09-22",
            "2026-09-22T08:08:00+08:00",
            "2026-09-22T17:00:00+08:00",
            false,
        )
        .unwrap();
        assert!(result.computed_time_in.contains("T09:00:00+08:00"));
        assert_eq!(result.late_hours, 1);
        assert_eq!(result.late_deduction_centavos, 1_000);
        assert_eq!(result.half_day_deduction_centavos, 0);
        assert_eq!(result.daily_pay_centavos, 7_000);
    }

    #[test]
    fn v3_grace_and_post_grace_cases_match_ts_parity() {
        let cases = [
            ("2026-09-07", "08:08:00", true, 8_000, "08:08:00", true),
            ("2026-09-08", "08:08:00", false, 7_000, "09:00:00", false),
            ("2026-09-09", "08:16:00", true, 7_000, "09:00:00", false),
            ("2026-09-10", "09:30:00", true, 7_000, "09:30:00", false),
            ("2026-09-11", "09:30:00", false, 7_000, "09:30:00", false),
            ("2026-09-14", "08:08:00", true, 8_000, "08:08:00", true),
        ];
        for (date, time_in, grace_available, pay, computed_in, expected_grace_used) in cases {
            let result = calculate(
                date,
                &format!("{date}T{time_in}+08:00"),
                &format!("{date}T17:00:00+08:00"),
                grace_available,
            )
            .unwrap();
            assert_eq!(result.daily_pay_centavos, pay, "{date} {time_in}");
            assert_eq!(result.grace_used, expected_grace_used, "{date} {time_in}");
            assert!(result.computed_time_in.contains(computed_in), "{date}: {}", result.computed_time_in);
            assert_eq!(result.late_hours, i64::from(pay == 7_000), "{date} {time_in}");
        }
    }

    #[test]
    fn exact_example_intern_eight_to_three_pays_six_hours() {
        // ₱80/day intern: 8:00 AM to 3:00 PM (7h elapsed - 1h lunch = 6 hours worked) -> pay = 6 * ₱10 = ₱60 (6000 centavos, ₱20 deduction).
        let result = calculate(
            "2026-08-01",
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T15:00:00+08:00",
            false,
        )
        .unwrap();
        assert_eq!(result.worked_hours, 6);
        assert_eq!(result.daily_pay_centavos, 6000);
        assert_eq!(result.half_day_deduction_centavos, 2000);
        assert_eq!(result.base_pay_centavos, 8000);
    }
    #[test]
    fn four_pm_clock_out_pays_seven_hours() {
        // 8:00 AM to 4:00 PM (8h elapsed - 1h lunch = 7 hours worked) -> pay = 7 * ₱10 = ₱70 (7000 centavos, ₱10 deduction).
        let result = calculate(
            "2026-08-01",
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T16:00:00+08:00",
            true,
        )
        .unwrap();
        assert_eq!(result.worked_hours, 7);
        assert_eq!(result.daily_pay_centavos, 7000);
        assert_eq!(result.half_day_deduction_centavos, 1000);
        assert_eq!(result.base_pay_centavos, 8000);
    }
    #[test]
    fn full_eight_hour_day_pays_full_daily_rate() {
        // Office hours: 8:00 AM to 5:00 PM (9h elapsed - 1h lunch = 8 hours worked) -> full daily rate (8000 centavos = ₱80, ₱0 deduction).
        let result = calculate(
            "2026-08-01",
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T17:00:00+08:00",
            true,
        )
        .unwrap();
        assert_eq!(result.worked_hours, 8);
        assert_eq!(result.daily_pay_centavos, 8000);
        assert_eq!(result.half_day_deduction_centavos, 0);
        assert_eq!(result.base_pay_centavos, 8000);
    }
    #[test]
    fn subsequent_late_arrival_is_clamped_to_one_hour_late() {
        // A subsequent 10:30 arrival is capped to 09:00 for payroll math.
        let result = calculate(
            "2026-08-10",
            "2026-08-10T10:30:00+08:00",
            "2026-08-10T17:00:00+08:00",
            false,
        )
        .unwrap();
        assert_eq!(result.late_hours, 1);
        assert_eq!(result.late_deduction_centavos, 1000);
        assert_eq!(result.computed_time_in, "2026-08-10T10:30:00+08:00");
        assert_eq!(result.worked_hours, 7);
        assert_eq!(result.half_day_deduction_centavos, 0);
        assert_eq!(result.daily_pay_centavos, 7000);
    }

    #[test]
    fn half_day_shift_deducts_half_daily_pay() {
        // 08:00–12:00 → 4 paid hours → half day
        let result = calculate(
            "2026-08-01",
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T12:00:00+08:00",
            true,
        )
        .unwrap();
        assert_eq!(result.worked_hours, 4);
        assert!(result.is_half_day);
        assert_eq!(result.half_day_deduction_centavos, 4000);
        assert_eq!(result.daily_pay_centavos, 4000);
    }

    #[test]
    fn early_clock_out_before_5pm_is_undertime_not_half_day() {
        // 08:00–15:00 → 7 paid hours, 1 hour undertime deduction (1,000 centavos), not half-day.
        let result = calculate(
            "2026-08-01",
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T15:00:00+08:00",
            true,
        )
        .unwrap();
        assert_eq!(result.worked_hours, 6);
        assert!(!result.is_half_day);
        assert_eq!(result.half_day_deduction_centavos, 2000);
        assert_eq!(result.daily_pay_centavos, 6000);
    }

    #[test]
    fn late_timeout_caps_to_five_pm_for_pay() {
        // Overtime forbidden: 08:00-19:30 pays as a full 08:00-17:00 day.
        let capped = calculate(
            "2026-08-01",
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T19:30:00+08:00",
            true,
        )
        .unwrap();
        assert!(!capped.is_half_day);
        assert_eq!(capped.daily_pay_centavos, 8000);
        assert!(capped.computed_time_out.contains("T17:00:00+08:00"));
        // Boundary: 18:00:00 caps, 17:59:59 stays actual.
        let at_six = calculate(
            "2026-08-01",
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T18:00:00+08:00",
            true,
        )
        .unwrap();
        assert!(at_six.computed_time_out.contains("T17:00:00+08:00"));
        let before_six = calculate(
            "2026-08-01",
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T17:59:59+08:00",
            true,
        )
        .unwrap();
        assert!(!before_six.is_half_day);
    }

    #[test]
    fn inverted_time_logs_return_validation_error() {
        // P4: time_out before time_in must surface as an error, not a zero.
        let result = calculate(
            "2026-08-01",
            "2026-08-01T02:00:00+08:00",
            "2026-08-01T01:00:00+08:00",
            true,
        );
        assert!(matches!(
            result,
            Err(message) if message.contains("time_out cannot be earlier than time_in")
        ));
    }

    #[test]
    fn post_close_arrival_errors_like_ts() {
        // Cap-then-check ordering (TS parity): out 19:30 caps to 17:00
        // first, so in 19:00 / out 19:30 errors instead of paying.
        let result = calculate(
            "2026-08-01",
            "2026-08-01T19:00:00+08:00",
            "2026-08-01T19:30:00+08:00",
            true,
        );
        assert!(matches!(
            result,
            Err(message) if message.contains("time_out cannot be earlier than time_in")
        ));
    }

    #[test]
    fn close_boundary_is_minute_precise() {
        // 16:59:59 is 8h 59m 59s elapsed - 1h lunch = 7h 59m 59s -> rounds to 8 worked hours.
        let just_before = calculate(
            "2026-08-01",
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T16:59:59+08:00",
            true,
        )
        .unwrap();
        assert!(!just_before.is_half_day);
        assert_eq!(just_before.worked_hours, 8);
        assert_eq!(just_before.daily_pay_centavos, 8000);
        for time_out in [
            "2026-08-01T17:00:00+08:00",
            "2026-08-01T17:00:01+08:00",
        ] {
            let result = calculate("2026-08-01", "2026-08-01T08:00:00+08:00", time_out, true).unwrap();
            assert!(!result.is_half_day);
            assert_eq!(result.worked_hours, 8);
            assert_eq!(result.daily_pay_centavos, 8000);
        }
    }

    #[test]
    fn afternoon_late_arrival_is_clamped_before_undertime_math() {
        // Once grace is unavailable, even a noon arrival is capped at 09:00.
        let noon = calculate(
            "2026-08-01",
            "2026-08-01T12:00:00+08:00",
            "2026-08-01T17:00:00+08:00",
            false,
        )
        .unwrap();
        assert!(noon.is_half_day);
        assert_eq!(noon.computed_time_in, "2026-08-01T12:00:00+08:00");
        assert_eq!(noon.late_hours, 1);
        assert_eq!(noon.worked_hours, 7);
        assert_eq!(noon.half_day_deduction_centavos, 0);
        assert_eq!(noon.daily_pay_centavos, 7000);
    }

    #[test]
    fn early_half_day_uses_effective_noon_window_for_pay() {
        // DTR/PAYROLL DECOUPLING: morning half-day (<=4h, e.g. 08:00-11:30)
        // pays as an effective 08:00-12:00 window (pay math only).
        let half = calculate(
            "2026-08-01",
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T11:30:00+08:00",
            true,
        )
        .unwrap();
        assert!(half.is_half_day);
        assert_eq!(half.daily_pay_centavos, 4000);
        assert!(half.computed_time_out.contains("T12:00:00+08:00"));
        // Full day keeps the actual time-out.
        let full = calculate(
            "2026-08-01",
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T17:00:00+08:00",
            true,
        )
        .unwrap();
        assert!(!full.is_half_day);
        assert!(full.computed_time_out.contains("T17:00:00+08:00"));
        // Afternoon arrival keeps its actual time-out (no noon override).
        let pm = calculate(
            "2026-08-01",
            "2026-08-01T12:30:00+08:00",
            "2026-08-01T17:00:00+08:00",
            false,
        )
        .unwrap();
        assert!(pm.is_half_day);
        assert!(pm.computed_time_out.contains("T17:00:00+08:00"));
    }

    #[test]
    fn morning_half_day_at_twelve_thirty_pays_strictly_by_the_hour() {
        // 08:00-12:00 (4h) and 08:00-12:30 (4.5h) both pay 4 hours (4000 centavos / ₱40).
        let at_noon = calculate(
            "2026-08-01",
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T12:00:00+08:00",
            true,
        )
        .unwrap();
        assert_eq!(at_noon.worked_hours, 4);
        assert_eq!(at_noon.daily_pay_centavos, 4000);
        assert!(at_noon.is_half_day);

        let at_twelve_thirty = calculate(
            "2026-08-01",
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T12:30:00+08:00",
            true,
        )
        .unwrap();
        assert_eq!(at_twelve_thirty.worked_hours, 4);
        assert_eq!(at_twelve_thirty.daily_pay_centavos, 4000);
        assert!(at_twelve_thirty.is_half_day);
        assert_eq!(at_twelve_thirty.half_day_deduction_centavos, 4000);
        assert!(at_twelve_thirty.computed_time_out.contains("T12:00:00+08:00"));
    }

    #[test]
    fn morning_half_day_closing_before_office_close_pays_as_noon() {
        // A morning half-day (<=4h) closed before 17:00 has payroll-only effective window at 12:00.
        let result = calculate(
            "2026-08-01",
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T11:30:00+08:00",
            true,
        )
        .unwrap();
        assert!(result.is_half_day);
        assert_eq!(result.computed_time_out, "2026-08-01T12:00:00+08:00");
    }

    #[test]
    fn afternoon_arrival_does_not_get_noon_substitution() {
        let result = calculate(
            "2026-08-01",
            "2026-08-01T12:00:00+08:00",
            "2026-08-01T15:00:00+08:00",
            true,
        )
        .unwrap();
        assert!(result.is_half_day);
        assert_eq!(result.computed_time_out, "2026-08-01T15:00:00+08:00");
    }

    #[test]
    fn clock_out_exactly_at_office_close_does_not_get_noon_substitution() {
        let result = calculate(
            "2026-08-01",
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T17:00:00+08:00",
            true,
        )
        .unwrap();
        assert!(!result.is_half_day);
        assert_eq!(result.computed_time_out, "2026-08-01T17:00:00+08:00");
    }

    #[test]
    fn post_six_cap_is_applied_before_the_noon_rule() {
        // 19:30 caps to 17:00 first, so the noon rule sees 17:00 (not early).
        let result = calculate(
            "2026-08-01",
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T19:30:00+08:00",
            true,
        )
        .unwrap();
        assert!(!result.is_half_day);
        assert_eq!(result.computed_time_out, "2026-08-01T17:00:00+08:00");
    }

    #[test]
    fn intern_else_branch_keeps_the_raw_capped_stamp() {
        // Intentional employee/intern difference: when the noon rule does not
        // apply the intern engine keeps the raw capped stamp, so 17:30 stays
        // 17:30 (the employee engine floors it to 17:00).
        let result = calculate(
            "2026-08-01",
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T17:30:00+08:00",
            true,
        )
        .unwrap();
        assert!(!result.is_half_day);
        assert_eq!(result.computed_time_out, "2026-08-01T17:30:00+08:00");
    }
}
