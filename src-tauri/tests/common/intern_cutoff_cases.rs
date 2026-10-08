#![allow(dead_code)] // each isolated target uses a subset of these shared helpers
// Raw attendance rows -> daily intern results -> cutoff net, through the real
// Rust engines. Shared by the golden-fixture consumer and the generator.
use super::cutoff_cases::cutoff_json;
use super::intern_cases::replay_rows;
use crate::services::cutoff_payroll::{calculate, CutoffInput};
use serde_json::{json, Value};

pub fn run_intern_cutoff(scenario: &Value) -> Value {
    let rows = scenario["rows"].as_array().expect("rows");
    let daily = replay_rows(rows);
    let standard = scenario["standardWorkingDays"].as_f64().expect("standardWorkingDays");
    let worked: Vec<&Value> = daily.iter().filter(|day| day["absent"].is_null()).collect();
    let sum = |key: &str| worked.iter().map(|day| day[key].as_i64().expect("centavos")).sum::<i64>();
    let late = sum("lateDeductionCentavos");
    let undertime = sum("undertimeDeductionCentavos");
    let daily_pay = sum("dailyPayCentavos");
    let actual = worked.len() as f64;
    let cutoff = calculate(&CutoffInput {
        employee_id: "INT-GOLDEN".into(),
        employee_name: "Golden Intern".into(),
        employee_type: "INTERN".into(),
        cutoff_start: scenario["cutoffStart"].as_str().expect("cutoffStart").into(),
        cutoff_end: scenario["cutoffEnd"].as_str().expect("cutoffEnd").into(),
        daily_rate: 80.0,
        standard_working_days: standard,
        actual_working_days: actual,
        basic_pay: None,
        special_holiday_days: 0.0,
        special_holiday_multiplier: 0.0,
        special_holiday_pay: None,
        regular_holiday_days: 0.0,
        regular_holiday_multiplier: 0.0,
        regular_holiday_pay: None,
        hra: 0.0,
        incentives_allowance: 0.0,
        special_allowance: 0.0,
        late_deduction: late as f64 / 100.0,
        half_day_count: 0.0,
        half_day_fraction: 0.5,
        half_day_deduction: Some(undertime as f64 / 100.0),
        absent_days: standard - actual,
        absence_deduction: None,
        overtime_hours: 0.0,
        overtime_rate: 0.0,
        overtime_pay: None,
        sss_employee_share: 0.0,
        phic_employee_share: 0.0,
        hdmf_employee_share: 0.0,
        salary_advance: 0.0,
        manual_adjustment: 0.0,
        adjustment_reason: None,
        approved_working_day_overage: false,
    })
    .expect("golden cutoff must calculate");
    json!({
        "daily": daily,
        "totals": {
            "actualWorkingDays": worked.len(),
            "absentDays": daily.len() - worked.len(),
            "lateDeductionCentavos": late,
            "undertimeDeductionCentavos": undertime,
            "dailyPayCentavos": daily_pay,
        },
        "cutoff": cutoff_json(&cutoff),
    })
}
