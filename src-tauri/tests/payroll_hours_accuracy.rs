// Keep focused payroll tests runnable without loading the app's Tauri/WebView2
// native dependencies into the Windows test process.
mod services {
    pub mod payroll {
        include!("../src/services/payroll.rs");
    }

    pub mod lunch_break {
        include!("../src/services/lunch_break.rs");
    }

    pub mod intern_payroll {
        include!("../src/services/intern_payroll.rs");
    }
}

#[path = "common/fixture.rs"]
mod fixture;
#[path = "common/intern_cases.rs"]
mod intern_cases;

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

    // R-I7: 12:00–17:00 books the shortfall as half-day undertime, not late.
    let r_i7 = calculate("2026-10-02", "2026-10-02T12:00:00+08:00", "2026-10-02T17:00:00+08:00", false).unwrap();
    assert_eq!(r_i7.late_hours, 0);
    assert_eq!(r_i7.late_deduction_centavos, 0);
    assert_eq!(r_i7.worked_hours, 4.0);
    assert!(r_i7.is_half_day);
    assert_eq!(r_i7.half_day_deduction_centavos, 4_000);
    assert_eq!(r_i7.daily_pay_centavos, 4_000);
    assert!(!r_i7.grace_used);

    // R-I8: same rule on the pre-cutover branch (no clamp at minute 0 anyway).
    let r_i8 = calculate("2026-09-15", "2026-09-15T12:00:00+08:00", "2026-09-15T17:00:00+08:00", false).unwrap();
    assert_eq!(r_i8.late_hours, 0);
    assert_eq!(r_i8.late_deduction_centavos, 0);
    assert_eq!(r_i8.worked_hours, 4.0);
    assert!(r_i8.is_half_day);
    assert_eq!(r_i8.half_day_deduction_centavos, 4_000);
    assert_eq!(r_i8.daily_pay_centavos, 4_000);
    assert!(!r_i8.grace_used);

    // R-I9: 12:30 pre-cutover skips the quarter-hour clamp (payable stays actual).
    // 12:30-to-17:00 spans 4.5h minus the 0.5h 12:30-13:00 lunch overlap.
    let r_i9 = calculate("2026-09-15", "2026-09-15T12:30:00+08:00", "2026-09-15T17:00:00+08:00", false).unwrap();
    assert_eq!(r_i9.late_hours, 0);
    assert_eq!(r_i9.late_deduction_centavos, 0);
    assert_eq!(r_i9.computed_time_in, "2026-09-15T12:30:00+08:00");
    assert_eq!(r_i9.worked_hours, 4.0);
    assert!(r_i9.is_half_day);
    assert_eq!(r_i9.half_day_deduction_centavos, 4_000);
    assert_eq!(r_i9.daily_pay_centavos, 4_000);
}

#[test]
fn intern_daily_cases_match_the_rust_golden_contract() {
    let cases = fixture::section("payroll_hours_accuracy", "internDaily");
    let cases = cases.as_array().expect("internDaily array");
    assert!(cases.iter().any(|case| case["error"].is_string()), "golden set must cover rejected inputs");
    assert!(cases.iter().any(|case| case["date"].as_str().is_some_and(|date| date < "2026-10-01")), "pre-cutover dates");
    assert!(cases.iter().any(|case| case["date"].as_str().is_some_and(|date| date >= "2026-10-01")), "post-cutover dates");

    for case in cases {
        let name = case["name"].as_str().expect("case name");
        let actual = intern_cases::run_daily(case);
        if let Some(error) = case["error"].as_str() {
            assert_eq!(actual["error"].as_str(), Some(error), "{name}");
        } else {
            assert_eq!(actual["expected"], case["expected"], "{name}");
        }
    }
    fixture::assert_owned_consumed("payroll_hours_accuracy");
}

type Sweep = Result<services::intern_payroll::InternPayrollResult, String>;

/// Plain-loop sweep: every minute of arrival between 07:00 and 16:59 against
/// several clock-outs, on a pre-cutover and a post-cutover date, with and
/// without an available weekly grace.
fn sweep(mut visit: impl FnMut(&str, bool, &str, &str, Sweep)) {
    use services::intern_payroll::calculate;
    for date in ["2026-09-15", "2026-10-06"] {
        for grace in [true, false] {
            for time_out in ["12:00:00", "13:30:00", "15:00:00", "16:59:59", "17:00:00", "17:30:00", "18:00:00", "19:00:00"] {
                for minute in 7 * 60..17 * 60 {
                    let time_in = format!("{:02}:{:02}:00", minute / 60, minute % 60);
                    let result = calculate(date, &format!("{date}T{time_in}+08:00"), &format!("{date}T{time_out}+08:00"), grace);
                    visit(date, grace, &time_in, time_out, result);
                }
            }
        }
    }
}

#[test]
fn invariant_daily_pay_stays_between_zero_and_the_daily_base() {
    let mut checked = 0;
    sweep(|date, grace, time_in, time_out, result| {
        if let Ok(pay) = result {
            checked += 1;
            assert!((0..=8_000).contains(&pay.daily_pay_centavos), "{date} grace={grace} {time_in}-{time_out}: {}", pay.daily_pay_centavos);
        }
    });
    assert!(checked > 10_000, "sweep must exercise the engine, got {checked}");
}

#[test]
fn invariant_late_plus_undertime_never_exceed_the_base_and_explain_the_pay() {
    sweep(|date, grace, time_in, time_out, result| {
        if let Ok(pay) = result {
            let deductions = pay.late_deduction_centavos + pay.half_day_deduction_centavos;
            let context = format!("{date} grace={grace} {time_in}-{time_out}");
            assert!(pay.late_deduction_centavos >= 0 && pay.half_day_deduction_centavos >= 0, "{context}");
            assert_eq!(pay.base_pay_centavos, 8_000, "{context}");
            assert_eq!(pay.daily_pay_centavos, (8_000 - deductions).max(0), "{context}");
        }
    });
}

#[test]
fn invariant_arriving_later_never_increases_pay() {
    use std::collections::HashMap;
    // Key: (date, grace, time_out) -> previous minute's arrival and pay.
    let mut previous: HashMap<(String, bool, String), (String, i64)> = HashMap::new();
    sweep(|date, grace, time_in, time_out, result| {
        let Ok(pay) = result else { return };
        let key = (date.to_owned(), grace, time_out.to_owned());
        if let Some((earlier_in, earlier_pay)) = previous.get(&key) {
            assert!(
                pay.daily_pay_centavos <= *earlier_pay,
                "{date} grace={grace} out {time_out}: arriving {time_in} paid {} but {earlier_in} paid {earlier_pay}",
                pay.daily_pay_centavos
            );
        }
        previous.insert(key, (time_in.to_owned(), pay.daily_pay_centavos));
    });
}
