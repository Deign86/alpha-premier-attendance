#![allow(dead_code)] // each isolated target uses a subset of these shared helpers
// Intern daily-payroll adapter shared by the golden-fixture consumers and the
// throwaway generator: fixture JSON input -> real Rust engine -> JSON output.
use crate::services::intern_payroll::{calculate, is_no_grace_date, InternPayrollResult};
use chrono::{Datelike, Duration, NaiveDate};
use serde_json::{json, Value};
use std::collections::HashSet;

pub fn result_json(result: &InternPayrollResult) -> Value {
    json!({
        "computedTimeIn": result.computed_time_in,
        "computedTimeOut": result.computed_time_out,
        "graceUsed": result.grace_used,
        "lateHours": result.late_hours,
        "lateDeductionCentavos": result.late_deduction_centavos,
        "isHalfDay": result.is_half_day,
        "undertimeDeductionCentavos": result.half_day_deduction_centavos,
        "basePayCentavos": result.base_pay_centavos,
        "dailyPayCentavos": result.daily_pay_centavos,
        "workedHours": result.worked_hours,
    })
}

/// Runs one `internDaily` case; returns `{"expected": {...}}` or `{"error": message}`.
pub fn run_daily(case: &Value) -> Value {
    let date = case["date"].as_str().expect("date");
    let time_in = case["timeIn"].as_str().expect("timeIn");
    let time_out = case["timeOut"].as_str().expect("timeOut");
    let grace = case["graceAvailable"].as_bool().expect("graceAvailable");
    match calculate(date, time_in, time_out, grace) {
        Ok(result) => json!({ "expected": result_json(&result) }),
        Err(message) => json!({ "error": message }),
    }
}

/// Monday of the Manila work week (attendance dates are already Manila dates).
pub fn week_start(date: &str) -> NaiveDate {
    let day = NaiveDate::parse_from_str(date, "%Y-%m-%d").expect("fixture date");
    day - Duration::days(i64::from(day.weekday().num_days_from_monday()))
}

/// Replays raw attendance rows in date order with the weekly-grace budget:
/// grace is available for a pre-cutover date until one arrival that week used it.
/// Absent rows (null stamps) yield `{"date", "absent": true}`.
pub fn replay_rows(rows: &[Value]) -> Vec<Value> {
    let mut used_weeks: HashSet<NaiveDate> = HashSet::new();
    rows.iter()
        .map(|row| {
            let date = row["date"].as_str().expect("row date");
            let (Some(time_in), Some(time_out)) = (row["timeIn"].as_str(), row["timeOut"].as_str()) else {
                return json!({ "date": date, "absent": true });
            };
            let week = week_start(date);
            let grace_available = !is_no_grace_date(date) && !used_weeks.contains(&week);
            let result = calculate(date, time_in, time_out, grace_available)
                .unwrap_or_else(|message| panic!("{date}: {message}"));
            if result.grace_used {
                used_weeks.insert(week);
            }
            let mut daily = result_json(&result);
            daily["date"] = json!(date);
            daily["graceAvailable"] = json!(grace_available);
            daily
        })
        .collect()
}
