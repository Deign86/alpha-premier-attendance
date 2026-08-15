use super::lunch_break::paid_work_hours_ceiled;
use chrono::{DateTime, Datelike, TimeZone, Timelike};
use chrono_tz::Asia::Manila;

#[derive(Debug, Clone, PartialEq)]
pub struct EmployeePayrollResult {
    pub computed_time_in: String,
    pub computed_time_out: String,
    pub late_hours: i64,
    pub late_deduction_centavos: i64,
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
    Ok(EmployeePayrollResult {
        computed_time_in: computed_in.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        computed_time_out: computed_out.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        late_hours: 0,
        late_deduction_centavos: 0,
        base_pay_centavos: daily_rate_centavos,
        daily_pay_centavos: daily_rate_centavos,
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
            + chrono::Duration::hours(1)
    }
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
}
