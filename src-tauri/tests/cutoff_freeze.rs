// Keep focused cutoff tests runnable without loading the app's Tauri/WebView2
// native dependencies into the Windows test process.
mod services {
    pub mod cutoff_payroll {
        include!("../src/services/cutoff_payroll.rs");
    }
}

use services::cutoff_payroll::{calculate, CutoffInput};

// PINNED_SHA256 08d8d00bd22a980243770eb307d2aaf58f27e7fa582ba33d6235d695c9c180b6
// is SHA-256 of shared/payroll-fixtures.json after CRLF -> LF normalization only
// (no trimming or JSON renormalization). The TypeScript freeze test enforces it;
// this isolated Rust harness documents the pin without a hash dependency.

#[test]
fn rounds_monetary_values_to_cents() {
    let result = calculate(&CutoffInput {
        employee_id: "FIXTURE-001".into(), employee_name: "Payroll Contract Fixture".into(), employee_type: "EMPLOYEE".into(),
        cutoff_start: "2026-07-01".into(), cutoff_end: "2026-07-15".into(), daily_rate: 100.005,
        standard_working_days: 11.0, actual_working_days: 1.0, basic_pay: None,
        special_holiday_days: 0.0, special_holiday_multiplier: 0.3, special_holiday_pay: None,
        regular_holiday_days: 0.0, regular_holiday_multiplier: 1.0, regular_holiday_pay: None,
        hra: 0.0, incentives_allowance: 0.0, special_allowance: 0.0, late_deduction: 0.0,
        half_day_count: 0.0, half_day_fraction: 0.5, half_day_deduction: None,
        absent_days: 0.0, absence_deduction: None, overtime_hours: 0.0, overtime_rate: 0.0, overtime_pay: None,
        sss_employee_share: 0.0, phic_employee_share: 0.0, hdmf_employee_share: 0.0, salary_advance: 0.0,
        manual_adjustment: 0.0, adjustment_reason: None, approved_working_day_overage: false,
    }).unwrap();
    assert_eq!(result.basic_pay, 10_001, "rounds monetary values: basic pay");
    assert_eq!(result.gross_compensation, 10_001, "rounds monetary values: gross");
    assert_eq!(result.net_pay, 10_001, "rounds monetary values: net");
}

#[test]
fn applies_half_day_fraction_to_whole_number_counts() {
    let result = calculate(&CutoffInput {
        employee_id: "FIXTURE-001".into(), employee_name: "Payroll Contract Fixture".into(), employee_type: "EMPLOYEE".into(),
        cutoff_start: "2026-07-01".into(), cutoff_end: "2026-07-15".into(), daily_rate: 100.01,
        standard_working_days: 11.0, actual_working_days: 1.0, basic_pay: None,
        special_holiday_days: 0.0, special_holiday_multiplier: 0.3, special_holiday_pay: None,
        regular_holiday_days: 0.0, regular_holiday_multiplier: 1.0, regular_holiday_pay: None,
        hra: 0.0, incentives_allowance: 0.0, special_allowance: 0.0, late_deduction: 0.0,
        half_day_count: 1.0, half_day_fraction: 0.5, half_day_deduction: None,
        absent_days: 0.0, absence_deduction: None, overtime_hours: 0.0, overtime_rate: 0.0, overtime_pay: None,
        sss_employee_share: 0.0, phic_employee_share: 0.0, hdmf_employee_share: 0.0, salary_advance: 0.0,
        manual_adjustment: 0.0, adjustment_reason: None, approved_working_day_overage: false,
    }).unwrap();
    assert_eq!(result.half_day_deduction, 5_001);
}

