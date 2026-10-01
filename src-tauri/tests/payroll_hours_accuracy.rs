// Keep focused payroll tests runnable without loading the app's Tauri/WebView2
// native dependencies into the Windows test process.
mod services {
    pub mod payroll {
        include!("../src/services/payroll.rs");
    }

    pub mod employee_payroll {
        include!("../src/services/employee_payroll.rs");
    }

    pub mod lunch_break {
        include!("../src/services/lunch_break.rs");
    }

    pub mod intern_payroll {
        include!("../src/services/intern_payroll.rs");
    }
}

#[test]
fn employee_vectors_match_rust_hours_contract() {
    use services::employee_payroll::calculate;

    // R-E1: regular full workday.
    let r_e1 = calculate("2026-10-01T08:00:00+08:00", "2026-10-01T17:00:00+08:00", 80_000).unwrap();
    assert_eq!(r_e1.worked_hours, 8);
    assert_eq!(r_e1.daily_pay_centavos, 80_000);
    assert_eq!(r_e1.half_day_deduction_centavos, 0);
    assert!(!r_e1.is_half_day);

    // R-E2: four paid hours; expectation transcribed from GATES.md.
    let r_e2 = calculate("2026-10-01T08:00:00+08:00", "2026-10-01T12:00:00+08:00", 80_000).unwrap();
    assert_eq!(r_e2.worked_hours, 4);
    assert_eq!(r_e2.daily_pay_centavos, 40_000);
    assert_eq!(r_e2.half_day_deduction_centavos, 40_000);
    assert!(r_e2.is_half_day);

    // R-E3: 45 paid minutes round to one hour (characterization vs T-E3).
    let r_e3 = calculate("2026-10-01T11:45:00+08:00", "2026-10-01T13:15:00+08:00", 80_000).unwrap();
    assert_eq!(r_e3.worked_hours, 1);
    assert_eq!(r_e3.daily_pay_centavos, 10_000);
    assert_eq!(r_e3.half_day_deduction_centavos, 70_000);
    assert!(r_e3.is_half_day);

    // R-E4: hourly rate integer division truncates 80,300 / 8 to 10,037.
    let r_e4 = calculate("2026-10-01T08:00:00+08:00", "2026-10-01T17:00:00+08:00", 80_300).unwrap();
    assert_eq!(r_e4.worked_hours, 8);
    assert_eq!(r_e4.daily_pay_centavos, 80_296);
    assert_eq!(r_e4.half_day_deduction_centavos, 0);
    assert!(!r_e4.is_half_day);

    // R-E5: time-out cap produces the same result as R-E1.
    let r_e5 = calculate("2026-10-01T08:00:00+08:00", "2026-10-01T18:30:00+08:00", 80_000).unwrap();
    assert_eq!(r_e5.worked_hours, 8);
    assert_eq!(r_e5.daily_pay_centavos, 80_000);
    assert_eq!(r_e5.half_day_deduction_centavos, 0);
    assert!(!r_e5.is_half_day);

    // R-E6: one paid hour of undertime.
    let r_e6 = calculate("2026-10-01T08:00:00+08:00", "2026-10-01T16:00:00+08:00", 80_000).unwrap();
    assert_eq!(r_e6.worked_hours, 7);
    assert_eq!(r_e6.daily_pay_centavos, 70_000);
    assert_eq!(r_e6.half_day_deduction_centavos, 10_000);
    assert!(!r_e6.is_half_day);

    // R-E7: inverted stamps are rejected.
    assert!(calculate("2026-10-01T09:00:00+08:00", "2026-10-01T08:00:00+08:00", 80_000).is_err());
}

#[test]
fn intern_vectors_match_rust_hours_contract() {
    use services::intern_payroll::calculate;

    // R-I1: an on-time shift does not consume grace.
    let r_i1 = calculate("2026-10-01", "2026-10-01T08:00:00+08:00", "2026-10-01T17:00:00+08:00", false).unwrap();
    assert_eq!(r_i1.late_hours, 0);
    assert_eq!(r_i1.late_deduction_centavos, 0);
    assert_eq!(r_i1.worked_hours, 8.0);
    assert_eq!(r_i1.half_day_deduction_centavos, 0);
    assert_eq!(r_i1.daily_pay_centavos, 8_000);
    assert!(!r_i1.is_half_day);
    assert!(!r_i1.grace_used);

    // R-I2: late arrival is charged from the cutover date's actual stamp.
    let r_i2 = calculate("2026-10-01", "2026-10-01T09:30:00+08:00", "2026-10-01T17:00:00+08:00", false).unwrap();
    assert_eq!(r_i2.late_hours, 2);
    assert_eq!(r_i2.late_deduction_centavos, 2_000);
    assert_eq!(r_i2.worked_hours, 6.5);
    assert_eq!(r_i2.half_day_deduction_centavos, 0);
    assert_eq!(r_i2.daily_pay_centavos, 6_000);

    // R-I3: late hours and remaining undertime are separate deductions.
    let r_i3 = calculate("2026-10-01", "2026-10-01T09:30:00+08:00", "2026-10-01T16:00:00+08:00", false).unwrap();
    assert_eq!(r_i3.late_hours, 2);
    assert_eq!(r_i3.late_deduction_centavos, 2_000);
    assert_eq!(r_i3.worked_hours, 5.5);
    assert_eq!(r_i3.half_day_deduction_centavos, 1_000);
    assert_eq!(r_i3.daily_pay_centavos, 5_000);

    // R-I4: one hour short of a full day.
    let r_i4 = calculate("2026-10-01", "2026-10-01T08:00:00+08:00", "2026-10-01T16:00:00+08:00", false).unwrap();
    assert_eq!(r_i4.late_hours, 0);
    assert_eq!(r_i4.late_deduction_centavos, 0);
    assert_eq!(r_i4.worked_hours, 7.0);
    assert_eq!(r_i4.half_day_deduction_centavos, 1_000);
    assert_eq!(r_i4.daily_pay_centavos, 7_000);

    // R-I5a: before cutover, available grace covers 08:08.
    let r_i5a = calculate("2026-09-30", "2026-09-30T08:08:00+08:00", "2026-09-30T17:00:00+08:00", true).unwrap();
    assert!(r_i5a.grace_used);
    assert_eq!(r_i5a.late_hours, 0);
    assert_eq!(r_i5a.late_deduction_centavos, 0);
    assert_eq!(r_i5a.daily_pay_centavos, 8_000);

    // R-I5b: on the cutover date, grace is unavailable for the same stamps.
    let r_i5b = calculate("2026-10-01", "2026-10-01T08:08:00+08:00", "2026-10-01T17:00:00+08:00", true).unwrap();
    assert!(!r_i5b.grace_used);
    assert_eq!(r_i5b.late_hours, 1);
    assert_eq!(r_i5b.late_deduction_centavos, 1_000);
    assert_eq!(r_i5b.daily_pay_centavos, 7_000);

    // R-I6: 08:00–12:30 is characterized as a half-day.
    let r_i6 = calculate("2026-10-01", "2026-10-01T08:00:00+08:00", "2026-10-01T12:30:00+08:00", false).unwrap();
    assert_eq!(r_i6.worked_hours, 4.0);
    assert!(r_i6.is_half_day);
    assert_eq!(r_i6.half_day_deduction_centavos, 4_000);
    assert_eq!(r_i6.daily_pay_centavos, 4_000);
}
