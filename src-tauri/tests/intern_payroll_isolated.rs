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

    pub mod cutoff_payroll {
        include!("../src/services/cutoff_payroll.rs");
    }
}

#[test]
fn named_0815_to_1500_edge_and_boundary_cases_match_daily_rule() {
    use services::intern_payroll::calculate;

    struct EdgeCase {
        date: &'static str,
        time_in: &'static str,
        time_out: &'static str,
        grace_available: bool,
        expected_grace_used: bool,
        expected_late_hours: i64,
        expected_late_centavos: i64,
        expected_undertime_centavos: i64,
        expected_net_centavos: i64,
    }

    // Sep 1–6 is the Manila Mon-week starting Aug 31: row 2 exhausts row 1's grace.
    // The remaining rows cover the seconds boundary and next-week Monday reset.
    let cases = [
        EdgeCase { date: "2026-09-01", time_in: "08:15:00", time_out: "15:00:00", grace_available: true, expected_grace_used: true, expected_late_hours: 0, expected_late_centavos: 0, expected_undertime_centavos: 2_000, expected_net_centavos: 6_000 },
        EdgeCase { date: "2026-09-02", time_in: "08:15:00", time_out: "15:00:00", grace_available: false, expected_grace_used: false, expected_late_hours: 1, expected_late_centavos: 1_000, expected_undertime_centavos: 2_000, expected_net_centavos: 5_000 },
        EdgeCase { date: "2026-09-03", time_in: "08:15:01", time_out: "15:00:00", grace_available: true, expected_grace_used: false, expected_late_hours: 1, expected_late_centavos: 1_000, expected_undertime_centavos: 2_000, expected_net_centavos: 5_000 },
        EdgeCase { date: "2026-09-04", time_in: "08:16:00", time_out: "17:00:00", grace_available: false, expected_grace_used: false, expected_late_hours: 1, expected_late_centavos: 1_000, expected_undertime_centavos: 0, expected_net_centavos: 7_000 },
        EdgeCase { date: "2026-09-07", time_in: "08:00:01", time_out: "17:00:00", grace_available: true, expected_grace_used: true, expected_late_hours: 0, expected_late_centavos: 0, expected_undertime_centavos: 0, expected_net_centavos: 8_000 },
    ];

    for case in cases {
        let result = calculate(
            case.date,
            &format!("{}T{}+08:00", case.date, case.time_in),
            &format!("{}T{}+08:00", case.date, case.time_out),
            case.grace_available,
        )
        .unwrap();

        assert_eq!(result.grace_used, case.expected_grace_used, "{} {}", case.date, case.time_in);
        assert_eq!(result.base_pay_centavos, 8_000, "{} {}", case.date, case.time_in);
        assert_eq!(result.late_hours, case.expected_late_hours, "{} {}", case.date, case.time_in);
        assert_eq!(result.late_deduction_centavos, case.expected_late_centavos, "{} {}", case.date, case.time_in);
        assert_eq!(result.half_day_deduction_centavos, case.expected_undertime_centavos, "{} {}", case.date, case.time_in);
        assert_eq!(
            result.daily_pay_centavos,
            case.expected_net_centavos,
            "{} {}",
            case.date,
            case.time_in
        );
        assert_eq!(
            result.daily_pay_centavos,
            8_000 - result.late_deduction_centavos - result.half_day_deduction_centavos,
            "late and undertime must not double-charge {} {}",
            case.date,
            case.time_in
        );
    }
}

