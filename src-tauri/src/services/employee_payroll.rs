use super::lunch_break::paid_work_hours_ceiled;
use super::payroll::{cap_late_timeout_out, ceil_hour, is_half_day, office_close_for, HALF_DAY_LATE_ARRIVAL_HOUR};
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
    let worked_hours = paid_work_hours_ceiled(time_in, time_out);
    let is_half_day = is_half_day(worked_hours, time_out, time_in);
    // DTR DECOUPLING: `computed_time_out` is a PAYROLL-ONLY effective window.
    // A morning half-day closed before office close pays as 08:00-12:00 even
    // though the DTR row keeps the actual stamps. Never push computed values
    // back into the DTR sheet writer (build_dtr_row).
    let early_half_day_out = is_half_day
        && time_in.hour() < HALF_DAY_LATE_ARRIVAL_HOUR
        && time_out < office_close_for(time_out);
    let effective_out = if early_half_day_out {
        Manila
            .with_ymd_and_hms(time_out.year(), time_out.month(), time_out.day(), 12, 0, 0)
            .single()
            .unwrap_or(time_out)
    } else {
        computed_out
    };
    let half_day_deduction = if is_half_day {
        daily_rate_centavos / 2
    } else {
        0
    };
    Ok(EmployeePayrollResult {
        computed_time_in: computed_in.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        computed_time_out: effective_out.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        late_hours: 0,
        late_deduction_centavos: 0,
        is_half_day,
        half_day_deduction_centavos: half_day_deduction,
        base_pay_centavos: daily_rate_centavos,
        daily_pay_centavos: daily_rate_centavos - half_day_deduction,
        worked_hours,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn calculate_reports_lunch_adjusted_worked_hours() {
        let result = calculate(
            "2026-08-01T09:00:00+08:00",
            "2026-08-01T17:00:00+08:00",
            100_000,
        )
        .unwrap();
        assert_eq!(result.worked_hours, 7);
        // Daily pay remains the flat daily rate (employee late rules still TBD).
        assert_eq!(result.daily_pay_centavos, 100_000);
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
    fn calculate_early_clock_out_before_5pm_is_half_day() {
        // 08:00 to 16:00: 7 worked hours, but clocked out before 17:00 (5:00 PM).
        let result = calculate(
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T16:00:00+08:00",
            100_000,
        )
        .unwrap();
        assert_eq!(result.worked_hours, 7);
        assert!(result.is_half_day);
        assert_eq!(result.half_day_deduction_centavos, 50_000);
        assert_eq!(result.daily_pay_centavos, 50_000);
    }

    #[test]
    fn close_boundary_is_minute_precise() {
        // T6 decision A: 16:59:59 is half-day; exactly 17:00:00 and 17:00:01 are full.
        let just_before = calculate(
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T16:59:59+08:00",
            100_000,
        )
        .unwrap();
        assert!(just_before.is_half_day);
        assert_eq!(just_before.daily_pay_centavos, 50_000);
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
        assert_eq!(noon.half_day_deduction_centavos, 50_000);
        let overtime = calculate(
            "2026-08-01T12:00:00+08:00",
            "2026-08-01T18:00:00+08:00",
            100_000,
        )
        .unwrap();
        assert!(overtime.is_half_day);
        let before = calculate(
            "2026-08-01T11:59:00+08:00",
            "2026-08-01T17:00:00+08:00",
            100_000,
        )
        .unwrap();
        assert!(!before.is_half_day);
    }

    #[test]
    fn early_half_day_uses_effective_noon_window_for_pay() {
        // DTR/PAYROLL DECOUPLING: 08:00-15:00 actuals pay as an effective
        // 08:00-12:00 window (pay math only; the DTR row keeps 15:00).
        let half = calculate(
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T15:00:00+08:00",
            100_000,
        )
        .unwrap();
        assert!(half.is_half_day);
        assert_eq!(half.daily_pay_centavos, 50_000);
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
}
