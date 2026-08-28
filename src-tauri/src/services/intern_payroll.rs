use super::lunch_break::paid_work_hours_ceiled;
use super::payroll::floor_zero;
use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Timelike};
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
    // Evening and night interns are measured from their actual shift anchor,
    // rather than being compared with the daytime 08:00 schedule.
    let start_hour = if time_in.hour() >= 18 {
        time_in.hour()
    } else {
        8
    };
    let start = Manila
        .with_ymd_and_hms(date.year(), date.month(), date.day(), start_hour, 0, 0)
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
    let is_half_day = worked_hours > 0 && worked_hours <= 4;
    let half_day_deduction = if is_half_day { base / 2 } else { 0 };
    Ok(InternPayrollResult {
        computed_time_in: computed_in.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        computed_time_out: time_out.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
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

fn ceil_hour(value: DateTime<chrono_tz::Tz>) -> DateTime<chrono_tz::Tz> {
    if value.minute() == 0 && value.second() == 0 {
        value
    } else {
        Manila
            .with_ymd_and_hms(value.year(), value.month(), value.day(), value.hour(), 0, 0)
            .single()
            .unwrap()
            + Duration::hours(1)
    }
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
    fn evening_shift_is_not_late_against_daytime_start() {
        // A 22:30 evening arrival is measured against the evening anchor
        // (22:00), not the daytime 08:00 schedule: 30 minutes late rounds up
        // to one late hour (PHP 10) instead of 14.5 hours (PHP 150).
        let result = calculate(
            "2026-08-10",
            "2026-08-10T22:30:00+08:00",
            "2026-08-11T06:30:00+08:00",
            true,
        )
        .unwrap();
        assert_eq!(result.late_hours, 1);
        assert_eq!(result.late_deduction_centavos, 1000);
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
}