#[test]
fn uses_full_fractional_day_count_as_half_day_fraction() {
    let result = calculate(&CutoffInput {
        employee_id: "FIXTURE-001".into(), employee_name: "Payroll Contract Fixture".into(), employee_type: "EMPLOYEE".into(),
        cutoff_start: "2026-07-01".into(), cutoff_end: "2026-07-15".into(), daily_rate: 100.01,
        standard_working_days: 11.0, actual_working_days: 1.0, basic_pay: None,
        special_holiday_days: 0.0, special_holiday_multiplier: 0.3, special_holiday_pay: None,
        regular_holiday_days: 0.0, regular_holiday_multiplier: 1.0, regular_holiday_pay: None,
        hra: 0.0, incentives_allowance: 0.0, special_allowance: 0.0, late_deduction: 0.0,
        half_day_count: 0.5, half_day_fraction: 0.5, half_day_deduction: None,
        absent_days: 0.0, absence_deduction: None, overtime_hours: 0.0, overtime_rate: 0.0, overtime_pay: None,
        sss_employee_share: 0.0, phic_employee_share: 0.0, hdmf_employee_share: 0.0, salary_advance: 0.0,
        manual_adjustment: 0.0, adjustment_reason: None, approved_working_day_overage: false,
    }).unwrap();
    assert_eq!(result.half_day_deduction, 5_001);
}

#[test]
fn zero_day_cutoff_removes_flat_allowances() {
    let result = calculate(&CutoffInput {
        employee_id: "FIXTURE-001".into(), employee_name: "Payroll Contract Fixture".into(), employee_type: "INTERN".into(),
        cutoff_start: "2026-07-01".into(), cutoff_end: "2026-07-15".into(), daily_rate: 80.0,
        standard_working_days: 11.0, actual_working_days: 0.0, basic_pay: None,
        special_holiday_days: 0.0, special_holiday_multiplier: 0.3, special_holiday_pay: None,
        regular_holiday_days: 0.0, regular_holiday_multiplier: 1.0, regular_holiday_pay: None,
        hra: 200.0, incentives_allowance: 1_000.0, special_allowance: 100.0, late_deduction: 0.0,
        half_day_count: 0.0, half_day_fraction: 0.5, half_day_deduction: None,
        absent_days: 11.0, absence_deduction: None, overtime_hours: 0.0, overtime_rate: 0.0, overtime_pay: None,
        sss_employee_share: 0.0, phic_employee_share: 0.0, hdmf_employee_share: 0.0, salary_advance: 0.0,
        manual_adjustment: 0.0, adjustment_reason: None, approved_working_day_overage: false,
    }).unwrap();
    assert_eq!(result.total_allowance, 0);
    assert_eq!(result.gross_compensation, 88_000);
    assert_eq!(result.net_pay, 0);
}

#[test]
fn floors_intern_gross_and_net_at_zero() {
    let result = calculate(&CutoffInput {
        employee_id: "FIXTURE-001".into(), employee_name: "Payroll Contract Fixture".into(), employee_type: "INTERN".into(),
        cutoff_start: "2026-07-01".into(), cutoff_end: "2026-07-15".into(), daily_rate: 0.0,
        standard_working_days: 11.0, actual_working_days: 0.0, basic_pay: None,
        special_holiday_days: 0.0, special_holiday_multiplier: 0.3, special_holiday_pay: None,
        regular_holiday_days: 0.0, regular_holiday_multiplier: 1.0, regular_holiday_pay: None,
        hra: 0.0, incentives_allowance: 0.0, special_allowance: 0.0, late_deduction: 10.0,
        half_day_count: 0.0, half_day_fraction: 0.5, half_day_deduction: None,
        absent_days: 0.0, absence_deduction: None, overtime_hours: 0.0, overtime_rate: 0.0, overtime_pay: None,
        sss_employee_share: 0.0, phic_employee_share: 0.0, hdmf_employee_share: 0.0, salary_advance: 0.0,
        manual_adjustment: 0.0, adjustment_reason: None, approved_working_day_overage: false,
    }).unwrap();
    assert_eq!(result.gross_compensation, 0);
    assert_eq!(result.net_pay, 0);
}

