#![allow(dead_code)] // each isolated target uses a subset of these shared helpers
// Cutoff-engine adapter shared by the golden-fixture consumers and the
// throwaway generator: fixture JSON input -> real Rust engine -> JSON output.
use crate::services::cutoff_payroll::{calculate, CutoffInput};
use serde_json::{json, Value};

pub fn merged_input(base: &Value, overrides: &Value) -> Value {
    let mut merged = base.as_object().expect("base input").clone();
    for (key, value) in overrides.as_object().expect("case input") {
        merged.insert(key.clone(), value.clone());
    }
    Value::Object(merged)
}

pub fn to_cutoff_input(input: &Value) -> CutoffInput {
    let number = |key: &str| input[key].as_f64().unwrap_or(0.0);
    let optional_number = |key: &str| input[key].as_f64();
    let string = |key: &str| input[key].as_str().expect("string input").to_owned();
    CutoffInput {
        employee_id: string("employeeId"),
        employee_name: string("employeeName"),
        employee_type: string("employeeType"),
        cutoff_start: string("cutoffStart"),
        cutoff_end: string("cutoffEnd"),
        daily_rate: number("dailyRate"),
        standard_working_days: number("standardWorkingDays"),
        actual_working_days: number("actualWorkingDays"),
        basic_pay: optional_number("basicPay"),
        special_holiday_days: number("specialHolidayDays"),
        special_holiday_multiplier: number("specialHolidayMultiplier"),
        special_holiday_pay: optional_number("specialHolidayPay"),
        regular_holiday_days: number("regularHolidayDays"),
        regular_holiday_multiplier: number("regularHolidayMultiplier"),
        regular_holiday_pay: optional_number("regularHolidayPay"),
        hra: number("hra"),
        incentives_allowance: number("incentivesAllowance"),
        special_allowance: number("specialAllowance"),
        late_deduction: number("lateDeduction"),
        half_day_count: number("halfDayCount"),
        half_day_fraction: number("halfDayFraction"),
        half_day_deduction: optional_number("halfDayDeduction"),
        absent_days: number("absentDays"),
        absence_deduction: optional_number("absenceDeduction"),
        overtime_hours: number("overtimeHours"),
        overtime_rate: number("overtimeRate"),
        overtime_pay: optional_number("overtimePay"),
        sss_employee_share: number("sss"),
        phic_employee_share: number("phic"),
        hdmf_employee_share: number("hdmf"),
        salary_advance: number("salaryAdvance"),
        manual_adjustment: number("manualAdjustment"),
        adjustment_reason: input["adjustmentReason"].as_str().map(str::to_owned),
        approved_working_day_overage: input["approvedWorkingDayOverage"].as_bool().expect("approval flag"),
    }
}

/// Runs the real engine and returns `{"expected": {...centavos}}` or `{"error": message}`.
pub fn run_cutoff(input: &Value) -> Value {
    match calculate(&to_cutoff_input(input)) {
        Ok(result) => json!({ "expected": cutoff_json(&result) }),
        Err(message) => json!({ "error": message }),
    }
}

pub fn cutoff_json(result: &crate::services::cutoff_payroll::CutoffResult) -> Value {
    json!({
        "basicPay": result.basic_pay,
        "specialHolidayPay": result.special_holiday_pay,
        "regularHolidayPay": result.regular_holiday_pay,
        "totalAllowance": result.total_allowance,
        "lateDeduction": result.late_deduction,
        "halfDayDeduction": result.half_day_deduction,
        "absenceDeduction": result.absence_deduction,
        "overtimePay": result.overtime_pay,
        "totalDeductions": result.total_deductions,
        "grossCompensation": result.gross_compensation,
        "netPay": result.net_pay,
    })
}
