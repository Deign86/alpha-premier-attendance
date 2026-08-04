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

pub fn late_deduction_centavos(daily_rate_centavos: i64, late_hours: i64, grace_hours: i64) -> i64 {
    floor_zero((late_hours - grace_hours).max(0) * daily_rate_centavos / 8)
}

#[derive(Debug, Clone, PartialEq)]
pub struct InternPayrollResult { pub computed_time_in: String, pub computed_time_out: String, pub late_hours: i64, pub late_deduction_centavos: i64, pub grace_used: bool, pub base_pay_centavos: i64, pub daily_pay_centavos: i64 }

pub fn calculate(attendance_date: &str, actual_time_in: &str, actual_time_out: &str, grace_available: bool) -> Result<InternPayrollResult, String> {
    let date = NaiveDate::parse_from_str(attendance_date, "%Y-%m-%d").map_err(|_| "attendanceDate must be a valid Manila date")?;
    let time_in = DateTime::parse_from_rfc3339(actual_time_in).map_err(|_| "Payroll timestamps must be valid ISO values")?.with_timezone(&Manila);
    let time_out = DateTime::parse_from_rfc3339(actual_time_out).map_err(|_| "Payroll timestamps must be valid ISO values")?.with_timezone(&Manila);
    let start = Manila.with_ymd_and_hms(date.year(), date.month(), date.day(), 8, 0, 0).single().ok_or("Invalid Manila start time")?;
    let late_seconds = time_in.signed_duration_since(start).num_seconds();
    let late_hours = if late_seconds > 0 { (late_seconds + 3599) / 3600 } else { 0 };
    let grace_used = late_hours > 0 && grace_available;
    let deduction = if late_hours > 0 && !grace_used { late_hours * INTERN_LATE_DEDUCTION_PER_HOUR_PHP * 100 } else { 0 };
    let computed_in = if late_hours > 0 && !grace_used { ceil_hour(time_in) } else { time_in };
    let base = INTERN_DAILY_RATE_PHP * 100;
    Ok(InternPayrollResult { computed_time_in: computed_in.to_rfc3339_opts(chrono::SecondsFormat::Secs, true), computed_time_out: time_out.to_rfc3339_opts(chrono::SecondsFormat::Secs, true), late_hours, late_deduction_centavos: deduction, grace_used, base_pay_centavos: base, daily_pay_centavos: floor_zero(base - deduction) })
}

fn ceil_hour(value: DateTime<chrono_tz::Tz>) -> DateTime<chrono_tz::Tz> {
    if value.minute() == 0 && value.second() == 0 { value } else { Manila.with_ymd_and_hms(value.year(), value.month(), value.day(), value.hour(), 0, 0).single().unwrap() + Duration::hours(1) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn grace_and_floor_are_applied() { assert_eq!(late_deduction_centavos(80000, 3, 1), 20000); assert_eq!(late_deduction_centavos(100, 0, 1), 0); }
}