#[test]
fn applies_special_and_regular_holiday_multipliers() {
    let result = calculate(&CutoffInput {
        employee_id: "FIXTURE-001".into(), employee_name: "Payroll Contract Fixture".into(), employee_type: "EMPLOYEE".into(),
        cutoff_start: "2026-07-01".into(), cutoff_end: "2026-07-15".into(), daily_rate: 100.0,
        standard_working_days: 11.0, actual_working_days: 0.0, basic_pay: None,
        special_holiday_days: 1.0, special_holiday_multiplier: 0.3, special_holiday_pay: None,
        regular_holiday_days: 1.0, regular_holiday_multiplier: 1.0, regular_holiday_pay: None,
        hra: 0.0, incentives_allowance: 0.0, special_allowance: 0.0, late_deduction: 0.0,
        half_day_count: 0.0, half_day_fraction: 0.5, half_day_deduction: None,
        absent_days: 0.0, absence_deduction: None, overtime_hours: 0.0, overtime_rate: 0.0, overtime_pay: None,
        sss_employee_share: 0.0, phic_employee_share: 0.0, hdmf_employee_share: 0.0, salary_advance: 0.0,
        manual_adjustment: 0.0, adjustment_reason: None, approved_working_day_overage: false,
    }).unwrap();
    assert_eq!(result.special_holiday_pay, 3_000);
    assert_eq!(result.regular_holiday_pay, 10_000);
    assert_eq!(result.gross_compensation, 13_000);
}

#[test]
fn includes_manual_adjustment_in_gross_and_net() {
    let result = calculate(&CutoffInput {
        employee_id: "FIXTURE-001".into(), employee_name: "Payroll Contract Fixture".into(), employee_type: "EMPLOYEE".into(),
        cutoff_start: "2026-07-01".into(), cutoff_end: "2026-07-15".into(), daily_rate: 100.0,
        standard_working_days: 11.0, actual_working_days: 1.0, basic_pay: None,
        special_holiday_days: 0.0, special_holiday_multiplier: 0.3, special_holiday_pay: None,
        regular_holiday_days: 0.0, regular_holiday_multiplier: 1.0, regular_holiday_pay: None,
        hra: 0.0, incentives_allowance: 0.0, special_allowance: 0.0, late_deduction: 0.0,
        half_day_count: 0.0, half_day_fraction: 0.5, half_day_deduction: None,
        absent_days: 0.0, absence_deduction: None, overtime_hours: 0.0, overtime_rate: 0.0, overtime_pay: None,
        sss_employee_share: 0.0, phic_employee_share: 0.0, hdmf_employee_share: 0.0, salary_advance: 0.0,
        manual_adjustment: 12.34, adjustment_reason: Some("Fixture adjustment".into()), approved_working_day_overage: false,
    }).unwrap();
    assert_eq!(result.gross_compensation - result.basic_pay - result.special_holiday_pay - result.regular_holiday_pay - result.total_allowance - result.overtime_pay, 1_234);
    assert_eq!(result.gross_compensation, 11_234);
    assert_eq!(result.net_pay, 11_234);
}

#[test]
fn rejects_invalid_calendar_date() {
    let result = calculate(&CutoffInput {
        employee_id: "FIXTURE-001".into(), employee_name: "Payroll Contract Fixture".into(), employee_type: "EMPLOYEE".into(),
        cutoff_start: "2026-02-30".into(), cutoff_end: "2026-07-15".into(), daily_rate: 100.0,
        standard_working_days: 11.0, actual_working_days: 1.0, basic_pay: None,
        special_holiday_days: 0.0, special_holiday_multiplier: 0.3, special_holiday_pay: None,
        regular_holiday_days: 0.0, regular_holiday_multiplier: 1.0, regular_holiday_pay: None,
        hra: 0.0, incentives_allowance: 0.0, special_allowance: 0.0, late_deduction: 0.0,
        half_day_count: 0.0, half_day_fraction: 0.5, half_day_deduction: None,
        absent_days: 0.0, absence_deduction: None, overtime_hours: 0.0, overtime_rate: 0.0, overtime_pay: None,
        sss_employee_share: 0.0, phic_employee_share: 0.0, hdmf_employee_share: 0.0, salary_advance: 0.0,
        manual_adjustment: 0.0, adjustment_reason: None, approved_working_day_overage: false,
    });
    assert!(result.as_ref().is_err_and(|message| message.contains("valid cutoff dates")), "invalid calendar date: {result:?}");
}