#[test]
fn september_intern_edge_attendance_matches_weekly_grace_and_cutoff_totals() {
    use services::intern_payroll::calculate;

    struct AttendanceCase {
        employee_id: &'static str,
        date: &'static str,
        time_in: &'static str,
        time_out: &'static str,
        grace_available: bool,
        expected_grace_used: bool,
        expected_late_hours: i64,
        expected_late_centavos: i64,
        expected_undertime_centavos: i64,
    }

    let cases = [
        AttendanceCase { employee_id: "APG-2026-116", date: "2026-09-01", time_in: "08:00:00", time_out: "17:00:00", grace_available: true, expected_grace_used: false, expected_late_hours: 0, expected_late_centavos: 0, expected_undertime_centavos: 0 },
        AttendanceCase { employee_id: "APG-2026-117", date: "2026-09-01", time_in: "08:00:01", time_out: "17:00:00", grace_available: true, expected_grace_used: true, expected_late_hours: 0, expected_late_centavos: 0, expected_undertime_centavos: 0 },
        AttendanceCase { employee_id: "APG-2026-116", date: "2026-09-02", time_in: "08:08:00", time_out: "17:00:00", grace_available: true, expected_grace_used: true, expected_late_hours: 0, expected_late_centavos: 0, expected_undertime_centavos: 0 },
        AttendanceCase { employee_id: "APG-2026-116", date: "2026-09-03", time_in: "08:08:00", time_out: "17:00:00", grace_available: false, expected_grace_used: false, expected_late_hours: 1, expected_late_centavos: 1_000, expected_undertime_centavos: 0 },
        AttendanceCase { employee_id: "APG-2026-117", date: "2026-09-03", time_in: "08:15:00", time_out: "17:00:00", grace_available: true, expected_grace_used: true, expected_late_hours: 0, expected_late_centavos: 0, expected_undertime_centavos: 0 },
        AttendanceCase { employee_id: "APG-2026-118", date: "2026-09-04", time_in: "08:15:01", time_out: "17:00:00", grace_available: true, expected_grace_used: false, expected_late_hours: 1, expected_late_centavos: 1_000, expected_undertime_centavos: 0 },
        AttendanceCase { employee_id: "APG-2026-119", date: "2026-09-04", time_in: "08:16:00", time_out: "17:00:00", grace_available: false, expected_grace_used: false, expected_late_hours: 1, expected_late_centavos: 1_000, expected_undertime_centavos: 0 },
        AttendanceCase { employee_id: "APG-2026-117", date: "2026-09-08", time_in: "08:30:00", time_out: "17:00:00", grace_available: false, expected_grace_used: false, expected_late_hours: 1, expected_late_centavos: 1_000, expected_undertime_centavos: 0 },
        AttendanceCase { employee_id: "APG-2026-118", date: "2026-09-09", time_in: "09:00:01", time_out: "17:00:00", grace_available: false, expected_grace_used: false, expected_late_hours: 2, expected_late_centavos: 2_000, expected_undertime_centavos: 0 },
        AttendanceCase { employee_id: "APG-2026-119", date: "2026-09-10", time_in: "08:00:00", time_out: "16:00:00", grace_available: false, expected_grace_used: false, expected_late_hours: 0, expected_late_centavos: 0, expected_undertime_centavos: 1_000 },
        AttendanceCase { employee_id: "APG-2026-116", date: "2026-09-11", time_in: "08:00:00", time_out: "15:00:00", grace_available: false, expected_grace_used: false, expected_late_hours: 0, expected_late_centavos: 0, expected_undertime_centavos: 2_000 },
        AttendanceCase { employee_id: "APG-2026-117", date: "2026-09-11", time_in: "08:30:00", time_out: "16:00:00", grace_available: false, expected_grace_used: false, expected_late_hours: 1, expected_late_centavos: 1_000, expected_undertime_centavos: 1_000 },
        AttendanceCase { employee_id: "APG-2026-118", date: "2026-09-11", time_in: "09:00:01", time_out: "15:00:00", grace_available: false, expected_grace_used: false, expected_late_hours: 2, expected_late_centavos: 2_000, expected_undertime_centavos: 2_000 },
        AttendanceCase { employee_id: "APG-2026-116", date: "2026-09-07", time_in: "08:08:00", time_out: "17:00:00", grace_available: true, expected_grace_used: true, expected_late_hours: 0, expected_late_centavos: 0, expected_undertime_centavos: 0 },
        AttendanceCase { employee_id: "APG-2026-116", date: "2026-09-08", time_in: "08:08:00", time_out: "17:00:00", grace_available: false, expected_grace_used: false, expected_late_hours: 1, expected_late_centavos: 1_000, expected_undertime_centavos: 0 },
        AttendanceCase { employee_id: "APG-2026-116", date: "2026-09-14", time_in: "08:08:00", time_out: "17:00:00", grace_available: true, expected_grace_used: true, expected_late_hours: 0, expected_late_centavos: 0, expected_undertime_centavos: 0 },
        AttendanceCase { employee_id: "APG-2026-116", date: "2026-09-15", time_in: "08:08:00", time_out: "17:00:00", grace_available: false, expected_grace_used: false, expected_late_hours: 1, expected_late_centavos: 1_000, expected_undertime_centavos: 0 },
    ];

    let employee_ids = [
        "APG-2026-116",
        "APG-2026-117",
        "APG-2026-118",
        "APG-2026-119",
    ];
    let mut employee_totals = [(0_i64, 0_i64, 0_i64); 4];
    for case in cases {
        let result = calculate(
            case.date,
            &format!("{}T{}+08:00", case.date, case.time_in),
            &format!("{}T{}+08:00", case.date, case.time_out),
            case.grace_available,
        )
        .unwrap();
        assert_eq!(result.grace_used, case.expected_grace_used, "{} {}", case.employee_id, case.date);
        assert_eq!(result.late_hours, case.expected_late_hours, "{} {}", case.employee_id, case.date);
        assert_eq!(result.late_deduction_centavos, case.expected_late_centavos, "{} {}", case.employee_id, case.date);
        assert_eq!(result.half_day_deduction_centavos, case.expected_undertime_centavos, "{} {}", case.employee_id, case.date);
        assert_eq!(result.base_pay_centavos, 8_000, "{} {}", case.employee_id, case.date);
        assert_eq!(
            result.daily_pay_centavos,
            8_000 - case.expected_late_centavos - case.expected_undertime_centavos,
            "{} {}",
            case.employee_id,
            case.date
        );
        let employee_index = employee_ids.iter().position(|id| *id == case.employee_id).unwrap();
        employee_totals[employee_index].0 += result.late_deduction_centavos;
        employee_totals[employee_index].1 += result.half_day_deduction_centavos;
        employee_totals[employee_index].2 += 1;
    }

    let late_total: i64 = employee_totals.iter().map(|totals| totals.0).sum();
    let undertime_total: i64 = employee_totals.iter().map(|totals| totals.1).sum();
    assert_eq!(late_total, 11_000);
    assert_eq!(undertime_total, 6_000);

    let mut cutoff_net_total = 0_i64;
    for (index, employee_id) in employee_ids.iter().enumerate() {
        let (late, undertime, attendance_days) = employee_totals[index];
        let cutoff = services::cutoff_payroll::calculate(&services::cutoff_payroll::CutoffInput {
            employee_id: (*employee_id).into(),
            employee_name: "Intern edge set".into(),
            employee_type: "INTERN".into(),
            cutoff_start: "2026-09-01".into(),
            cutoff_end: "2026-09-15".into(),
            daily_rate: 80.0,
            standard_working_days: 17.0,
            actual_working_days: attendance_days as f64,
            basic_pay: Some(attendance_days as f64 * 80.0),
            special_holiday_days: 0.0,
            special_holiday_multiplier: 1.0,
            special_holiday_pay: None,
            regular_holiday_days: 0.0,
            regular_holiday_multiplier: 1.0,
            regular_holiday_pay: None,
            hra: 0.0,
            incentives_allowance: 0.0,
            special_allowance: 0.0,
            late_deduction: late as f64 / 100.0,
            half_day_count: 0.0,
            half_day_fraction: 0.5,
            half_day_deduction: Some(undertime as f64 / 100.0),
            absent_days: 0.0,
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
        .unwrap();
        assert_eq!(cutoff.late_deduction, late, "{employee_id}");
        assert_eq!(cutoff.half_day_deduction, undertime, "{employee_id}");
        assert_eq!(cutoff.total_deductions, late + undertime, "{employee_id}");
        assert_eq!(cutoff.net_pay, attendance_days * 8_000 - late - undertime, "{employee_id}");
        cutoff_net_total += cutoff.net_pay;
    }
    assert_eq!(cutoff_net_total, 119_000);
}
