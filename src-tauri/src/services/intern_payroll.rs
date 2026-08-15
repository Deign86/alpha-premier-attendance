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
    let start = Manila
        .with_ymd_and_hms(date.year(), date.month(), date.day(), 8, 0, 0)
        .single()
        .ok_or("Invalid Manila start time")?;
    let late_seconds = time_in.signed_duration_since(start).num_seconds();
    let late_hours = if late_seconds > 0 {
        (late_seconds + 3599) / 3600
    } else {
        0
    };
    let grace_used = late_hours > 0 && grace_available;
    let deduction = if late_hours > 0 && !grace_used {
        late_hours * INTERN_LATE_DEDUCTION_PER_HOUR_PHP * 100
    } else {
        0
    };
    let computed_in = if late_hours > 0 && !grace_used {
        ceil_hour(time_in)
    } else {
        time_in
    };
    let base = INTERN_DAILY_RATE_PHP * 100;
    Ok(InternPayrollResult {
        computed_time_in: computed_in.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        computed_time_out: time_out.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        late_hours,
        late_deduction_centavos: deduction,
        grace_used,
        base_pay_centavos: base,
        daily_pay_centavos: floor_zero(base - deduction),
        worked_hours: paid_work_hours_ceiled(time_in, time_out),
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
}