#[test]
fn rejects_negative_payroll_values() {
    let result = calculate(&CutoffInput {
        employee_id: "FIXTURE-001".into(), employee_name: "Payroll Contract Fixture".into(), employee_type: "EMPLOYEE".into(),
        cutoff_start: "2026-07-01".into(), cutoff_end: "2026-07-15".into(), daily_rate: -1.0,
        standard_working_days: 11.0, actual_working_days: 1.0, basic_pay: None,
        special_holiday_days: 0.0, special_holiday_multiplier: 0.3, special_holiday_pay: None,
        regular_holiday_days: 0.0, regular_holiday_multiplier: 1.0, regular_holiday_pay: None,
        hra: 0.0, incentives_allowance: 0.0, special_allowance: 0.0, late_deduction: 0.0,
        half_day_count: 0.0, half_day_fraction: 0.5, half_day_deduction: None,
        absent_days: 0.0, absence_deduction: None, overtime_hours: 0.0, overtime_rate: 0.0, overtime_pay: None,
        sss_employee_share: 0.0, phic_employee_share: 0.0, hdmf_employee_share: 0.0, salary_advance: 0.0,
        manual_adjustment: 0.0, adjustment_reason: None, approved_working_day_overage: false,
    });
    assert!(result.as_ref().is_err_and(|message| message.contains("Payroll values are invalid or require working-day approval.")), "negative payroll values: {result:?}");
}

#[test]
fn requires_approval_for_working_day_overage() {
    let result = calculate(&CutoffInput {
        employee_id: "FIXTURE-001".into(), employee_name: "Payroll Contract Fixture".into(), employee_type: "EMPLOYEE".into(),
        cutoff_start: "2026-07-01".into(), cutoff_end: "2026-07-15".into(), daily_rate: 100.0,
        standard_working_days: 11.0, actual_working_days: 12.0, basic_pay: None,
        special_holiday_days: 0.0, special_holiday_multiplier: 0.3, special_holiday_pay: None,
        regular_holiday_days: 0.0, regular_holiday_multiplier: 1.0, regular_holiday_pay: None,
        hra: 0.0, incentives_allowance: 0.0, special_allowance: 0.0, late_deduction: 0.0,
        half_day_count: 0.0, half_day_fraction: 0.5, half_day_deduction: None,
        absent_days: 0.0, absence_deduction: None, overtime_hours: 0.0, overtime_rate: 0.0, overtime_pay: None,
        sss_employee_share: 0.0, phic_employee_share: 0.0, hdmf_employee_share: 0.0, salary_advance: 0.0,
        manual_adjustment: 0.0, adjustment_reason: None, approved_working_day_overage: false,
    });
    assert!(result.as_ref().is_err_and(|message| message.contains("Payroll values are invalid or require working-day approval.")), "working-day overage: {result:?}");
}

#[test]
fn requires_reason_for_manual_adjustment() {
    let result = calculate(&CutoffInput {
        employee_id: "FIXTURE-001".into(), employee_name: "Payroll Contract Fixture".into(), employee_type: "EMPLOYEE".into(),
        cutoff_start: "2026-07-01".into(), cutoff_end: "2026-07-15".into(), daily_rate: 100.0,
        standard_working_days: 11.0, actual_working_days: 1.0, basic_pay: None,
        special_holiday_days: 0.0, special_holiday_multiplier: 0.3, special_holiday_pay: None,
        regular_holiday_days: 0.0, regular_holiday_multiplier: 1.0, regular_holiday_pay: None,
        hra: 0.0, incentives_allowance: 0.0, special_allowance: 0.0, late_deduction: 0.0,
        half_day_count: 0.0, half_day_fraction: 0.5, half_day_deduction: None,
        absent_days: 0.0, absence_deduction: None, overtime_hours: 0.0, overtime_rate: 0.0, overtime_pay: None,
        sss_employee_share: 0.0, phic_employee_share: 0.0, hdmf_employee_share: 0.0, salary_advance: 0.0,
        manual_adjustment: 1.0, adjustment_reason: None, approved_working_day_overage: false,
    });
    assert!(result.as_ref().is_err_and(|message| message.contains("A manual adjustment reason is required.")), "manual adjustment without reason: {result:?}");
}
