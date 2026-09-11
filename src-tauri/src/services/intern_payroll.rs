use super::lunch_break::paid_work_hours_ceiled;
use super::payroll::{cap_late_timeout_out, ceil_hour, floor_zero, is_half_day, office_close_for, HALF_DAY_LATE_ARRIVAL_HOUR};
use chrono::Timelike;
use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone};
use chrono_tz::Asia::Manila;

/// Intern payroll policy shared with the admin payroll commands and the
/// printable payroll worksheet: a fixed PHP 80.00 daily rate and a PHP 10.00
/// deduction per full hour of lateness (after the weekly grace).
pub const INTERN_DAILY_RATE_PHP: i64 = 80;
pub const INTERN_LATE_DEDUCTION_PER_HOUR_PHP: i64 = 10;
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
    let grace_end = start + Duration::minutes(15);

    let late_seconds = time_in.signed_duration_since(start).num_seconds();
    let raw_late_hours = if late_seconds > 0 {
        (late_seconds + 3599) / 3600
    } else {
        0
    };
    let in_grace_window = time_in > start && time_in <= grace_end;
    let grace_used = in_grace_window && grace_available;
    let late_hours = if grace_used { 0 } else { raw_late_hours };
    let deduction = if late_hours > 0 {
        late_hours * INTERN_LATE_DEDUCTION_PER_HOUR_PHP * 100
    } else {
        0
    };
    let computed_in = if late_hours > 0 {
        ceil_hour(time_in)
    } else {
        time_in
    };
    let base = INTERN_DAILY_RATE_PHP * 100;
    let worked_hours = paid_work_hours_ceiled(time_in, time_out);
    let is_half_day = is_half_day(worked_hours, time_out, time_in);
    let half_day_deduction = if is_half_day { base / 2 } else { 0 };
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
        time_out
    };
    Ok(InternPayrollResult {
        computed_time_in: computed_in.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        computed_time_out: effective_out.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        late_hours,
        late_deduction_centavos: deduction,
        is_half_day,
        half_day_deduction_centavos: half_day_deduction,
        grace_used,
        base_pay_centavos: base,
        daily_pay_centavos: floor_zero(base - deduction - half_day_deduction),
        worked_hours,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn worked_hours_exclude_lunch_but_keep_fixed_daily_pay() {
        // 08:00–17:00 → 8 paid hours after the 12:00–13:00 lunch cut.
        let result = calculate(
            "2026-08-01",
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T17:00:00+08:00",
            true,
        )
        .unwrap();
        assert_eq!(result.worked_hours, 8);
        // The fixed PHP 80.00/day intern rule is untouched by the lunch cut.
        assert_eq!(result.base_pay_centavos, 8000);
        assert_eq!(result.daily_pay_centavos, 8000);
    }
    #[test]
    fn late_hours_are_not_affected_by_lunch() {
        // Lateness is measured against the 08:00 start, before any lunch window.
        let result = calculate(
            "2026-08-01",
            "2026-08-01T09:30:00+08:00",
            "2026-08-01T17:00:00+08:00",
            false,
        )
        .unwrap();
        assert_eq!(result.late_hours, 2);
        assert_eq!(result.late_deduction_centavos, 2000);
        assert_eq!(result.worked_hours, 7);
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
    fn arrival_beyond_08_15_is_late() {
        // 08:16 is beyond grace period
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
        assert_eq!(result.daily_pay_centavos, 7000);
    }
    #[test]
    fn arrivals_are_always_measured_against_08_00_office_start() {
        // There are no night shifts: office hours are 8 am to 5 pm.
        // An arrival at 10:30 is measured against 08:00 (2.5 hours late -> 3 late hours).
        let result = calculate(
            "2026-08-10",
            "2026-08-10T10:30:00+08:00",
            "2026-08-10T17:00:00+08:00",
            false,
        )
        .unwrap();
        assert_eq!(result.late_hours, 3);
        assert_eq!(result.late_deduction_centavos, 3000);
        assert_eq!(result.daily_pay_centavos, 5000);
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
    fn early_clock_out_before_5pm_is_half_day() {
        // 08:00–16:00 → 7 paid hours, but clocked out before 17:00 (5:00 PM).
        let result = calculate(
            "2026-08-01",
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T16:00:00+08:00",
            true,
        )
        .unwrap();
        assert_eq!(result.worked_hours, 7);
        assert!(result.is_half_day);
        assert_eq!(result.half_day_deduction_centavos, 4000);
        assert_eq!(result.daily_pay_centavos, 4000);
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
        // T6 decision A: 16:59:59 is half-day; exactly 17:00:00 and 17:00:01 are full.
        let just_before = calculate(
            "2026-08-01",
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T16:59:59+08:00",
            true,
        )
        .unwrap();
        assert!(just_before.is_half_day);
        assert_eq!(just_before.daily_pay_centavos, 4000);
        for time_out in [
            "2026-08-01T17:00:00+08:00",
            "2026-08-01T17:00:01+08:00",
        ] {
            let result = calculate("2026-08-01", "2026-08-01T08:00:00+08:00", time_out, true).unwrap();
            assert!(!result.is_half_day);
            assert_eq!(result.daily_pay_centavos, 8000);
        }
    }

    #[test]
    fn afternoon_arrival_at_noon_is_half_day() {
        let noon = calculate(
            "2026-08-01",
            "2026-08-01T12:00:00+08:00",
            "2026-08-01T17:00:00+08:00",
            false,
        )
        .unwrap();
        assert!(noon.is_half_day);
        assert_eq!(noon.half_day_deduction_centavos, 4000);
    }

    #[test]
    fn early_half_day_uses_effective_noon_window_for_pay() {
        // DTR/PAYROLL DECOUPLING: 08:00-15:00 actuals pay as an effective
        // 08:00-12:00 window (pay math only; the DTR row keeps 15:00).
        let half = calculate(
            "2026-08-01",
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T15:00:00+08:00",
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
}
