use super::payroll::{cap_late_timeout_out, ceil_hour, early_half_day_noon_out, floor_hours, is_half_day};
use chrono::{DateTime, Datelike, TimeZone, Timelike};
use chrono_tz::Asia::Manila;

#[derive(Debug, Clone, PartialEq)]
pub struct EmployeePayrollResult {
    pub computed_time_in: String,
    pub computed_time_out: String,
    pub late_hours: i64,
    pub late_deduction_centavos: i64,
    pub is_half_day: bool,
    pub half_day_deduction_centavos: i64,
    pub base_pay_centavos: i64,
    pub daily_pay_centavos: i64,
    pub worked_hours: i64,
}

pub fn calculate(
    actual_time_in: &str,
    actual_time_out: &str,
    daily_rate_centavos: i64,
) -> Result<EmployeePayrollResult, String> {
    if daily_rate_centavos <= 0 {
        return Err("Employee daily rate must be greater than zero".into());
    }
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
    // BUG-PAY-03: reject inverted time logs instead of silently flooring
    // worked hours to zero and masking corrupted data.
    if time_out < time_in {
        return Err("time_out cannot be earlier than time_in".into());
    }
    // TODO: Employee late rules TBD by client
    let computed_in = ceil_hour(time_in);
    let computed_out = Manila
        .with_ymd_and_hms(
            time_out.year(),
            time_out.month(),
            time_out.day(),
            time_out.hour(),
            0,
            0,
        )
        .single()
        .unwrap();
    let hourly_rate_centavos = daily_rate_centavos / 8;
    let start = Manila
        .with_ymd_and_hms(time_in.year(), time_in.month(), time_in.day(), 8, 0, 0)
        .single()
        .ok_or("Invalid Manila start time")?;
    let payable_in = time_in.max(start);
    let paid_seconds = crate::services::lunch_break::paid_work_seconds(payable_in, time_out);
    let worked_hours = floor_hours(paid_seconds).min(8);
    let is_half_day = is_half_day(worked_hours, time_out, time_in);
    // DTR DECOUPLING: `computed_time_out` is a PAYROLL-ONLY effective window.
    // A morning half-day closed before office close pays as 08:00-12:00 even
    // though the DTR row keeps the actual stamps. Never push computed values
    // back into the DTR sheet writer (build_dtr_row).
    // Employee else-branch floors to the hour (`computed_out`) when the shared
    // rule does not apply; the intern else-branch keeps the raw capped stamp.
    let effective_out =
        early_half_day_noon_out(is_half_day, time_in, time_out).unwrap_or(computed_out);
    let unrendered_hours = (8 - worked_hours).max(0);
    let deduction = unrendered_hours * hourly_rate_centavos;
    let daily_pay_centavos = worked_hours * hourly_rate_centavos;
    Ok(EmployeePayrollResult {
        computed_time_in: computed_in.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        computed_time_out: effective_out.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        late_hours: 0,
        late_deduction_centavos: 0,
        is_half_day,
        half_day_deduction_centavos: deduction,
        base_pay_centavos: daily_rate_centavos,
        daily_pay_centavos,
        worked_hours,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn calculate_reports_hours_worked_from_dtr() {
        let result = calculate(
            "2026-08-01T09:00:00+08:00",
            "2026-08-01T17:00:00+08:00",
            100_000,
        )
        .unwrap();
        assert_eq!(result.worked_hours, 8);
        assert_eq!(result.daily_pay_centavos, 100_000);
        assert_eq!(result.half_day_deduction_centavos, 0);
        assert!(!result.is_half_day);
    }
    #[test]
    fn exact_example_employee_eight_to_three_pays_six_hours() {
        // Employee at ₱800/day (80,000 centavos): 8:00 AM to 3:00 PM (7h elapsed - 1h lunch = 6 hours) -> 60,000 centavos (₱600).
        let result = calculate(
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T15:00:00+08:00",
            80_000,
        )
        .unwrap();
        assert_eq!(result.worked_hours, 6);
        assert_eq!(result.daily_pay_centavos, 60_000);
        assert_eq!(result.half_day_deduction_centavos, 20_000);
        assert_eq!(result.base_pay_centavos, 80_000);
    }
    #[test]
    fn four_pm_clock_out_pays_seven_hours() {
        // 8:00 AM to 4:00 PM (8h elapsed - 1h lunch = 7 hours worked) -> pay = 70,000 centavos = ₱700 (₱100 deduction).
        let result = calculate(
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T16:00:00+08:00",
            80_000,
        )
        .unwrap();
        assert_eq!(result.worked_hours, 7);
        assert_eq!(result.daily_pay_centavos, 70_000);
        assert_eq!(result.half_day_deduction_centavos, 10_000);
        assert_eq!(result.base_pay_centavos, 80_000);
    }
    #[test]
    fn full_eight_hour_day_pays_full_daily_rate() {
        // Office hours: 8:00 AM to 5:00 PM (9h elapsed - 1h lunch = 8 hours worked) -> full daily rate (80,000 centavos = ₱800, ₱0 deduction).
        let result = calculate(
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T17:00:00+08:00",
            80_000,
        )
        .unwrap();
        assert_eq!(result.worked_hours, 8);
        assert_eq!(result.daily_pay_centavos, 80_000);
        assert_eq!(result.half_day_deduction_centavos, 0);
        assert_eq!(result.base_pay_centavos, 80_000);
    }
    #[test]
    fn calculate_half_day_deducts_half_daily_rate() {
        let result = calculate(
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T12:00:00+08:00",
            100_000,
        )
        .unwrap();
        assert_eq!(result.worked_hours, 4);
        assert!(result.is_half_day);
        assert_eq!(result.half_day_deduction_centavos, 50_000);
        assert_eq!(result.daily_pay_centavos, 50_000);
    }

    #[test]
    fn calculate_early_clock_out_before_5pm_is_undertime_not_half_day() {
        // 08:00 to 15:00: 7 worked hours, 1 hour unrendered deducted (12,500 centavos, not half-day).
        let result = calculate(
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T15:00:00+08:00",
            100_000,
        )
        .unwrap();
        assert_eq!(result.worked_hours, 7);
        assert!(!result.is_half_day);
        assert_eq!(result.half_day_deduction_centavos, 12_500);
        assert_eq!(result.daily_pay_centavos, 87_500);
    }

    #[test]
    fn close_boundary_is_minute_precise() {
        // Under new policy, timing out before 17:00 does not force half-day; 16:59:59 ceils to 8 worked hours (full day).
        let just_before = calculate(
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T16:59:59+08:00",
            100_000,
        )
        .unwrap();
        assert!(!just_before.is_half_day);
        assert_eq!(just_before.daily_pay_centavos, 100_000);
        for time_out in [
            "2026-08-01T17:00:00+08:00",
            "2026-08-01T17:00:01+08:00",
        ] {
            let result = calculate("2026-08-01T08:00:00+08:00", time_out, 100_000).unwrap();
            assert!(!result.is_half_day);
            assert_eq!(result.daily_pay_centavos, 100_000);
        }
    }

    #[test]
    fn sub_second_arrival_still_counts_exact_hour() {
        // P5 (TS parity): 08:00:00.500 truncates to the hour, not up to 09:00.
        let result = calculate(
            "2026-08-01T08:00:00.500+08:00",
            "2026-08-01T17:00:00+08:00",
            100_000,
        )
        .unwrap();
        assert_eq!(result.computed_time_in, "2026-08-01T08:00:00+08:00");
    }

    #[test]
    fn afternoon_arrival_at_noon_is_half_day_even_with_overtime() {
        let noon = calculate(
            "2026-08-01T12:00:00+08:00",
            "2026-08-01T17:00:00+08:00",
            100_000,
        )
        .unwrap();
        assert!(noon.is_half_day);
        assert_eq!(noon.worked_hours, 4);
        assert_eq!(noon.half_day_deduction_centavos, 50_000);
        assert_eq!(noon.daily_pay_centavos, 50_000);
        let overtime = calculate(
            "2026-08-01T12:00:00+08:00",
            "2026-08-01T18:00:00+08:00",
            100_000,
        )
        .unwrap();
        assert!(overtime.is_half_day);
        let before = calculate(
            "2026-08-01T11:00:00+08:00",
            "2026-08-01T17:00:00+08:00",
            100_000,
        )
        .unwrap();
        assert!(!before.is_half_day);
        assert_eq!(before.worked_hours, 5);
    }

    #[test]
    fn early_half_day_uses_effective_noon_window_for_pay() {
        // DTR/PAYROLL DECOUPLING: morning half-day (<=4h, e.g. 08:00-11:30)
        // pays as an effective 08:00-12:00 window (pay math only).
        let half = calculate(
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T11:30:00+08:00",
            100_000,
        )
        .unwrap();
        assert!(half.is_half_day);
        assert_eq!(half.daily_pay_centavos, 37_500);
        assert!(half.computed_time_out.contains("T12:00:00+08:00"));
        // Full day keeps the floored actual time-out.
        let full = calculate(
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T17:00:00+08:00",
            100_000,
        )
        .unwrap();
        assert!(!full.is_half_day);
        assert!(full.computed_time_out.contains("T17:00:00+08:00"));
    }

    #[test]
    fn morning_half_day_at_twelve_thirty_pays_strictly_by_the_hour() {
        // 08:00-12:00 (4h) and 08:00-12:30 (4.5h) both pay 4 hours (50,000 centavos on 100k daily rate).
        let at_noon = calculate(
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T12:00:00+08:00",
            100_000,
        )
        .unwrap();
        assert_eq!(at_noon.worked_hours, 4);
        assert_eq!(at_noon.daily_pay_centavos, 50_000);
        assert!(at_noon.is_half_day);

        let at_twelve_thirty = calculate(
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T12:30:00+08:00",
            100_000,
        )
        .unwrap();
        assert_eq!(at_twelve_thirty.worked_hours, 4);
        assert_eq!(at_twelve_thirty.daily_pay_centavos, 50_000);
        assert!(at_twelve_thirty.is_half_day);
        assert_eq!(at_twelve_thirty.half_day_deduction_centavos, 50_000);
    }

    #[test]
    fn late_timeout_caps_to_five_pm_for_pay() {
        // Overtime forbidden: 08:00-19:30 pays the full daily rate at 17:00.
        let capped = calculate(
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T19:30:00+08:00",
            100_000,
        )
        .unwrap();
        assert!(!capped.is_half_day);
        assert_eq!(capped.daily_pay_centavos, 100_000);
        assert!(capped.computed_time_out.contains("T17:00:00+08:00"));
        // Boundary: 18:00:00 caps, 17:59:59 stays actual.
        let at_six = calculate(
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T18:00:00+08:00",
            100_000,
        )
        .unwrap();
        assert!(at_six.computed_time_out.contains("T17:00:00+08:00"));
    }

    #[test]
    fn inverted_time_logs_return_validation_error() {
        // BUG-PAY-03: time_out before time_in must surface as an error.
        let result = calculate(
            "2026-08-01T02:00:00+08:00",
            "2026-08-01T01:00:00+08:00",
            100_000,
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
            "2026-08-01T19:00:00+08:00",
            "2026-08-01T19:30:00+08:00",
            100_000,
        );
        assert!(matches!(
            result,
            Err(message) if message.contains("time_out cannot be earlier than time_in")
        ));
    }

    #[test]
    fn morning_half_day_closing_before_office_close_pays_as_noon() {
        // A morning half-day (<=4h) closed before 17:00 has payroll-only effective window at 12:00.
        let result = calculate(
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T11:30:00+08:00",
            100_000,
        )
        .unwrap();
        assert!(result.is_half_day);
        assert_eq!(result.computed_time_out, "2026-08-01T12:00:00+08:00");
    }

    #[test]
    fn afternoon_arrival_does_not_get_noon_substitution() {
        let result = calculate(
            "2026-08-01T12:00:00+08:00",
            "2026-08-01T15:00:00+08:00",
            100_000,
        )
        .unwrap();
        assert!(result.is_half_day);
        assert_eq!(result.computed_time_out, "2026-08-01T15:00:00+08:00");
    }

    #[test]
    fn clock_out_exactly_at_office_close_does_not_get_noon_substitution() {
        let result = calculate(
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T17:00:00+08:00",
            100_000,
        )
        .unwrap();
        assert!(!result.is_half_day);
        assert_eq!(result.computed_time_out, "2026-08-01T17:00:00+08:00");
    }

    #[test]
    fn post_six_cap_is_applied_before_the_noon_rule() {
        // 19:30 caps to 17:00 first, so the noon rule sees 17:00 (not early).
        let result = calculate(
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T19:30:00+08:00",
            100_000,
        )
        .unwrap();
        assert!(!result.is_half_day);
        assert_eq!(result.computed_time_out, "2026-08-01T17:00:00+08:00");
    }

    #[test]
    fn employee_else_branch_floors_to_the_hour() {
        // Intentional employee/intern difference: when the noon rule does not
        // apply the employee engine floors to the whole hour, so 17:30 pays as
        // 17:00 (the intern engine keeps the raw 17:30 stamp).
        let result = calculate(
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T17:30:00+08:00",
            100_000,
        )
        .unwrap();
        assert!(!result.is_half_day);
        assert_eq!(result.computed_time_out, "2026-08-01T17:00:00+08:00");
    }
}
